import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanGroupTitle, fallbackGroupKey, groupKeyFor, ticketKeyFromBranch } from './groupKey.js';

test('the ticket key wins over anything in the branch name', () => {
  assert.equal(groupKeyFor({ ticket_key: 'ABC-123', repo: 'my-service', branch: 'feat/xyz-9-other' }), 'ABC-123');
  // Kept verbatim, whatever its shape (a GitHub issue key here).
  assert.equal(
    groupKeyFor({ ticket_key: 'my-org/my-service#12', repo: 'my-service', branch: 'fix/abc-1' }),
    'my-org/my-service#12',
  );
});

test('without a ticket key, a ticket-like key in the branch name is used, upper-cased', () => {
  const key = (branch: string): string => groupKeyFor({ ticket_key: null, repo: 'my-service', branch });
  assert.equal(key('feat/abc-123-foo'), 'ABC-123');
  assert.equal(key('abc-7'), 'ABC-7');
  assert.equal(key('user/abc-45-bar'), 'ABC-45');
  assert.equal(key('feature/ABC-45'), 'ABC-45');
  assert.equal(key('feat/ab2-12_x'), 'AB2-12');
  // The first ticket-like token counts.
  assert.equal(key('feat/abc-1-and-xyz-2'), 'ABC-1');
  // An empty ticket key is no ticket key.
  assert.equal(groupKeyFor({ ticket_key: '  ', repo: 'my-service', branch: 'feat/abc-3' }), 'ABC-3');
});

test('without any key, the group is the branch itself', () => {
  assert.equal(groupKeyFor({ ticket_key: null, repo: 'my-service', branch: 'cleanup-logging' }), 'my-service#cleanup-logging');
  assert.equal(fallbackGroupKey('my-service', 'main'), 'my-service#main');
});

test('version-like and generic tokens are not taken for ticket keys', () => {
  for (const branch of [
    'release/v2-1', 'feat/utf-8-fix', 'chore/iso-8601-dates', 'fix/sha-256', 'chore/node-20-upgrade',
    'feat/step-2', 'feat/phase-3-rollout', 'hotfix-12', 'feat/http2-1', 'feat/x86-64', 'feat/md5-1',
    // Not a whole token: glued to more letters or digits on either side.
    'feat/abc-123foo', 'feat/xabc-12a', '2026-09-30-notes', 'feat/a-1',
    // Longer than any tracker's project key.
    'feat/readinessplan-2',
  ]) {
    assert.equal(ticketKeyFromBranch(branch), null, branch);
  }
  // A denied token does not hide a real key later in the name.
  assert.equal(ticketKeyFromBranch('release/v2-1-abc-45'), 'ABC-45');
});

test('a group title drops the heading marker and a leading copy of the key', () => {
  assert.equal(cleanGroupTitle('# ABC-123: Add export', 'ABC-123'), 'Add export');
  assert.equal(cleanGroupTitle('abc-123 - Add export', 'ABC-123'), 'Add export');
  assert.equal(cleanGroupTitle('[ABC-123] Add export', 'ABC-123'), 'Add export');
  assert.equal(cleanGroupTitle('Add export', 'ABC-123'), 'Add export');
  // Another key that merely starts the same is kept.
  assert.equal(cleanGroupTitle('ABC-1234: Other', 'ABC-123'), 'ABC-1234: Other');
  assert.equal(cleanGroupTitle('# ABC-123', 'ABC-123'), null);
  assert.equal(cleanGroupTitle(null, 'ABC-123'), null);
});
