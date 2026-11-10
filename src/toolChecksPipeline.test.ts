import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeChangedFiles } from './changedFiles.js';
import { parseChecksConfig } from './checks/config.js';
import { compactFindings } from './mcp/format.js';
import { renderReport } from './reportWriter.js';
import { liveReviewerGroups, runReview, type RunnableReview } from './reviewRunner.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import { git } from './testGit.js';
import type { CheckoutResult, FindingRow } from './types.js';

/**
 * runReview with tool checks: they run after the lenses, reach the synthesis
 * prompt, are appended to the final findings whatever synthesis says, and
 * count toward the verdict.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-toolpipe-'));
const repo = path.join(root, 'repo');
const prompts = path.join(root, 'prompts');
fs.mkdirSync(repo);
fs.mkdirSync(prompts);

git(repo, 'init', '-q', '-b', 'main');
fs.mkdirSync(path.join(repo, 'apps/core/migrations'), { recursive: true });
fs.writeFileSync(path.join(repo, 'apps/core/migrations/0001_initial.py'), 'x\n');
fs.writeFileSync(path.join(repo, 'apps/core/migrations/0002_base.py'), 'x\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'base');
const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(repo, 'apps/core/migrations/0002_branch.py'), 'x\n');
fs.writeFileSync(path.join(repo, 'service.py'), 'one\ntwo\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'branch');
const headSha = git(repo, 'rev-parse', 'HEAD').trim();

const changedFileList = mergeChangedFiles(
  git(repo, 'diff', '--name-status', '-z', '-M', `${baseSha}..HEAD`),
  git(repo, 'diff', '--numstat', '-z', '-M', `${baseSha}..HEAD`),
);
const checkout: CheckoutResult = {
  dir: repo, headSha, baseSha, filesChanged: 2, additions: 3, deletions: 0,
  changedFiles: changedFileList.map((f) => f.path), changedFileList,
};

// Synthesis approves and returns no findings: it cannot drop the tool's.
const synthesis = {
  summary: 'Adds a migration.',
  requirements: [{ text: 'Add it', status: 'met', evidence: 'service.py:1' }],
  findings: [],
  observations: [{ file: 'service.py', line: 1, note: 'Model remark.', rationale: 'r' }],
  verdict: 'approve',
  can_merge: true,
  conclusion: 'Fine.',
};

const script = `
printf '%s' "$1" > "$PROMPT_DIR/$$.txt"
case "$1" in
  *"Your job: synthesis"*) printf '%s\\n' "$SYNTH_JSON" ;;
  *) printf '%s\\n' '{"findings":[],"observations":[]}' ;;
esac
`;

const fakeReviewer: ReviewerDefinition = {
  name: 'claude',
  label: 'Fake reviewer',
  defaultModel: 'fake',
  bin: '/bin/sh',
  buildArgs: (prompt) => ['-c', script, 'sh', prompt],
  buildChildEnv: () => ({ PATH: process.env.PATH, PROMPT_DIR: prompts, SYNTH_JSON: JSON.stringify(synthesis) }),
  parseStreamLine: (line) => ({ result: line }),
  listModels: async () => [],
  isAvailable: () => true,
  describeFailure: () => null,
};

const review: RunnableReview = {
  id: 1, repo: 'test-repo', branch: 'feat/x', reviewer: 'claude', model: 'fake',
  ticket_key: null, ticket_title: null, ticket_url: null, ticket_body: null,
};

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('tool findings reach synthesis, are appended by the tool, and decide the verdict', async () => {
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), {
    reviewerDefinition: fakeReviewer,
    timeoutMs: 30_000,
    rules: { text: '- RULE-MARKER', files: ['test-repo.md'] },
    checksConfig: parseChecksConfig({ checks: { 'migration-collision': true, 'diff-size': { maxFiles: 1 } } }),
  });

  assert.equal(out.findings.length, 1);
  const tool = out.findings[0]!;
  assert.equal(tool.lens, 'tool');
  assert.equal(tool.severity, 'major');
  assert.equal(tool.file, 'apps/core/migrations/0002_branch.py');
  assert.equal(tool.anchor_status, 'ok');
  assert.deepEqual(out.observations.map((o) => o.lens ?? null), [null, 'tool']);

  // Synthesis said approve; the tool's major finding overrules it.
  assert.equal(out.verdict, 'changes_requested');
  assert.equal(out.can_merge, false);
  assert.equal(out.code_verdict, 'changes_requested');
  assert.deepEqual(out.toolChecks.ran, ['migration-collision', 'diff-size']);
  assert.ok(logs.some((l) => /tool checks: 2 ran; 1 finding, 1 observation/.test(l)));

  const sent = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  const synthesisPrompt = sent.find((p) => p.includes('Your job: synthesis'))!;
  assert.match(synthesisPrompt, /# Tool checks \(deterministic, already verified\)/);
  assert.match(synthesisPrompt, /\[MAJOR\] migration-collision: Migration number 0002/);
  const lensPrompts = sent.filter((p) => p.includes('# Your lens:'));
  assert.equal(lensPrompts.length, 5);
  assert.ok(lensPrompts.every((p) => p.includes('RULE-MARKER') && !p.includes('# Tool checks (deterministic')));

  // The report lists tool results under their own heading; MCP carries the lens.
  const report = renderReport(
    { id: 1, repo: 'test-repo', branch: 'feat/x', base_branch: 'main', run_index: 1, head_sha: headSha, base_sha: baseSha,
      reviewer: 'claude', model: 'fake', ticket_key: null, ticket_title: null, ticket_url: null },
    null, checkout, out,
  );
  const issues = report.slice(report.indexOf('## Issues to fix'), report.indexOf('## Tool checks'));
  assert.match(issues, /No issues found by the review passes; see Tool checks below\./);
  const toolSection = report.slice(report.indexOf('## Tool checks'), report.indexOf('## Suggestions'));
  assert.match(toolSection, /### 1\. \[MAJOR\] migration-collision: /);
  assert.match(toolSection, /- _not tied to a single file_: diff-size: This branch changes 2 files/);
  const suggestions = report.slice(report.indexOf('## Suggestions'));
  assert.match(suggestions, /Model remark\./);
  assert.doesNotMatch(suggestions, /diff-size/);

  const rows = out.findings.map((f, i) => ({ ...f, id: i + 1, review_id: 1, ord: i, anchor_status: f.anchor_status ?? 'unverified' })) as FindingRow[];
  assert.equal(compactFindings(rows).findings[0]!.lens, 'tool');
});

test('without a checks config nothing runs and the synthesis prompt has no tool section', async () => {
  fs.rmSync(prompts, { recursive: true, force: true });
  fs.mkdirSync(prompts);
  const out = await runReview(review, checkout, null, () => {}, {
    reviewerDefinition: fakeReviewer, timeoutMs: 30_000, rules: { text: '', files: [] }, checksConfig: null,
  });
  assert.deepEqual(out.findings, []);
  assert.equal(out.verdict, 'approve');
  const sent = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  assert.ok(sent.every((p) => !p.includes('# Tool checks (deterministic') && !p.includes('# Repository rules (binding)')));
});
