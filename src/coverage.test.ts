import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewerDefinition } from './reviewers/types.js';
import { git } from './testGit.js';

/**
 * The ticket coverage pass with a stand-in reviewer: a group of four branches
 * in two repositories, one of them never reviewed. Evidence is checked in the
 * checkouts that are still on disk and against the changed set otherwise.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-coverage-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc,web';

const store = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const coverage = await import('./coverage.js');
const { checkoutDir } = await import('./gitSandbox.js');
const { branchCoverage } = await import('./coverageView.js');
const { COVERAGE_START } = await import('./reportWriter.js');

const prompts = path.join(root, 'prompts');
fs.mkdirSync(prompts);

test.after(() => {
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function reviewer(answer: unknown): ReviewerDefinition {
  const script = `printf '%s' "$1" > "$PROMPT_DIR/$$.txt"; printf '%s\\n' "$ANSWER"`;
  return {
    name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', bin: '/bin/sh',
    buildArgs: (prompt) => ['-c', script, 'sh', prompt],
    buildChildEnv: () => ({
      PATH: process.env.PATH, PROMPT_DIR: prompts,
      ANSWER: typeof answer === 'string' ? answer : JSON.stringify(answer),
    }),
    parseStreamLine: (line) => ({ result: line }),
    listModels: async () => [],
    isAvailable: () => true,
    describeFailure: () => null,
  };
}

const KEY = 'ABC-7';
const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

/** A finished review of one branch, with its changed files and its own checklist. */
function doneReview(repo: string, branch: string, base: string, files: string[], minute: number, checklist: string) {
  const row = store.createReview({
    ticket_key: KEY, ticket_title: 'Export risks', ticket_url: 'https://tracker.example/ABC-7',
    ticket_body: 'Users can export risks to Excel. The export has a button on the risk list.',
    repo, branch, base_branch: base, status: 'done', verdict: 'approve', code_verdict: 'approve', can_merge: 1,
    code_can_merge: 1, summary: `Adds ${branch}.`, head_sha: 'a'.repeat(40), created_at: at(minute),
    report_path: `reports/${KEY}/${repo}__${branch.replace(/\//g, '__')}/run-1.md`,
  });
  store.replaceReviewFiles(row.id, files.map((p) => ({ path: p, status: 'A', old_path: null, additions: 3, deletions: 0 })));
  store.replaceRequirements(row.id, [{ text: checklist, status: 'met', evidence: `${files[0]}:2` }]);
  const report = path.join(process.env.DATA_DIR!, row.report_path!);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `# Code Review\n\n${COVERAGE_START}\n## Ticket coverage\n\nPending.\n<!-- ticket-coverage:end -->\n\n## Issues to fix\n`);
  return row;
}

/** A real checkout of a review, as the queue keeps it for a slice. */
function keepCheckout(row: { id: number; repo: string; branch: string }, files: Record<string, string>): string {
  const dir = checkoutDir(row, row.id);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'x');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  return dir;
}

const api = doneReview('svc', 'feat/abc-7-api', 'main', ['src/export.py'], 1, 'Export endpoint');
const dates = doneReview('svc', 'feat/abc-7-dates', 'feat/abc-7-api', ['src/dates.py'], 2, 'Date columns');
const ui = doneReview('web', 'feat/abc-7-ui', 'main', ['ui/button.tsx'], 3, 'Export button');
store.createReview({ ticket_key: KEY, repo: 'web', branch: 'feat/abc-7-ui-tests', base_branch: 'feat/abc-7-ui', status: 'failed', created_at: at(4) });
ticketStore.syncMembersFromReviews(KEY);
const apiDir = keepCheckout(api, { 'src/export.py': 'a\nb\nc\nd\n', 'src/other.py': 'x\n' });
const datesDir = keepCheckout(dates, { 'src/dates.py': '1\n2\n' });

const answer = {
  summary: 'API and button are in place; tests for the button are missing.',
  requirements: [
    {
      text: 'An export endpoint returns an Excel file', status: 'covered', note: '',
      branches: [{ repo: 'svc', branch: 'feat/abc-7-api', status: 'covered', evidence: [{ file: 'src/export.py', line: 3 }, 'src/other.py:1'] }],
    },
    {
      text: 'Dates are exported as dates', status: 'partial', note: 'Time zones are not handled.',
      branches: [{ repo: 'svc', branch: 'svc#feat/abc-7-dates', status: 'partial', evidence: [{ file: './src/dates.py', line: 99 }] }],
    },
    {
      text: 'The risk list has an export button', status: 'covered',
      branches: [
        { repo: 'web', branch: 'feat/abc-7-ui', status: 'covered', evidence: [{ file: 'ui/button.tsx', line: 4 }, { file: 'ui/elsewhere.tsx', line: 1 }] },
        { repo: 'svc', branch: 'feat/abc-7-api', status: 'partial', evidence: ['src/export.py'] },
      ],
    },
    { text: 'The button has tests', status: 'missing', note: 'Planned for feat/abc-7-ui-tests, which has no finished review.', branches: [] },
    { text: 'An audit entry is written', status: 'covered', branches: [{ repo: 'svc', branch: 'feat/nope', status: 'covered' }] },
    { text: 'Tests for the button pass', status: 'covered', branches: [{ repo: 'web', branch: 'feat/abc-7-ui-tests', status: 'covered' }] },
  ],
};

test('coverage: per requirement status and branches, evidence anchors checked, unknown branches dropped', async () => {
  const run = ticketStore.createTicketRun(KEY, [api.id, dates.id, ui.id]);
  const row = await coverage.runCoverage(KEY, { reviewerDefinition: reviewer(answer), timeoutMs: 20_000, trigger: 'test' });
  assert.equal(row.status, 'done', row.error ?? '');
  assert.equal(row.verdict, 'needs_work');
  assert.deepEqual(ticketStore.parseIds(row.review_ids), [api.id, dates.id, ui.id]);
  const reqs = ticketStore.parseCoverageRequirements(row);
  assert.deepEqual(reqs.map((r) => r.status), ['covered', 'partial', 'covered', 'missing', 'missing', 'missing']);

  // In the kept checkout: a changed file at a real line is ok, an unchanged one off the diff.
  assert.deepEqual(reqs[0]!.branches[0]!.evidence, [
    { file: 'src/export.py', line: 3, anchor_status: 'ok' },
    { file: 'src/other.py', line: 1, anchor_status: 'off_diff' },
  ]);
  // "repo#branch" in the branch field, a ./ path, and a line past the end.
  assert.equal(reqs[1]!.branches[0]!.branch, 'feat/abc-7-dates');
  assert.deepEqual(reqs[1]!.branches[0]!.evidence, [{ file: 'src/dates.py', line: 99, anchor_status: 'line_out_of_range' }]);
  // No checkout for the UI branch: only the changed set can be checked.
  assert.deepEqual(reqs[2]!.branches.map((b) => `${b.repo}#${b.branch}:${b.status}`), ['web#feat/abc-7-ui:covered', 'svc#feat/abc-7-api:partial']);
  assert.deepEqual(reqs[2]!.branches[0]!.evidence.map((e) => e.anchor_status), ['unverified', 'off_diff']);
  // Not a branch of the ticket, and a branch with no finished review: both dropped, so missing.
  assert.equal(reqs[4]!.branches.length, 0);
  assert.match(reqs[4]!.note, /No reviewed branch/);
  assert.equal(reqs[5]!.branches.length, 0);

  // The prompt: the ticket, every branch in stack order, the unreviewed one marked.
  const prompt = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8')).find((p) => p.includes('# Branches'))!;
  assert.match(prompt, /Users can export risks to Excel/);
  const order = ['svc#feat/abc-7-api', 'svc#feat/abc-7-dates', 'web#feat/abc-7-ui`', 'web#feat/abc-7-ui-tests'].map((b) => prompt.indexOf(b));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)), `stack order in the prompt: ${order}`);
  assert.match(prompt, /web#feat\/abc-7-ui-tests`\n- Diffed against: `feat\/abc-7-ui`\n- NOT REVIEWED: its latest review is failed/);
  assert.match(prompt, /\[met\] Export endpoint \(evidence: src\/export\.py:2\)/);

  // One branch's reading: here, elsewhere, nowhere.
  const lines = branchCoverage(reqs, 'web', 'feat/abc-7-ui');
  assert.deepEqual(lines.map((l) => l.where), ['elsewhere', 'elsewhere', 'here', 'nowhere', 'nowhere', 'nowhere']);
  assert.deepEqual(lines[0]!.others, ['svc#feat/abc-7-api']);
  assert.deepEqual(lines[2]!.others, ['svc#feat/abc-7-api']);

  // The ticket report, and the coverage section of every branch report.
  assert.match(row.report_path!, /^reports\/ABC-7\/coverage-\d{8}-\d{6}-\d+\.md$/);
  const report = fs.readFileSync(path.join(process.env.DATA_DIR!, row.report_path!), 'utf8');
  assert.match(report, /# Ticket coverage: ABC-7/);
  assert.match(report, /NEEDS WORK/);
  assert.match(report, /\| 4 \| The button has tests \| ❌ Missing \| not covered anywhere \|/);
  assert.match(report, /`src\/dates\.py:99` \[line out of range at HEAD\]/);
  const branchReport = fs.readFileSync(path.join(process.env.DATA_DIR!, ui.report_path!), 'utf8');
  assert.match(branchReport, /\| 3 \| The risk list has an export button \| ✅ Covered \| in this branch and svc#feat\/abc-7-api \|/);
  assert.match(branchReport, /\| 1 \| An export endpoint returns an Excel file \| ✅ Covered \| in svc#feat\/abc-7-api \|/);
  assert.doesNotMatch(branchReport, /Pending\./);
  assert.match(branchReport, /## Issues to fix/);

  // The checkouts it read are gone; the batch is closed by this coverage.
  assert.equal(fs.existsSync(apiDir), false);
  assert.equal(fs.existsSync(datesDir), false);
  const closed = ticketStore.getTicketRun(run.id)!;
  assert.equal(closed.status, 'done');
  assert.equal(closed.coverage_id, row.id);
  // The workspace of the pass is removed.
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, 'coverage', KEY, String(row.id))), false);
});

test('coverage: every requirement covered gives "covered"; an answer that is not JSON fails the row', async () => {
  const all = {
    summary: 'All there.',
    requirements: [{ text: 'Export endpoint', status: 'met', branches: [{ repo: 'svc', branch: 'feat/abc-7-api', evidence: ['src/export.py:1'] }] }],
  };
  const ok = await coverage.runCoverage(KEY, { reviewerDefinition: reviewer(all), timeoutMs: 20_000 });
  assert.equal(ok.verdict, 'covered');
  // Without the checkout (pruned by the first pass) the changed set still places it.
  assert.equal(ticketStore.parseCoverageRequirements(ok)[0]!.branches[0]!.evidence[0]!.anchor_status, 'unverified');

  const run = ticketStore.createTicketRun(KEY, [ui.id]);
  const bad = await coverage.runCoverage(KEY, { reviewerDefinition: reviewer('no json here'), timeoutMs: 20_000 });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error ?? '', /did not return a valid JSON block/);
  // A failed pass still closes the batch, so a waiter does not hang.
  assert.equal(ticketStore.getTicketRun(run.id)!.status, 'done');
  // The last finished coverage stays the one a reader sees.
  assert.equal(ticketStore.latestDoneCoverage(KEY)!.id, ok.id);
});

test('coverage of a group with no finished review fails at once', async () => {
  store.createReview({ ticket_key: 'NEW-1', repo: 'svc', branch: 'feat/new-1', base_branch: 'main', status: 'failed' });
  const row = await coverage.runCoverage('NEW-1', { reviewerDefinition: reviewer(answer) });
  assert.equal(row.status, 'failed');
  assert.match(row.error ?? '', /No branch of this ticket has a finished review/);
});

test('scheduler: a burst of settled reviews runs one pass, after the group is idle; a signal during a pass runs one more', async () => {
  const runs: string[] = [];
  let active = true;
  let release: () => void = () => {};
  const scheduler = coverage.createCoverageScheduler({
    run: async (key) => {
      runs.push(key);
      await new Promise<void>((resolve) => { release = resolve; });
    },
    isActive: () => active,
    delayMs: 30,
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Still active: the timer fires and nothing runs (the last review to settle schedules again).
  scheduler.schedule('K-1');
  await wait(60);
  assert.deepEqual(runs, []);

  active = false;
  scheduler.schedule('K-1');
  await wait(10);
  scheduler.schedule('K-1');
  await wait(10);
  scheduler.schedule('K-1');
  assert.equal(scheduler.pending('K-1'), true);
  await wait(60);
  assert.deepEqual(runs, ['K-1']);

  // Another settle while the pass runs: one more pass once it ends, not a parallel one.
  scheduler.schedule('K-1');
  await wait(60);
  assert.deepEqual(runs, ['K-1']);
  release();
  await wait(80);
  assert.deepEqual(runs, ['K-1', 'K-1']);
  release();

  // A manual run skips the timer, and joins a running pass instead of starting a second.
  const first = scheduler.runNow('K-2');
  assert.equal(first.started, true);
  const second = scheduler.runNow('K-2');
  assert.equal(second.started, false);
  release();
  await wait(20);
  release();
  await wait(20);
  assert.deepEqual(runs.filter((k) => k === 'K-2').length, 2);
  scheduler.cancelAll();
});
