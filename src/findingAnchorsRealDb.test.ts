import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

/**
 * The anchor migration against a copy of a real database. Opt-in: set
 * CRT_MIGRATION_DB to a review.db. The source is opened read-only and copied
 * with SQLite's backup API; only the copy is migrated.
 */
const source = process.env.CRT_MIGRATION_DB;

test('a copy of a real database migrates without losing rows', { skip: !source && 'CRT_MIGRATION_DB is not set' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-anchors-real-'));
  try {
    const src = new Database(source!, { readonly: true, fileMustExist: true });
    const before = {
      reviews: (src.prepare('SELECT COUNT(*) AS n FROM reviews').get() as { n: number }).n,
      findings: (src.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n,
    };
    await src.backup(path.join(dataDir, 'review.db'));
    src.close();

    process.env.DATA_DIR = dataDir;
    const store = await import('./db.js');
    try {
      const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
      assert.equal(count('SELECT COUNT(*) AS n FROM reviews'), before.reviews);
      assert.equal(count('SELECT COUNT(*) AS n FROM findings'), before.findings);
      const cols = (store.db.pragma('table_info(findings)') as { name: string }[]).map((c) => c.name);
      for (const c of ['kind', 'cause_file', 'cause_line', 'hunk', 'anchor_status', 'lens']) assert.ok(cols.includes(c), c);
      // Rows written before this migration: no new values, only the defaults.
      const legacy = count(
        `SELECT COUNT(*) AS n FROM findings WHERE kind = 'diff' AND anchor_status = 'unverified'
           AND cause_file IS NULL AND lens IS NULL`,
      );
      const total = count('SELECT COUNT(*) AS n FROM findings');
      const migratedBefore = count(`SELECT COUNT(*) AS n FROM findings WHERE anchor_status <> 'unverified'`);
      assert.equal(legacy + migratedBefore, total);
      assert.equal(count(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'review_files'`), 1);
      console.log(`migrated copy: ${before.reviews} reviews, ${before.findings} findings, ${legacy} legacy finding rows`);
    } finally {
      store.db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
