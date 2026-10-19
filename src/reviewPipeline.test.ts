import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeChangedFiles } from './changedFiles.js';
import { liveReviewerGroups, runReview, type RunnableReview } from './reviewRunner.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import type { CheckoutResult } from './types.js';

/**
 * runReview end to end with a stand-in reviewer CLI: five lenses, synthesis,
 * anchor validation, and the re-anchor pass, against a real git checkout.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-pipeline-'));
const repo = path.join(root, 'repo');
const prompts = path.join(root, 'prompts');
fs.mkdirSync(repo);
fs.mkdirSync(prompts);

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

git('init', '-q', '-b', 'main');
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'src/service.py'), lines(10, 'service'));
fs.writeFileSync(path.join(repo, 'src/caller.py'), lines(30, 'caller'));
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(repo, 'src/service.py'), lines(12, 'service v2'));
git('commit', '-q', '-am', 'branch');
const headSha = git('rev-parse', 'HEAD').trim();

const changedFileList = mergeChangedFiles(
  git('diff', '--name-status', '-z', '-M', `${baseSha}..HEAD`),
  git('diff', '--numstat', '-z', '-M', `${baseSha}..HEAD`),
);
const checkout: CheckoutResult = {
  dir: repo, headSha, baseSha, filesChanged: 1, additions: 12, deletions: 10,
  changedFiles: changedFileList.map((f) => f.path), changedFileList,
};

const regressionsLens = {
  findings: [{
    severity: 'major', category: 'correctness', kind: 'regression', file: 'src/caller.py', line: 20,
    cause_file: 'src/service.py', cause_line: 4, title: 'Caller left behind', problem: 'caller.py still calls f() the old way.',
  }],
  observations: [],
};

const synthesis = {
  summary: 'Changes the service.',
  requirements: [{ text: 'Do the thing', status: 'met', evidence: 'src/service.py:3' }],
  findings: [
    { severity: 'minor', kind: 'diff', file: 'src/service.py', line: 3, lens: 'correctness', title: 'Diff finding', problem: 'p1', hunk: '@@ -1,10 +1,12 @@' },
    // Kind and cause dropped by synthesis; the regressions candidate sits at the same place.
    { severity: 'major', file: 'src/caller.py', line: 20, title: 'Caller left behind', problem: 'p2' },
    // Counted from sed output: past the end of the file.
    { severity: 'minor', kind: 'diff', file: 'src/service.py', line: 50, title: 'Wrong line', problem: 'p3' },
    // An untouched file with no cause.
    { severity: 'minor', kind: 'diff', file: 'src/caller.py', line: 5, title: 'Consumer without cause', problem: 'p4' },
  ],
  observations: [],
  verdict: 'changes_requested',
  can_merge: false,
  conclusion: 'Fix the caller.',
};

const reanchor = {
  anchors: [
    { id: 3, file: 'src/service.py', line: 11, kind: 'diff' },
    { id: 4, file: 'src/caller.py', line: 5, kind: 'consumer', cause_file: 'src/service.py', cause_line: 2 },
  ],
};

const script = `
printf '%s' "$1" > "$PROMPT_DIR/$$.txt"
case "$1" in
  *"fixing the locations of findings"*) printf '%s\\n' "$REANCHOR_JSON" ;;
  *"Your job: synthesis"*) printf '%s\\n' "$SYNTH_JSON" ;;
  *"Your lens: regressions"*) printf '%s\\n' "$REG_JSON" ;;
  *) printf '%s\\n' '{"findings":[],"observations":[]}' ;;
esac
`;

const fakeReviewer: ReviewerDefinition = {
  name: 'claude',
  label: 'Fake reviewer',
  defaultModel: 'fake',
  bin: '/bin/sh',
  buildArgs: (prompt) => ['-c', script, 'sh', prompt],
  buildChildEnv: () => ({
    PATH: process.env.PATH,
    PROMPT_DIR: prompts,
    REG_JSON: JSON.stringify(regressionsLens),
    SYNTH_JSON: JSON.stringify(synthesis),
    REANCHOR_JSON: JSON.stringify(reanchor),
  }),
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

test('runReview validates anchors, carries kinds from the lens, and runs one re-anchor pass', async () => {
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), {
    reviewerDefinition: fakeReviewer, timeoutMs: 30_000,
  });

  const [diff, regression, wrongLine, consumer] = out.findings;
  assert.equal(diff!.anchor_status, 'ok');
  assert.equal(diff!.lens, 'correctness');
  assert.equal(diff!.hunk, '@@ -1,10 +1,12 @@');

  assert.equal(regression!.kind, 'regression');
  assert.equal(regression!.cause_file, 'src/service.py');
  assert.equal(regression!.cause_line, 4);
  assert.equal(regression!.lens, 'regressions');
  assert.equal(regression!.anchor_status, 'ok');

  assert.equal(wrongLine!.line, 11);
  assert.equal(wrongLine!.anchor_status, 'ok');
  assert.equal(consumer!.kind, 'consumer');
  assert.equal(consumer!.anchor_status, 'ok');

  assert.equal(out.anchors.sent, 2);
  assert.equal(out.anchors.fixed, 2);
  assert.deepEqual(out.reanchorRaw, reanchor);
  assert.deepEqual(out.synthesisRaw, synthesis);
  assert.equal(out.lensResults.length, 5);
  assert.deepEqual(out.lensResults.find((l) => l.lens === 'regressions')!.raw, regressionsLens);

  // Five lenses, synthesis, and exactly one re-anchor pass.
  const sent = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  assert.equal(sent.length, 7);
  const reanchorPrompts = sent.filter((p) => p.includes('fixing the locations of findings'));
  assert.equal(reanchorPrompts.length, 1);
  assert.match(reanchorPrompts[0]!, /## Finding 3: \[minor\] Wrong line/);
  assert.match(reanchorPrompts[0]!, /## Finding 4: \[minor\] Consumer without cause/);
  assert.doesNotMatch(reanchorPrompts[0]!, /## Finding [12]:/);
  assert.match(reanchorPrompts[0]!, /- `src\/service\.py`/);
  // Every prompt now asks for numbered line reads and a kind.
  assert.ok(sent.filter((p) => !p.includes('fixing the locations')).every((p) => p.includes('Never count lines yourself')));
  assert.ok(logs.some((l) => /re-anchor fixed 2 of 2/.test(l)));
});
