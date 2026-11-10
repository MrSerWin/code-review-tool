import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Per-repository review rules, read from `RULES_DIR` on every review so an
 * edited file takes effect without a restart:
 * - `_all.md`: rules for every repository;
 * - `<repo>.md`: rules for one repository;
 * - `<repo>.json`: which tool checks run, and their parameters (src/checks).
 * A missing file means no section and no checks.
 */

const REPO_FILE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_RULES_BYTES = 64 * 1024;

export interface RepoRules {
  /** The text of `_all.md`, then `<repo>.md`; empty when neither exists. */
  text: string;
  /** The files the text came from, for the run log. */
  files: string[];
}

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_RULES_BYTES) {
      throw new Error(`${path.basename(file)} is larger than ${MAX_RULES_BYTES} bytes`);
    }
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function repoFile(dir: string, repo: string, ext: string): string | null {
  if (!REPO_FILE_NAME.test(repo) || repo === '.' || repo === '..') return null;
  return path.join(dir, `${repo}${ext}`);
}

export function loadRepoRules(repo: string, dir: string = config.RULES_DIR): RepoRules {
  const parts: string[] = [];
  const files: string[] = [];
  for (const file of [path.join(dir, '_all.md'), repoFile(dir, repo, '.md')]) {
    if (!file) continue;
    const text = readText(file);
    if (text) {
      parts.push(text);
      files.push(path.basename(file));
    }
  }
  return { text: parts.join('\n\n'), files };
}

/** The raw `<repo>.json`, or null when there is none. Throws on unreadable or invalid JSON. */
export function readRepoChecksFile(repo: string, dir: string = config.RULES_DIR): unknown | null {
  const file = repoFile(dir, repo, '.json');
  if (!file) return null;
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${(err as Error).message}`);
  }
}

/** The `{{REPO_RULES}}` section of the lens and synthesis prompts; empty without rules. */
export function renderRepoRules(repo: string, rules: Pick<RepoRules, 'text'>): string {
  if (!rules.text.trim()) return '';
  return [
    '# Repository rules (binding)',
    '',
    `These are the binding rules for \`${repo}\`, a summary of the repository's own instructions. Review the`,
    'branch against them. Where they differ from a CLAUDE.md or AGENTS.md in the repository, these rules take',
    'precedence. A finding that rests on one of these rules names the rule in `why`, in one short phrase.',
    '',
    rules.text.trim(),
  ].join('\n');
}
