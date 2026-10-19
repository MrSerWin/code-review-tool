import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** The queue starts a child slice only after the review of its parent slice has ended. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-queue-deps-'));
process.env.DATA_DIR = dataDir;
const { nextEligible } = await import('./queue.js');
const store = await import('./db.js');

test.after(() => {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the first queued review whose dependency has ended is taken; the others keep their place', () => {
  const deps = new Map<number, number | null>([[1, null], [2, 1], [3, null], [4, 3], [5, 99]]);
  const ended = new Set<number>([99]);
  const queue = [2, 4, 1, 3, 5];
  const take = () => nextEligible(queue, (id) => ended.has(id), (id) => deps.get(id) ?? null);
  assert.equal(take(), 1);
  assert.equal(take(), 3);
  // 2 and 4 wait for 1 and 3; 5 depends on a review that has ended.
  assert.equal(take(), 5);
  assert.equal(take(), undefined);
  assert.deepEqual(queue, [2, 4]);
  // A parent that failed releases its child just like a finished one.
  ended.add(3);
  assert.equal(take(), 4);
  ended.add(1);
  assert.equal(take(), 2);
  assert.deepEqual(queue, []);
});

test('depends_on is stored on the review row', () => {
  const parent = store.createReview({ repo: 'test-repo', branch: 'a', base_branch: 'main', status: 'done' });
  const child = store.createReview({ repo: 'test-repo', branch: 'b', base_branch: 'a', depends_on: parent.id });
  assert.equal(store.getReview(child.id)!.depends_on, parent.id);
  assert.equal(store.getReview(parent.id)!.depends_on, null);
});
