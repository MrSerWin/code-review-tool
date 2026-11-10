import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeChangedFiles } from './changedFiles.js';
import { parseChecksConfig } from './checks/config.js';
import { globToRegExp } from './checks/glob.js';
import { parseAddedLines } from './checks/git.js';
import { renderToolChecks, runToolChecks, type CheckContext } from './checks/index.js';
import { buildCheckContext, type SourceDeps } from './checks/sources.js';
import { git } from './testGit.js';
import type { CheckoutResult } from './types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-checks-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let repoCount = 0;

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/** A repository with a base commit on main, then a `feat` branch with `head` applied. */
function makeRepo(base: Record<string, string>, head: Record<string, string | null>, opts: { authorEmail?: string; message?: string } = {}) {
  repoCount += 1;
  const dir = path.join(root, `repo${repoCount}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(base)) write(dir, f, t);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  const baseSha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'feat');
  for (const [f, t] of Object.entries(head)) {
    if (t === null) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    else write(dir, f, t);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', opts.message ?? 'change');
  if (opts.authorEmail) git(dir, 'commit', '-q', '--amend', '--no-edit', `--author=x <${opts.authorEmail}>`);
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();
  return { dir, baseSha, headSha, ctx: contextFor(dir, baseSha, headSha) };
}

function contextFor(dir: string, baseSha: string, headSha: string, extra: Partial<CheckContext> = {}): CheckContext {
  const changedFiles = mergeChangedFiles(
    git(dir, 'diff', '--name-status', '-z', '-M', `${baseSha}..${headSha}`),
    git(dir, 'diff', '--numstat', '-z', '-M', `${baseSha}..${headSha}`),
  );
  return {
    repo: 'test-repo', checkoutDir: dir, baseSha, headSha, changedFiles,
    baseTip: null, defaultBranch: null, siblings: [], syntheticCommits: [], ...extra,
  };
}

const MIGRATIONS = ['apps/*/migrations/[0-9][0-9][0-9][0-9]_*.py'];
const noLog = () => {};

// --- glob ------------------------------------------------------------------------

test('globToRegExp: path, basename, directory, ** and class patterns', () => {
  const m = (p: string, f: string) => globToRegExp(p).test(f);
  assert.ok(m(MIGRATIONS[0]!, 'apps/core/migrations/0042_add.py'));
  assert.ok(!m(MIGRATIONS[0]!, 'apps/core/migrations/42_add.py'));
  assert.ok(!m(MIGRATIONS[0]!, 'apps/core/sub/migrations/0042_add.py'));
  assert.ok(m('apps/**/serializers*.py', 'apps/x/serializers.py'));
  assert.ok(m('apps/**/serializers*.py', 'apps/x/y/serializers_v2.py'));
  assert.ok(m('src/**/*.tsx', 'src/A.tsx'));
  assert.ok(m('src/**/*.tsx', 'src/Screens/X/A.tsx'));
  assert.ok(!m('src/**/*.tsx', 'src/A.ts'));
  assert.ok(m('apps/docs/content/**', 'apps/docs/content/a/b.md'));
  assert.ok(m('*.pyc', 'a/b/c.pyc'));
  assert.ok(m('.DS_Store', 'x/.DS_Store'));
  assert.ok(!m('.env', 'x/.env.example'));
  assert.ok(m('.venv/', '.venv'));
  assert.ok(m('.venv/', 'backend/.venv/bin/python'));
  assert.ok(!m('venv/', 'myvenv/x'));
  assert.ok(m('{a,b}/*.md', 'b/x.md'));
});

test('parseAddedLines numbers added lines from -U0 hunks', () => {
  const diff = [
    'diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md',
    '@@ -1,0 +2,2 @@', '+one', '+two', '@@ -9 +11 @@', '-old', '+new',
    'diff --git a/gone.md b/gone.md', '--- a/gone.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff).get('x.md'), [
    { line: 2, text: 'one' }, { line: 3, text: 'two' }, { line: 11, text: 'new' },
  ]);
  assert.equal(parseAddedLines(diff).has('gone.md'), false);
});

// --- config ------------------------------------------------------------------------

test('parseChecksConfig: defaults, toggles, and rejected keys', () => {
  const c = parseChecksConfig({ checks: { 'diff-size': true, 'forbidden-paths': {}, 'migration-collision': false } });
  assert.equal(c.checks['diff-size']!.maxFiles, 40);
  assert.deepEqual(c.checks['forbidden-paths']!.blockerPatterns, ['.venv/', 'venv/', '.env']);
  assert.equal(c.checks['migration-collision'], null);
  assert.equal(c.checks['em-dash'], null);
  assert.throws(() => parseChecksConfig({ checks: { 'em-dash': true } }), /em-dash\.globs/);
  assert.deepEqual(parseChecksConfig({ checks: { 'em-dash': { globs: ['x/**'] } } }).checks['em-dash']!.excludeGlobs,
    ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**', '**/test_*.py']);
  assert.throws(() => parseChecksConfig({ checks: { 'commit-identity': {} } }), /needs allowedEmails or allowedDomains/);
  assert.deepEqual(parseChecksConfig({ checks: { 'commit-identity': { allowedDomains: ['a.com'] } } }).checks['commit-identity'],
    { allowedEmails: [], allowedDomains: ['a.com'] });
  assert.throws(() => parseChecksConfig({ checks: { 'migration-colision': true } }), /Unrecognized key/);
});

// --- migration-collision -----------------------------------------------------------

test('migration-collision: a number already used on the base commit', async () => {
  const r = makeRepo(
    { 'apps/core/migrations/0001_initial.py': 'x\n', 'apps/core/migrations/0002_a.py': 'x\n' },
    { 'apps/core/migrations/0002_b.py': 'x\n', 'apps/other/migrations/0002_b.py': 'x\n' },
  );
  const run = await runToolChecks(r.ctx, parseChecksConfig({ checks: { 'migration-collision': true } }), noLog);
  assert.equal(run.findings.length, 1);
  const f = run.findings[0]!;
  assert.equal(f.severity, 'major');
  assert.equal(f.lens, 'tool');
  assert.equal(f.kind, 'diff');
  assert.equal(f.file, 'apps/core/migrations/0002_b.py');
  assert.match(f.problem, /apps\/core\/migrations\/0002_a\.py.*the base commit/);
  assert.match(f.title, /^migration-collision: /);
});

test('migration-collision: the default branch tip and a sibling branch, but not the same file in a child slice', async () => {
  const r = makeRepo({ 'apps/core/migrations/0001_initial.py': 'x\n' }, { 'apps/core/migrations/0002_mine.py': 'x\n' });
  // main moves on with its own 0002; a sibling branch has a 0003 and our 0002; a child slice carries our file.
  git(r.dir, 'checkout', '-q', 'main');
  write(r.dir, 'apps/core/migrations/0002_main.py', 'x\n');
  git(r.dir, 'add', '-A');
  git(r.dir, 'commit', '-q', '-m', 'main 0002');
  git(r.dir, 'checkout', '-q', '-b', 'child', 'feat');
  write(r.dir, 'apps/core/migrations/0003_child.py', 'x\n');
  git(r.dir, 'add', '-A');
  git(r.dir, 'commit', '-q', '-m', 'child');
  git(r.dir, 'checkout', '-q', '-b', 'sibling', r.baseSha);
  write(r.dir, 'apps/core/migrations/0002_sibling.py', 'x\n');
  git(r.dir, 'add', '-A');
  git(r.dir, 'commit', '-q', '-m', 'sibling');
  git(r.dir, 'checkout', '-q', 'feat');

  const ctx: CheckContext = {
    ...r.ctx,
    defaultBranch: { label: 'main as last fetched', dir: r.dir, ref: 'refs/heads/main' },
    siblings: [
      { repo: 'test-repo', branch: 'child', tree: { label: 'sibling branch child', dir: r.dir, ref: 'refs/heads/child' } },
      { repo: 'test-repo', branch: 'sibling', tree: { label: 'sibling branch sibling', dir: r.dir, ref: 'refs/heads/sibling' } },
      { repo: 'other-repo', branch: 'x', tree: { label: 'other repo', dir: r.dir, ref: 'refs/heads/main' } },
      { repo: 'test-repo', branch: 'gone', tree: { label: 'unreadable', dir: r.dir, ref: 'refs/heads/nope' } },
    ],
  };
  const logs: string[] = [];
  const run = await runToolChecks(ctx, parseChecksConfig({ checks: { 'migration-collision': true } }), (_l, m) => logs.push(m));
  assert.equal(run.findings.length, 1);
  const { problem } = run.findings[0]!;
  assert.match(problem, /0002_main\.py` \(on main as last fetched\)/);
  assert.match(problem, /0002_sibling\.py` \(on sibling branch sibling\)/);
  assert.doesNotMatch(problem, /child|other repo/);
  assert.ok(logs.some((l) => /could not read unreadable/.test(l)));
});

test('migration-collision: no finding without a clash', async () => {
  const r = makeRepo({ 'apps/core/migrations/0001_initial.py': 'x\n' }, { 'apps/core/migrations/0002_mine.py': 'x\n' });
  const run = await runToolChecks(r.ctx, parseChecksConfig({ checks: { 'migration-collision': true } }), noLog);
  assert.deepEqual(run.findings, []);
  assert.deepEqual(run.ran, ['migration-collision']);
});

// --- data-migration-idempotence ----------------------------------------------------

test('data-migration-idempotence: flags an unguarded create in RunPython, not a guarded one', async () => {
  const unguarded = 'def seed(apps, s):\n    T = apps.get_model("x", "T")\n    T.objects.create(name="a")\n\nops = [migrations.RunPython(seed)]\n';
  const guarded = 'def seed(apps, s):\n    T = apps.get_model("x", "T")\n    T.objects.get_or_create(name="a")\n\nops = [migrations.RunPython(seed)]\n';
  const schema = 'ops = [migrations.CreateModel(name="T")]\n';
  const r = makeRepo({}, {
    'apps/x/migrations/0002_seed.py': unguarded,
    'apps/x/migrations/0003_seed_ok.py': guarded,
    'apps/x/migrations/0004_schema.py': schema,
  });
  const run = await runToolChecks(r.ctx, parseChecksConfig({ checks: { 'data-migration-idempotence': true } }), noLog);
  assert.equal(run.findings.length, 0);
  assert.equal(run.observations.length, 1);
  assert.equal(run.observations[0]!.file, 'apps/x/migrations/0002_seed.py');
  assert.equal(run.observations[0]!.line, 1);
  assert.equal(run.observations[0]!.lens, 'tool');
  assert.match(run.observations[0]!.note, /idempotent against a database that already holds this data/);
});

// --- em-dash -----------------------------------------------------------------------

test('em-dash: test files are excluded by default; explicit excludeGlobs replace the defaults', async () => {
  const dash = 'a \u2014 b\n';
  const r = makeRepo({}, {
    'src/A.tsx': dash, 'src/A.test.tsx': dash, 'src/B.spec.tsx': dash, 'src/__tests__/C.tsx': dash,
    'apps/x/tests/d.py': dash, 'apps/x/test_e.py': dash, 'apps/x/serializers.py': dash,
  });
  const files = async (checks: unknown) =>
    (await runToolChecks(r.ctx, parseChecksConfig({ checks }), noLog)).findings.map((f) => f.file).sort();
  assert.deepEqual(await files({ 'em-dash': { globs: ['src/**', 'apps/**'] } }), ['apps/x/serializers.py', 'src/A.tsx']);
  assert.deepEqual(await files({ 'em-dash': { globs: ['src/**'], excludeGlobs: ['**/*.spec.*'] } }),
    ['src/A.test.tsx', 'src/A.tsx', 'src/__tests__/C.tsx']);
  assert.equal((await files({ 'em-dash': { globs: ['src/**', 'apps/**'], excludeGlobs: [] } })).length, 7);
});

test('em-dash: added lines of user-facing files only, tests excluded, one finding per file', async () => {
  const r = makeRepo(
    { 'docs/content/a.md': 'old \u2014 line\n', 'docs/content/b.md': 'b\n' },
    {
      'docs/content/a.md': 'old \u2014 line\nnew line\n',
      'docs/content/b.md': 'b\nfirst \u2014 x \u2014 y\nok\nsecond \u2014 z\n',
      'docs/content/tests/c.md': 'c \u2014\n',
      'src/code.py': 'x = "\u2014"\n',
    },
  );
  const cfg = parseChecksConfig({ checks: { 'em-dash': { globs: ['docs/content/**'] } } });
  const run = await runToolChecks(r.ctx, cfg, noLog);
  assert.equal(run.findings.length, 1);
  const f = run.findings[0]!;
  assert.equal(f.file, 'docs/content/b.md');
  assert.equal(f.line, 2);
  assert.equal(f.severity, 'minor');
  assert.match(f.title, /\(3\)/);
  assert.match(f.problem, /lines 2, 4/);
});

// --- forbidden-paths -----------------------------------------------------------------

test('forbidden-paths: env and venv are blockers, other patterns and large files major', async () => {
  const r = makeRepo({ 'README.md': 'x\n' }, {
    '.env': 'SECRET=1\n',
    'svc/.venv/bin/python': 'x\n',
    'pkg/__pycache__/m.cpython-311.pyc': 'x\n',
    'big.bin': 'x'.repeat(2048),
    '.env.example': 'SECRET=\n',
  });
  const cfg = parseChecksConfig({ checks: { 'forbidden-paths': { maxFileBytes: 1024 } } });
  const run = await runToolChecks(r.ctx, cfg, noLog);
  const by = (re: RegExp) => run.findings.find((f) => re.test(f.title));
  assert.equal(by(/`\.env`/)!.severity, 'blocker');
  assert.equal(by(/`\.env`/)!.file, '.env');
  assert.equal(by(/`\.venv\/`/)!.severity, 'blocker');
  assert.equal(by(/__pycache__/)!.severity, 'major');
  assert.equal(by(/Large file/)!.file, 'big.bin');
  assert.equal(run.findings.length, 4, run.findings.map((f) => f.title).join('\n'));
});

// --- commit-identity -----------------------------------------------------------------

test('commit-identity: wrong author and AI trailers, synthetic commits skipped', async () => {
  const r = makeRepo({}, { 'a.txt': 'a\n' }, {
    authorEmail: 'someone@else.invalid',
    message: 'Change a\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>',
  });
  const cfg = parseChecksConfig({ checks: { 'commit-identity': { allowedEmails: ['dev@example.invalid'] } } });
  const run = await runToolChecks(r.ctx, cfg, noLog);
  assert.equal(run.findings.length, 2);
  assert.ok(run.findings.every((f) => f.severity === 'minor' && f.file === null));
  assert.match(run.findings[0]!.problem, new RegExp(r.headSha.slice(0, 9)));
  assert.match(run.findings[0]!.problem, /someone@else\.invalid/);
  assert.match(run.findings[1]!.title, /AI attribution/);

  const skipped = await runToolChecks({ ...r.ctx, syntheticCommits: [r.headSha] }, cfg, noLog);
  assert.deepEqual(skipped.findings, []);

  const ok = makeRepo({}, { 'b.txt': 'b\n' }, { authorEmail: 'Dev@Example.invalid' });
  assert.deepEqual((await runToolChecks(ok.ctx, cfg, noLog)).findings, []);
});

test('commit-identity: an allowed domain passes a teammate, case-insensitive; a personal address still fails', async () => {
  const cfg = parseChecksConfig({
    checks: { 'commit-identity': { allowedEmails: ['me@work.invalid'], allowedDomains: ['work.invalid', '@Team.Invalid'] } },
  });
  const teammate = makeRepo({}, { 'a.txt': 'a\n' }, { authorEmail: 'Colleague@TEAM.invalid' });
  assert.deepEqual((await runToolChecks(teammate.ctx, cfg, noLog)).findings, []);
  const sameDomain = makeRepo({}, { 'a.txt': 'a\n' }, { authorEmail: 'other@work.invalid' });
  assert.deepEqual((await runToolChecks(sameDomain.ctx, cfg, noLog)).findings, []);
  const personal = makeRepo({}, { 'a.txt': 'a\n' }, { authorEmail: 'me@gmail.invalid' });
  const [f] = (await runToolChecks(personal.ctx, cfg, noLog)).findings;
  assert.match(f!.problem, /me@gmail\.invalid.*\(me@work\.invalid, @work\.invalid, @Team\.Invalid\)/);
  // A subdomain is not the domain.
  const sub = makeRepo({}, { 'a.txt': 'a\n' }, { authorEmail: 'x@evil.work.invalid' });
  assert.equal((await runToolChecks(sub.ctx, cfg, noLog)).findings.length, 1);
});

// --- doc-update-heuristic and diff-size --------------------------------------------

test('doc-update-heuristic: an observation only when behaviour changed without a doc', async () => {
  const cfg = parseChecksConfig({
    checks: { 'doc-update-heuristic': { behaviourGlobs: ['apps/*/views*.py'], docGlobs: ['apps/docs/content/**'] } },
  });
  const noDoc = makeRepo({}, { 'apps/x/views.py': 'v\n' });
  const run = await runToolChecks(noDoc.ctx, cfg, noLog);
  assert.equal(run.findings.length, 0);
  assert.equal(run.observations.length, 1);
  assert.equal(run.observations[0]!.file, null);
  assert.match(run.observations[0]!.note, /apps\/x\/views\.py/);

  const withDoc = makeRepo({}, { 'apps/x/views.py': 'v\n', 'apps/docs/content/x.md': 'd\n' });
  assert.deepEqual((await runToolChecks(withDoc.ctx, cfg, noLog)).observations, []);
});

test('diff-size: an observation above the limit', async () => {
  const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.txt`, `${i}\n`]));
  const r = makeRepo({}, files);
  const over = await runToolChecks(r.ctx, parseChecksConfig({ checks: { 'diff-size': { maxFiles: 3 } } }), noLog);
  assert.match(over.observations[0]!.note, /^diff-size: This branch changes 4 files \(limit 3\)\. Consider splitting/);
  const under = await runToolChecks(r.ctx, parseChecksConfig({ checks: { 'diff-size': { maxFiles: 4 } } }), noLog);
  assert.deepEqual(under.observations, []);
});

// --- framework ---------------------------------------------------------------------

test('runToolChecks: a failing check is logged and skipped, the others still run', async () => {
  const r = makeRepo({}, { 'a.txt': 'a\n' });
  const logs: string[] = [];
  const run = await runToolChecks(
    { ...r.ctx, baseSha: 'f'.repeat(40) },
    parseChecksConfig({ checks: { 'commit-identity': { allowedEmails: ['x@y.z'] }, 'diff-size': { maxFiles: 1 } } }),
    (_l, m) => logs.push(m),
  );
  assert.deepEqual(run.failed.map((f) => f.id), ['commit-identity']);
  assert.deepEqual(run.ran, ['diff-size']);
  assert.ok(logs.some((l) => /tool check commit-identity: failed, skipped/.test(l)));
});

test('renderToolChecks lists findings and observations, and is empty when nothing ran', () => {
  assert.equal(renderToolChecks({ ran: [], failed: [], findings: [], observations: [] }), '');
  const text = renderToolChecks({
    ran: ['migration-collision', 'diff-size'],
    failed: [],
    findings: [{
      severity: 'major', category: 'correctness', file: 'apps/x/migrations/0002_a.py', line: 1, end_line: null,
      title: 'migration-collision: Migration number 0002 is already taken', problem: 'Clash.', why: '', suggestion: '',
      snippet: null, kind: 'diff', cause_file: null, cause_line: null, hunk: null, lens: 'tool',
    }],
    observations: [{ file: null, line: null, note: 'diff-size: big', rationale: '', lens: 'tool' }],
  });
  assert.match(text, /^# Tool checks \(deterministic, already verified\)/);
  assert.match(text, /Do NOT copy them/);
  assert.match(text, /- \[MAJOR\] migration-collision: .* \(apps\/x\/migrations\/0002_a\.py:1\): Clash\./);
  assert.match(text, /- \(no location\) diff-size: big/);
});

// --- sources -------------------------------------------------------------------------

test('buildCheckContext: base tip, default branch and siblings from review checkouts or the local clone', async () => {
  const clone = path.join(root, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  write(clone, 'a.txt', 'a\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'branch', 'feat/local-sibling');

  const checkoutDirOnDisk = path.join(root, 'data-checkouts');
  const deps: SourceDeps = {
    latestReviewId: (_key, _repo, branch) => (branch === 'feat/reviewed' ? 7 : null),
    localClone: async (repo) => (repo === 'test-repo' ? clone : null),
  };
  const checkout: CheckoutResult = {
    dir: checkoutDirOnDisk, headSha: 'h', baseSha: 'b', baseTipSha: 't', filesChanged: 0, additions: 0, deletions: 0,
    changedFiles: [], workingTreeSnapshot: { sha: 'snap', files: 1 },
  };
  const ctx = await buildCheckContext(
    { repo: 'test-repo', branch: 'feat/self', base_branch: 'main', group_key: 'ABC-1' },
    checkout,
    [],
    [
      { repo: 'test-repo', branch: 'feat/self' },
      { repo: 'test-repo', branch: 'feat/local-sibling' },
      { repo: 'test-repo', branch: 'feat/reviewed' },
      { repo: 'other-repo', branch: 'feat/x' },
    ],
    deps,
  );
  assert.deepEqual(ctx.baseTip, { label: 'the main tip', dir: checkoutDirOnDisk, ref: 't' });
  assert.deepEqual(ctx.defaultBranch, { label: 'main as last fetched in the local clone', dir: clone, ref: 'refs/heads/main' });
  assert.deepEqual(ctx.syntheticCommits, ['snap']);
  assert.deepEqual(ctx.siblings.map((s) => [s.branch, s.tree?.ref ?? null]), [
    ['feat/local-sibling', 'refs/heads/feat/local-sibling'],
    // Its review checkout is not on disk, and the clone has no such branch.
    ['feat/reviewed', null],
  ]);
});
