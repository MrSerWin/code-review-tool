import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLsRemoteBranches } from './gitSandbox.js';
import { createBranchCache, selectBranches } from './remoteBranches.js';

test('ls-remote output: the HEAD symref names the default branch, heads become branch names', () => {
  const stdout = [
    'ref: refs/heads/main\tHEAD',
    'aaa\tHEAD',
    'aaa\trefs/heads/main',
    'bbb\trefs/heads/feat/abc-1-x',
    'ccc\trefs/heads/feat/deep/nested',
    'ddd\trefs/tags/v1',
    '',
  ].join('\n');
  assert.deepEqual(parseLsRemoteBranches(stdout), {
    defaultBranch: 'main',
    branches: ['main', 'feat/abc-1-x', 'feat/deep/nested'],
  });
  assert.deepEqual(parseLsRemoteBranches(''), { defaultBranch: null, branches: [] });
  // A HEAD that is not a symref leaves the default unknown.
  assert.deepEqual(parseLsRemoteBranches('aaa\tHEAD\nbbb\trefs/heads/dev'), { defaultBranch: null, branches: ['dev'] });
});

test('selection: default branch first, then alphabetical; filtered by substring; capped', () => {
  const list = { defaultBranch: 'main', branches: ['zeta', 'feat/abc-10', 'main', 'Alpha', 'feat/abc-9', 'zeta'] };
  assert.deepEqual(selectBranches(list), {
    defaultBranch: 'main',
    branches: ['main', 'Alpha', 'feat/abc-9', 'feat/abc-10', 'zeta'],
    total: 5,
    truncated: false,
  });
  assert.deepEqual(selectBranches(list, { q: ' ABC ' }).branches, ['feat/abc-9', 'feat/abc-10']);
  assert.deepEqual(selectBranches(list, { q: 'nothing' }), {
    defaultBranch: 'main', branches: [], total: 0, truncated: false,
  });
  const capped = selectBranches(list, { limit: 2 });
  assert.deepEqual(capped.branches, ['main', 'Alpha']);
  assert.equal(capped.total, 5);
  assert.equal(capped.truncated, true);
});

test('the branch cache shares a listing for its TTL, refreshes on demand, and forgets failures', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const cache = createBranchCache(
    async (repo) => {
      calls += 1;
      if (fail) throw new Error('sandbox down');
      return { defaultBranch: 'main', branches: [`${repo}-${calls}`] };
    },
    60_000,
    () => clock,
  );

  const [a, b] = await Promise.all([cache('my-service'), cache('my-service')]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);

  clock = 59_999;
  await cache('my-service');
  assert.equal(calls, 1);

  await cache('my-service', { fresh: true });
  assert.equal(calls, 2);

  clock = 200_000;
  assert.deepEqual((await cache('my-service')).branches, ['my-service-3']);

  fail = true;
  await assert.rejects(cache('my-web', { fresh: true }), /sandbox down/);
  fail = false;
  assert.deepEqual((await cache('my-web')).branches, ['my-web-5']);
});
