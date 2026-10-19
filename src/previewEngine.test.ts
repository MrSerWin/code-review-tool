import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

/**
 * The preview engine end to end, from the request to the teardown, with a fake
 * `docker`: it answers the sandbox's GitHub calls, and every `git clone` creates
 * the clone directory and then fails, like a copy that broke halfway. Nothing
 * here reaches Docker, GitHub, or a real data directory.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-preview-engine-'));
const dataDir = path.join(root, 'data');
const recipesDir = path.join(root, 'recipes');
const clone = path.join(root, 'clones', 'test-repo');
const dockerLog = path.join(root, 'docker.log');
const FAKE_SHA = 'f'.repeat(40);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } },
  ).trim();
}

// A clone with `main` and `feat/x`, two commits ahead; `feat/gone` was never there.
fs.mkdirSync(clone, { recursive: true });
git(clone, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'initial');
git(clone, 'checkout', '-q', '-b', 'feat/x');
fs.writeFileSync(path.join(clone, 'b.txt'), 'reviewed\n');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'reviewed commit');
const reviewedSha = git(clone, 'rev-parse', 'HEAD');
fs.writeFileSync(path.join(clone, 'b.txt'), 'fixed after the review\n');
git(clone, 'commit', '-q', '-am', 'fix');
const tipSha = git(clone, 'rev-parse', 'HEAD');
git(clone, 'checkout', '-q', 'main');

function writeRecipe(name: string, repos: Record<string, string>, down: string): void {
  fs.mkdirSync(path.join(recipesDir, name), { recursive: true });
  fs.writeFileSync(path.join(recipesDir, name, 'recipe.json'), JSON.stringify({
    name,
    repos,
    ports: [{ id: 'web', internal: 3000 }],
    steps: { up: ['true'], down: [down] },
    readyTimeoutSec: 60,
  }));
}
writeRecipe('duo', { backend: 'test-repo', frontend: 'test-web' }, 'true');
// Its teardown takes a moment and counts its runs.
writeRecipe('solo', { backend: 'test-repo' }, 'sleep 1; echo down >> "$PREVIEW_DIR/down.log"');

// The fake docker: a Node script behind a shell wrapper (the sandbox passes it only PATH and HOME).
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const script = path.join(bin, 'fake-docker.mjs');
fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
let mount = null;
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === 'fake-git-image') { i++; break; }
  if (a === '-v') { mount = args[++i].replace(/:\\/work$/, ''); continue; }
  if (['-e', '-w', '--mount', '--user'].includes(a)) i++;
}
const cmd = args.slice(i);
const sha = ${JSON.stringify(FAKE_SHA)};
if (cmd[0] === 'gh' && cmd[1] === 'api') {
  process.stdout.write(JSON.stringify({ default_branch: 'main' }));
  process.exit(0);
}
if (cmd[0] === 'git' && cmd[1] === 'ls-remote') {
  process.stdout.write('ref: refs/heads/main\\tHEAD\\n' + sha + '\\trefs/heads/main\\n');
  process.exit(0);
}
if (cmd[0] === 'git' && cmd[1] === 'clone') {
  const dest = path.join(mount, cmd[cmd.length - 1].replace(/^\\/work\\/?/, ''));
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'half-copied.txt'), 'x');
  process.stderr.write('fatal: simulated failure after the clone directory was created\\n');
  process.exit(128);
}
if (cmd[0] === 'git' && cmd[1] === 'status') process.exit(0);
process.stderr.write('fake docker: unsupported ' + cmd.join(' ') + '\\n');
process.exit(1);
`);
const docker = path.join(bin, 'docker');
fs.writeFileSync(docker, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
fs.chmodSync(docker, 0o755);

// Everything explicit: the real .env must not leak in (dotenv never overrides a set variable).
Object.assign(process.env, {
  DATA_DIR: dataDir,
  ALLOWED_REPOS: 'test-repo,test-web',
  GITHUB_ORG: 'test-org',
  DOCKER_BIN: docker,
  GIT_IMAGE: 'fake-git-image',
  LOCAL_REPOS: `test-repo=${clone}`,
  LOCAL_REPOS_DIR: '',
  PREVIEW_ENABLED: '1',
  PREVIEW_RECIPES_DIR: recipesDir,
  PREVIEW_PORT_RANGE: '47100-47199',
  PREVIEW_MAX_CONCURRENT: '3',
  LOG_LEVEL: 'error',
});

const { requestPreview } = await import('./preview/engine.js');
const { previewRoutes } = await import('./routes/previews.js');
const store = await import('./preview/store.js');
const { createReview, db } = await import('./db.js');

const app = Fastify({ logger: false });
await app.register(previewRoutes);

test.after(async () => {
  await app.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const ENDED = ['ready', 'stopped', 'failed', 'expired'];

async function settled(id: number, want: string[] = ENDED, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = store.getPreview(id)?.status ?? 'missing';
    if (want.includes(status)) return status;
    if (Date.now() > deadline) throw new Error(`preview ${id} is still ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const logsOf = (id: number): string => store.getPreviewLogs(id).map((l) => l.message).join('\n');
const rolesOf = (id: number): { role: string; branch: string; sha?: string }[] =>
  JSON.parse(store.getPreview(id)?.roles_json ?? '[]');
const checkoutPath = (branch: string, id: number): string =>
  path.join(dataDir, 'checkouts', 'test-repo', branch.replace(/\//g, '__'), String(id));
const previewCheckout = (repo: string, branch: string, previewId: number): string =>
  path.join(dataDir, 'checkouts', repo, branch.replace(/\//g, '__'), String(1_000_000_000 + previewId));

/** A finished review; `checkout` leaves its checkout on disk, as a failed or running review does. */
function review(fields: {
  branch: string; source: 'github' | 'local'; headSha: string; checkout?: boolean;
}): { id: number; dir: string } {
  const row = createReview({
    repo: 'test-repo', branch: fields.branch, base_branch: 'main', status: 'done',
    source: fields.source, head_sha: fields.headSha,
  });
  const dir = checkoutPath(fields.branch, row.id);
  if (fields.checkout) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return { id: row.id, dir };
}

test('a local review whose branch is gone from the clone still previews hand-picked roles', async () => {
  const gone = review({ branch: 'feat/gone', source: 'local', headSha: reviewedSha });
  const preview = await requestPreview({
    reviewId: gone.id,
    recipe: 'duo',
    roles: [{ role: 'backend', branch: 'local:test-repo#feat/x' }, { role: 'frontend', branch: '' }],
  });
  // Accepted: the worker may already have picked it up.
  assert.ok(['queued', 'preparing'].includes(preview.status), preview.status);
  assert.equal(await settled(preview.id), 'failed');
  assert.match(store.getPreview(preview.id)?.error ?? '', /simulated failure after the clone directory was created/);

  // The copy broke after its directory existed; the teardown still removed it.
  const half = previewCheckout('test-repo', 'feat/x', preview.id);
  assert.ok(fs.readFileSync(dockerLog, 'utf8').includes(`/work/test-repo/feat__x/${1_000_000_000 + preview.id}`));
  assert.equal(fs.existsSync(half), false, `${half} must be removed by the teardown`);
});

test('a role that runs the reviewed branch with no review checkout needs the branch: a clear error', async () => {
  const gone = review({ branch: 'feat/gone', source: 'local', headSha: reviewedSha });
  const before = store.listPreviews({ limit: 500, offset: 0 }).total;
  await assert.rejects(
    requestPreview({ reviewId: gone.id, recipe: 'duo', roles: [{ role: 'frontend', branch: '' }] }),
    (err: Error) => {
      assert.match(err.message, /^Cannot run the reviewed branch for role backend: Branch feat\/gone not found in the local clone of test-repo\. /);
      assert.match(err.message, /pick a branch for role backend by hand/);
      assert.ok(!err.message.includes(root), 'the clone path must not reach the API');
      return true;
    },
  );
  assert.equal(store.listPreviews({ limit: 500, offset: 0 }).total, before, 'nothing is queued');
});

test('the review checkout on disk stands in for a reviewed branch the clone no longer has', async () => {
  const gone = review({ branch: 'feat/gone', source: 'local', headSha: reviewedSha, checkout: true });
  const preview = await requestPreview({ reviewId: gone.id, recipe: 'duo', roles: [{ role: 'frontend', branch: '' }] });
  assert.equal(await settled(preview.id), 'failed'); // the frontend fetch is the fake's failure
  assert.match(logsOf(preview.id), /Reusing the review checkout of test-repo \(feat\/gone\)/);
  assert.equal(rolesOf(preview.id)[0]?.sha, reviewedSha);
  // Borrowed, so the teardown checks it and leaves it; the frontend's own fetch is removed.
  assert.ok(fs.existsSync(path.join(gone.dir, '.git')));
  assert.equal(fs.existsSync(previewCheckout('test-web', 'main', preview.id)), false);
});

test('a local override of the reviewed branch runs its tip, not the older review checkout', async () => {
  const older = review({ branch: 'feat/x', source: 'local', headSha: reviewedSha, checkout: true });
  const preview = await requestPreview({
    reviewId: older.id,
    recipe: 'duo',
    roles: [{ role: 'backend', branch: 'local:test-repo#feat/x' }, { role: 'frontend', branch: '' }],
  });
  assert.equal(await settled(preview.id), 'failed');
  const logs = logsOf(preview.id);
  assert.doesNotMatch(logs, /Reusing the review checkout/);
  assert.match(logs, /Copying test-repo \(feat\/x\) from the local clone/);
  assert.equal(rolesOf(preview.id)[0]?.sha, tipSha, 'the role keeps the tip it was asked for');
  assert.ok(fs.existsSync(path.join(older.dir, '.git')), 'the review checkout is not the preview\'s to delete');

  // Once the review ran the tip, its checkout is reused again.
  const current = review({ branch: 'feat/x', source: 'local', headSha: tipSha, checkout: true });
  const again = await requestPreview({
    reviewId: current.id,
    recipe: 'duo',
    roles: [{ role: 'backend', branch: 'feat/x', local: true }, { role: 'frontend', branch: '' }],
  });
  assert.equal(await settled(again.id), 'failed');
  assert.match(logsOf(again.id), /Reusing the review checkout of test-repo \(feat\/x\)/);
  assert.equal(rolesOf(again.id)[0]?.sha, tipSha);
});

test('stop answers while the teardown runs; a second stop joins it', async () => {
  const reviewed = review({ branch: 'feature/plain', source: 'github', headSha: FAKE_SHA, checkout: true });
  const preview = await requestPreview({ reviewId: reviewed.id, recipe: 'solo' });
  assert.equal(await settled(preview.id), 'ready');

  const first = await app.inject({ method: 'POST', url: `/api/previews/${preview.id}/stop` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().preview.status, 'stopping', 'the answer must not wait for `down`');
  const second = await app.inject({ method: 'POST', url: `/api/previews/${preview.id}/stop` });
  assert.equal(second.json().preview.status, 'stopping');
  const polled = await app.inject({ method: 'GET', url: `/api/previews/${preview.id}` });
  assert.equal(polled.json().preview.status, 'stopping');
  const { url, links } = polled.json().preview;
  assert.deepEqual(links, [{ label: 'web', url, port_id: 'web', primary: true }]);

  assert.equal(await settled(preview.id, ['stopped', 'failed']), 'stopped');
  const downLog = path.join(dataDir, 'previews', String(preview.id), 'down.log');
  assert.equal(fs.readFileSync(downLog, 'utf8'), 'down\n', '`down` runs once');
  assert.match(logsOf(preview.id), /Reviewed checkout is unchanged/);

  const ended = await app.inject({ method: 'POST', url: `/api/previews/${preview.id}/stop` });
  assert.equal(ended.json().preview.status, 'stopped', 'an ended preview is left as it is');
});

test('the API derives links from the recipe, and one per allocated port when the recipe is gone', async () => {
  const dir = path.join(recipesDir, 'linked');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify({
    name: 'linked',
    repos: { backend: 'test-repo' },
    ports: [
      { id: 'db', internal: 5432, link: false },
      { id: 'api', internal: 8000, label: 'Backend API', links: [{ label: 'Admin', path: '/admin/' }] },
      { id: 'web', internal: 3000, primary: true, label: 'Web app' },
    ],
    steps: { up: ['true'], down: ['true'] },
  }));
  try {
    const ports = JSON.stringify({ db: 47900, api: 47901, web: 47902 });
    const linked = store.createPreview({ recipe: 'linked', ports_json: ports, url: 'http://127.0.0.1:47902', status: 'stopped' });
    const orphan = store.createPreview({ recipe: 'gone', ports_json: ports, url: 'http://127.0.0.1:47902', status: 'stopped' });

    const one = await app.inject({ method: 'GET', url: `/api/previews/${linked.id}` });
    assert.deepEqual(one.json().preview.links, [
      { label: 'Web app', url: 'http://127.0.0.1:47902', port_id: 'web', primary: true },
      { label: 'Admin', url: 'http://127.0.0.1:47901/admin/', port_id: 'api', primary: false },
    ]);

    const list = await app.inject({ method: 'GET', url: '/api/previews?limit=500' });
    const byId = new Map(list.json().previews.map((p: { id: number }) => [p.id, p]));
    assert.deepEqual((byId.get(linked.id) as { links: unknown }).links, one.json().preview.links);
    assert.deepEqual((byId.get(orphan.id) as { links: unknown }).links, [
      { label: 'web', url: 'http://127.0.0.1:47902', port_id: 'web', primary: true },
      { label: 'db', url: 'http://127.0.0.1:47900', port_id: 'db', primary: false },
      { label: 'api', url: 'http://127.0.0.1:47901', port_id: 'api', primary: false },
    ]);

    const recipes = await app.inject({ method: 'GET', url: '/api/recipes' });
    const recipe = recipes.json().recipes.find((r: { name: string }) => r.name === 'linked');
    assert.deepEqual(recipe.ports.map((p: { label: string }) => p.label), ['db', 'Backend API', 'Web app']);
    assert.deepEqual(recipe.ports.map((p: { link: boolean }) => p.link), [false, true, true]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
