/**
 * Remote branch names of the allowed repositories, for the custom preview
 * launcher's suggestions and for checking hand-picked branches. One listing is
 * a Docker run, so it is cached per repository for a short while.
 */
import { assertAllowedRepo } from './config.js';
import { lsRemoteBranches, type RemoteBranchList } from './gitSandbox.js';

export const BRANCH_CACHE_TTL_MS = 60_000;
export const BRANCH_LIST_LIMIT = 200;

type Lister = (repo: string) => Promise<RemoteBranchList>;

/**
 * A per-repository cache of listings. Concurrent callers share one in-flight
 * listing; a failed listing is forgotten at once, so the next call retries.
 */
export function createBranchCache(lister: Lister, ttlMs = BRANCH_CACHE_TTL_MS, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; listing: Promise<RemoteBranchList> }>();
  return (repo: string, opts: { fresh?: boolean } = {}): Promise<RemoteBranchList> => {
    const hit = entries.get(repo);
    if (hit && !opts.fresh && now() - hit.at < ttlMs) return hit.listing;
    const listing = lister(repo);
    entries.set(repo, { at: now(), listing });
    listing.catch(() => {
      if (entries.get(repo)?.listing === listing) entries.delete(repo);
    });
    return listing;
  };
}

const cached = createBranchCache(lsRemoteBranches);

/** The branches of an allowed repository; `fresh` skips the cache (and refills it). */
export function remoteBranches(repo: string, opts: { fresh?: boolean } = {}): Promise<RemoteBranchList> {
  assertAllowedRepo(repo);
  return cached(repo, opts);
}

export interface BranchSelection {
  defaultBranch: string | null;
  branches: string[];
  /** How many branches matched before the cap. */
  total: number;
  truncated: boolean;
}

/**
 * The default branch first, then the rest alphabetically; only names containing
 * `q` (case-insensitive) when it is given; at most `limit` of them.
 */
export function selectBranches(
  list: RemoteBranchList,
  opts: { q?: string | undefined; limit?: number } = {},
): BranchSelection {
  const limit = opts.limit ?? BRANCH_LIST_LIMIT;
  const needle = opts.q?.trim().toLowerCase() ?? '';
  const def = list.defaultBranch;
  const matched = [...new Set(list.branches)]
    .filter((name) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a === def) return -1;
      if (b === def) return 1;
      return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
    });
  return {
    defaultBranch: def,
    branches: matched.slice(0, limit),
    total: matched.length,
    truncated: matched.length > limit,
  };
}
