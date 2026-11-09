/**
 * The cross-repository contract check of the coverage pass: per branch, the
 * diff hunks of its contract files (serializers, views, URL maps, API
 * services, models of the response), read from the branch's checkout, so the
 * pass can compare what the backend returns with what the frontend reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { runInSandbox } from './gitSandbox.js';
import type { AnchorStatus, ContractIssue, ContractSite, ReviewFileRow, ReviewRow } from './types.js';

/**
 * Used for a repository without `contractGlobs` in `RULES_DIR/<repo>.json`:
 * backend and frontend files alike. A name may carry a prefix
 * (`hub_views.py`, `ato_serializers.py`); a `!` glob excludes (tests).
 */
export const DEFAULT_CONTRACT_GLOBS: readonly string[] = Object.freeze([
  '**/*serializers*.py',
  '**/*views*.py',
  '**/*urls*.py',
  '**/*schemas*.py',
  'src/Services/**',
  'src/Models/**',
  'src/**/*Models.ts',
  'src/**/*Service.ts',
  '!**/tests/**',
  '!**/test_*.py',
  '!**/*.test.*',
]);

/** At most this many diff lines per branch go into the prompt. */
export const MAX_CONTRACT_LINES = 400;

const rulesFileSchema = z.object({ contractGlobs: z.array(z.string().min(1)).optional() }).passthrough();

/**
 * The contract globs of a repository: `contractGlobs` from `RULES_DIR/<repo>.json`
 * when that file sets it, else the defaults. A file that cannot be read or
 * parsed counts as absent.
 */
export function contractGlobsFor(repo: string, rulesDir: string = config.RULES_DIR): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return [...DEFAULT_CONTRACT_GLOBS];
  const file = path.join(rulesDir, `${repo}.json`);
  try {
    if (!fs.existsSync(file)) return [...DEFAULT_CONTRACT_GLOBS];
    const parsed = rulesFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success && parsed.data.contractGlobs) return parsed.data.contractGlobs;
  } catch {
    // Fall through to the defaults.
  }
  return [...DEFAULT_CONTRACT_GLOBS];
}

/** `**` crosses directories, `*` and `?` do not; `**\/` also matches no directory. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The changed files that match a glob and no `!` glob, by their HEAD path (a
 * deleted file by its path, a rename by either path).
 */
export function matchContractFiles(files: readonly Pick<ReviewFileRow, 'path' | 'old_path'>[], globs: readonly string[]): string[] {
  const include = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  const hit = (p: string | null | undefined) =>
    Boolean(p) && include.some((re) => re.test(p!)) && !exclude.some((re) => re.test(p!));
  return files.filter((f) => hit(f.path) || hit(f.old_path)).map((f) => f.path);
}

/** Runs `git <args>` in a checkout and returns stdout; throws when git fails. */
export type DiffRunner = (dir: string, args: string[]) => Promise<string>;

/** git in the sandbox, like every other git call on a checkout. */
export const sandboxDiff: DiffRunner = async (dir, args) => {
  const root = path.join(config.DATA_DIR, 'checkouts');
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`checkout outside the data dir: ${dir}`);
  const result = await runInSandbox(['git', ...args], { workdir: `/work/${rel.split(path.sep).join('/')}`, timeoutMs: 120_000 });
  return result.stdout;
};

export interface ContractHunks {
  /** The contract files of the branch's diff. */
  files: string[];
  /** Their unified diff, capped at `MAX_CONTRACT_LINES`. */
  diff: string;
  truncated: boolean;
  /** Why there is no diff, or what was left out. */
  note: string | null;
}

/** Caps a unified diff and names the files whose hunks were cut. */
export function capDiff(diff: string, maxLines = MAX_CONTRACT_LINES): { text: string; truncated: boolean; cut: string[] } {
  const lines = diff.replace(/\n$/, '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), truncated: false, cut: [] };
  const fileOf = (line: string) => /^diff --git a\/(.+?) b\//.exec(line)?.[1] ?? null;
  const kept = lines.slice(0, maxLines);
  const cut = new Set<string>();
  let current: string | null = null;
  for (const line of kept) current = fileOf(line) ?? current;
  if (current) cut.add(current);
  for (const line of lines.slice(maxLines)) {
    const f = fileOf(line);
    if (f) cut.add(f);
  }
  return { text: kept.join('\n'), truncated: true, cut: [...cut] };
}

/**
 * The contract hunks of one finished review, from its checkout. Without the
 * checkout, the commits, or any contract file, the note says why and there is
 * no diff.
 */
export async function collectContractHunks(
  review: Pick<ReviewRow, 'repo' | 'base_sha' | 'head_sha'>,
  files: readonly ReviewFileRow[],
  dir: string | null,
  opts: { globs?: readonly string[]; run?: DiffRunner; maxLines?: number } = {},
): Promise<ContractHunks> {
  const matched = matchContractFiles(files, opts.globs ?? contractGlobsFor(review.repo));
  if (matched.length === 0) return { files: [], diff: '', truncated: false, note: 'no contract file changed' };
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
    return { files: matched, diff: '', truncated: false, note: 'the checkout is no longer on disk; only the file names are known' };
  }
  if (!review.base_sha || !review.head_sha) {
    return { files: matched, diff: '', truncated: false, note: 'the review recorded no base or head commit' };
  }
  const paths = new Set<string>();
  for (const f of files) {
    if (!matched.includes(f.path)) continue;
    paths.add(f.path);
    if (f.old_path) paths.add(f.old_path);
  }
  let raw: string;
  try {
    raw = await (opts.run ?? sandboxDiff)(dir, [
      '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '-M', '-U3',
      `${review.base_sha}..${review.head_sha}`, '--', ...paths,
    ]);
  } catch (err) {
    return { files: matched, diff: '', truncated: false, note: `git diff failed: ${(err as Error).message.split('\n')[0]}` };
  }
  const capped = capDiff(raw, opts.maxLines ?? MAX_CONTRACT_LINES);
  return {
    files: matched,
    diff: capped.text,
    truncated: capped.truncated,
    note: capped.truncated
      ? `truncated at ${opts.maxLines ?? MAX_CONTRACT_LINES} lines; not shown in full: ${capped.cut.join(', ')} (read them in that branch's changed files)`
      : null,
  };
}

/** The `{{CONTRACT}}` block of the coverage prompt. */
export function renderContractHunks(branches: readonly { repo: string; branch: string; hunks: ContractHunks | null }[]): string {
  const parts = branches.map(({ repo, branch, hunks }) => {
    const head = `### \`${repo}#${branch}\``;
    if (!hunks) return `${head}\n\nNot reviewed: no diff.`;
    const lines = [head, ''];
    lines.push(hunks.files.length
      ? `Contract files changed: ${hunks.files.map((f) => `\`${f}\``).join(', ')}`
      : 'No contract file changed.');
    if (hunks.diff) lines.push('', '```diff', hunks.diff, '```');
    if (hunks.note && hunks.files.length) lines.push('', `Note: ${hunks.note}.`);
    return lines.join('\n');
  });
  return parts.length ? parts.join('\n\n') : 'No branches.';
}

// --- the answer -----------------------------------------------------------------

function severity(value: unknown): 'major' | 'minor' {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'major' || v === 'blocker' || v === 'critical' || v === 'high' ? 'major' : 'minor';
}

const siteSchema = z.object({
  repo: z.string().nullish().transform((v) => v?.trim() || null),
  branch: z.string().min(1),
  file: z.string().min(1),
  line: z.coerce.number().int().nullish().transform((v) => v ?? null),
});

export const contractIssuesSchema = z
  .array(z.object({
    problem: z.string().min(1),
    severity: z.unknown().optional().transform(severity),
    sites: z.array(siteSchema).nullish().transform((v) => v ?? []),
  }))
  .nullish()
  .transform((v) => v ?? []);

export type RawContractIssue = z.infer<typeof contractIssuesSchema>[number];

/** Where a site points: the group branch, and a checker for its locations. */
export interface SiteTarget {
  repo: string;
  branch: string;
  check: (file: string, line: number | null) => { file: string; line: number | null; anchor_status: AnchorStatus };
}

const SHOWN: ReadonlySet<AnchorStatus> = new Set(['ok', 'off_diff', 'unverified']);

/**
 * The issues, held to the group: a site must name a reviewed branch of the
 * group, and its location is checked in that branch. An issue keeps only the
 * sites that resolve, and is dropped unless at least two of them point at a
 * real place: a mismatch has to be shown at both ends.
 */
export function normalizeContractIssues(
  raw: readonly RawContractIssue[],
  resolve: (repo: string | null, branch: string) => SiteTarget | undefined,
  onLog: (message: string) => void = () => {},
): ContractIssue[] {
  const out: ContractIssue[] = [];
  for (const issue of raw) {
    const sites: ContractSite[] = [];
    for (const s of issue.sites) {
      const target = resolve(s.repo, s.branch);
      if (!target) {
        onLog(`contract: dropped a site in ${s.repo ?? '?'}#${s.branch}: not a reviewed branch of this ticket`);
        continue;
      }
      const checked = target.check(s.file, s.line);
      if (sites.some((x) => x.repo === target.repo && x.branch === target.branch && x.file === checked.file && x.line === checked.line)) continue;
      sites.push({ repo: target.repo, branch: target.branch, ...checked });
    }
    const real = sites.filter((s) => SHOWN.has(s.anchor_status));
    if (real.length < 2) {
      onLog(`contract: dropped "${issue.problem.slice(0, 80)}": fewer than two sites that exist`);
      continue;
    }
    out.push({ problem: issue.problem.trim(), severity: issue.severity, sites: sites.slice(0, 8) });
  }
  return out.slice(0, 30);
}

export function parseContractIssues(json: string | null | undefined): ContractIssue[] | null {
  if (json === null || json === undefined) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as ContractIssue[]) : null;
  } catch {
    return null;
  }
}
