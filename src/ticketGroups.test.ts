import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitCompare, makeStack } from './testGit.js';

/**
 * Ticket groups against real git: two repositories, each with the stack
 * main -> feat/abc-1-a -> feat/abc-1-b.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-groups-'));
const repos = { svc: path.join(root, 'svc'), web: path.join(root, 'web') };
makeStack(repos.svc, 'feat/abc-1-a', 'feat/abc-1-b');
makeStack(repos.web, 'feat/abc-1-a', 'feat/abc-1-b');
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc,web';
process.env.LOCAL_REPOS = `svc=${repos.svc},web=${repos.web}`;

const store = await import('./db.js');
const groups = await import('./ticketGroups.js');
const ticketStore = await import('./ticketStore.js');
const chains = await import('./ticketChains.js');
const { resolveLocalTarget } = await import('./localRepos.js');
const { withGroupBases } = await import('./routes/reviews.js');

test.after(() => {
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const A = 'feat/abc-1-a';
const B = 'feat/abc-1-b';
const offline = {
  compare: async () => { throw new Error('no network in this test'); },
  defaultBranch: async () => 'main',
  localParent: groups.defaultDetectDeps.localParent,
};
/** GitHub, played by the local repositories. */
const remote = {
  compare: async (repo: string, base: string, head: string) => gitCompare(repos[repo as 'svc' | 'web'], base, head),
  defaultBranch: async () => 'main',
  localParent: async () => { throw new Error('not local'); },
};

function shape(key: string) {
  return groups.ticketGroupView(key)!.chains.map((c) => ({
    repo: c.repo,
    branches: c.branches.map((b) => `${'  '.repeat(b.depth)}${b.branch} <- ${b.parent} (${b.parentReason})`),
  }));
}

test('local branches: each joins with its detected parent, one chain per repository', async () => {
  // Joined child first: order must come from the parents, not from the arrival order.
  const targets = [
    await resolveLocalTarget({ repo: 'web', branch: B }),
    await resolveLocalTarget({ repo: 'svc', branch: B }),
    await resolveLocalTarget({ repo: 'svc', branch: A }),
    await resolveLocalTarget({ repo: 'web', branch: A }),
  ];
  await groups.joinGroup('ABC-1', { title: 'Export', url: '' }, targets, offline, { detect: 'new' });
  assert.deepEqual(shape('ABC-1'), [
    { repo: 'svc', branches: [`${A} <- main (default)`, `  ${B} <- ${A} (detected)`] },
    { repo: 'web', branches: [`${A} <- main (default)`, `  ${B} <- ${A} (detected)`] },
  ]);
  assert.deepEqual(groups.orderedMembers('ABC-1').map((m) => `${m.repo}#${m.branch}`), [
    `svc#${A}`, `svc#${B}`, `web#${A}`, `web#${B}`,
  ]);
});

test('pushed branches: parents from GitHub compare between siblings, and a PR base wins', async () => {
  const targets = [B, A].flatMap((branch) => (['svc', 'web'] as const).map((repo) => ({
    repo, branch, baseBranch: 'main', prNumber: null,
  })));
  await groups.joinGroup('ABC-2', null, targets, remote, { detect: 'all' });
  assert.deepEqual(shape('ABC-2'), [
    { repo: 'svc', branches: [`${A} <- main (default)`, `  ${B} <- ${A} (detected)`] },
    { repo: 'web', branches: [`${A} <- main (default)`, `  ${B} <- ${A} (detected)`] },
  ]);

  // A PR of web#a against another branch: its base is the parent, whatever compare says.
  await groups.joinGroup('ABC-2', null, [{ repo: 'web', branch: A, baseBranch: 'release', prNumber: 9 }], remote, {
    detect: 'all',
  });
  const webA = ticketStore.getTicketBranch('ABC-2', 'web', A)!;
  assert.equal(webA.parent_branch, 'release');
  assert.equal(webA.parent_reason, 'pr');
  assert.equal(webA.pr_number, 9);
  // Detected again without PR information: the learnt PR base stays.
  await groups.detectGroupParents('ABC-2', remote, {});
  assert.equal(ticketStore.getTicketBranch('ABC-2', 'web', A)!.parent_branch, 'release');
});

test('a branch of a group is diffed against its parent unless a base was chosen', async () => {
  const [b] = groups.applyGroupBases('ABC-2', [{ repo: 'svc', branch: B, baseBranch: 'main', prNumber: null }]);
  assert.equal(b!.baseBranch, A);
  assert.equal(b!.baseReason, 'parent');
  const [a] = groups.applyGroupBases('ABC-2', [{ repo: 'svc', branch: A, baseBranch: 'main', prNumber: null }]);
  assert.equal(a!.baseBranch, 'main');
  assert.equal(a!.baseReason, 'default');
  const [kept] = groups.applyGroupBases('ABC-2', [{ repo: 'svc', branch: B, baseBranch: 'main', prNumber: null }], {
    explicitBase: true,
  });
  assert.equal(kept!.baseBranch, 'main');
  const [outside] = groups.applyGroupBases('ABC-2', [{ repo: 'svc', branch: 'other', baseBranch: 'main', prNumber: null }]);
  assert.equal(outside!.baseBranch, 'main');
});

test('start_review of a group branch: its base defaults to the group parent', async () => {
  // As POST /api/reviews sees it: the resolver gave the default branch as the base.
  const ticket = {
    provider: 'linear', key: 'ABC-2', title: 'Export', url: '', body: '', state: '', branchName: null,
    comments: [], attachmentUrls: [],
  };
  const out = await withGroupBases([{ repo: 'web', branch: B, baseBranch: 'main', prNumber: null }], ticket, false);
  assert.equal(out[0]!.baseBranch, A);
  // Pasted requirements (no ticket key): the key in the branch name finds the group of ABC-1.
  const local = await withGroupBases([
    { repo: 'svc', branch: B, baseBranch: 'main', prNumber: null, source: 'local', baseReason: 'default' },
  ], null, false);
  assert.equal(local[0]!.baseBranch, A);
  // An explicit base wins.
  const chosen = await withGroupBases([
    { repo: 'svc', branch: B, baseBranch: 'main', prNumber: null, source: 'local', baseReason: 'chosen' },
  ], null, true);
  assert.equal(chosen[0]!.baseBranch, 'main');
});

test('a parent set by hand sticks, loops are refused, and an order makes a linear chain', async () => {
  await assert.rejects(groups.setParentByHand('ABC-2', 'svc', A, B, remote), /loop/);
  await assert.rejects(groups.setParentByHand('ABC-2', 'svc', A, A, remote), /own parent/);
  await assert.rejects(groups.setParentByHand('ABC-2', 'svc', 'nope', A, remote), /not a branch/);

  // Back to the default branch, by hand: detection leaves it alone.
  await groups.setParentByHand('ABC-2', 'svc', B, null, remote);
  await groups.detectGroupParents('ABC-2', remote, {});
  // Two roots now, in the order they joined the group.
  assert.deepEqual(shape('ABC-2')[0], { repo: 'svc', branches: [`${B} <- main (user)`, `${A} <- main (default)`] });
  // Unless the user asks for a reset.
  await groups.detectGroupParents('ABC-2', remote, { includeUser: true });
  assert.deepEqual(shape('ABC-2')[0], { repo: 'svc', branches: [`${A} <- main (default)`, `  ${B} <- ${A} (detected)`] });

  await groups.setChainOrder('ABC-2', 'svc', [B, A], null, remote);
  assert.deepEqual(shape('ABC-2')[0], { repo: 'svc', branches: [`${B} <- main (user)`, `  ${A} <- ${B} (user)`] });
  await assert.rejects(groups.setChainOrder('ABC-2', 'svc', [A, A], null, remote), /twice/);
  await assert.rejects(groups.setChainOrder('ABC-2', 'svc', [A, 'ghost'], null, remote), /not a branch/);
});

test('branches known only from the review history join with their stored base', () => {
  store.createReview({ ticket_key: 'XYZ-9', repo: 'svc', branch: 'feat/xyz-9-api', base_branch: 'main', status: 'done' });
  store.createReview({
    ticket_key: null, ticket_title: '# XYZ-9: limits', repo: 'web', branch: 'feat/xyz-9-ui', base_branch: 'develop',
    status: 'done',
  });
  const view = groups.ticketGroupView('XYZ-9')!;
  assert.equal(view.title, '# XYZ-9: limits');
  assert.deepEqual(view.chains.map((c) => c.branches.map((b) => [b.branch, b.parent, b.parentReason, b.latestDone?.id !== undefined])), [
    [['feat/xyz-9-api', 'main', 'stored', true]],
    [['feat/xyz-9-ui', 'develop', 'stored', true]],
  ]);
  assert.equal(groups.ticketGroupView('NOPE-1'), null);
});

test('chains: parents first, siblings by position, and a loop cannot hide a branch', () => {
  const row = (branch: string, parent: string | null, position = 0) => ({ repo: 'r', branch, parent_branch: parent, position });
  const out = chains.orderChains([row('c', 'b'), row('b', 'a'), row('a', 'main'), row('x', 'a', 1), row('y', 'a', 0)]);
  assert.deepEqual(out[0]!.nodes.map((n) => `${n.depth}:${n.item.branch}`), ['0:a', '1:b', '2:c', '1:y', '1:x']);
  const loop = chains.orderChains([row('p', 'q'), row('q', 'p')]);
  assert.deepEqual(loop[0]!.nodes.map((n) => n.item.branch).sort(), ['p', 'q']);
  assert.equal(chains.wouldCycle([row('b', 'a'), row('c', 'b')], 'r', 'a', 'c'), true);
  assert.equal(chains.wouldCycle([row('b', 'a'), row('c', 'b')], 'r', 'c', 'a'), false);
  assert.deepEqual(chains.linearParents(['a', 'b'], 'main'), [
    { branch: 'a', parent: 'main', position: 0 }, { branch: 'b', parent: 'a', position: 1 },
  ]);
});

test('remote parent choice: PR base, closest contained sibling, else the default branch', () => {
  const ahead = (n: number) => ({ status: 'ahead', ahead_by: n, behind_by: 0 });
  const base = { defaultBranch: 'main', defaultCompare: { status: 'diverged', ahead_by: 5, behind_by: 2 }, prBase: null };
  assert.deepEqual(chains.chooseRemoteParent({ ...base, siblings: [{ name: 'a', compare: ahead(3) }, { name: 'b', compare: ahead(1) }] }),
    { parent: 'b', reason: 'detected', distance: 1 });
  // A sibling exactly as far as the default branch is not closer.
  assert.equal(chains.chooseRemoteParent({ ...base, siblings: [{ name: 'a', compare: ahead(5) }] }).parent, 'main');
  assert.equal(chains.chooseRemoteParent({
    ...base, siblings: [{ name: 'a', compare: { status: 'diverged', ahead_by: 1, behind_by: 1 } }],
  }).reason, 'default');
  assert.deepEqual(chains.chooseRemoteParent({ ...base, prBase: 'a', siblings: [] }), { parent: 'a', reason: 'pr', distance: null });
  // A PR against the default branch still lets a contained sibling win.
  assert.equal(chains.chooseRemoteParent({ ...base, prBase: 'main', siblings: [{ name: 'a', compare: ahead(2) }] }).parent, 'a');
  // GitHub could not answer for the default branch: any contained sibling wins.
  assert.equal(chains.chooseRemoteParent({ ...base, defaultCompare: null, siblings: [{ name: 'a', compare: ahead(9) }] }).parent, 'a');
});
