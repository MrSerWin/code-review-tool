import fs from 'node:fs';
import { checkoutDir } from '../gitSandbox.js';
import { branchRefs, detectBaseBranch, localRepoPath } from '../localRepos.js';
import { groupHeads } from '../ticketGroups.js';
import type { CheckoutResult, ReviewRow } from '../types.js';
import { hasCommit } from './git.js';
import type { CheckContext, SiblingBranch, TreeRef } from './types.js';

/** Lookups `buildCheckContext` needs from the database and the local clones; replaceable in tests. */
export interface SourceDeps {
  /** The latest review id of a branch of the group, or null. */
  latestReviewId(groupKey: string, repo: string, branch: string): number | null;
  /** The path of the local clone of `repo`, or null when none is configured. */
  localClone(repo: string): Promise<string | null>;
}

export const defaultSourceDeps: SourceDeps = {
  latestReviewId(groupKey, repo, branch) {
    return groupHeads(groupKey).get(`${repo}#${branch}`)?.latest.id ?? null;
  },
  async localClone(repo) {
    try {
      return await localRepoPath(repo);
    } catch {
      return null;
    }
  },
};

async function cloneRef(clone: string, branch: string): Promise<string | null> {
  try {
    const refs = await branchRefs(clone, branch);
    if (refs.localHead) return `refs/heads/${branch}`;
    if (refs.originRef) return `refs/remotes/origin/${branch}`;
  } catch {
    // An unsafe or unknown name: nothing to read.
  }
  return null;
}

/** A sibling's tree: its own review checkout when one is on disk, else its ref in the local clone. */
async function siblingTree(
  review: Pick<ReviewRow, 'group_key'>,
  repo: string,
  branch: string,
  deps: SourceDeps,
): Promise<TreeRef | null> {
  const id = review.group_key ? deps.latestReviewId(review.group_key, repo, branch) : null;
  if (id !== null) {
    const dir = checkoutDir({ repo, branch }, id);
    if (fs.existsSync(dir) && (await hasCommit(dir, 'HEAD'))) {
      return { label: `sibling branch ${branch} (review #${id} checkout)`, dir, ref: 'HEAD' };
    }
  }
  const clone = await deps.localClone(repo);
  const ref = clone ? await cloneRef(clone, branch) : null;
  return clone && ref ? { label: `sibling branch ${branch} (local clone)`, dir: clone, ref } : null;
}

/**
 * The read-only material the tool checks compare against: the base tip, the
 * default branch as last fetched in the local clone, and the other branches
 * of the ticket group. Nothing is fetched or checked out.
 */
export async function buildCheckContext(
  review: Pick<ReviewRow, 'repo' | 'branch' | 'base_branch' | 'group_key'>,
  checkout: CheckoutResult,
  changedFiles: CheckContext['changedFiles'],
  siblings: readonly { repo: string; branch: string }[],
  deps: SourceDeps = defaultSourceDeps,
): Promise<CheckContext> {
  const baseTip: TreeRef | null = checkout.baseTipSha && checkout.baseTipSha !== checkout.baseSha
    ? { label: `the ${review.base_branch} tip`, dir: checkout.dir, ref: checkout.baseTipSha }
    : null;

  let defaultBranch: TreeRef | null = null;
  const clone = await deps.localClone(review.repo);
  if (clone) {
    const name = await detectBaseBranch(clone).catch(() => null);
    const ref = name ? await cloneRef(clone, name) : null;
    if (name && ref) defaultBranch = { label: `${name} as last fetched in the local clone`, dir: clone, ref };
  }

  const others: SiblingBranch[] = [];
  for (const s of siblings) {
    if (s.repo !== review.repo || s.branch === review.branch) continue;
    others.push({ repo: s.repo, branch: s.branch, tree: await siblingTree(review, s.repo, s.branch, deps) });
  }

  return {
    repo: review.repo,
    checkoutDir: checkout.dir,
    baseSha: checkout.baseSha,
    headSha: checkout.headSha,
    changedFiles,
    baseTip,
    defaultBranch,
    siblings: others,
    syntheticCommits: checkout.workingTreeSnapshot ? [checkout.workingTreeSnapshot.sha] : [],
  };
}
