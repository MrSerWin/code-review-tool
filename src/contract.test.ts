import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewerDefinition } from './reviewers/types.js';
import { git } from './testGit.js';

/**
 * The cross-repository contract check: contract globs, the hunks read from a
 * branch checkout and their cap, issue anchoring, and a coverage pass over a
 * backend and a frontend branch with a stand-in reviewer.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-contract-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'api,web';

const store = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const contract = await import('./contract.js');
const { parseChecksConfig } = await import('./checks/config.js');
const coverage = await import('./coverage.js');
const { checkoutDir } = await import('./gitSandbox.js');
const { liveReviewerGroups } = await import('./reviewRunner.js');

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Host git in a test checkout, standing in for the sandbox. */
const hostDiff = async (dir: string, args: string[]) => git(dir, ...args);

function write(dir: string, file: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

/** A checkout with a base commit and a branch commit; returns both shas. */
function makeCheckout(dir: string, base: Record<string, string>, head: Record<string, string>): { base: string; head: string } {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, b] of Object.entries(base)) write(dir, f, b);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const baseSha = git(dir, 'rev-parse', 'HEAD').trim();
  for (const [f, b] of Object.entries(head)) write(dir, f, b);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'branch');
  return { base: baseSha, head: git(dir, 'rev-parse', 'HEAD').trim() };
}

const fileRow = (p: string, status = 'M') => ({ review_id: 0, path: p, status, old_path: null, additions: 1, deletions: 1, ord: 0 });

test('default globs match backend and frontend contract files, not tests', () => {
  const files = [
    'apps/risk/serializers.py', 'apps/compliance/ato_serializers.py', 'apps/compliance/hub_views.py', 'apps/risk/urls.py',
    'config/schemas_v2.py', 'apps/risk/models.py', 'apps/risk/tests/test_views.py', 'apps/risk/test_views.py',
    'src/Services/RiskService.ts', 'src/Services/http/client.ts', 'src/Models/IncidentModel.ts', 'src/Screens/Risk/RiskModels.ts',
    'src/Screens/Risk/RiskList.tsx', 'src/Helpers/ExportService.ts', 'src/Services/RiskService.test.ts',
  ].map((p) => fileRow(p));
  assert.deepEqual(contract.matchContractFiles(files, contract.DEFAULT_CONTRACT_GLOBS), [
    'apps/risk/serializers.py', 'apps/compliance/ato_serializers.py', 'apps/compliance/hub_views.py', 'apps/risk/urls.py',
    'config/schemas_v2.py', 'src/Services/RiskService.ts', 'src/Services/http/client.ts', 'src/Models/IncidentModel.ts',
    'src/Screens/Risk/RiskModels.ts', 'src/Helpers/ExportService.ts',
  ]);
  assert.ok(contract.globToRegExp('**/views*.py').test('views.py'));
  assert.ok(!contract.globToRegExp('src/*.ts').test('src/a/b.ts'));
  // A rename matches by its old path too.
  assert.deepEqual(contract.matchContractFiles([{ path: 'apps/risk/api.py', old_path: 'apps/risk/views.py' }], ['**/views*.py']), ['apps/risk/api.py']);
});

test('contract globs come from RULES_DIR/<repo>.json when it sets them', () => {
  const rules = path.join(root, 'rules');
  fs.mkdirSync(rules);
  fs.writeFileSync(path.join(rules, 'api.json'), JSON.stringify({ contractGlobs: ['**/api/*.py'], other: true }));
  fs.writeFileSync(path.join(rules, 'web.json'), JSON.stringify({ lensRules: [] }));
  fs.writeFileSync(path.join(rules, 'broken.json'), '{ not json');
  assert.deepEqual(contract.contractGlobsFor('api', rules), ['**/api/*.py']);
  assert.deepEqual(contract.contractGlobsFor('web', rules), [...contract.DEFAULT_CONTRACT_GLOBS]);
  assert.deepEqual(contract.contractGlobsFor('broken', rules), [...contract.DEFAULT_CONTRACT_GLOBS]);
  assert.deepEqual(contract.contractGlobsFor('missing', rules), [...contract.DEFAULT_CONTRACT_GLOBS]);
  assert.deepEqual(contract.contractGlobsFor('../etc', rules), [...contract.DEFAULT_CONTRACT_GLOBS]);
  // The same file holds the tool checks; contractGlobs next to them keeps it a valid checks config.
  const both = parseChecksConfig({ checks: { 'diff-size': true }, contractGlobs: ['**/api/*.py'] });
  assert.equal(both.checks['diff-size']?.maxFiles, 40);
});

test('hunks of the contract files only, from base to head; capped with a note naming the cut files', async () => {
  const dir = path.join(root, 'hunks');
  const many = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}_${i} = ${i}`).join('\n') + '\n';
  const shas = makeCheckout(dir,
    { 'risk/serializers.py': 'fields = ["id", "name"]\n', 'risk/models.py': 'x = 1\n', 'risk/views.py': many('old', 5) },
    { 'risk/serializers.py': 'fields = ["id", "title"]\n', 'risk/models.py': 'x = 2\n', 'risk/views.py': many('new', 300) });
  const files = [fileRow('risk/serializers.py'), fileRow('risk/models.py'), fileRow('risk/views.py')];
  const review = { repo: 'api', base_sha: shas.base, head_sha: shas.head };

  const full = await contract.collectContractHunks(review, files, dir, { run: hostDiff, globs: contract.DEFAULT_CONTRACT_GLOBS });
  assert.deepEqual(full.files, ['risk/serializers.py', 'risk/views.py']);
  assert.match(full.diff, /^-fields = \["id", "name"\]$/m);
  assert.match(full.diff, /^\+fields = \["id", "title"\]$/m);
  assert.doesNotMatch(full.diff, /models\.py/);
  assert.equal(full.truncated, false);

  const cut = await contract.collectContractHunks(review, files, dir, { run: hostDiff, globs: contract.DEFAULT_CONTRACT_GLOBS, maxLines: 40 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.diff.split('\n').length, 40);
  assert.match(cut.note!, /truncated at 40 lines; not shown in full: risk\/views\.py/);

  // Nothing to diff: no contract file, no checkout, no commits, git failing.
  assert.equal((await contract.collectContractHunks(review, [fileRow('risk/models.py')], dir, { run: hostDiff })).note, 'no contract file changed');
  assert.match((await contract.collectContractHunks(review, files, path.join(root, 'gone'), { run: hostDiff })).note!, /no longer on disk/);
  assert.match((await contract.collectContractHunks({ ...review, base_sha: null }, files, dir, { run: hostDiff })).note!, /no base or head/);
  const failing = await contract.collectContractHunks(review, files, dir, { run: async () => { throw new Error('boom'); } });
  assert.match(failing.note!, /git diff failed: boom/);
});

test('issues are held to the group: unknown branches dropped, both ends must exist', () => {
  const ok = (file: string, line: number | null) => ({ file, line, anchor_status: file.includes('missing') ? 'missing_path' as const : 'ok' as const });
  const resolve = (repo: string | null, branch: string) => (branch === 'feat/x-api' && (!repo || repo === 'api')) || branch === 'api#feat/x-api'
    ? { repo: 'api', branch: 'feat/x-api', check: ok }
    : branch === 'feat/x-web' ? { repo: 'web', branch: 'feat/x-web', check: ok } : undefined;
  const logs: string[] = [];
  const out = contract.normalizeContractIssues(contract.contractIssuesSchema.parse([
    {
      problem: 'name renamed to title; the risk model still reads name', severity: 'blocker',
      sites: [
        { repo: 'api', branch: 'feat/x-api', file: 'risk/serializers.py', line: 1 },
        { repo: 'web', branch: 'feat/x-web', file: 'src/RiskModels.ts', line: '3' },
        { repo: 'web', branch: 'feat/other', file: 'src/a.ts', line: 1 },
      ],
    },
    { problem: 'one end only', severity: 'minor', sites: [{ repo: 'api', branch: 'feat/x-api', file: 'a.py', line: 1 }] },
    {
      problem: 'second end does not exist', severity: 'minor',
      sites: [{ repo: 'api', branch: 'feat/x-api', file: 'a.py', line: 1 }, { repo: 'web', branch: 'feat/x-web', file: 'missing.ts', line: 1 }],
    },
  ]), resolve, (m) => logs.push(m));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.severity, 'major');
  assert.deepEqual(out[0]!.sites.map((s) => `${s.repo}#${s.branch}:${s.file}:${s.line}:${s.anchor_status}`), [
    'api#feat/x-api:risk/serializers.py:1:ok', 'web#feat/x-web:src/RiskModels.ts:3:ok',
  ]);
  assert.ok(logs.some((m) => /feat\/other: not a reviewed branch/.test(m)));
  assert.equal(logs.filter((m) => /fewer than two sites/.test(m)).length, 2);
  assert.deepEqual(contract.contractIssuesSchema.parse(null), []);
  assert.equal(contract.parseContractIssues(null), null);
  assert.deepEqual(contract.parseContractIssues('[]'), []);
});

// --- a coverage pass with a backend and a frontend branch -----------------------------

function reviewer(answer: unknown, prompts: string): ReviewerDefinition {
  const script = `printf '%s' "$1" > "$PROMPT_DIR/$$.txt"; printf '%s\\n' "$ANSWER"`;
  return {
    name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', bin: '/bin/sh',
    buildArgs: (prompt) => ['-c', script, 'sh', prompt],
    buildChildEnv: () => ({ PATH: process.env.PATH, PROMPT_DIR: prompts, ANSWER: JSON.stringify(answer) }),
    parseStreamLine: (line) => ({ result: line }),
    listModels: async () => [],
    isAvailable: () => true,
    describeFailure: () => null,
  };
}

test('coverage: the prompt carries each branch\'s contract hunks; issues stored, anchored, reported', async () => {
  const KEY = 'CON-1';
  const prompts = path.join(root, 'prompts');
  fs.mkdirSync(prompts);
  const mk = (repo: string, branch: string, files: string[]) => {
    const row = store.createReview({
      ticket_key: KEY, ticket_title: 'Rename', ticket_body: 'Rename the risk name to title.',
      repo, branch, base_branch: 'main', status: 'done', verdict: 'approve', code_verdict: 'approve',
    });
    store.replaceReviewFiles(row.id, files.map((p) => ({ path: p, status: 'M', old_path: null, additions: 1, deletions: 1 })));
    return row;
  };
  const api = mk('api', 'feat/con-1-api', ['risk/serializers.py']);
  const web = mk('web', 'feat/con-1-web', ['src/Services/RiskService.ts']);
  const apiShas = makeCheckout(checkoutDir(api, api.id),
    { 'risk/serializers.py': 'class RiskSerializer:\n    fields = ["id", "name"]\n' },
    { 'risk/serializers.py': 'class RiskSerializer:\n    fields = ["id", "title"]\n' });
  const webShas = makeCheckout(checkoutDir(web, web.id),
    { 'src/Services/RiskService.ts': 'export const list = () => get("/risks");\n', 'src/Screens/RiskModels.ts': 'export interface Risk {\n  id: number;\n  name: string;\n}\n' },
    { 'src/Services/RiskService.ts': 'export const list = () => get("/risks/");\n' });
  store.updateReview(api.id, { base_sha: apiShas.base, head_sha: apiShas.head });
  store.updateReview(web.id, { base_sha: webShas.base, head_sha: webShas.head });
  ticketStore.syncMembersFromReviews(KEY);

  const answer = {
    summary: 'Covered; the frontend model still reads name.',
    requirements: [{ text: 'Rename name to title', status: 'covered', branches: [{ repo: 'api', branch: 'feat/con-1-api', evidence: ['risk/serializers.py:2'] }] }],
    contract_issues: [{
      problem: 'The serializer returns title instead of name; the Risk model still reads name.', severity: 'major',
      sites: [
        { repo: 'api', branch: 'feat/con-1-api', file: 'risk/serializers.py', line: 2 },
        { repo: 'web', branch: 'feat/con-1-web', file: 'src/Screens/RiskModels.ts', line: 3 },
      ],
    }],
  };
  const row = await coverage.runCoverage(KEY, { reviewerDefinition: reviewer(answer, prompts), timeoutMs: 20_000, contractDiff: hostDiff });
  assert.equal(row.status, 'done', row.error ?? '');

  const prompt = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'))[0]!;
  assert.match(prompt, /# Contract files/);
  assert.match(prompt, /### `api#feat\/con-1-api`\n\nContract files changed: `risk\/serializers\.py`\n\n```diff\n[\s\S]*\+    fields = \["id", "title"\]/);
  assert.match(prompt, /\+export const list = \(\) => get\("\/risks\/"\);/);
  assert.match(prompt, /5\. \*\*Cross-repository contract\.\*\*/);

  const issues = contract.parseContractIssues(row.contract_json)!;
  assert.equal(issues.length, 1);
  // The frontend end is an untouched file: it exists, outside that branch's diff.
  assert.deepEqual(issues[0]!.sites.map((s) => s.anchor_status), ['ok', 'off_diff']);
  const report = fs.readFileSync(path.join(process.env.DATA_DIR!, row.report_path!), 'utf8');
  assert.match(report, /## Cross-repository contract\n\n- \*\*major\*\*: The serializer returns title/);
  assert.match(report, /web#feat\/con-1-web `src\/Screens\/RiskModels\.ts:3` \[outside the changed files\]|web#feat\/con-1-web `src\/Screens\/RiskModels\.ts:3`/);

  // A pass that finds nothing stores an empty list: checked, none found.
  const none = await coverage.runCoverage(KEY, {
    reviewerDefinition: reviewer({ ...answer, contract_issues: [] }, prompts), timeoutMs: 20_000, contractDiff: hostDiff,
  });
  assert.equal(none.contract_json, '[]');
  const noneReport = fs.readFileSync(path.join(process.env.DATA_DIR!, none.report_path!), 'utf8');
  assert.match(noneReport, /No contract mismatch found between the branches\./);
});
