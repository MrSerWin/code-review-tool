/**
 * Local clones: reviewing branches that are not pushed yet.
 *
 * Everything in this file only ever READS the user's clone. Every git command
 * here is one of rev-parse, symbolic-ref, for-each-ref, merge-base, rev-list,
 * log --walk-reflogs, status, diff, ls-files,
 * run through execFile with an argv (never a shell) and GIT_OPTIONAL_LOCKS=0 so
 * even `status` does not opportunistically rewrite the index. Anything that
 * writes (clone, fetch, checkout, commit) happens in the review checkout inside
 * the Docker sandbox, which sees the clone through a read-only mount.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_REPOS, assertAllowedRepo, config } from './config.js';
import { assertSafeName, isSafeName } from './gitNames.js';
import type { BaseReason, ResolvedTarget } from './types.js';

const REPO_NAME_SAFE = /^[A-Za-z0-9._-]+$/;

export const LOCAL_PREFIX = 'local:';

// ---------------------------------------------------------------------------
// Configuration

/** `name=/abs/path,other=/abs/path` → map. Pure; throws on a malformed entry. */
export function parseLocalReposOverride(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw?.trim()) return out;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`LOCAL_REPOS entry must look like name=/abs/path: ${JSON.stringify(trimmed)}`);
    const name = trimmed.slice(0, eq).trim();
    const dir = trimmed.slice(eq + 1).trim();
    if (!path.isAbsolute(dir)) throw new Error(`LOCAL_REPOS path for ${name} must be absolute: ${JSON.stringify(dir)}`);
    out.set(name, path.resolve(dir));
  }
  return out;
}

/**
 * The configured path of every allowed repository that has one. Only names in
 * `allowed` are ever considered, so the allowlist stays the boundary: nothing
 * but `<dir>/<allowed name>` (or an explicit override for an allowed name) is
 * ever read. Pure: existence is checked separately.
 */
export function configuredLocalPaths(
  allowed: readonly string[],
  dir: string | undefined,
  overrides: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const root = dir ? path.resolve(dir) : null;
  for (const name of allowed) {
    if (!REPO_NAME_SAFE.test(name) || name === '.' || name === '..') continue;
    const override = overrides.get(name);
    if (override) {
      out.set(name, override);
      continue;
    }
    if (!root) continue;
    const candidate = path.resolve(root, name);
    // Belt and braces: the child must sit directly under the root.
    if (path.dirname(candidate) !== root) continue;
    out.set(name, candidate);
  }
  return out;
}

let cachedPaths: Map<string, string> | null = null;

/** The configured local path of every allowed repository, from the environment. */
export function localRepoPaths(): Map<string, string> {
  if (!cachedPaths) {
    cachedPaths = configuredLocalPaths(
      ALLOWED_REPOS,
      config.LOCAL_REPOS_DIR,
      parseLocalReposOverride(config.LOCAL_REPOS),
    );
  }
  return cachedPaths;
}

// ---------------------------------------------------------------------------
// Read-only git on the host

export interface GitReadResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/**
 * Runs one read-only git command in a local clone. The argv is fixed by the
 * callers in this file; it is never assembled from a shell string.
 */
export function gitRead(repoPath: string, args: string[], timeoutMs = 60_000): Promise<GitReadResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '-C', repoPath,
        // Never let a user-level fsmonitor hook or pager run on our behalf.
        '-c', 'core.fsmonitor=false',
        '--no-pager',
        ...args,
      ],
      {
        encoding: 'buffer',
        timeout: timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: 'C',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
          : 0;
        resolve({ stdout: stdout as Buffer, stderr: (stderr as Buffer).toString('utf8'), code });
      },
    );
  });
}

async function gitText(repoPath: string, args: string[]): Promise<string> {
  const result = await gitRead(repoPath, args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed in ${repoPath}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.toString('utf8');
}

/** True when `dir` is itself the top level of a git work tree (not a sub-folder of one). */
export async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const top = (await gitText(dir, ['rev-parse', '--show-toplevel'])).trim();
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * The local clone of an allowed repository, or a clear error. The path must
 * be a plain directory mountable into Docker (no `,` or `:` in it).
 */
export async function localRepoPath(repo: string, paths: Map<string, string> = localRepoPaths()): Promise<string> {
  if (!REPO_NAME_SAFE.test(repo) || repo === '.' || repo === '..') {
    throw new Error(`Unsafe repository name: ${JSON.stringify(repo)}`);
  }
  assertAllowedRepo(repo);
  const dir = paths.get(repo);
  if (!dir) {
    throw new Error(`No local clone is configured for ${repo}. Set LOCAL_REPOS_DIR (or LOCAL_REPOS) in .env.`);
  }
  if (/[,:]/.test(dir)) throw new Error(`Local clone path of ${repo} cannot contain "," or ":": ${dir}`);
  if (!(await isGitWorkTree(dir))) throw new Error(`Local clone of ${repo} is not a git work tree: ${dir}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Pure helpers

export interface LocalInput {
  repo: string;
  /** null: the clone's currently checked-out branch. */
  branch: string | null;
}

/** `local:<repo>` or `local:<repo>#<branch>`; null when the input is not a local one. */
export function parseLocalInput(raw: string): LocalInput | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(LOCAL_PREFIX)) return null;
  const rest = trimmed.slice(LOCAL_PREFIX.length);
  const hash = rest.indexOf('#');
  const repo = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
  const branch = hash >= 0 ? rest.slice(hash + 1).trim() : null;
  if (!repo || !REPO_NAME_SAFE.test(repo) || repo === '.' || repo === '..') {
    throw new Error(`Unsafe or missing repository in ${JSON.stringify(trimmed)}; use local:<repo>#<branch>`);
  }
  if (branch !== null) {
    if (!branch) throw new Error(`Missing branch after "#" in ${JSON.stringify(trimmed)}`);
    assertSafeName('branch', branch);
  }
  return { repo, branch };
}

/**
 * The repository's default branch as the clone knows it: the target of
 * `refs/remotes/origin/HEAD`, else `origin/main`, else `origin/master`, else a
 * local `main` or `master`. `refs` are full ref names.
 */
export function pickBaseBranch(originHead: string | null, refs: readonly string[]): string | null {
  const set = new Set(refs);
  const head = originHead?.trim();
  if (head?.startsWith('refs/remotes/origin/')) {
    const name = head.slice('refs/remotes/origin/'.length);
    if (name && name !== 'HEAD' && isSafeName(name)) return name;
  }
  for (const name of ['main', 'master']) {
    if (set.has(`refs/remotes/origin/${name}`)) return name;
  }
  for (const name of ['main', 'master']) {
    if (set.has(`refs/heads/${name}`)) return name;
  }
  return null;
}

export interface UpstreamTrack {
  ahead: number;
  behind: number;
  /** The upstream branch was deleted on the remote. */
  gone: boolean;
}

/** Parses `%(upstream:track)`: "", "[ahead 2]", "[behind 1]", "[ahead 2, behind 1]", "[gone]". */
export function parseUpstreamTrack(track: string): UpstreamTrack {
  const text = track.trim();
  const ahead = /ahead (\d+)/.exec(text);
  const behind = /behind (\d+)/.exec(text);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: /\bgone\b/.test(text),
  };
}

/** Unpushed: no upstream at all, an upstream that is gone, or local commits the upstream lacks. */
export function isUnpushed(upstream: string, track: UpstreamTrack): boolean {
  return !upstream.trim() || track.gone || track.ahead > 0;
}

// ---------------------------------------------------------------------------
// Clone inspection (read-only)

export async function currentBranch(repoPath: string): Promise<string | null> {
  const result = await gitRead(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (result.code !== 0) return null;
  return result.stdout.toString('utf8').trim() || null;
}

export async function branchTip(repoPath: string, branch: string): Promise<string> {
  assertSafeName('branch', branch);
  const result = await gitRead(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  const sha = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Branch ${JSON.stringify(branch)} does not exist in the local clone`);
  }
  return sha;
}

export async function headSha(repoPath: string): Promise<string | null> {
  const result = await gitRead(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

export async function detectBaseBranch(repoPath: string): Promise<string> {
  const head = await gitRead(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const originHead = head.code === 0 ? head.stdout.toString('utf8').trim() : null;
  const refs = (await gitText(repoPath, [
    'for-each-ref', '--format=%(refname)',
    'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master',
  ])).split('\n').map((l) => l.trim()).filter(Boolean);
  const base = pickBaseBranch(originHead, refs);
  if (!base) throw new Error(`Could not determine the default branch of ${repoPath}`);
  return base;
}

/** Whether `refs/heads/<name>` / `refs/remotes/origin/<name>` exist in the clone. */
export async function branchRefs(repoPath: string, name: string): Promise<{ localHead: boolean; originRef: boolean }> {
  assertSafeName('branch', name);
  const out = await gitText(repoPath, [
    'for-each-ref', '--format=%(refname)', `refs/heads/${name}`, `refs/remotes/origin/${name}`,
  ]);
  const refs = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  return { localHead: refs.has(`refs/heads/${name}`), originRef: refs.has(`refs/remotes/origin/${name}`) };
}

export async function isDirty(repoPath: string): Promise<boolean> {
  const out = await gitText(repoPath, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all']);
  return out.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Parent-branch detection (stacked branches)

/** Why a base was picked: an ancestor branch, a branch the reviewed one forked from, or the default. */
export type ParentReason = 'ancestor' | 'fork-point' | 'default';

export interface ParentCandidate {
  /** Short branch name (`feat/a`), never a full ref. */
  name: string;
  /** Commits on the reviewed branch that the candidate lacks (`rev-list --count <from>..<branch>`). */
  distance: number;
  /** Committer date of the candidate's tip, seconds since the epoch; breaks ties (newest wins). */
  date: number;
}

export interface ParentFacts {
  defaultBase: string;
  /** Distance from the default branch's tip when that tip is an ancestor of the branch, else null. */
  defaultAncestorDistance: number | null;
  /** Distance from the merge base with the default branch; the distance reported for the fallback. */
  defaultForkDistance: number;
  /** Non-default branches whose tip is an ancestor of the reviewed branch (and not of the default). */
  ancestors: ParentCandidate[];
  /**
   * Non-default branches the reviewed one forked from after they moved on:
   * their merge base with it is strictly newer than the default branch's.
   */
  forkPoints: ParentCandidate[];
}

export interface ParentResult {
  base: string;
  reason: ParentReason;
  distance: number;
}

/** Closest first; on equal distance the newest tip wins. */
function byCloseness(a: ParentCandidate, b: ParentCandidate): number {
  return a.distance - b.distance || b.date - a.date;
}

/**
 * The pure half of parent detection. The closest ancestor wins; the default
 * branch only wins when it is strictly closer than every other ancestor. Only
 * when no other branch is an ancestor are fork points considered, closest
 * first. Otherwise: the default branch.
 */
export function chooseParent(facts: ParentFacts): ParentResult {
  const ancestor = [...facts.ancestors].sort(byCloseness)[0];
  if (ancestor) {
    const def = facts.defaultAncestorDistance;
    if (def !== null && def < ancestor.distance) {
      return { base: facts.defaultBase, reason: 'default', distance: def };
    }
    return { base: ancestor.name, reason: 'ancestor', distance: ancestor.distance };
  }
  const fork = [...facts.forkPoints].sort(byCloseness)[0];
  if (fork) return { base: fork.name, reason: 'fork-point', distance: fork.distance };
  return {
    base: facts.defaultBase,
    reason: 'default',
    distance: facts.defaultAncestorDistance ?? facts.defaultForkDistance,
  };
}

/**
 * True when `candidate` was cut from the reviewed branch rather than the other
 * way round: the candidate was created at `candidateCreatedAt`, a commit of the
 * branch that is strictly newer than the branch's own creation point. Unknown
 * creation points (no reflog) never exclude anything.
 */
export function looksLikeChild(
  branchCreatedAt: string | null,
  candidateCreatedAt: string | null,
  facts: { createdAfterBranchStart: boolean; onBranchHistory: boolean },
): boolean {
  if (!branchCreatedAt || !candidateCreatedAt || branchCreatedAt === candidateCreatedAt) return false;
  return facts.createdAfterBranchStart && facts.onBranchHistory;
}

/** Default-branch refs that exist in the clone: the local head and/or origin's. */
async function defaultRefs(repoPath: string, defaultBase: string): Promise<string[]> {
  const { localHead, originRef } = await branchRefs(repoPath, defaultBase);
  const refs: string[] = [];
  if (localHead) refs.push(`refs/heads/${defaultBase}`);
  if (originRef) refs.push(`refs/remotes/origin/${defaultBase}`);
  return refs;
}

async function revCount(repoPath: string, range: string): Promise<number> {
  return Number((await gitText(repoPath, ['rev-list', '--count', range])).trim()) || 0;
}

async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  return (await gitRead(repoPath, ['merge-base', '--is-ancestor', a, b])).code === 0;
}

async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  const r = await gitRead(repoPath, ['merge-base', a, b]);
  const sha = r.stdout.toString('utf8').trim();
  return r.code === 0 && sha ? sha : null;
}

/** The commit a branch pointed to when it was created: its oldest reflog entry, if the reflog still has it. */
async function creationPoint(repoPath: string, ref: string): Promise<string | null> {
  const r = await gitRead(repoPath, ['log', '--walk-reflogs', '--format=%H', ref, '--']);
  if (r.code !== 0) return null;
  const lines = r.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Candidates considered per pass; repos with hundreds of branches only look at the most recent. */
const PARENT_CANDIDATE_CAP = 150;
/** Candidates checked against the "cut from the branch" guard, closest first. */
const CHILD_GUARD_CAP = 12;

interface RefLine { ref: string; name: string; sha: string; date: number }

function parseRefLines(out: string): RefLine[] {
  return out.split('\n').map((line) => {
    const [ref, sha, date] = line.split('\0');
    if (!ref || !sha) return null;
    const name = ref.startsWith('refs/heads/')
      ? ref.slice('refs/heads/'.length)
      : ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : '';
    return { ref, name, sha, date: Number(date) || 0 };
  }).filter((r): r is RefLine => r !== null && Boolean(r.name) && r.name !== 'HEAD' && isSafeName(r.name));
}

/**
 * The branch the reviewed one was most likely cut from, read-only. See
 * `chooseParent` for the ranking; this half gathers the facts:
 *
 * 1. Ancestors: `for-each-ref --merged <branch> --no-merged <default…>` over
 *    local heads and origin's branches (origin's only when there is no local
 *    head of that name) — branches whose tip the reviewed branch contains and
 *    which add something beyond the default branch. Distance is
 *    `rev-list --count <candidate>..<branch>`.
 * 2. Fork points (only if step 1 found none): local heads merged into neither
 *    the branch nor the default and not containing the branch. A candidate
 *    qualifies when `merge-base(candidate, branch)` is strictly newer than the
 *    default's merge base with the branch.
 *
 * Candidates the reflog shows were cut FROM the reviewed branch are dropped.
 */
export async function detectParentBranch(
  repoPath: string,
  branch: string,
  defaultBase: string,
): Promise<ParentResult> {
  assertSafeName('branch', branch);
  assertSafeName('base branch', defaultBase);
  const branchRef = `refs/heads/${branch}`;
  const tip = await branchTip(repoPath, branch);
  const defaults = branch === defaultBase ? [] : await defaultRefs(repoPath, defaultBase);
  const fmt = '--format=%(refname)%00%(objectname)%00%(committerdate:unix)';

  // Default branch: distance from its tip (when an ancestor) and from its merge base.
  let defaultAncestorDistance: number | null = null;
  let defaultMb: string | null = null;
  let defaultForkDistance = 0;
  for (const ref of defaults) {
    if (await isAncestor(repoPath, ref, branchRef)) {
      const d = await revCount(repoPath, `${ref}..${branchRef}`);
      if (defaultAncestorDistance === null || d < defaultAncestorDistance) defaultAncestorDistance = d;
    }
    const mb = await mergeBase(repoPath, ref, branchRef);
    if (!mb) continue;
    const d = await revCount(repoPath, `${mb}..${branchRef}`);
    if (defaultMb === null || d < defaultForkDistance) {
      defaultMb = mb;
      defaultForkDistance = d;
    }
  }
  if (defaults.length === 0) defaultForkDistance = await revCount(repoPath, branchRef);

  const noMergedDefault = defaults.flatMap((ref) => ['--no-merged', ref]);
  const skip = (name: string): boolean => name === branch || name === defaultBase;

  // Pass 1: ancestors, one for-each-ref call.
  const merged = parseRefLines(await gitText(repoPath, [
    'for-each-ref', '--sort=-committerdate', `--count=${PARENT_CANDIDATE_CAP * 2}`, fmt,
    '--merged', branchRef, ...noMergedDefault, 'refs/heads', 'refs/remotes/origin',
  ]));
  // A local head shadows origin's branch of the same name; an origin-only branch is still a candidate.
  const localHeads = new Set(
    parseRefLines(await gitText(repoPath, ['for-each-ref', fmt, 'refs/heads'])).map((r) => r.name),
  );
  const ancestorRefs = merged
    .filter((r) => !skip(r.name) && r.sha !== tip)
    .filter((r) => r.ref.startsWith('refs/heads/') || !localHeads.has(r.name))
    .slice(0, PARENT_CANDIDATE_CAP);
  const ancestors = await mapLimit(ancestorRefs, 8, async (r) => ({
    name: r.name, ref: r.ref, sha: r.sha, date: r.date,
    distance: await revCount(repoPath, `${r.ref}..${branchRef}`),
  }));

  const branchCreated = await creationPoint(repoPath, branchRef);
  const guard = async <C extends ParentCandidate & { ref: string }>(list: C[]): Promise<C[]> => {
    const sorted = [...list].sort(byCloseness);
    const kept: C[] = [];
    for (const [i, c] of sorted.entries()) {
      if (i >= CHILD_GUARD_CAP || !branchCreated) {
        kept.push(c);
        continue;
      }
      const created = c.ref.startsWith('refs/heads/') ? await creationPoint(repoPath, c.ref) : null;
      const child = created !== null && created !== branchCreated && looksLikeChild(branchCreated, created, {
        createdAfterBranchStart: await isAncestor(repoPath, branchCreated, created),
        onBranchHistory: await isAncestor(repoPath, created, branchRef),
      });
      if (!child) kept.push(c);
    }
    return kept;
  };

  const keptAncestors = await guard(ancestors);
  let forkPoints: (ParentCandidate & { ref: string })[] = [];
  if (keptAncestors.length === 0) {
    // Pass 2: branches that moved on after the reviewed one was cut from them.
    const others = parseRefLines(await gitText(repoPath, [
      'for-each-ref', '--sort=-committerdate', `--count=${PARENT_CANDIDATE_CAP}`, fmt,
      '--no-merged', branchRef, ...noMergedDefault, '--no-contains', branchRef, 'refs/heads',
    ])).filter((r) => !skip(r.name));
    const qualified = await mapLimit(others, 8, async (r) => {
      const mb = await mergeBase(repoPath, r.ref, branchRef);
      if (!mb || mb === tip || mb === defaultMb) return null;
      if (defaultMb && !(await isAncestor(repoPath, defaultMb, mb))) return null;
      return { name: r.name, ref: r.ref, date: r.date, distance: await revCount(repoPath, `${mb}..${branchRef}`) };
    });
    forkPoints = await guard(qualified.filter((q): q is NonNullable<typeof q> => q !== null));
  }

  return chooseParent({
    defaultBase,
    defaultAncestorDistance,
    defaultForkDistance,
    ancestors: keptAncestors,
    forkPoints,
  });
}

/** Where the review checkout takes its base from. */
export type BaseSource = 'github' | 'local-head' | 'local-origin';

/**
 * The repository's default branch comes fresh from GitHub (the clone's copy is
 * only a fallback). Any other base may be unpushed, so it comes from the clone:
 * its local head, else its copy of origin's branch.
 */
export function planBaseSource(
  base: string,
  defaultBase: string | null,
  refs: { localHead: boolean; originRef: boolean },
): BaseSource {
  if (defaultBase !== null && base === defaultBase) return 'github';
  if (refs.localHead) return 'local-head';
  if (refs.originRef) return 'local-origin';
  throw new Error(`Base branch ${JSON.stringify(base)} exists neither locally nor as origin/${base} in the local clone`);
}

// ---------------------------------------------------------------------------
// Resolution

export interface LocalResolveOptions {
  includeWorkingTree?: boolean;
  /** An explicit base branch; absent means the detected parent of the branch. */
  baseBranch?: string;
  paths?: Map<string, string>;
}

/** Checks that a chosen base can serve as one: a safe name, present in the clone, not the branch itself. */
export async function assertUsableBase(repoPath: string, branch: string, base: string): Promise<void> {
  assertSafeName('base branch', base);
  if (base === branch) throw new Error(`The base branch cannot be the reviewed branch itself (${branch})`);
  const refs = await branchRefs(repoPath, base);
  if (!refs.localHead && !refs.originRef) {
    throw new Error(`Base branch ${JSON.stringify(base)} exists neither locally nor as origin/${base} in the local clone`);
  }
}

/** Turns `local:<repo>[#<branch>]` into a target, validated against the clone. */
export async function resolveLocalTarget(input: LocalInput, options: LocalResolveOptions = {}): Promise<ResolvedTarget> {
  const repoPath = await localRepoPath(input.repo, options.paths);
  const checkedOut = await currentBranch(repoPath);
  const branch = input.branch ?? checkedOut;
  if (!branch) {
    throw new Error(`The local clone of ${input.repo} has a detached HEAD; name the branch: local:${input.repo}#<branch>`);
  }
  assertSafeName('branch', branch);
  await branchTip(repoPath, branch);
  if (options.includeWorkingTree && branch !== checkedOut) {
    throw new Error(
      `Uncommitted changes can only be included for the checked-out branch` +
        ` (${checkedOut ?? 'detached HEAD'}), not ${branch}.`,
    );
  }
  const defaultBase = await detectBaseBranch(repoPath);
  assertSafeName('base branch', defaultBase);

  let baseBranch: string;
  let baseReason: BaseReason;
  let baseDistance: number | undefined;
  const chosen = options.baseBranch?.trim();
  if (chosen) {
    await assertUsableBase(repoPath, branch, chosen);
    baseBranch = chosen;
    baseReason = 'chosen';
  } else {
    const parent = await detectParentBranch(repoPath, branch, defaultBase);
    baseBranch = parent.base;
    baseReason = parent.reason === 'default' ? 'default' : 'parent';
    baseDistance = parent.distance;
  }
  return {
    repo: input.repo,
    branch,
    baseBranch,
    prNumber: null,
    source: 'local',
    includeWorkingTree: Boolean(options.includeWorkingTree),
    baseReason,
    ...(baseDistance !== undefined ? { baseDistance } : {}),
  };
}

/** For the UI: the detected parent of one branch of a configured clone. */
export async function describeParent(repo: string, branch: string, paths?: Map<string, string>): Promise<{
  branch: string; base: string; reason: ParentReason; distance: number; defaultBase: string;
}> {
  assertSafeName('branch', branch);
  const repoPath = await localRepoPath(repo, paths);
  await branchTip(repoPath, branch);
  const defaultBase = await detectBaseBranch(repoPath);
  const parent = await detectParentBranch(repoPath, branch, defaultBase);
  return { branch, base: parent.base, reason: parent.reason, distance: parent.distance, defaultBase };
}

// ---------------------------------------------------------------------------
// Listing for the UI

export interface LocalBranchInfo {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  unpushed: boolean;
  lastCommit: { sha: string; subject: string; date: string };
}

export interface LocalRepoInfo {
  repo: string;
  path: string;
  currentBranch: string | null;
  baseBranch: string | null;
  dirty: boolean;
  branches: LocalBranchInfo[];
}

const BRANCH_CAP = 500;
const FIELD = '%00';

/** One `for-each-ref` line: name, upstream, track, sha, date, subject — NUL separated. */
export function parseBranchLine(line: string): LocalBranchInfo | null {
  const [name, upstream, track, sha, date, ...subject] = line.split('\0');
  if (!name || !sha) return null;
  const parsed = parseUpstreamTrack(track ?? '');
  const up = (upstream ?? '').trim();
  return {
    name,
    upstream: up || null,
    ahead: parsed.ahead,
    behind: parsed.behind,
    unpushed: isUnpushed(up, parsed),
    lastCommit: { sha, subject: subject.join('\0'), date: date ?? '' },
  };
}

async function listBranches(repoPath: string, current: string | null): Promise<LocalBranchInfo[]> {
  const format = [
    '%(refname:lstrip=2)', '%(upstream:lstrip=2)', '%(upstream:track)', '%(objectname)',
    '%(committerdate:iso-strict)', '%(subject)',
  ].join(FIELD);
  const run = async (patterns: string[], count?: number): Promise<LocalBranchInfo[]> => {
    const args = ['for-each-ref', '--sort=-committerdate', `--format=${format}`];
    if (count) args.push(`--count=${count}`);
    const out = await gitText(repoPath, [...args, ...patterns]);
    return out.split('\n').map(parseBranchLine).filter((b): b is LocalBranchInfo => b !== null);
  };
  const recent = (await run(['refs/heads'], BRANCH_CAP)).filter((b) => isSafeName(b.name));
  if (!current) return recent;
  const rest = recent.filter((b) => b.name !== current);
  const mine = recent.find((b) => b.name === current)
    ?? (isSafeName(current) ? (await run([`refs/heads/${current}`]))[0] : undefined);
  return mine ? [mine, ...rest].slice(0, BRANCH_CAP) : rest;
}

export async function describeLocalRepo(repo: string, repoPath: string): Promise<LocalRepoInfo> {
  const current = await currentBranch(repoPath);
  const [branches, dirty, baseBranch] = await Promise.all([
    listBranches(repoPath, current),
    isDirty(repoPath),
    detectBaseBranch(repoPath).catch(() => null),
  ]);
  return { repo, path: repoPath, currentBranch: current, baseBranch, dirty, branches };
}

export async function listLocalRepos(): Promise<{
  repos: LocalRepoInfo[];
  unavailable: { repo: string; reason: string }[];
}> {
  const repos: LocalRepoInfo[] = [];
  const unavailable: { repo: string; reason: string }[] = [];
  const paths = localRepoPaths();
  await Promise.all(
    ALLOWED_REPOS.map(async (repo) => {
      if (!paths.has(repo)) return;
      try {
        const dir = await localRepoPath(repo, paths);
        repos.push(await describeLocalRepo(repo, dir));
      } catch (err) {
        unavailable.push({ repo, reason: (err as Error).message });
      }
    }),
  );
  const order = (name: string): number => ALLOWED_REPOS.indexOf(name);
  repos.sort((a, b) => order(a.repo) - order(b.repo));
  unavailable.sort((a, b) => order(a.repo) - order(b.repo));
  return { repos, unavailable };
}

// ---------------------------------------------------------------------------
// Working-tree capture (read-only on the clone, writes only into the checkout)

export interface WorkingTreeCapture {
  /** HEAD of the clone at capture time; the patch applies on top of it. */
  head: string;
  patch: Buffer;
  untracked: string[];
  skipped: string[];
}

const MAX_UNTRACKED_FILE = 5 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL = 50 * 1024 * 1024;

/** A repo-relative path that cannot escape the checkout it is copied into. */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0')) return false;
  const parts = rel.split(/[\\/]/);
  return !parts.some((p) => p === '..' || p === '') && parts[0] !== '.git';
}

/**
 * Reads the clone's uncommitted state: `git diff HEAD --binary` (staged and
 * unstaged, tracked files) plus the untracked, non-ignored files, which are
 * copied into `destDir`. Nothing is written to the clone.
 */
export async function captureWorkingTree(repoPath: string, destDir: string): Promise<WorkingTreeCapture> {
  const head = await headSha(repoPath);
  if (!head) throw new Error(`The local clone ${repoPath} has no HEAD commit`);

  const diff = await gitRead(repoPath, [
    // Neutralise user diff settings that would make the patch unappliable.
    '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
    'diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative',
    '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/',
  ]);
  if (diff.code !== 0) throw new Error(`git diff HEAD failed in ${repoPath}: ${diff.stderr.trim()}`);

  const listing = await gitRead(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listing.code !== 0) throw new Error(`git ls-files failed in ${repoPath}: ${listing.stderr.trim()}`);

  const untracked: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  const realRoot = fs.realpathSync(repoPath);
  for (const rel of listing.stdout.toString('utf8').split('\0').filter(Boolean)) {
    if (!isSafeRelativePath(rel)) {
      skipped.push(`${rel} (unsafe path)`);
      continue;
    }
    const src = path.join(repoPath, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      skipped.push(`${rel} (vanished)`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${rel} (${stat.isSymbolicLink() ? 'symlink' : 'not a regular file'})`);
      continue;
    }
    // A parent directory could itself be a symlink pointing outside the clone.
    const realParent = fs.realpathSync(path.dirname(src));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      skipped.push(`${rel} (outside the clone)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_FILE || total + stat.size > MAX_UNTRACKED_TOTAL) {
      skipped.push(`${rel} (too large)`);
      continue;
    }
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, stat.mode & 0o777);
    total += stat.size;
    untracked.push(rel);
  }

  return { head, patch: diff.stdout, untracked, skipped };
}
