import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

/**
 * A database written before finding anchors existed: the original `reviews`
 * and `findings` tables only. db.ts migrates it on import.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-anchors-db-'));
{
  const old = new Database(path.join(dataDir, 'review.db'));
  old.exec(`
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_key TEXT, ticket_title TEXT, ticket_url TEXT, ticket_body TEXT,
      repo TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, head_sha TEXT, base_sha TEXT,
      pr_number INTEGER, run_index INTEGER NOT NULL, status TEXT NOT NULL, verdict TEXT, can_merge INTEGER,
      summary TEXT, requirements_met INTEGER, requirements_total INTEGER, blocking_count INTEGER, report_path TEXT,
      reviewer TEXT, model TEXT, error TEXT, files_changed INTEGER, additions INTEGER, deletions INTEGER,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
    CREATE TABLE findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      severity TEXT NOT NULL, category TEXT, file TEXT, line INTEGER, end_line INTEGER, title TEXT NOT NULL,
      problem TEXT NOT NULL, why TEXT, suggestion TEXT, snippet TEXT, ord INTEGER NOT NULL
    );
    INSERT INTO reviews (repo, branch, base_branch, run_index, status, created_at)
      VALUES ('svc', 'feat/a', 'main', 1, 'done', '2026-01-01T00:00:00.000Z');
    INSERT INTO findings (review_id, severity, file, line, title, problem, ord)
      VALUES (1, 'major', 'rrpoam.py', 504, 'Old finding', 'Old problem', 0);
  `);
  old.close();
}
process.env.DATA_DIR = dataDir;
const store = await import('./db.js');
const { renderReport, writeReport, rawOutputDir } = await import('./reportWriter.js');
const { compactFindings, reviewDetail } = await import('./mcp/format.js');

test.after(() => {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('an old database gains the anchor columns; old rows read as unchecked diff findings', () => {
  const cols = (store.db.pragma('table_info(findings)') as { name: string }[]).map((c) => c.name);
  for (const c of ['kind', 'cause_file', 'cause_line', 'hunk', 'anchor_status', 'lens']) assert.ok(cols.includes(c), c);
  const [row] = store.getFindings(1);
  assert.equal(row!.title, 'Old finding');
  assert.equal(row!.kind, 'diff');
  assert.equal(row!.anchor_status, 'unverified');
  assert.equal(row!.cause_file, null);
  assert.equal(row!.lens, null);
  assert.deepEqual(store.getReviewFiles(1), []);
  // Running the migration again changes nothing.
  store.migrate();
  assert.equal(store.getFindings(1).length, 1);
});

test('findings round-trip their anchor fields; the changed set is stored per review', () => {
  const review = store.createReview({ repo: 'svc', branch: 'feat/b', base_branch: 'main' });
  store.replaceFindings(review.id, [
    {
      severity: 'major', category: 'correctness', file: 'src/caller.py', line: 20, end_line: null,
      title: 'Caller left behind', problem: 'p', why: '', suggestion: '', snippet: null,
      kind: 'regression', cause_file: 'src/service.py', cause_line: 4, hunk: null, lens: 'regressions',
      anchor_status: 'ok',
    },
    {
      severity: 'minor', category: 'correctness', file: 'src/a.py', line: 3, end_line: null,
      title: 'Plain', problem: 'p', why: '', suggestion: '', snippet: null,
      kind: 'diff', cause_file: null, cause_line: null, hunk: '@@ -1 +1,2 @@', lens: null,
    },
  ]);
  const [a, b] = store.getFindings(review.id);
  assert.equal(a!.kind, 'regression');
  assert.equal(a!.cause_file, 'src/service.py');
  assert.equal(a!.cause_line, 4);
  assert.equal(a!.lens, 'regressions');
  assert.equal(a!.anchor_status, 'ok');
  assert.equal(b!.hunk, '@@ -1 +1,2 @@');
  assert.equal(b!.anchor_status, 'unverified', 'a finding that never went through validation says so');

  store.replaceReviewFiles(review.id, [
    { path: 'src/service.py', status: 'M', old_path: null, additions: 2, deletions: 1 },
    { path: 'src/new.py', status: 'R', old_path: 'src/old.py', additions: 0, deletions: 0 },
  ]);
  const files = store.getReviewFiles(review.id);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.old_path]), [
    ['src/service.py', 'M', null], ['src/new.py', 'R', 'src/old.py'],
  ]);
  store.deleteReview(review.id);
  assert.deepEqual(store.getReviewFiles(review.id), []);
});

const reportReview = {
  id: 9, repo: 'svc', branch: 'feat/c', base_branch: 'main', run_index: 2, head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40), reviewer: 'claude', model: 'm', ticket_key: 'ABC-1', ticket_title: 'T', ticket_url: null,
};
const reportCheckout = {
  dir: '/nonexistent', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), filesChanged: 1, additions: 1, deletions: 1,
  changedFiles: ['src/service.py'],
};
const baseFinding = {
  category: 'correctness', end_line: null, why: '', suggestion: '', snippet: null, hunk: null, lens: null,
  cause_file: null, cause_line: null,
} as const;
const reportOutput = {
  summary: 's', requirements: [], observations: [], verdict: 'changes_requested' as const, can_merge: false,
  conclusion: 'c',
  findings: [
    { ...baseFinding, severity: 'major' as const, file: 'src/caller.py', line: 20, title: 'Regression', problem: 'p',
      kind: 'regression' as const, cause_file: 'src/service.py', cause_line: 4, anchor_status: 'ok' as const },
    { ...baseFinding, severity: 'minor' as const, file: 'src/service.py', line: 3, title: 'Plain', problem: 'p',
      kind: 'diff' as const, anchor_status: 'ok' as const, hunk: '@@ -1 +1,2 @@' },
    { ...baseFinding, severity: 'minor' as const, file: 'src/gone.py', line: 3, title: 'Missing', problem: 'p',
      kind: 'diff' as const, anchor_status: 'missing_path' as const },
    { ...baseFinding, severity: 'nit' as const, file: 'README.md', line: 900, title: 'Doc', problem: 'p',
      kind: 'stale_doc' as const, cause_file: 'src/service.py', cause_line: 2, anchor_status: 'line_out_of_range' as const },
  ],
};

test('the report shows kinds, causes, hunks, and anchor warnings; plain diff findings stay plain', () => {
  const md = renderReport(reportReview, null, reportCheckout, reportOutput);
  assert.match(md, /- \*\*File:\*\* `src\/caller\.py:20` \(dependent site\)\n- \*\*Caused by:\*\* `src\/service\.py:4`/);
  assert.match(md, /- \*\*File:\*\* `src\/service\.py:3`\n/);
  assert.match(md, /- \*\*Hunk:\*\* `@@ -1 \+1,2 @@`/);
  assert.match(md, /`src\/gone\.py:3` \*\*\[anchor: path not found at HEAD\]\*\*/);
  assert.match(md, /`README\.md:900` \(stale doc\) \*\*\[anchor: line out of range at HEAD\]\*\*/);
});

test('writeReport keeps each lens answer beside the report', async () => {
  const rel = await writeReport(reportReview, null, reportCheckout, reportOutput, {
    lenses: [
      { lens: 'regressions', raw: { findings: [{ title: 'x' }] }, error: null },
      { lens: 'security', error: 'timed out' },
    ],
    synthesis: { summary: 's' },
    reanchor: null,
  });
  const dir = path.join(dataDir, rawOutputDir(rel));
  assert.match(rawOutputDir(rel), /run-2-\d{8}-\d{6}\.lenses$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'regressions.json'), 'utf8')), { findings: [{ title: 'x' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'security.json'), 'utf8')), { error: 'timed out' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'synthesis.json'), 'utf8')), { summary: 's' });
  assert.equal(fs.existsSync(path.join(dir, 'reanchor.json')), false);
});

test('MCP findings carry kind, cause, and anchor_status', () => {
  const review = store.createReview({ repo: 'svc', branch: 'feat/d', base_branch: 'main', status: 'done' });
  store.replaceFindings(review.id, reportOutput.findings);
  const rows = store.getFindings(review.id);
  const { findings } = compactFindings(rows);
  const regression = findings.find((f) => f.title === 'Regression')!;
  assert.equal(regression.kind, 'regression');
  assert.equal(regression.cause, 'src/service.py:4');
  assert.equal(regression.anchor_status, 'ok');
  const plain = findings.find((f) => f.title === 'Plain')!;
  assert.equal(plain.kind, 'diff');
  assert.equal(plain.cause, null);
  assert.equal(findings.find((f) => f.title === 'Missing')!.anchor_status, 'missing_path');

  const detail = reviewDetail({ review: store.getReview(review.id)!, findings: rows }, 'http://x/review/1');
  assert.equal(detail.findings.find((f) => f.title === 'Doc')!.anchor_status, 'line_out_of_range');

  // A row from before the migration still formats.
  const [old] = compactFindings(store.getFindings(1)).findings;
  assert.equal(old!.kind, 'diff');
  assert.equal(old!.anchor_status, 'unverified');
});
