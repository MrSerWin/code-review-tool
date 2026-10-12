import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The preview engine reaches db.ts, which opens `<DATA_DIR>/review.db` on
// import: point it at a throwaway directory first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-preview-local-'));
process.env.DATA_DIR = dataDir;
const { checkLocalOverrides, checkoutTarget } = await import('./preview/engine.js');
const { normalizeOverrides } = await import('./preview/roles.js');
const { resolveLocalBranch } = await import('./localRepos.js');
const { db } = await import('./db.js');

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } },
  ).trim();
}

/**
 * A main clone on `main`, plus a linked worktree on `feat/wt` with one commit
 * and an uncommitted edit: the layout of a branch developed in a worktree.
 */
function setupClone(): { root: string; clone: string; worktree: string; wtTip: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-preview-clone-'));
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'test-repo');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, clone);
  git(clone, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'initial');
  git(clone, 'push', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');

  const worktree = path.join(root, 'test-repo-wt');
  git(clone, 'worktree', 'add', '-b', 'feat/wt', worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'b.txt'), 'committed\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'worktree commit');
  const wtTip = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'b.txt'), 'uncommitted\n');
  fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'untracked\n');
  return { root, clone, worktree, wtTip };
}

const recipeRepos = { backend: 'test-repo' };

test('a branch checked out in a worktree resolves through the main clone, committed tip only', async () => {
  const { root, clone, wtTip } = setupClone();
  try {
    const paths = new Map([['test-repo', clone]]);
    const before = git(clone, 'for-each-ref', '--format=%(refname) %(objectname)');

    const ref = await resolveLocalBranch('test-repo', 'feat/wt', paths);
    assert.deepEqual(ref, { repoPath: clone, branch: 'feat/wt', sha: wtTip });

    const overrides = normalizeOverrides([{ role: 'backend', branch: 'local:test-repo#feat/wt' }], recipeRepos);
    await checkLocalOverrides(overrides, paths);
    assert.deepEqual(overrides, [{ role: 'backend', repo: 'test-repo', branch: 'feat/wt', source: 'local', sha: wtTip }]);

    // No branch named: the main clone's checked-out branch.
    const current = normalizeOverrides([{ role: 'backend', local: true }], recipeRepos);
    await checkLocalOverrides(current, paths);
    assert.equal(current[0]?.branch, 'main');

    // Read-only: refs of the clone are untouched.
    assert.equal(git(clone, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing local branch or base fails with every miss named', async () => {
  const { root, clone } = setupClone();
  try {
    const paths = new Map([['test-repo', clone]]);
    const overrides = normalizeOverrides(
      [{ role: 'backend', branch: 'feat/typo', local: true }],
      recipeRepos,
    );
    await assert.rejects(
      checkLocalOverrides(overrides, paths),
      /^Error: Branch feat\/typo not found in the local clone of repo test-repo \(role backend\)$/,
    );
    const badBase = normalizeOverrides([{ role: 'backend', branch: 'feat/wt', base: 'gone', local: true }], recipeRepos);
    await assert.rejects(
      checkLocalOverrides(badBase, paths),
      /Base branch gone not found in the local clone of repo test-repo \(role backend\)/,
    );
    // origin's copy of a branch counts as a base.
    const originBase = normalizeOverrides([{ role: 'backend', branch: 'feat/wt', base: 'main', local: true }], recipeRepos);
    await checkLocalOverrides(originBase, paths);
    // A repo without a configured clone is a configuration error, not a missing branch.
    await assert.rejects(checkLocalOverrides(overrides, new Map()), /No local clone is configured for test-repo/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub roles are left alone by the local check', async () => {
  const overrides = normalizeOverrides([{ role: 'backend', branch: 'feat/x' }], recipeRepos);
  await checkLocalOverrides(overrides, new Map());
  assert.deepEqual(overrides, [{ role: 'backend', repo: 'test-repo', branch: 'feat/x' }]);
});

test('a local role is checked out from the clone, committed state only', () => {
  const local = checkoutTarget({
    role: 'backend', repo: 'test-repo', branch: 'feat/wt', base: 'main', usedBase: false, source: 'local',
  });
  assert.deepEqual(local, {
    repo: 'test-repo', branch: 'feat/wt', baseBranch: 'main', prNumber: null, source: 'local', includeWorkingTree: false,
  });
  const github = checkoutTarget({ role: 'backend', repo: 'test-repo', branch: 'feat/x', base: 'main', usedBase: false });
  assert.deepEqual(github, { repo: 'test-repo', branch: 'feat/x', baseBranch: 'main', prNumber: null });
});

test('cloning the worktree branch from the main clone copies the commit, not the worktree files', () => {
  // The same git clone the sandbox runs for a local checkout, on the host.
  const { root, clone, wtTip } = setupClone();
  try {
    const copy = path.join(root, 'copy');
    git(root, 'clone', '--no-local', '--single-branch', '--branch', 'feat/wt', clone, copy);
    assert.equal(git(copy, 'rev-parse', 'HEAD'), wtTip);
    assert.equal(fs.readFileSync(path.join(copy, 'b.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.existsSync(path.join(copy, 'untracked.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
