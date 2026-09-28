import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureWorkingTree,
  chooseParent,
  configuredLocalPaths,
  describeLocalRepo,
  describeParent,
  detectParentBranch,
  looksLikeChild,
  planBaseSource,
  isSafeRelativePath,
  isUnpushed,
  localRepoPath,
  parseBranchLine,
  parseLocalInput,
  parseLocalReposOverride,
  parseUpstreamTrack,
  pickBaseBranch,
  resolveLocalTarget,
} from './localRepos.js';

// --- input parsing ---------------------------------------------------------

test('local:<repo>#<branch> and local:<repo> parse', () => {
  assert.deepEqual(parseLocalInput('local:my-service#feat/x'), { repo: 'my-service', branch: 'feat/x' });
  assert.deepEqual(parseLocalInput('  local:my-service  '), { repo: 'my-service', branch: null });
  assert.deepEqual(parseLocalInput('LOCAL:my-repo#a.b_c-1'), { repo: 'my-repo', branch: 'a.b_c-1' });
});

test('non-local inputs are not claimed', () => {
  assert.equal(parseLocalInput('my-service#feat/x'), null);
  assert.equal(parseLocalInput('ABC-123'), null);
  assert.equal(parseLocalInput('https://github.com/o/r/pull/1'), null);
});

test('unsafe repo or branch names are rejected', () => {
  assert.throws(() => parseLocalInput('local:'), /missing repository/i);
  assert.throws(() => parseLocalInput('local:../etc#main'), /unsafe/i);
  assert.throws(() => parseLocalInput('local:..'), /unsafe/i);
  assert.throws(() => parseLocalInput('local:a/b#main'), /unsafe/i);
  assert.throws(() => parseLocalInput('local:repo#'), /missing branch/i);
  assert.throws(() => parseLocalInput('local:repo#../../x'), /unsafe branch/i);
  assert.throws(() => parseLocalInput('local:repo#a;rm -rf'), /unsafe branch/i);
  assert.throws(() => parseLocalInput('local:repo#--upload-pack=x'), /unsafe branch/i);
});

// --- configuration -----------------------------------------------------------

test('only allowed names map to <dir>/<name>; overrides win', () => {
  const overrides = parseLocalReposOverride('b=/elsewhere/b, not-allowed=/x');
  const paths = configuredLocalPaths(['a', 'b', '../evil', '..'], '/clones', overrides);
  assert.deepEqual([...paths.entries()], [['a', '/clones/a'], ['b', '/elsewhere/b']]);
  assert.equal(paths.has('not-allowed'), false);
});

test('without a dir only overrides count', () => {
  const paths = configuredLocalPaths(['a', 'b'], undefined, parseLocalReposOverride('a=/x/a'));
  assert.deepEqual([...paths.entries()], [['a', '/x/a']]);
});

test('LOCAL_REPOS rejects malformed and relative entries', () => {
  assert.throws(() => parseLocalReposOverride('nopath'), /name=\/abs\/path/);
  assert.throws(() => parseLocalReposOverride('a=relative/path'), /absolute/);
  assert.equal(parseLocalReposOverride('').size, 0);
});

test('a repo outside ALLOWED_REPOS is refused even when a path is given', async () => {
  const paths = new Map([['other-repo', os.tmpdir()]]);
  await assert.rejects(localRepoPath('other-repo', paths), /not allowed/);
  await assert.rejects(localRepoPath('../test-repo', paths), /unsafe/i);
});

// --- base branch detection ---------------------------------------------------

test('base branch: origin/HEAD target wins', () => {
  assert.equal(pickBaseBranch('refs/remotes/origin/develop', ['refs/remotes/origin/main']), 'develop');
});

test('base branch: falls back to origin/main, origin/master, then local', () => {
  assert.equal(pickBaseBranch(null, ['refs/remotes/origin/master', 'refs/remotes/origin/main']), 'main');
  assert.equal(pickBaseBranch(null, ['refs/remotes/origin/master', 'refs/heads/main']), 'master');
  assert.equal(pickBaseBranch(null, ['refs/heads/master']), 'master');
  assert.equal(pickBaseBranch('', ['refs/heads/main', 'refs/heads/master']), 'main');
  assert.equal(pickBaseBranch(null, []), null);
});

test('base branch: a weird origin/HEAD is ignored', () => {
  assert.equal(pickBaseBranch('refs/remotes/origin/HEAD', ['refs/heads/main']), 'main');
  assert.equal(pickBaseBranch('refs/remotes/origin/a;b', ['refs/heads/master']), 'master');
});

// --- upstream tracking -------------------------------------------------------

test('%(upstream:track) parsing', () => {
  assert.deepEqual(parseUpstreamTrack(''), { ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack('[ahead 2]'), { ahead: 2, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack('[behind 13]'), { ahead: 0, behind: 13, gone: false });
  assert.deepEqual(parseUpstreamTrack('[ahead 1, behind 4]'), { ahead: 1, behind: 4, gone: false });
  assert.deepEqual(parseUpstreamTrack('[gone]'), { ahead: 0, behind: 0, gone: true });
});

test('unpushed: no upstream, gone upstream, or ahead', () => {
  assert.equal(isUnpushed('', parseUpstreamTrack('')), true);
  assert.equal(isUnpushed('origin/x', parseUpstreamTrack('[gone]')), true);
  assert.equal(isUnpushed('origin/x', parseUpstreamTrack('[ahead 1, behind 2]')), true);
  assert.equal(isUnpushed('origin/x', parseUpstreamTrack('[behind 2]')), false);
  assert.equal(isUnpushed('origin/x', parseUpstreamTrack('')), false);
});

test('for-each-ref line parsing', () => {
  const line = ['feat/x', 'origin/feat/x', '[ahead 3]', 'abc123', '2026-09-28T10:00:00+00:00', 'Add a thing'].join('\0');
  assert.deepEqual(parseBranchLine(line), {
    name: 'feat/x',
    upstream: 'origin/feat/x',
    ahead: 3,
    behind: 0,
    unpushed: true,
    lastCommit: { sha: 'abc123', subject: 'Add a thing', date: '2026-09-28T10:00:00+00:00' },
  });
  assert.equal(parseBranchLine(''), null);
});

test('untracked paths cannot escape the checkout', () => {
  assert.equal(isSafeRelativePath('src/a.ts'), true);
  assert.equal(isSafeRelativePath('../a'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('.git/config'), false);
});

// --- against a throwaway repository (no network) ------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } },
  ).trim();
}

function setupRepo(): { root: string; clone: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-local-'));
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'test-repo');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, clone);
  fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
  git(clone, 'checkout', '-b', 'main');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'initial');
  git(clone, 'push', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  // A pushed branch, one commit ahead of its upstream.
  git(clone, 'checkout', '-b', 'pushed');
  git(clone, 'push', '-u', 'origin', 'pushed');
  fs.writeFileSync(path.join(clone, 'b.txt'), 'two\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'ahead');
  // A never-pushed branch, checked out, with a dirty tree.
  git(clone, 'checkout', '-b', 'feat/local', 'main');
  fs.writeFileSync(path.join(clone, 'c.txt'), 'three\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'local only');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'one\nedited\n');
  fs.writeFileSync(path.join(clone, 'new.txt'), 'untracked\n');
  return { root, clone };
}

test('resolver, listing and working-tree capture against a real clone', async () => {
  const { root, clone } = setupRepo();
  try {
    const paths = new Map([['test-repo', clone]]);
    const before = { status: git(clone, 'status', '--porcelain'), head: git(clone, 'rev-parse', 'HEAD') };
    const refsBefore = git(clone, 'for-each-ref', '--format=%(refname) %(objectname)');

    const current = await resolveLocalTarget({ repo: 'test-repo', branch: null }, { paths });
    assert.deepEqual(current, {
      repo: 'test-repo', branch: 'feat/local', baseBranch: 'main', prNumber: null,
      source: 'local', includeWorkingTree: false, baseReason: 'default', baseDistance: 1,
    });

    const other = await resolveLocalTarget({ repo: 'test-repo', branch: 'pushed' }, { paths });
    assert.equal(other.branch, 'pushed');

    await assert.rejects(
      resolveLocalTarget({ repo: 'test-repo', branch: 'pushed' }, { paths, includeWorkingTree: true }),
      /checked-out branch/,
    );
    await assert.rejects(
      resolveLocalTarget({ repo: 'test-repo', branch: 'nope' }, { paths }),
      /does not exist/,
    );
    const withTree = await resolveLocalTarget({ repo: 'test-repo', branch: 'feat/local' }, { paths, includeWorkingTree: true });
    assert.equal(withTree.includeWorkingTree, true);

    const info = await describeLocalRepo('test-repo', clone);
    assert.equal(info.currentBranch, 'feat/local');
    assert.equal(info.baseBranch, 'main');
    assert.equal(info.dirty, true);
    assert.equal(info.branches[0]?.name, 'feat/local', 'the current branch comes first');
    const byName = new Map(info.branches.map((b) => [b.name, b]));
    assert.equal(byName.get('feat/local')?.unpushed, true);
    assert.equal(byName.get('pushed')?.ahead, 1);
    assert.equal(byName.get('pushed')?.unpushed, true);
    assert.equal(byName.get('main')?.unpushed, false);

    const dest = path.join(root, 'dest');
    fs.mkdirSync(dest);
    const capture = await captureWorkingTree(clone, dest);
    assert.equal(capture.head, before.head);
    assert.match(capture.patch.toString('utf8'), /^\+edited$/m);
    assert.deepEqual(capture.untracked, ['new.txt']);
    assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'untracked\n');

    // Nothing above may have touched the clone.
    assert.equal(git(clone, 'status', '--porcelain'), before.status);
    assert.equal(git(clone, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(clone, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- parent detection: pure selection ----------------------------------------

const cand = (name: string, distance: number, date = 0) => ({ name, distance, date });

test('parent: the closest ancestor wins', () => {
  assert.deepEqual(
    chooseParent({
      defaultBase: 'main', defaultAncestorDistance: 5, defaultForkDistance: 5,
      ancestors: [cand('feat/far', 3), cand('feat/near', 1)], forkPoints: [cand('feat/fork', 0)],
    }),
    { base: 'feat/near', reason: 'ancestor', distance: 1 },
  );
});

test('parent: a tie with the default prefers the other branch; equal others prefer the newest', () => {
  assert.deepEqual(
    chooseParent({
      defaultBase: 'main', defaultAncestorDistance: 2, defaultForkDistance: 2,
      ancestors: [cand('feat/a', 2)], forkPoints: [],
    }),
    { base: 'feat/a', reason: 'ancestor', distance: 2 },
  );
  assert.equal(
    chooseParent({
      defaultBase: 'main', defaultAncestorDistance: null, defaultForkDistance: 9,
      ancestors: [cand('feat/old', 2, 100), cand('feat/new', 2, 200)], forkPoints: [],
    }).base,
    'feat/new',
  );
});

test('parent: a strictly closer default beats other ancestors', () => {
  assert.deepEqual(
    chooseParent({
      defaultBase: 'main', defaultAncestorDistance: 1, defaultForkDistance: 1,
      ancestors: [cand('feat/a', 4)], forkPoints: [],
    }),
    { base: 'main', reason: 'default', distance: 1 },
  );
});

test('parent: fork points only count when no other branch is an ancestor', () => {
  assert.deepEqual(
    chooseParent({
      defaultBase: 'main', defaultAncestorDistance: 6, defaultForkDistance: 6,
      ancestors: [], forkPoints: [cand('feat/x', 4), cand('feat/y', 2)],
    }),
    { base: 'feat/y', reason: 'fork-point', distance: 2 },
  );
});

test('parent: nothing qualifies → the default branch', () => {
  assert.deepEqual(
    chooseParent({ defaultBase: 'main', defaultAncestorDistance: null, defaultForkDistance: 7, ancestors: [], forkPoints: [] }),
    { base: 'main', reason: 'default', distance: 7 },
  );
});

test('parent: a branch created from the reviewed one is a child, not a parent', () => {
  const yes = { createdAfterBranchStart: true, onBranchHistory: true };
  assert.equal(looksLikeChild('aaa', 'bbb', yes), true);
  assert.equal(looksLikeChild('aaa', 'bbb', { ...yes, createdAfterBranchStart: false }), false);
  assert.equal(looksLikeChild('aaa', 'bbb', { ...yes, onBranchHistory: false }), false);
  assert.equal(looksLikeChild(null, 'bbb', yes), false, 'no reflog: never excluded');
  assert.equal(looksLikeChild('aaa', 'aaa', yes), false);
});

test('base source: the default comes from GitHub, anything else from the clone', () => {
  const both = { localHead: true, originRef: true };
  assert.equal(planBaseSource('main', 'main', both), 'github');
  assert.equal(planBaseSource('feat/a', 'main', both), 'local-head');
  assert.equal(planBaseSource('feat/a', 'main', { localHead: false, originRef: true }), 'local-origin');
  assert.equal(planBaseSource('feat/a', null, { localHead: true, originRef: false }), 'local-head');
  assert.throws(() => planBaseSource('feat/a', 'main', { localHead: false, originRef: false }), /neither locally/);
});

// --- parent detection against a throwaway repository ---------------------------

function commit(repo: string, file: string, text: string): void {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', `edit ${file}`);
}

test('parent detection on stacked branches (no network)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-parent-'));
  const repo = path.join(root, 'test-repo');
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    commit(repo, 'base.txt', 'base\n');
    // main → feat/a (2 commits) → feat/b (1 commit); feat/side straight off main.
    git(repo, 'checkout', '-b', 'feat/a');
    commit(repo, 'a1.txt', '1\n');
    commit(repo, 'a2.txt', '2\n');
    git(repo, 'checkout', '-b', 'feat/b');
    commit(repo, 'b1.txt', '1\n');
    git(repo, 'checkout', '-b', 'feat/side', 'main');
    commit(repo, 'side.txt', 's\n');
    git(repo, 'checkout', 'main');
    commit(repo, 'main2.txt', 'm\n');

    assert.deepEqual(await detectParentBranch(repo, 'feat/b', 'main'), { base: 'feat/a', reason: 'ancestor', distance: 1 });
    assert.deepEqual(await detectParentBranch(repo, 'feat/a', 'main'), { base: 'main', reason: 'default', distance: 2 });
    assert.deepEqual(await detectParentBranch(repo, 'feat/side', 'main'), { base: 'main', reason: 'default', distance: 1 });

    // feat/a moves on after feat/b was cut: its tip is no longer an ancestor of feat/b.
    git(repo, 'checkout', 'feat/a');
    commit(repo, 'a3.txt', '3\n');
    git(repo, 'checkout', 'main');
    assert.deepEqual(await detectParentBranch(repo, 'feat/b', 'main'), { base: 'feat/a', reason: 'fork-point', distance: 1 });
    // …and feat/b, cut from feat/a, must not be taken for feat/a's parent.
    assert.deepEqual(await detectParentBranch(repo, 'feat/a', 'main'), { base: 'main', reason: 'default', distance: 3 });

    // A merged, stale branch is never a parent, even when main has moved on.
    git(repo, 'branch', 'old/merged', 'main~1');
    assert.equal((await detectParentBranch(repo, 'feat/side', 'main')).base, 'main');

    const refsBefore = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const headBefore = git(repo, 'rev-parse', 'HEAD');

    const paths = new Map([['test-repo', repo]]);
    assert.deepEqual(await describeParent('test-repo', 'feat/b', paths), {
      branch: 'feat/b', base: 'feat/a', reason: 'fork-point', distance: 1, defaultBase: 'main',
    });
    await assert.rejects(describeParent('test-repo', 'nope', paths), /does not exist/);

    const detected = await resolveLocalTarget({ repo: 'test-repo', branch: 'feat/b' }, { paths });
    assert.equal(detected.baseBranch, 'feat/a');
    assert.equal(detected.baseReason, 'parent');
    const chosen = await resolveLocalTarget({ repo: 'test-repo', branch: 'feat/b' }, { paths, baseBranch: 'main' });
    assert.equal(chosen.baseBranch, 'main');
    assert.equal(chosen.baseReason, 'chosen');
    await assert.rejects(resolveLocalTarget({ repo: 'test-repo', branch: 'feat/b' }, { paths, baseBranch: 'feat/b' }), /itself/);
    await assert.rejects(resolveLocalTarget({ repo: 'test-repo', branch: 'feat/b' }, { paths, baseBranch: 'nope' }), /neither locally/);
    await assert.rejects(resolveLocalTarget({ repo: 'test-repo', branch: 'feat/b' }, { paths, baseBranch: 'a;b' }), /unsafe/i);

    // Detection and resolution never touch the clone.
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
