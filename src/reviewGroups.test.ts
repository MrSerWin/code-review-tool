import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// db.ts opens `<DATA_DIR>/review.db` on import, so point it at a throwaway
// directory first. Each test file runs in its own process.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-groups-'));
process.env.DATA_DIR = dataDir;
const store = await import('./db.js');

test.after(() => {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function seed(): void {
  store.db.prepare('DELETE FROM reviews').run();
  // A ticket run on one repo.
  store.createReview({
    ticket_key: 'ABC-123', ticket_title: 'Add export (from the tracker)', ticket_url: 'https://tracker.example/ABC-123',
    repo: 'my-service', branch: 'feature/abc-123-api', base_branch: 'main',
    status: 'done', verdict: 'approve', can_merge: 1, created_at: at(10),
  });
  // Runs with pasted requirements: no ticket key, but the branch names carry it.
  store.createReview({
    ticket_key: null, ticket_title: '# ABC-123: Add export', repo: 'my-frontend', branch: 'feat/abc-123-ui',
    base_branch: 'main', source: 'local', status: 'done', verdict: 'changes_requested', can_merge: 0,
    created_at: at(20),
  });
  store.createReview({
    ticket_key: 'XYZ-9', ticket_title: 'Rate limits', repo: 'my-service', branch: 'feat/xyz-9-limits',
    base_branch: 'main', status: 'done', verdict: 'approve', can_merge: 1, created_at: at(30),
  });
  store.createReview({
    ticket_key: null, ticket_title: '# ABC-123: Add export', repo: 'my-frontend', branch: 'feat/abc-123-ui',
    base_branch: 'main', source: 'local', status: 'reviewing', created_at: at(40),
  });
  // Neither a ticket nor a ticket-like branch name.
  store.createReview({
    repo: 'my-service', branch: 'cleanup-logging', base_branch: 'main', status: 'failed', created_at: at(5),
  });
}

test('createReview derives the group key; ticket_key stays as given', () => {
  seed();
  const rows = store.listReviews({ limit: 50 }).reviews;
  const manual = rows.find((r) => r.branch === 'feat/abc-123-ui');
  assert.equal(manual?.ticket_key, null);
  assert.equal(manual?.group_key, 'ABC-123');
  assert.equal(rows.find((r) => r.branch === 'cleanup-logging')?.group_key, 'my-service#cleanup-logging');
});

test('groups: one per key, latest run per branch, most recently active first', () => {
  seed();
  const { groups, total } = store.listReviewGroups({ limit: 20 });
  assert.equal(total, 3);
  assert.deepEqual(groups.map((g) => g.key), ['ABC-123', 'XYZ-9', 'my-service#cleanup-logging']);

  const abc = groups[0]!;
  assert.equal(abc.isTicket, true);
  assert.equal(abc.runCount, 3);
  assert.equal(abc.activeCount, 1);
  assert.equal(abc.lastActivity, at(40));
  // Newest non-empty title, without "# " and the key.
  assert.equal(abc.title, 'Add export');
  assert.equal(abc.ticketUrl, 'https://tracker.example/ABC-123');
  assert.deepEqual(
    abc.branches.map((b) => [b.repo, b.branch, b.source, b.latest.run_index, b.latest.status]),
    [
      ['my-frontend', 'feat/abc-123-ui', 'local', 2, 'reviewing'],
      ['my-service', 'feature/abc-123-api', 'github', 1, 'done'],
    ],
  );
  assert.equal(abc.branches[1]!.latest.verdict, 'approve');
  assert.equal(abc.branches[1]!.latest.can_merge, 1);

  const fallback = groups[2]!;
  assert.equal(fallback.isTicket, false);
  assert.equal(fallback.title, null);
  assert.equal(fallback.branches.length, 1);
});

test('groups: q keeps groups with any matching run; status filters per group', () => {
  seed();
  const keys = (filter: Parameters<typeof store.listReviewGroups>[0]): string[] =>
    store.listReviewGroups(filter).groups.map((g) => g.key);

  assert.deepEqual(keys({ q: 'frontend' }), ['ABC-123']);
  assert.deepEqual(keys({ q: 'abc-123' }), ['ABC-123']);
  assert.deepEqual(keys({ q: 'rate LIMITS' }), ['XYZ-9']);
  assert.deepEqual(keys({ q: 'cleanup' }), ['my-service#cleanup-logging']);
  // LIKE wildcards are literal.
  assert.deepEqual(keys({ q: '%' }), []);
  assert.equal(store.listReviewGroups({ q: 'my-service' }).total, 3);

  assert.deepEqual(keys({ status: 'active' }), ['ABC-123']);
  assert.deepEqual(keys({ status: 'failed' }), ['my-service#cleanup-logging']);
  assert.deepEqual(keys({ status: 'done' }), ['XYZ-9']);
});

test('groups: pagination keeps the total', () => {
  seed();
  const second = store.listReviewGroups({ limit: 1, offset: 1 });
  assert.equal(second.total, 3);
  assert.deepEqual(second.groups.map((g) => g.key), ['XYZ-9']);
  const past = store.listReviewGroups({ limit: 20, offset: 10 });
  assert.equal(past.total, 3);
  assert.deepEqual(past.groups, []);
});

test('runs of one group, newest first, by exact group key', () => {
  seed();
  const { reviews, total } = store.listReviews({ group: 'ABC-123', limit: 100 });
  assert.equal(total, 3);
  assert.deepEqual(reviews.map((r) => r.created_at), [at(40), at(20), at(10)]);
  assert.equal(store.listReviews({ group: 'abc-123' }).total, 0);
  // The free-text filter also sees the group key of runs without a ticket key.
  assert.equal(store.listReviews({ q: 'ABC-123' }).total, 3);
});

test('migrate backfills missing group keys and is idempotent', () => {
  seed();
  store.db.prepare(
    `INSERT INTO reviews (ticket_key, repo, branch, base_branch, run_index, status, created_at)
     VALUES (NULL, 'my-service', 'bugfix/abc-77-crash', 'main', 1, 'done', ?)`,
  ).run(at(50));
  store.db.prepare(`UPDATE reviews SET group_key = NULL WHERE branch = 'feat/xyz-9-limits'`).run();

  store.migrate();
  const keyOf = (branch: string): unknown =>
    (store.db.prepare('SELECT group_key FROM reviews WHERE branch = ?').get(branch) as { group_key: unknown }).group_key;
  assert.equal(keyOf('bugfix/abc-77-crash'), 'ABC-77');
  assert.equal(keyOf('feat/xyz-9-limits'), 'XYZ-9');
  assert.equal(store.syncGroupKeys(), 0);
});

test('updateReview re-derives the group key when the ticket changes', () => {
  seed();
  const row = store.listReviews({ q: 'cleanup' }).reviews[0]!;
  store.updateReview(row.id, { ticket_key: 'QRS-5', group_key: 'ignored' });
  assert.equal(store.getReview(row.id)?.group_key, 'QRS-5');
  store.updateReview(row.id, { status: 'done' });
  assert.equal(store.getReview(row.id)?.group_key, 'QRS-5');
});
