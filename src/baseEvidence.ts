/**
 * `already_on_base` for the ticket coverage: code a requirement asks for that
 * existed on the base of the chain root (its merge base, `base_sha` of the
 * root review) before any branch of the ticket. The coverage pass may claim
 * it only with sites (`repo`, `file`, `line`, an exact `quote`), and the tool
 * checks each site at that commit with read-only git: in the root review's
 * checkout when it is still on disk, else in a checkout of the base branch
 * fetched for the pass and pruned afterwards.
 *
 * The slice reviews often already say "already on main (services.py:926)":
 * those notes become hints, and the lines they point at are shown to the pass
 * as excerpts it can quote from.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseEvidence, OnLog, RequirementRow, ResolvedTarget } from './types.js';

/** git with these arguments in a checkout; returns stdout, throws on a non-zero exit. */
export type GitRunner = (dir: string, args: string[]) => Promise<string>;

/** The base commit of one chain root of the group. */
export interface BaseRoot {
  repo: string;
  /** The branch the root was diffed against (usually the default branch). */
  baseBranch: string;
  sha: string;
  /** The root review's checkout; null or a missing path when it is gone. */
  checkout: string | null;
  /** What to fetch when the checkout is gone: the base branch, which holds the commit. */
  fetchTarget: ResolvedTarget;
  reviewId: number;
}

export interface BaseClaim {
  repo: string | null;
  file: string;
  line: number | null;
  quote: string;
}

/** Lines around `line` that `quote` may sit on. */
export const QUOTE_WINDOW = 3;
const MIN_QUOTE = 4;
const MAX_QUOTE = 300;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function cleanBasePath(raw: string): { file: string; line: number | null } {
  let file = raw.trim().replace(/\\/g, '/').replace(/^`|`$/g, '');
  while (file.startsWith('./')) file = file.slice(2);
  file = file.replace(/^[ab]\//, '');
  const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(file);
  return m ? { file: m[1]!, line: Number(m[2]) } : { file, line: null };
}

/**
 * Why `quote` does not hold at `line` of this file, or null when it does: the
 * line must exist, and the quote (whitespace runs count as one space) must be
 * on it or within `QUOTE_WINDOW` lines of it.
 */
export function checkQuote(lines: readonly string[], line: number | null, quote: string): string | null {
  const q = squash(quote);
  if (q.length < MIN_QUOTE) return 'no quote given (a short exact substring of the line is required)';
  if (q.length > MAX_QUOTE) return `the quote is longer than ${MAX_QUOTE} characters`;
  if (line === null || !Number.isInteger(line) || line < 1) return 'no line given';
  if (line > lines.length) return `line ${line} is out of range (the file has ${lines.length} lines)`;
  const from = Math.max(0, line - 1 - QUOTE_WINDOW);
  const to = Math.min(lines.length, line + QUOTE_WINDOW);
  const window = lines.slice(from, to).map(squash);
  if (window.some((l) => l.includes(q)) || window.join(' ').includes(q)) return null;
  return `the quote is not within ${QUOTE_WINDOW} lines of line ${line}`;
}

/** File contents as lines, without the trailing empty line of a final newline. */
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface BaseReaderOptions {
  run: GitRunner;
  /** Fetches the base branch of a root whose checkout is gone; returns the new checkout's directory. */
  fetch: (root: BaseRoot) => Promise<string>;
  /** Removes a checkout `fetch` created. */
  prune: (dir: string) => void;
  onLog?: OnLog;
}

interface RootAccess {
  dir: string | null;
  error: string | null;
}

/**
 * Read-only access to the base commits of a group's chain roots. Directories
 * are opened lazily (a pass without base claims fetches nothing); `close`
 * prunes what was fetched.
 */
export class BaseReader {
  private readonly access = new Map<BaseRoot, Promise<RootAccess>>();
  private readonly fetched: string[] = [];
  private readonly files = new Map<string, Promise<string[] | null>>();
  private readonly trees = new Map<BaseRoot, Promise<string[]>>();
  private readonly onLog: OnLog;

  constructor(readonly roots: readonly BaseRoot[], private readonly opts: BaseReaderOptions) {
    this.onLog = opts.onLog ?? (() => {});
  }

  repos(): string[] {
    return [...new Set(this.roots.map((r) => r.repo))];
  }

  rootsOf(repo: string): BaseRoot[] {
    return this.roots.filter((r) => r.repo === repo);
  }

  /** The repository a claim names; the only one when it names none and the group has one. */
  resolveRepo(repo: string | null): string | null {
    const repos = this.repos();
    if (repo) {
      const name = repo.trim();
      return repos.find((r) => r === name) ?? repos.find((r) => r.toLowerCase() === name.toLowerCase()) ?? null;
    }
    return repos.length === 1 ? repos[0]! : null;
  }

  private open(root: BaseRoot): Promise<RootAccess> {
    let hit = this.access.get(root);
    if (!hit) {
      hit = this.openNow(root);
      this.access.set(root, hit);
    }
    return hit;
  }

  private async hasCommit(dir: string, sha: string): Promise<boolean> {
    try {
      await this.opts.run(dir, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async openNow(root: BaseRoot): Promise<RootAccess> {
    if (root.checkout && fs.existsSync(path.join(root.checkout, '.git')) && await this.hasCommit(root.checkout, root.sha)) {
      return { dir: root.checkout, error: null };
    }
    try {
      this.onLog('info', `base check: fetching ${root.repo} ${root.baseBranch} to read ${root.sha.slice(0, 7)}`);
      const dir = await this.opts.fetch(root);
      this.fetched.push(dir);
      if (!(await this.hasCommit(dir, root.sha))) {
        return { dir: null, error: `the base commit ${root.sha.slice(0, 7)} is not in ${root.baseBranch} any more` };
      }
      return { dir, error: null };
    } catch (err) {
      const message = (err as Error).message.split('\n')[0] ?? 'unknown error';
      this.onLog('warn', `base check: could not fetch ${root.repo} ${root.baseBranch}: ${message}`);
      return { dir: null, error: `the base of ${root.repo} could not be read (${message})` };
    }
  }

  /** The file at the root's base commit as lines; null when it does not exist there. */
  async readFile(root: BaseRoot, file: string): Promise<string[] | null> {
    const key = `${root.repo}\0${root.sha}\0${file}`;
    let hit = this.files.get(key);
    if (!hit) {
      hit = (async () => {
        const { dir, error } = await this.open(root);
        if (!dir) throw new Error(error ?? 'no checkout');
        try {
          return toLines(await this.opts.run(dir, ['show', `${root.sha}:${file}`]));
        } catch {
          return null;
        }
      })();
      this.files.set(key, hit);
    }
    return hit;
  }

  /** Every path at the root's base commit. */
  async listFiles(root: BaseRoot): Promise<string[]> {
    let hit = this.trees.get(root);
    if (!hit) {
      hit = (async () => {
        const { dir, error } = await this.open(root);
        if (!dir) throw new Error(error ?? 'no checkout');
        const out = await this.opts.run(dir, ['ls-tree', '-r', '--name-only', '-z', root.sha]);
        return out.split('\0').filter(Boolean);
      })();
      this.trees.set(root, hit);
    }
    return hit;
  }

  /**
   * The path a claim means: as written when it exists at the base, else the
   * one path that ends with it (a bare file name, or a path missing its first
   * directories). Null when none or several match.
   */
  async resolvePath(root: BaseRoot, file: string): Promise<string | null> {
    const tree = await this.listFiles(root);
    if (tree.includes(file)) return file;
    const tail = `/${file.replace(/^\/+/, '')}`;
    const matches = tree.filter((p) => p.endsWith(tail));
    return matches.length === 1 ? matches[0]! : null;
  }

  /** `file:line` hits of a whole word at the root's base commit, at most `max`. */
  async grep(root: BaseRoot, word: string, max = 3): Promise<{ file: string; line: number }[]> {
    const { dir } = await this.open(root);
    if (!dir) return [];
    let out: string;
    try {
      out = await this.opts.run(dir, ['grep', '-n', '-w', '-F', '-I', '--max-count', '1', '-e', word, root.sha, '--']);
    } catch {
      return [];
    }
    const hits: { file: string; line: number }[] = [];
    const prefix = `${root.sha}:`;
    for (const raw of out.split('\n')) {
      if (!raw.startsWith(prefix)) continue;
      const m = /^(.*?):(\d+):/.exec(raw.slice(prefix.length));
      if (m) hits.push({ file: m[1]!, line: Number(m[2]) });
      if (hits.length >= max) break;
    }
    return hits;
  }

  /** Checks one claimed site against every root of its repository; verified when one root holds it. */
  async verify(claim: BaseClaim): Promise<BaseEvidence> {
    const { file: cleaned, line: suffixLine } = cleanBasePath(claim.file);
    const line = claim.line ?? suffixLine;
    const quote = squash(claim.quote ?? '');
    const repo = this.resolveRepo(claim.repo);
    const base = { file: cleaned, line, quote };
    if (!repo) {
      return {
        repo: claim.repo ?? '', ...base, base_branch: null, base_sha: null, verified: false,
        reason: claim.repo ? `${claim.repo} is not a repository of this ticket with a known base` : 'no repository named',
      };
    }
    const roots = this.rootsOf(repo);
    let first: BaseEvidence | null = null;
    for (const root of roots) {
      const result = await this.verifyAt(root, cleaned, line, quote);
      if (result.verified) return result;
      first ??= result;
    }
    return first ?? { repo, ...base, base_branch: null, base_sha: null, verified: false, reason: `no base commit is recorded for ${repo}` };
  }

  private async verifyAt(root: BaseRoot, file: string, line: number | null, quote: string): Promise<BaseEvidence> {
    const out = (reason: string | null, resolved = file): BaseEvidence => ({
      repo: root.repo, file: resolved, line, quote, base_branch: root.baseBranch, base_sha: root.sha, verified: reason === null, reason,
    });
    const at = `${root.baseBranch}@${root.sha.slice(0, 7)}`;
    try {
      const resolved = await this.resolvePath(root, file);
      if (!resolved) return out(`${file} does not exist at ${at}`);
      const lines = await this.readFile(root, resolved);
      if (!lines) return out(`${resolved} could not be read at ${at}`, resolved);
      return out(checkQuote(lines, line, quote), resolved);
    } catch (err) {
      return out((err as Error).message.split('\n')[0] ?? 'the base could not be read');
    }
  }

  /** Prunes the checkouts this reader fetched. */
  close(): void {
    for (const dir of this.fetched.splice(0)) {
      try {
        this.opts.prune(dir);
      } catch (err) {
        this.onLog('warn', `base check: could not remove ${dir}: ${(err as Error).message}`);
      }
    }
  }
}

// --- hints from the slice reviews ------------------------------------------------------

/** A slice review's note that a requirement's code is already on the base. */
export interface BaseHint {
  repo: string;
  branch: string;
  requirement_id: number | null;
  text: string;
  note: string;
  locations: { file: string; line: number }[];
  words: string[];
}

const ON_BASE = /\b(already|on main|on master|on the base|on base|before this|existed|exists on|from code on)\b/i;
const LOCATION = /([A-Za-z0-9_.\-/]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)/g;
const WORD = /`([A-Za-z_][A-Za-z0-9_.]{3,80})`|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b|\b([a-z]+(?:[A-Z][a-z0-9]+)+)\b/g;
const MAX_WORDS_PER_HINT = 3;

/**
 * The rows of the slice reviews that say the requirement is not in their diff
 * because it already exists on the base, with the `file:line` sites and the
 * identifiers they name.
 */
export function collectBaseHints(
  reviews: readonly { repo: string; branch: string; requirements: readonly RequirementRow[] }[],
): BaseHint[] {
  const hints: BaseHint[] = [];
  for (const r of reviews) {
    for (const q of r.requirements) {
      if (q.status === 'met' || !q.evidence || !ON_BASE.test(q.evidence)) continue;
      const locations: { file: string; line: number }[] = [];
      for (const m of q.evidence.matchAll(LOCATION)) {
        const file = m[1]!.replace(/^\.?\/+/, '');
        if (!locations.some((l) => l.file === file && l.line === Number(m[2]))) locations.push({ file, line: Number(m[2]) });
      }
      const words: string[] = [];
      const withoutPaths = q.evidence.replace(LOCATION, ' ');
      for (const m of withoutPaths.matchAll(WORD)) {
        const word = (m[1] ?? m[2] ?? m[3])!;
        if (word.includes('/') || /\.(py|ts|tsx|js|md)$/.test(word) || words.includes(word)) continue;
        words.push(word);
        if (words.length >= MAX_WORDS_PER_HINT) break;
      }
      if (locations.length === 0 && words.length === 0) continue;
      hints.push({
        repo: r.repo, branch: r.branch, requirement_id: q.requirement_id, text: q.text, note: q.evidence, locations, words,
      });
    }
  }
  return hints;
}

const EXCERPT_RADIUS = 5;
const MAX_EXCERPTS = 40;

/**
 * The `{{BASE}}` block of the coverage prompt: per hint, the lines at the
 * base that the slice review pointed at (or where the identifiers it named
 * are defined), numbered, so the pass can quote them exactly.
 */
export async function renderBaseExcerpts(hints: readonly BaseHint[], reader: BaseReader | null): Promise<string> {
  if (!reader || reader.roots.length === 0) return 'No base commit is known for this ticket: `already_on_base` cannot be verified.';
  if (hints.length === 0) return 'No branch review said a requirement is already on the base.';
  const parts: string[] = [];
  let excerpts = 0;
  for (const hint of hints) {
    const id = hint.requirement_id ? `R${hint.requirement_id}` : `"${hint.text.slice(0, 80)}"`;
    const lines = [`### ${id}, per the review of \`${hint.repo}#${hint.branch}\``, '', `Review note: ${squash(hint.note)}`];
    const seen = new Set<string>();
    const sites: { root: BaseRoot; file: string; line: number }[] = [];
    // A site is looked up in the hint's repository first, then in the others.
    const order = [hint.repo, ...reader.repos().filter((r) => r !== hint.repo)];
    for (const loc of hint.locations) {
      for (const repo of order) {
        const root = reader.rootsOf(repo)[0];
        if (!root) continue;
        const file = await reader.resolvePath(root, loc.file).catch(() => null);
        if (file) {
          sites.push({ root, file, line: loc.line });
          break;
        }
      }
    }
    if (sites.length === 0) {
      for (const word of hint.words) {
        for (const repo of order) {
          const root = reader.rootsOf(repo)[0];
          if (!root) continue;
          const hits = await reader.grep(root, word);
          if (hits.length) {
            sites.push(...hits.map((h) => ({ root, file: h.file, line: h.line })));
            break;
          }
        }
      }
    }
    for (const site of sites) {
      const key = `${site.root.repo}\0${site.file}\0${site.line}`;
      if (seen.has(key) || excerpts >= MAX_EXCERPTS) continue;
      seen.add(key);
      const content = await reader.readFile(site.root, site.file).catch(() => null);
      if (!content) continue;
      const from = Math.max(1, site.line - EXCERPT_RADIUS);
      const to = Math.min(content.length, site.line + EXCERPT_RADIUS);
      if (from > to) continue;
      excerpts += 1;
      lines.push(
        '',
        `\`${site.root.repo}\` \`${site.file}\` at ${site.root.baseBranch}@${site.root.sha.slice(0, 7)}, lines ${from}-${to}:`,
        '```text',
        ...content.slice(from - 1, to).map((text, i) => `${String(from + i).padStart(5)}| ${text.slice(0, 240)}`),
        '```',
      );
    }
    if (seen.size === 0) lines.push('', 'None of the named sites exist at the base.');
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
