/**
 * Test-only: throwaway git repositories, and a stand-in for GitHub's compare
 * API answered from such a repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CompareResult } from './ticketChains.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

/**
 * A repository with `main`, then `<a>` cut from main with one commit, then
 * `<b>` cut from `<a>` with one more: the stack main -> a -> b. main moves on
 * by one commit afterwards, so a and b are not merged into it.
 */
export function makeStack(dir: string, a: string, b: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', a);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\na2\na3\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'slice a');
  git(dir, 'checkout', '-q', '-b', b);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'slice b');
  git(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'main.txt'), 'later\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main moves on');
}

/** GitHub's `compare/<base>...<head>` semantics, from a local repository. */
export function gitCompare(dir: string, base: string, head: string): CompareResult {
  const ahead = Number(git(dir, 'rev-list', '--count', `${base}..${head}`).trim());
  const behind = Number(git(dir, 'rev-list', '--count', `${head}..${base}`).trim());
  const status = ahead === 0 && behind === 0 ? 'identical' : behind === 0 ? 'ahead' : ahead === 0 ? 'behind' : 'diverged';
  return { status, ahead_by: ahead, behind_by: behind };
}
