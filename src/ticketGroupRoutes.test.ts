import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { gitCompare, makeStack } from './testGit.js';
import type { ResolvedTarget, ReviewRow, TicketInfo } from './types.js';

/**
 * The ticket-group routes with the tracker, GitHub, and the queue stubbed: a
 * ticket with a stack main -> a -> b in two repositories.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-ticket-routes-'));
const repos = { svc: path.join(root, 'svc'), web: path.join(root, 'web') };
const A = 'feat/abc-3-a';
const B = 'feat/abc-3-b';
makeStack(repos.svc, A, B);
makeStack(repos.web, A, B);
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc,web';

const store = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const { ticketGroupRoutes } = await import('./routes/ticketGroups.js');
type TicketRouteDeps = import('./routes/ticketGroups.js').TicketRouteDeps;
const { reviewRoutes } = await import('./routes/reviews.js');
const { setReviewerForTests } = await import('./reviewers/index.js');

// The routes refuse a reviewer whose CLI is missing; CI runners have none.
setReviewerForTests('claude', {
  name: 'claude', label: 'Claude Code', defaultModel: 'opus', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/true',
  buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
  discoverModels: async () => ({
    models: [{ id: 'opus', label: 'opus' }], source: 'cli-cache', fetchedAt: Date.now(), hint: null,
  }),
  isAvailable: () => true,
  describeFailure: () => null,
  acceptsUnlistedModels: true,
});

const ticket: TicketInfo = {
  provider: 'linear', key: 'ABC-3', title: 'Export', url: 'https://tracker.example/ABC-3', body: 'Export risks.',
  state: 'Todo', branchName: null, comments: [], attachmentUrls: [],
};
// Children first, as a branch scan may list them.
const resolved: ResolvedTarget[] = [B, A].flatMap((branch) => (['web', 'svc'] as const).map((repo) => ({
  repo, branch, baseBranch: 'main', prNumber: null,
})));

const started: { target: ResolvedTarget; ticket: TicketInfo | null; reviewer?: string; model?: string }[] = [];
const recomputed: { key: string; opts: unknown }[] = [];
let resolveFails = false;

const app = Fastify({ logger: false });
const deps: Partial<TicketRouteDeps> = {
  resolve: async (input: string) => {
    if (resolveFails) throw new Error('tracker down');
    if (input !== 'ABC-3') throw new Error(`Unsupported input: ${input}`);
    return { ticket, targets: resolved };
  },
  detect: {
    compare: async (repo, base, head) => gitCompare(repos[repo as 'svc' | 'web'], base, head),
    defaultBranch: async () => 'main',
    localParent: async () => { throw new Error('not local'); },
  },
  startRun: (target, t, reviewer, model, opts) => {
    started.push({ target, ticket: t, reviewer, model });
    return store.createReview({
      depends_on: opts?.dependsOn ?? null,
      ticket_key: t?.key || null, ticket_title: t?.title ?? null, ticket_body: t?.body ?? null,
      repo: target.repo, branch: target.branch, base_branch: target.baseBranch, status: 'queued',
      base_reason: target.baseReason ?? null, reviewer: reviewer ?? 'claude',
    });
  },
  recompute: (key, opts) => {
    recomputed.push({ key, opts });
    ticketStore.createCoverage(key, { reviewIds: [], reviewer: 'claude', model: 'opus', trigger: 'manual' });
    return { started: true, done: Promise.resolve() };
  },
  pending: () => false,
};
await app.register(ticketGroupRoutes, { deps });
await app.register(reviewRoutes);

test.after(async () => {
  setReviewerForTests('claude', null);
  await app.close();
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const enc = encodeURIComponent;

test('review the ticket: every branch queued parents first, each against its parent', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/tickets/ABC-3/review',
    payload: { reviewer: 'claude', requirementsText: 'Decision: CSV is enough.' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(started.map((s) => `${s.target.repo}#${s.target.branch} <- ${s.target.baseBranch}`), [
    `svc#${A} <- main`, `svc#${B} <- ${A}`, `web#${A} <- main`, `web#${B} <- ${A}`,
  ]);
  assert.deepEqual(started.map((s) => s.target.baseReason), ['default', 'parent', 'default', 'parent']);
  // The added text joins the ticket's checklist as a user item; the ticket text stays as the tracker has it.
  assert.equal(started[1]!.ticket!.body, 'Export risks.');
  assert.deepEqual(
    (await import('./ticketRequirements.js')).activeChecklist('ABC-3').map((r) => [r.text, r.source]),
    [['Decision: CSV is enough.', 'user']],
  );
  assert.equal(body.run.status, 'running');
  assert.deepEqual(body.run.review_ids, body.reviews.map((r: ReviewRow) => r.id));
  // Each child waits for its parent's review in this batch, and the answer says so.
  assert.equal(body.notes.length, 2);
  assert.match(body.notes[0], new RegExp(`svc#${B}: starts after the review of its parent ${A} in this batch ends`));
  const ids = new Map(body.reviews.map((r: ReviewRow) => [`${r.repo}#${r.branch}`, r.id]));
  assert.deepEqual(body.reviews.map((r: ReviewRow) => store.getReview(r.id)!.depends_on), [
    null, ids.get(`svc#${A}`), null, ids.get(`web#${A}`),
  ]);
  assert.equal(body.group.chains.length, 2);
  assert.equal(ticketStore.getTicketGroup('ABC-3')!.requirements_text, 'Decision: CSV is enough.');
});

test('the ticket page payload: chains, latest runs, links, coverage, run', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/ticket-groups/ABC-3' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const svc = body.group.chains[0];
  assert.equal(svc.repo, 'svc');
  assert.deepEqual(svc.branches.map((b: any) => [b.branch, b.parent, b.parentReason, b.depth, b.parentInGroup]), [
    [A, 'main', 'default', 0, false], [B, A, 'detected', 1, true],
  ]);
  assert.equal(svc.branches[1].latest.status, 'queued');
  assert.equal(svc.branches[1].parentReviewed, false);
  assert.match(svc.branches[0].links.branch, /github\.com\/test-org\/svc\/tree\/feat\/abc-3-a/);
  assert.equal(body.coverage, null);
  assert.equal(body.run.status, 'running');

  assert.equal((await app.inject({ method: 'GET', url: '/api/ticket-groups/NOPE-1' })).statusCode, 404);
  // A key with a slash and a hash arrives whole.
  const issue = await app.inject({ method: 'GET', url: `/api/ticket-groups/${enc('my-org/svc#12')}` });
  assert.equal(issue.statusCode, 404);
  assert.match(issue.json().error, /my-org\/svc#12/);
});

test('a subset of branches, and an unknown one', async () => {
  started.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/api/tickets/ABC-3/review', payload: { branches: [`web#${B}`], refresh: false },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(started.map((s) => `${s.target.repo}#${s.target.branch} <- ${s.target.baseBranch}`), [`web#${B} <- ${A}`]);
  assert.match(res.json().notes[0], /is not in this batch/);
  const bad = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/review', payload: { branches: ['web#ghost'] } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Not branches of ABC-3: web#ghost/);
});

test('the tracker is down: the stored group is reviewed, with a warning; an unknown ticket is a 404', async () => {
  resolveFails = true;
  started.length = 0;
  try {
    const res = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/review', payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(started.length, 4);
    assert.match(res.json().resolve_warning, /tracker down/);
    const none = await app.inject({ method: 'POST', url: '/api/tickets/ZZZ-1/review', payload: {} });
    assert.equal(none.statusCode, 404);
  } finally {
    resolveFails = false;
  }
});

test('set a parent, refuse a loop, reorder a chain, re-detect', async () => {
  const loop = await app.inject({ method: 'PUT', url: '/api/tickets/ABC-3/parent', payload: { repo: 'svc', branch: A, parent: B } });
  assert.equal(loop.statusCode, 400);
  assert.match(loop.json().error, /loop/);
  const missing = await app.inject({ method: 'PUT', url: '/api/tickets/ABC-3/parent', payload: { repo: 'svc', branch: 'x', parent: null } });
  assert.equal(missing.statusCode, 404);

  const set = await app.inject({ method: 'PUT', url: '/api/tickets/ABC-3/parent', payload: { repo: 'web', branch: B, parent: null } });
  assert.equal(set.statusCode, 200);
  const web = set.json().group.chains[1].branches.find((b: any) => b.branch === B);
  assert.deepEqual([web.parent, web.parentReason], ['main', 'user']);

  const order = await app.inject({ method: 'PUT', url: '/api/tickets/ABC-3/order', payload: { repo: 'svc', branches: [B, A] } });
  assert.equal(order.statusCode, 200);
  assert.deepEqual(order.json().group.chains[0].branches.map((b: any) => `${b.branch}<-${b.parent}`), [`${B}<-main`, `${A}<-${B}`]);

  const reset = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/detect', payload: { reset: true } });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json().group.chains[0].branches.map((b: any) => `${b.branch}<-${b.parent}`), [`${A}<-main`, `${B}<-${A}`]);
});

test('recompute coverage, and the coverage seen from one review', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/coverage', payload: { model: 'sonnet' } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().started, true);
  assert.equal(res.json().coverage.status, 'running');
  assert.deepEqual(recomputed.at(-1), { key: 'ABC-3', opts: { trigger: 'manual', reviewer: 'claude', model: 'sonnet' } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/tickets/NOPE-2/coverage', payload: {} })).statusCode, 404);

  // A finished coverage, and a review of one branch reading it.
  const review = store.listReviews({ group: 'ABC-3', limit: 50 }).reviews.find((r) => r.repo === 'svc' && r.branch === B)!;
  const row = ticketStore.createCoverage('ABC-3', { reviewIds: [review.id], reviewer: 'claude', model: 'opus', trigger: 'test' });
  ticketStore.finishCoverage(row.id, {
    status: 'done', verdict: 'needs_work', summary: 'One missing.', reportPath: null,
    requirements: [
      { text: 'Export', status: 'covered', note: '', branches: [{ repo: 'svc', branch: B, review_id: review.id, status: 'covered', note: '', evidence: [] }] },
      { text: 'Button', status: 'covered', note: '', branches: [{ repo: 'web', branch: A, review_id: null, status: 'covered', note: '', evidence: [] }] },
      { text: 'Tests', status: 'missing', note: 'none', branches: [] },
    ],
  });
  const detail = (await app.inject({ method: 'GET', url: `/api/reviews/${review.id}` })).json();
  assert.equal(detail.ticket_group.key, 'ABC-3');
  assert.equal(detail.ticket_group.parent, A);
  assert.equal(detail.ticket_group.coverage.verdict, 'needs_work');
  assert.equal(detail.ticket_group.coverage.includes_this_review, true);
  assert.deepEqual(detail.ticket_group.coverage.requirements.map((r: any) => r.where), ['here', 'elsewhere', 'nowhere']);

  const page = (await app.inject({ method: 'GET', url: '/api/ticket-groups/ABC-3' })).json();
  assert.equal(page.coverage.id, row.id);
  // The finished pass is the newest one, so nothing shows beside it.
  assert.equal(page.latest_coverage, null);
  assert.equal(page.coverage.requirements.length, 3);

  // A branch without a ticket has no group context.
  const lone = store.createReview({ repo: 'svc', branch: 'cleanup', base_branch: 'main', status: 'done' });
  assert.equal((await app.inject({ method: 'GET', url: `/api/reviews/${lone.id}` })).json().ticket_group, null);
});

test('incident: stored parents with the child at position 0, targets listed children first, frontend first', async () => {
  // The state of INC-9 when a ticket review queued the children first.
  const KEY = 'INC-9';
  const P = 'feat/inc-9-export';
  const C = 'feat/inc-9-dates';
  const now = new Date().toISOString();
  ticketStore.upsertTicketGroup(KEY, { title: 'Incident' });
  for (const repo of ['web', 'svc']) {
    for (const [branch, parent, position] of [[C, P, 0], [P, 'main', 1]] as const) {
      store.db.prepare(
        `INSERT INTO ticket_branches (ticket_key, repo, branch, source, parent_branch, parent_reason, position, created_at, updated_at)
         VALUES (?, ?, ?, 'github', ?, 'stored', ?, ?, ?)`,
      ).run(KEY, repo, branch, parent, position, now, now);
    }
  }
  started.length = 0;
  const res = await app.inject({ method: 'POST', url: `/api/tickets/${KEY}/review`, payload: { refresh: false } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(started.map((s) => `${s.target.repo}#${s.target.branch} <- ${s.target.baseBranch}`), [
    `svc#${P} <- main`, `svc#${C} <- ${P}`, `web#${P} <- main`, `web#${C} <- ${P}`,
  ]);
  const rows = res.json().reviews.map((r: ReviewRow) => store.getReview(r.id)!);
  assert.deepEqual(rows.map((r: ReviewRow) => r.depends_on), [null, rows[0].id, null, rows[2].id]);
  // Positions follow the chain now: the parent sorts first.
  const positions = ticketStore.listTicketBranches(KEY).map((b) => `${b.repo}#${b.branch}:${b.position}`);
  assert.deepEqual(positions.sort(), [`svc#${C}:1`, `svc#${P}:0`, `web#${C}:1`, `web#${P}:0`]);
});

// --- the model is checked before anything is queued ------------------------

/** Codex with a model list the test sets; nothing it lists is ever run. */
function codexListing(list: string[]): import('./reviewers/types.js').ReviewerDefinition {
  const models = list.map((id) => ({ id, label: id }));
  return {
    name: 'codex', label: 'OpenAI Codex', defaultModel: '', defaultModelEnv: 'CODEX_REVIEW_MODEL', bin: '/bin/true',
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    discoverModels: async () => ({
      models,
      source: models.length ? 'cli-cache' : null,
      fetchedAt: Date.now(),
      hint: models.length ? null : 'Codex has no model list yet: run `codex login` or `codex` once, then retry',
    }),
    isAvailable: () => true,
    describeFailure: () => null,
  };
}

const reviewCount = (): number => (store.db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as { n: number }).n;

test('an unlisted model is a 400 naming the available ids on every start path, and nothing is queued', async () => {
  setReviewerForTests('codex', codexListing(['gpt-6.1-sol', 'gpt-5.6-sol']));
  try {
    const before = reviewCount();
    const startedBefore = started.length;
    const recomputedBefore = recomputed.length;
    const bad = { reviewer: 'codex', model: 'gpt-5.5' };
    const expected = 'Model "gpt-5.5" is not available for OpenAI Codex. Available: gpt-6.1-sol, gpt-5.6-sol.';
    const prev = store.createReview({ repo: 'svc', branch: A, base_branch: 'main', status: 'done', reviewer: 'codex', model: 'gpt-6.1-sol' });
    const calls = [
      { method: 'POST' as const, url: '/api/reviews', payload: { input: 'ABC-3', ...bad } },
      { method: 'POST' as const, url: '/api/tickets/ABC-3/review', payload: { ...bad, refresh: false } },
      { method: 'POST' as const, url: `/api/reviews/${prev.id}/rerun`, payload: bad },
      { method: 'POST' as const, url: '/api/tickets/ABC-3/coverage', payload: bad },
      { method: 'POST' as const, url: '/api/tickets/ABC-3/requirements/derive', payload: bad },
    ];
    for (const call of calls) {
      const res = await app.inject(call);
      assert.equal(res.statusCode, 400, `${call.url}: ${res.body}`);
      assert.equal(res.json().error, expected, call.url);
    }
    assert.equal(reviewCount(), before + 1);
    assert.equal(started.length, startedBefore);
    assert.equal(recomputed.length, recomputedBefore);
  } finally {
    setReviewerForTests('codex', null);
  }
});

test('without a model the resolved default is queued; a pass by hand gets a checked model', async () => {
  setReviewerForTests('codex', codexListing(['gpt-6.1-sol', 'gpt-5.6-sol']));
  try {
    const from = started.length;
    const res = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/review', payload: { reviewer: 'codex', refresh: false } });
    assert.equal(res.statusCode, 201, res.body);
    assert.ok(started.length > from);
    assert.deepEqual(new Set(started.slice(from).map((s) => `${s.reviewer}/${s.model}`)), new Set(['codex/gpt-6.1-sol']));

    const cov = await app.inject({ method: 'POST', url: '/api/tickets/ABC-3/coverage', payload: { reviewer: 'codex', model: 'gpt-5.6-sol' } });
    assert.equal(cov.statusCode, 202, cov.body);
    assert.deepEqual(recomputed.at(-1)!.opts, { trigger: 'manual', reviewer: 'codex', model: 'gpt-5.6-sol' });
  } finally {
    setReviewerForTests('codex', null);
  }
});

test('an empty model list refuses a start with the login hint', async () => {
  setReviewerForTests('codex', codexListing([]));
  try {
    const before = reviewCount();
    for (const url of ['/api/reviews', '/api/tickets/ABC-3/review']) {
      const res = await app.inject({ method: 'POST', url, payload: { input: 'ABC-3', reviewer: 'codex', refresh: false } });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error, 'Codex has no model list yet: run `codex login` or `codex` once, then retry');
    }
    assert.equal(reviewCount(), before);
  } finally {
    setReviewerForTests('codex', null);
  }
});

test('a review in progress cannot be deleted; a settled one can', async () => {
  for (const status of ['queued', 'fetching', 'reviewing'] as const) {
    const review = store.createReview({ repo: 'svc', branch: `feat/delete-${status}`, base_branch: 'main', status });
    const refused = await app.inject({ method: 'DELETE', url: `/api/reviews/${review.id}` });
    assert.equal(refused.statusCode, 409, status);
    assert.match(refused.json().error, /cancel it first/i);
    assert.deepEqual(store.getReview(review.id), review, `${status} row left as it was`);
  }

  for (const status of ['done', 'cancelled'] as const) {
    const review = store.createReview({ repo: 'svc', branch: `feat/delete-${status}`, base_branch: 'main', status });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/reviews/${review.id}` });
    assert.equal(deleted.statusCode, 200, status);
    assert.equal(store.getReview(review.id), undefined, status);
  }
});

test('every run in the list carries the label its ticket cell shows', async () => {
  const row = (branch: string, extra: Partial<Parameters<typeof store.createReview>[0]> = {}) =>
    store.createReview({ repo: 'svc', branch, base_branch: 'main', status: 'done', ...extra });
  const keyed = row('feat/label-ticket', { ticket_key: 'ABC-3', ticket_title: 'Export' });
  const fromBranch = row('feat/abc-7-x');
  const pasted = row('feat/pasted-label', {
    ticket_title: 'ABC-42: Add due dates to loans', ticket_body: 'ABC-42: Add due dates to loans\n\n1. Due dates.',
  });
  const bare = row('feat/no-label');
  const { reviews } = (await app.inject({ method: 'GET', url: '/api/reviews?limit=500' })).json() as {
    reviews: { id: number; ticket_label: unknown }[];
  };
  const byId = new Map(reviews.map((r) => [r.id, r.ticket_label]));
  assert.deepEqual(byId.get(keyed.id), { text: 'ABC-3', key: 'ABC-3', from: 'ticket' });
  assert.deepEqual(byId.get(fromBranch.id), { text: 'ABC-7', key: 'ABC-7', from: 'branch' });
  assert.deepEqual(byId.get(pasted.id), { text: 'ABC-42: Add due dates to loans', key: null, from: 'title' });
  assert.ok(byId.has(bare.id), 'the bare run is listed');
  assert.equal(byId.get(bare.id), null);
});

test('a slice page attributes its checklist to this branch, another slice, the base, or nowhere; pending while stale', async () => {
  const { replaceDerivedRequirements } = await import('./ticketRequirements.js');
  const KEY = 'ATT-1';
  const items = replaceDerivedRequirements(KEY, ['API field', 'Screen reads it', 'Helper', 'FE test', 'Reopen action'], []);
  const [api, screen, helper, feTest, reopen] = items.map((i) => i.id) as [number, number, number, number, number];
  const done = (repo: string, branch: string, minute: number) => store.createReview({
    ticket_key: KEY, repo, branch, base_branch: 'main', status: 'done', verdict: 'approve', code_verdict: 'approve',
    requirements_met: repo === 'svc' ? 1 : 1, requirements_total: 5, created_at: new Date(Date.UTC(2026, 1, 1, 0, minute)).toISOString(),
  });
  const svc = done('svc', 'feat/att-1-api', 1);
  const web = done('web', 'feat/att-1-ui', 2);
  const statuses = (met: number[]) => items.map((i) => ({
    requirement_id: i.id, text: i.text, status: met.includes(i.id) ? 'met' as const : 'missing' as const, evidence: '',
  }));
  store.replaceRequirements(svc.id, statuses([api]));
  store.replaceRequirements(web.id, statuses([screen]));
  ticketStore.syncMembersFromReviews(KEY);
  const share = (r: ReviewRow, status: 'covered' | 'partial' = 'covered') => ({
    repo: r.repo, branch: r.branch, review_id: r.id, status, note: '', evidence: [],
  });
  const cov = ticketStore.createCoverage(KEY, { reviewIds: [svc.id, web.id], reviewer: 'claude', model: 'opus', trigger: 'test' });
  ticketStore.finishCoverage(cov.id, {
    status: 'done', verdict: 'needs_work', summary: 's', reportPath: null,
    requirements: [
      { requirement_id: api, text: 'API field', status: 'covered', note: '', branches: [share(svc)] },
      { requirement_id: screen, text: 'Screen reads it', status: 'covered', note: '', branches: [share(web)] },
      { requirement_id: helper, text: 'Helper', status: 'already_on_base', note: 'on main', branches: [], base_evidence: [] },
      { requirement_id: feTest, text: 'FE test', status: 'missing', note: 'No branch adds it.', branches: [] },
      { requirement_id: reopen, text: 'Reopen action', status: 'partial', note: 'Reassign only.', branches: [share(svc, 'partial')] },
    ],
  });

  const page = (await app.inject({ method: 'GET', url: `/api/reviews/${web.id}` })).json();
  assert.deepEqual(page.requirements.map((r: any) => r.attribution.state), ['other_branch', 'this_branch', 'already_on_base', 'nowhere', 'partial']);
  assert.equal(page.requirements[0].attribution.label, 'in svc#feat/att-1-api');
  assert.equal(page.requirements[0].attribution.branches[0].review_id, svc.id);
  assert.equal(page.requirements[4].attribution.note, 'Reassign only.');
  assert.equal(page.ticket_group.attribution.fresh, true);
  assert.deepEqual(page.ticket_group.attribution.by_attribution, {
    this_branch: 1, other_branch: 1, already_on_base: 1, not_verifiable: 0, nowhere: 1, partial: 1, pending: 0,
  });
  assert.equal(page.ticket_group.attribution.summary, '1 in this slice, 1 in other slices, 1 already on base, 1 nowhere, 1 partial');
  assert.equal(page.ticket_group.ticket_coverage.label, 'ticket coverage: needs_work (1 nowhere, 1 partial)');
  assert.equal(page.ticket_group.coverage.requirements[2].where, 'base');
  assert.equal(page.review.requirements_met, 1, 'the stored met/total stay as they are');

  const ticketPage = (await app.inject({ method: 'GET', url: `/api/ticket-groups/${KEY}` })).json();
  const branches = ticketPage.group.chains.flatMap((c: any) => c.branches);
  const ui = branches.find((b: any) => b.branch === 'feat/att-1-ui');
  assert.equal(ui.latestDone.requirements_attribution.summary, page.ticket_group.attribution.summary);
  assert.equal(ui.latestDone.requirements_attribution.by_attribution.nowhere, 1);

  // A newer run of the sibling is under way: the coverage is stale, nothing here is red.
  store.createReview({ ticket_key: KEY, repo: 'svc', branch: 'feat/att-1-api', base_branch: 'main', status: 'reviewing' });
  const stale = (await app.inject({ method: 'GET', url: `/api/reviews/${web.id}` })).json();
  assert.deepEqual(stale.requirements.map((r: any) => r.attribution.state), ['pending', 'this_branch', 'pending', 'pending', 'pending']);
  assert.equal(stale.requirements[0].attribution.label, 'not in this slice (coverage pending)');
  assert.equal(stale.ticket_group.attribution.fresh, false);
  assert.equal(stale.ticket_group.attribution.summary, '1 in this slice, 4 not in this slice (coverage pending)');
  assert.equal(stale.ticket_group.ticket_coverage.label, 'ticket coverage: pending');

  // A review without a ticket group keeps its plain rows.
  const lone = store.createReview({ repo: 'svc', branch: 'att-cleanup', base_branch: 'main', status: 'done' });
  store.replaceRequirements(lone.id, [{ text: 'x', status: 'missing', evidence: '' }]);
  const plain = (await app.inject({ method: 'GET', url: `/api/reviews/${lone.id}` })).json();
  assert.equal(plain.requirements[0].attribution, undefined);
  assert.equal(plain.ticket_group, null);
});
