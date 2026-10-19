import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

/**
 * A database written before ticket groups and code verdicts existed: reviews
 * with a group key, and no ticket tables. db.ts migrates it on import.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-groups-db-'));
{
  const old = new Database(path.join(dataDir, 'review.db'));
  old.exec(`
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_key TEXT, ticket_title TEXT, ticket_url TEXT, ticket_body TEXT,
      repo TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, head_sha TEXT, base_sha TEXT,
      pr_number INTEGER, run_index INTEGER NOT NULL, status TEXT NOT NULL, verdict TEXT, can_merge INTEGER,
      summary TEXT, requirements_met INTEGER, requirements_total INTEGER, blocking_count INTEGER, report_path TEXT,
      reviewer TEXT, model TEXT, error TEXT, files_changed INTEGER, additions INTEGER, deletions INTEGER,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      source TEXT NOT NULL DEFAULT 'github', working_tree INTEGER NOT NULL DEFAULT 0, base_reason TEXT,
      group_key TEXT, runner_pid INTEGER, runner_started_at TEXT, reviewer_pgids TEXT
    );
    INSERT INTO reviews (ticket_key, ticket_title, repo, branch, base_branch, run_index, status, verdict, can_merge, created_at, group_key)
      VALUES ('OLD-1', 'Old ticket', 'svc', 'feat/old-1-api', 'main', 1, 'done', 'changes_requested', 0, '2026-01-01T00:00:00.000Z', 'OLD-1'),
             ('OLD-1', 'Old ticket', 'svc', 'feat/old-1-more', 'feat/old-1-api', 1, 'done', 'approve', 1, '2026-01-01T00:01:00.000Z', 'OLD-1'),
             (NULL, NULL, 'svc', 'cleanup', 'main', 1, 'done', 'approve', 1, '2026-01-01T00:02:00.000Z', 'svc#cleanup');
  `);
  old.close();
}
process.env.DATA_DIR = dataDir;
process.env.ALLOWED_REPOS = 'svc';
const store = await import('./db.js');
const { ticketGroupView } = await import('./ticketGroups.js');
const { latestDoneCoverage } = await import('./ticketStore.js');

test.after(() => {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('an old database gains the ticket tables and the code verdict; old rows keep their verdict', () => {
  const tables = (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((t) => t.name);
  for (const t of ['ticket_groups', 'ticket_branches', 'ticket_coverage', 'ticket_runs']) assert.ok(tables.includes(t), t);
  const cols = (store.db.pragma('table_info(reviews)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('code_verdict') && cols.includes('code_can_merge'));
  const old = store.getReview(1)!;
  assert.equal(old.verdict, 'changes_requested');
  assert.equal(old.code_verdict, null);
  assert.equal(old.code_can_merge, null);
  // A new row writes both.
  const fresh = store.createReview({ repo: 'svc', branch: 'feat/new', base_branch: 'main', code_verdict: 'approve', code_can_merge: 1 });
  assert.equal(store.getReview(fresh.id)!.code_verdict, 'approve');
});

test('an old ticket shows as a group built from its runs; a branch without a ticket does not', () => {
  const view = ticketGroupView('OLD-1')!;
  assert.equal(view.title, 'Old ticket');
  assert.deepEqual(view.chains[0]!.branches.map((b) => [b.branch, b.parent, b.parentReason, b.depth]), [
    ['feat/old-1-api', 'main', 'stored', 0],
    ['feat/old-1-more', 'feat/old-1-api', 'stored', 1],
  ]);
  assert.equal(latestDoneCoverage('OLD-1'), undefined);
  // Running the migration again changes nothing.
  store.migrate();
  assert.equal(ticketGroupView('OLD-1')!.chains[0]!.branches.length, 2);
  assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ticket_branches`).get() as { n: number }).n, 2);
  assert.equal(ticketGroupView('svc#cleanup'), null);
});
