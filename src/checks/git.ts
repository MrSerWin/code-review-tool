import { gitRead } from '../localRepos.js';
import type { TreeRef } from './types.js';

/** Every file path of a tree, or null when the ref cannot be read there. Read-only. */
export async function lsTreeNames(tree: TreeRef): Promise<string[] | null> {
  if (tree.ref.startsWith('-')) return null;
  const result = await gitRead(tree.dir, ['ls-tree', '-r', '--name-only', '-z', `${tree.ref}^{tree}`]);
  if (result.code !== 0) return null;
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

/** Whether `ref` names a commit in `dir`. */
export async function hasCommit(dir: string, ref: string): Promise<boolean> {
  if (ref.startsWith('-')) return false;
  const result = await gitRead(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.code === 0;
}

export interface AddedLine {
  line: number;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses `git diff -U0` output into the added lines per HEAD-side path. */
export function parseAddedLines(diff: string): Map<string, AddedLine[]> {
  const out = new Map<string, AddedLine[]>();
  let file: string | null = null;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4);
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (file && raw.startsWith('+')) {
      const list = out.get(file) ?? [];
      list.push({ line: next, text: raw.slice(1) });
      out.set(file, list);
      next += 1;
    }
  }
  return out;
}

/** The lines `base..head` adds to `files`, by HEAD-side path. */
export async function addedLines(dir: string, base: string, head: string, files: readonly string[]): Promise<Map<string, AddedLine[]>> {
  if (files.length === 0) return new Map();
  const result = await gitRead(dir, [
    '-c', 'core.quotePath=false',
    'diff', '-U0', '--no-color', '--no-ext-diff', '-M', `${base}..${head}`, '--', ...files.map((f) => `:(literal)${f}`),
  ]);
  if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return parseAddedLines(result.stdout.toString('utf8'));
}

export interface CommitInfo {
  sha: string;
  email: string;
  message: string;
}

/** The commits of `base..head`, newest first. */
export async function listCommits(dir: string, base: string, head: string): Promise<CommitInfo[]> {
  const result = await gitRead(dir, ['log', '--format=%H%x00%ae%x00%B%x1e', `${base}..${head}`]);
  if (result.code !== 0) throw new Error(`git log failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout.toString('utf8').split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((record) => {
    const [sha = '', email = '', message = ''] = record.split('\0');
    return { sha: sha.trim(), email: email.trim(), message: message.trim() };
  }).filter((c) => c.sha);
}
