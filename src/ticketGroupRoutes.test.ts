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

const ticket: TicketInfo = {
  provider: 'linear', key: 'ABC-3', title: 'Export', url: 'https://tracker.example/ABC-3', body: 'Export risks.',
  state: 'Todo', branchName: null, comments: [], attachmentUrls: [],
};
// Children first, as a branch scan may list them.
const resolved: ResolvedTarget[] = [B, A].flatMap((branch) => (['web', 'svc'] as const).map((repo) => ({
  repo, branch, baseBranch: 'main', prNumber: null,
})));

const started: { target: ResolvedTarget; ticket: TicketInfo | null; reviewer?: string }[] = [];
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
  startRun: (target, t, reviewer) => {
    started.push({ target, ticket: t, reviewer });
    return store.createReview({
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
  // The added text reaches every branch review, after the ticket's own text.
  assert.match(started[1]!.ticket!.body, /^Export risks\.\n\n## Added requirements and decisions\n\nDecision: CSV is enough\.$/);
  assert.equal(body.run.status, 'running');
  assert.deepEqual(body.run.review_ids, body.reviews.map((r: ReviewRow) => r.id));
  // The children's parents have no finished review yet: allowed, and said.
  assert.equal(body.notes.length, 2);
  assert.match(body.notes[0], new RegExp(`svc#${B}: its parent ${A} has no finished review yet; it is queued first`));
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
  assert.deepEqual(recomputed.at(-1), { key: 'ABC-3', opts: { trigger: 'manual', model: 'sonnet' } });
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
