import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

/**
 * The ticket preview plan: per recipe role, the tip of its repo's chain in the
 * ticket group, local when the tip's latest review was local, the base branch
 * for a repo the group never touched; and a live preview that runs it already.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-ticket-plan-'));
const recipesDir = path.join(root, 'recipes');
const soloDir = path.join(root, 'recipes-solo');

function writeRecipe(dir: string, name: string, repos: Record<string, string>): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'recipe.json'), JSON.stringify({
    name, repos, ports: [{ id: 'web', internal: 3000 }], steps: { up: ['true'], down: ['true'] }, readyTimeoutSec: 60,
  }));
}
writeRecipe(recipesDir, 'stack', { backend: 'svc', frontend: 'web', worker: 'jobs' });
writeRecipe(recipesDir, 'api', { backend: 'svc' });
writeRecipe(soloDir, 'only', { backend: 'svc', frontend: 'web' });

Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'),
  ALLOWED_REPOS: 'svc,web,jobs',
  GITHUB_ORG: 'test-org',
  LOCAL_REPOS: '',
  LOCAL_REPOS_DIR: '',
  PREVIEW_ENABLED: '1',
  PREVIEW_RECIPES_DIR: recipesDir,
  LOG_LEVEL: 'error',
});

const { loadRecipes } = await import('./preview/recipes.js');
const { createReview, db } = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const previewStore = await import('./preview/store.js');
const {
  livePreviewsFor, planRequestRoles, planTicketRoles, runsPlan, ticketPreviewPlan,
} = await import('./preview/ticketPlan.js');
type TicketPlanRole = import('./preview/ticketPlan.js').TicketPlanRole;
const { previewRoutes } = await import('./routes/previews.js');

const defaultCalls: string[] = [];
const planDeps = {
  defaultBranch: async (repo: string) => {
    defaultCalls.push(repo);
    if (repo === 'broken') throw new Error('GitHub down');
    return repo === 'jobs' ? 'develop' : 'main';
  },
};

const app = Fastify({ logger: false });
await app.register(previewRoutes, { planDeps });

test.after(async () => {
  await app.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const KEY = 'ABC-7';

/** svc: main -> a -> b -> c; web: main -> ui (reviewed locally last); jobs: none. */
function seedGroup(): void {
  ticketStore.upsertTicketGroup(KEY, { title: 'Export' });
  for (const [repo, branch, parent] of [
    ['svc', 'feat/abc-7-c', 'feat/abc-7-b'],
    ['svc', 'feat/abc-7-a', 'main'],
    ['svc', 'feat/abc-7-b', 'feat/abc-7-a'],
    ['web', 'feat/abc-7-ui', 'main'],
  ] as const) {
    ticketStore.upsertTicketBranch(KEY, { repo, branch, source: 'github', prNumber: null });
    ticketStore.setTicketBranchParent(KEY, repo, branch, parent, parent === 'main' ? 'default' : 'detected', {
      defaultBranch: 'main',
    });
  }
  ticketStore.renumberPositions(KEY);
  createReview({
    ticket_key: KEY, repo: 'web', branch: 'feat/abc-7-ui', base_branch: 'main', status: 'done', source: 'github',
  });
  createReview({
    ticket_key: KEY, repo: 'web', branch: 'feat/abc-7-ui', base_branch: 'main', status: 'done', source: 'local',
  });
  createReview({
    ticket_key: KEY, repo: 'svc', branch: 'feat/abc-7-c', base_branch: 'feat/abc-7-b', status: 'done', source: 'github',
  });
}
seedGroup();

const member = (branch: string, parent: string | null, extra: Record<string, unknown> = {}) => ({
  branch, parent_branch: parent, default_branch: 'main', position: 0, source: 'github' as const, ...extra,
});

test('planTicketRoles: chain tip, its base, local from the latest review, base branch for a missing repo', () => {
  const { roles, notes } = planTicketRoles({
    recipeRepos: { backend: 'svc', frontend: 'web', worker: 'jobs' },
    chains: {
      svc: [member('a', 'release'), member('b', 'a'), member('c', 'b')],
      web: [member('ui', 'main', { source: 'github', latestSource: 'local' })],
    },
    defaultBranches: { jobs: 'develop' },
  });
  assert.deepEqual(notes, []);
  assert.deepEqual(roles, [
    { role: 'backend', repo: 'svc', branch: 'c', base: 'release', defaultBranch: 'main', usedBase: false, source: 'github', chain: ['a', 'b', 'c'] },
    { role: 'frontend', repo: 'web', branch: 'ui', base: 'main', defaultBranch: 'main', usedBase: false, source: 'local', chain: ['ui'] },
    { role: 'worker', repo: 'jobs', branch: 'develop', base: 'develop', defaultBranch: 'develop', usedBase: true, source: 'github', chain: [] },
  ]);
  assert.deepEqual(planRequestRoles(roles), [
    { role: 'backend', branch: 'c', base: 'release' },
    { role: 'frontend', branch: 'ui', local: true },
    { role: 'worker' },
  ]);
});

test('planTicketRoles: a member source counts when the branch has no review; a forked chain is noted', () => {
  const { roles, notes } = planTicketRoles({
    recipeRepos: { backend: 'svc' },
    chains: { svc: [member('a', 'main'), member('b', 'a'), member('c', 'a', { source: 'local', latestSource: null })] },
    defaultBranches: {},
  });
  assert.equal(roles[0]!.branch, 'c');
  assert.equal(roles[0]!.source, 'local');
  assert.equal(roles[0]!.base, 'main');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /svc: the branches do not stack into one line; c/);
});

test('planTicketRoles: an unknown default branch is an error', () => {
  assert.throws(
    () => planTicketRoles({ recipeRepos: { backend: 'svc' }, chains: {}, defaultBranches: {} }),
    /default branch of svc is unknown/,
  );
});

const planned: TicketPlanRole[] = [
  { role: 'backend', repo: 'svc', branch: 'c', base: 'main', defaultBranch: 'main', usedBase: false, source: 'github', chain: ['c'] },
  { role: 'worker', repo: 'jobs', branch: 'develop', base: 'develop', defaultBranch: 'develop', usedBase: true, source: 'github', chain: [] },
];

test('runsPlan / livePreviewsFor: same branches and sources only, newest openable first', () => {
  const same = JSON.stringify([
    { role: 'backend', repo: 'svc', branch: 'c', base: 'main', usedBase: false },
    { role: 'worker', repo: 'jobs', branch: 'develop', base: 'develop', usedBase: true },
  ]);
  const local = JSON.stringify([
    { role: 'backend', repo: 'svc', branch: 'c', base: 'main', usedBase: false, source: 'local' },
    { role: 'worker', repo: 'jobs', branch: 'develop', base: 'develop', usedBase: true },
  ]);
  assert.equal(runsPlan({ roles_json: same }, planned), true);
  assert.equal(runsPlan({ roles_json: local }, planned), false);
  assert.equal(runsPlan({ roles_json: 'not json' }, planned), false);
  const row = (id: number, status: string, roles_json: string, recipe = 'stack') =>
    ({ id, status, roles_json, recipe }) as unknown as import('./types.js').PreviewRow;
  const { match, others } = livePreviewsFor(
    [row(1, 'ready', same), row(2, 'stopped', same), row(3, 'starting', same), row(4, 'ready', local), row(5, 'ready', same, 'api')],
    'stack',
    planned,
  );
  assert.equal(match?.id, 3);
  assert.deepEqual(others.map((r) => r.id), [5, 4, 1]);
});

test('ticketPreviewPlan: reads the stored group; several recipes need a name', async () => {
  await assert.rejects(ticketPreviewPlan(KEY, undefined, planDeps), /Several recipes are configured; name one of: /);
  await assert.rejects(ticketPreviewPlan(KEY, 'nope', planDeps), /Unknown recipe "nope"/);
  await assert.rejects(ticketPreviewPlan('NOPE-1', 'stack', planDeps), (err: Error & { status?: number }) => err.status === 404);

  defaultCalls.length = 0;
  const plan = await ticketPreviewPlan(KEY, 'stack', planDeps);
  // Only the repo without members asks GitHub.
  assert.deepEqual(defaultCalls, ['jobs']);
  assert.deepEqual(plan.roles.map((r) => [r.role, r.branch, r.source, r.usedBase]), [
    ['backend', 'feat/abc-7-c', 'github', false],
    ['frontend', 'feat/abc-7-ui', 'local', false],
    ['worker', 'develop', 'github', true],
  ]);
  assert.deepEqual(plan.roles[0]!.chain, ['feat/abc-7-a', 'feat/abc-7-b', 'feat/abc-7-c']);
  assert.deepEqual(plan.request, {
    ticket: KEY,
    recipe: 'stack',
    roles: [
      { role: 'backend', branch: 'feat/abc-7-c' },
      { role: 'frontend', branch: 'feat/abc-7-ui', local: true },
      { role: 'worker' },
    ],
  });
  assert.equal(plan.livePreview, null);
});

test('ticketPreviewPlan: the only recipe is used without a name', async () => {
  const plan = await ticketPreviewPlan(KEY, undefined, { ...planDeps, recipes: () => loadRecipes(soloDir).recipes });
  assert.equal(plan.recipe, 'only');
  assert.deepEqual(plan.roles.map((r) => r.role), ['backend', 'frontend']);
});

test('GET /api/ticket-groups/:key/preview-plan: plan, live preview, errors', async () => {
  const roles = [
    { role: 'backend', repo: 'svc', branch: 'feat/abc-7-c', base: 'main', usedBase: false },
    { role: 'frontend', repo: 'web', branch: 'feat/abc-7-ui', base: 'main', usedBase: false, source: 'local' },
    { role: 'worker', repo: 'jobs', branch: 'develop', base: 'develop', usedBase: true },
  ];
  const live = previewStore.createPreview({
    recipe: 'stack', ticket_key: KEY, roles_json: JSON.stringify(roles), ports_json: '{}', status: 'ready',
  });
  const other = previewStore.createPreview({
    recipe: 'stack', ticket_key: KEY, roles_json: JSON.stringify(roles.slice(0, 2)), ports_json: '{}', status: 'queued',
  });
  previewStore.createPreview({
    recipe: 'stack', ticket_key: KEY, roles_json: JSON.stringify(roles), ports_json: '{}', status: 'stopped',
  });

  const res = await app.inject({ method: 'GET', url: `/api/ticket-groups/${KEY}/preview-plan?recipe=stack` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ticket, KEY);
  assert.equal(body.recipe, 'stack');
  assert.equal(body.roles.length, 3);
  assert.equal(body.live_preview.id, live.id);
  assert.equal(body.live_preview.roles[1].source, 'local');
  assert.deepEqual(body.other_live.map((p: { id: number }) => p.id), [other.id]);
  assert.deepEqual(body.request.roles[2], { role: 'worker' });

  const several = await app.inject({ method: 'GET', url: `/api/ticket-groups/${KEY}/preview-plan` });
  assert.equal(several.statusCode, 400);
  assert.match(several.json().error, /Several recipes/);
  const missing = await app.inject({ method: 'GET', url: '/api/ticket-groups/NOPE-2/preview-plan?recipe=stack' });
  assert.equal(missing.statusCode, 404);
  const unknown = await app.inject({ method: 'GET', url: `/api/ticket-groups/${KEY}/preview-plan?recipe=nope` });
  assert.equal(unknown.statusCode, 400);
});
