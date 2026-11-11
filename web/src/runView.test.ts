import assert from 'node:assert/strict';
import test from 'node:test';
import { cardCount, diffCounts, emptyNote, requirementsCount, shaPair } from './runView';
import type { Review } from './types';

const queued = { status: 'queued', head_sha: null, base_sha: null, files_changed: null, additions: null, deletions: null, requirements_met: null, requirements_total: null } as const;
const run = (fields: Partial<Review>): Review => ({ ...queued, ...fields }) as Review;

test('a run in progress shows pending, not zero, for what it has not measured yet', () => {
  for (const status of ['queued', 'fetching', 'reviewing'] as const) {
    const r = run({ status });
    assert.equal(diffCounts(r), 'pending', status);
    assert.equal(requirementsCount(r), 'pending', status);
    assert.equal(shaPair(r), 'pending', status);
  }
});

test('the checkout counts show as soon as they are recorded', () => {
  const r = run({ status: 'reviewing', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), files_changed: 6, additions: 63, deletions: 2 });
  assert.deepEqual(diffCounts(r), { files: 6, additions: 63, deletions: 2 });
  assert.equal(shaPair(r), null);
  assert.equal(requirementsCount(r), 'pending');
});

test('a finished run shows its counts, zero included', () => {
  const r = run({ status: 'done', head_sha: 'a', base_sha: 'b', files_changed: 0, additions: 0, deletions: 0, requirements_met: 0, requirements_total: 0 });
  assert.deepEqual(diffCounts(r), { files: 0, additions: 0, deletions: 0 });
  assert.equal(requirementsCount(r), '0/0 met');
  assert.equal(requirementsCount(run({ status: 'done', requirements_met: 8, requirements_total: 14 })), '8/14 met');
});

test('a run that ended before measuring shows a dash', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    assert.equal(diffCounts(run({ status })), '—');
    assert.equal(requirementsCount(run({ status })), '—');
    assert.equal(shaPair(run({ status })), '—');
  }
});

test('"No issues found" is said only of a finished review', () => {
  assert.equal(emptyNote('findings', 'done'), 'No issues found.');
  assert.equal(emptyNote('requirements', 'done'), 'No requirements recorded.');
  for (const status of ['queued', 'fetching', 'reviewing'] as const) {
    assert.doesNotMatch(emptyNote('findings', status), /no issues/i);
    assert.match(emptyNote('findings', status), /once the review finishes/);
    assert.match(emptyNote('requirements', status), /once the review finishes/);
  }
  assert.doesNotMatch(emptyNote('findings', 'failed'), /no issues/i);
  assert.doesNotMatch(emptyNote('findings', 'cancelled'), /no issues/i);
});

test('a card counts only what a finished or ended run recorded', () => {
  assert.equal(cardCount('Findings', 0, 'reviewing'), 'Findings');
  assert.equal(cardCount('Findings', 0, 'done'), 'Findings (0)');
  assert.equal(cardCount('Findings', 3, 'failed'), 'Findings (3)');
});
