import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

/**
 * A database written before stored ticket checklists: requirements without an
 * item id, ticket groups without derivation columns, no ticket_requirements.
 * db.ts migrates it on import; old rows keep their text and read as not by id.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-reqs-db-'));
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
      group_key TEXT, runner_pid INTEGER, runner_started_at TEXT, reviewer_pgids TEXT,
      code_verdict TEXT, code_can_merge INTEGER, depends_on INTEGER
    );
    CREATE TABLE requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      text TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT, ord INTEGER NOT NULL
    );
    CREATE TABLE ticket_groups (
      key TEXT PRIMARY KEY, title TEXT, ticket_url TEXT, requirements_text TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE ticket_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_key TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT, summary TEXT,
      review_ids TEXT NOT NULL, requirements_json TEXT, reviewer TEXT, model TEXT, report_path TEXT, error TEXT,
      trigger TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    INSERT INTO ticket_coverage (ticket_key, status, verdict, summary, review_ids, requirements_json, created_at)
      VALUES ('OLD-2', 'done', 'covered', 'Old pass', '[1]', '[{"text":"Old requirement","status":"covered","note":"","branches":[]}]',
              '2026-01-01T00:05:00.000Z');
    INSERT INTO reviews (ticket_key, repo, branch, base_branch, run_index, status, created_at, group_key)
      VALUES ('OLD-2', 'svc', 'feat/old-2', 'main', 1, 'done', '2026-01-01T00:00:00.000Z', 'OLD-2');
    INSERT INTO requirements (review_id, text, status, evidence, ord) VALUES (1, 'Old requirement', 'met', 'a.py:1', 0);
    INSERT INTO ticket_groups (key, title, ticket_url, requirements_text, created_at, updated_at)
      VALUES ('OLD-2', 'Old', NULL, 'Decision: keep it', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  old.close();
}
process.env.DATA_DIR = dataDir;
process.env.ALLOWED_REPOS = 'svc';
const store = await import('./db.js');
const { checklistPayload, addUserRequirements } = await import('./ticketRequirements.js');
const { coveragePayload } = await import('./routes/ticketGroups.js');
const { latestDoneCoverage } = await import('./ticketStore.js');

test.after(() => {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('an old database gains the checklist table and columns and the contract column; old rows read as before', () => {
  const cols = (table: string) => (store.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  assert.ok(cols('requirements').includes('requirement_id'));
  assert.ok(cols('reviews').includes('proposed_requirements'));
  for (const c of ['requirements_derived_at', 'requirements_notes']) assert.ok(cols('ticket_groups').includes(c), c);
  assert.ok(cols('ticket_requirements').includes('state'));

  const [old] = store.getRequirements(1);
  assert.equal(old!.text, 'Old requirement');
  assert.equal(old!.requirement_id, null);
  assert.equal(store.getReview(1)!.proposed_requirements, null);

  // The old group has no checklist and was never derived; it takes items at once.
  assert.deepEqual(checklistPayload('OLD-2').items, []);
  assert.equal(checklistPayload('OLD-2').derived_at, null);
  addUserRequirements('OLD-2', ['Decision: keep it']);
  assert.equal(checklistPayload('OLD-2').items.length, 1);

  // An old coverage pass was never contract-checked: null, not an empty list; its requirements have no id.
  assert.ok(cols('ticket_coverage').includes('contract_json'));
  const old2 = coveragePayload(latestDoneCoverage('OLD-2'))!;
  assert.equal(old2.contract_issues, null);
  assert.equal(old2.requirements[0]!.requirement_id, undefined);

  // A second migration changes nothing.
  store.migrate();
  assert.equal(store.getRequirements(1).length, 1);
  assert.equal(checklistPayload('OLD-2').items.length, 1);
});
