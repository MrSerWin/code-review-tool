/**
 * Ticket groups: the branches of one ticket, ordered per repository into a
 * chain (stack) by their parent, so each slice is diffed against its parent
 * instead of the default branch. Parents are detected (local clones:
 * `detectParentBranch`; pushed branches: the pull request base, else GitHub's
 * compare between siblings) and can be set by hand.
 */
import { db } from './db.js';
import { ghCompare } from './gitSandbox.js';
import { describeParent } from './localRepos.js';
import { logger } from './logger.js';
import { defaultBranch } from './resolver.js';
import {
  chooseRemoteParent, linearParents, orderChains, wouldCycle, type CompareResult,
} from './ticketChains.js';
import {
  getTicketBranch, getTicketGroup, listTicketBranches, renumberPositions, setTicketBranchParent, syncMembersFromReviews,
  upsertTicketBranch, upsertTicketGroup,
} from './ticketStore.js';
import type {
  BaseReason, ParentReason, ResolvedTarget, ReviewRow, ReviewSource, TicketBranchRow, TicketInfo, Verdict,
} from './types.js';

export interface DetectDeps {
  compare(repo: string, base: string, head: string): Promise<CompareResult>;
  defaultBranch(repo: string): Promise<string>;
  /** The detected parent of a branch of a local clone. */
  localParent(repo: string, branch: string): Promise<{ base: string; reason: string; defaultBase: string }>;
}

export const defaultDetectDeps: DetectDeps = {
  compare: ghCompare,
  defaultBranch,
  localParent: (repo, branch) => describeParent(repo, branch),
};

export interface DetectedParent {
  repo: string;
  branch: string;
  parent: string;
  reason: ParentReason;
  previous: string | null;
}

export interface DetectOptions {
  /** Only these repositories; all when absent. */
  repos?: ReadonlySet<string>;
  /** Pull request bases by `repo#branch`, from the resolved targets. */
  prBases?: ReadonlyMap<string, string>;
  /** Re-detect parents set by hand too. Default false: a user choice sticks. */
  includeUser?: boolean;
}

const memberKey = (repo: string, branch: string): string => `${repo}#${branch}`;

/**
 * Detects the parent of every branch of the group (in `opts.repos`), except
 * those set by hand. A failed lookup keeps the stored parent, or falls back to
 * the default branch when there is none. Returns what was decided.
 */
export async function detectGroupParents(
  key: string,
  deps: DetectDeps = defaultDetectDeps,
  opts: DetectOptions = {},
): Promise<DetectedParent[]> {
  const members = listTicketBranches(key);
  const defaults = new Map<string, Promise<string | null>>();
  const defaultOf = (repo: string): Promise<string | null> => {
    let hit = defaults.get(repo);
    if (!hit) {
      hit = deps.defaultBranch(repo).catch((err: unknown) => {
        logger.warn(`ticket ${key}: default branch of ${repo} unknown: ${(err as Error).message}`);
        return null;
      });
      defaults.set(repo, hit);
    }
    return hit;
  };

  /** One branch's parent, or null to keep what is stored. */
  const decide = async (row: TicketBranchRow): Promise<{ parent: string; reason: ParentReason; def: string | null } | null> => {
    let def: string | null = row.default_branch;
    try {
      if (row.source === 'local') {
        const found = await deps.localParent(row.repo, row.branch);
        return { parent: found.base, reason: found.reason === 'default' ? 'default' : 'detected', def: found.defaultBase };
      }
      def = (await defaultOf(row.repo)) ?? def;
      if (!def) throw new Error(`no default branch for ${row.repo}`);
      const prBase = opts.prBases?.get(memberKey(row.repo, row.branch)) ?? null;
      // A pull request base learnt earlier stays until a newer one is seen.
      if (!prBase && row.parent_reason === 'pr' && row.parent_branch) return null;
      // A pull request against another branch names the parent; no compare is needed.
      if (prBase && prBase !== def) return { parent: prBase, reason: 'pr', def };
      const safeCompare = (base: string): Promise<CompareResult | null> =>
        deps.compare(row.repo, base, row.branch).catch((err: unknown) => {
          logger.warn(`ticket ${key}: compare ${base}...${row.branch} failed: ${(err as Error).message}`);
          return null;
        });
      const siblings = members.filter((m) => m.repo === row.repo && m.branch !== row.branch);
      const [defaultCompare, ...compares] = await Promise.all([def, ...siblings.map((s) => s.branch)].map(safeCompare));
      const chosen = chooseRemoteParent({
        defaultBranch: def,
        defaultCompare: defaultCompare ?? null,
        siblings: siblings.map((s, i) => ({ name: s.branch, compare: compares[i] ?? null })),
        prBase,
      });
      return { parent: chosen.parent, reason: chosen.reason, def };
    } catch (err) {
      logger.warn(`ticket ${key}: parent of ${row.repo}#${row.branch} not detected: ${(err as Error).message}`);
      if (row.parent_branch || !def) return null;
      return { parent: def, reason: 'default', def };
    }
  };

  const eligible = members.filter((row) =>
    (!opts.repos || opts.repos.has(row.repo)) && (row.parent_reason !== 'user' || opts.includeUser));
  const decisions = await mapLimit(eligible, 4, async (row) => ({ row, decision: await decide(row) }));

  // Decide on the whole graph at once: a loop can only come from equal tips, and
  // a decision that would close one keeps the stored parent instead.
  const final = members.map((m) => ({ ...m }));
  const changed = decisions.filter((d) => d.decision && d.decision.parent !== d.row.branch);
  for (const { row, decision } of changed) final.find((m) => m.id === row.id)!.parent_branch = decision!.parent;
  const out: DetectedParent[] = [];
  for (const { row, decision } of changed) {
    const item = final.find((m) => m.id === row.id)!;
    if (wouldCycle(final.filter((m) => m.id !== row.id), row.repo, row.branch, decision!.parent)) {
      item.parent_branch = row.parent_branch;
      continue;
    }
    out.push({ repo: row.repo, branch: row.branch, parent: decision!.parent, reason: decision!.reason, previous: row.parent_branch });
  }
  const write = db.transaction(() => {
    for (const d of out) {
      const def = decisions.find((x) => x.row.repo === d.repo && x.row.branch === d.branch)?.decision?.def ?? null;
      setTicketBranchParent(key, d.repo, d.branch, d.parent, d.reason, { defaultBranch: def });
    }
    renumberPositions(key);
  });
  write();
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order. */
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

export interface JoinOptions {
  /** `all`: re-detect every repository the targets touch; `new`: only where a branch joined or has no parent. */
  detect: 'all' | 'new' | 'none';
  requirementsText?: string | null;
}

/**
 * Makes the targets members of the ticket's group and detects parents where
 * needed. Returns the members that joined now.
 */
export async function joinGroup(
  key: string,
  ticket: Pick<TicketInfo, 'title' | 'url'> | null,
  targets: readonly ResolvedTarget[],
  deps: DetectDeps = defaultDetectDeps,
  opts: JoinOptions = { detect: 'new' },
): Promise<{ joined: string[]; detected: DetectedParent[] }> {
  syncMembersFromReviews(key);
  upsertTicketGroup(key, {
    title: ticket?.title ?? null,
    ticket_url: ticket?.url ?? null,
    requirements_text: opts.requirementsText ?? null,
  });
  const joined: string[] = [];
  const repos = new Set<string>();
  const prBases = new Map<string, string>();
  for (const t of targets) {
    const { created } = upsertTicketBranch(key, {
      repo: t.repo, branch: t.branch, source: t.source ?? 'github', prNumber: t.prNumber,
    });
    if (t.prNumber !== null && t.prNumber !== undefined && t.source !== 'local') prBases.set(memberKey(t.repo, t.branch), t.baseBranch);
    if (created) joined.push(memberKey(t.repo, t.branch));
    if (opts.detect === 'all' || created) repos.add(t.repo);
    // A local target arrives with its parent already detected against the clone.
    if (created && t.source === 'local' && t.baseReason !== 'chosen') {
      setTicketBranchParent(key, t.repo, t.branch, t.baseBranch, t.baseReason === 'default' ? 'default' : 'detected');
    }
  }
  for (const row of listTicketBranches(key)) if (!row.parent_branch) repos.add(row.repo);
  const detected = opts.detect === 'none' || repos.size === 0
    ? []
    : await detectGroupParents(key, deps, { repos, prBases });
  renumberPositions(key);
  return { joined, detected };
}

/** `parent` / `chosen` / `default`, as a review row records how its base was picked. */
function baseReasonFor(row: TicketBranchRow): BaseReason {
  if (row.parent_reason === 'user') return 'chosen';
  if (row.parent_reason === 'default' || (row.default_branch && row.parent_branch === row.default_branch)) return 'default';
  return 'parent';
}

/**
 * The targets with their base taken from the group: each member branch is
 * diffed against its parent. A base the caller chose explicitly wins.
 */
export function applyGroupBases(
  key: string,
  targets: readonly ResolvedTarget[],
  opts: { explicitBase?: boolean } = {},
): ResolvedTarget[] {
  return targets.map((t) => {
    if (opts.explicitBase) return t;
    const row = getTicketBranch(key, t.repo, t.branch);
    if (!row?.parent_branch || row.parent_branch === t.branch) return t;
    return { ...t, baseBranch: row.parent_branch, baseReason: baseReasonFor(row) };
  });
}

export class GroupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'GroupError';
  }
}

/** Sets one branch's parent by hand; `null` resets it to the default branch. Refuses loops. */
export async function setParentByHand(
  key: string,
  repo: string,
  branch: string,
  parent: string | null,
  deps: Pick<DetectDeps, 'defaultBranch'> = defaultDetectDeps,
): Promise<TicketBranchRow> {
  syncMembersFromReviews(key);
  const row = getTicketBranch(key, repo, branch);
  if (!row) throw new GroupError(`${repo}#${branch} is not a branch of ${key}`, 404);
  let target = parent?.trim() || null;
  let def = row.default_branch;
  if (!target) {
    def = def ?? (await deps.defaultBranch(repo).catch(() => null));
    if (!def) throw new GroupError(`The default branch of ${repo} is unknown; name the parent explicitly`);
    target = def;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes('..') || target.startsWith('-')) {
    throw new GroupError(`Unsafe branch name: ${JSON.stringify(target)}`);
  }
  if (target === branch) throw new GroupError('A branch cannot be its own parent');
  if (wouldCycle(listTicketBranches(key), repo, branch, target)) {
    throw new GroupError(`${target} is ${branch} itself or one of its children: that would make a loop`);
  }
  setTicketBranchParent(key, repo, branch, target, 'user', { defaultBranch: def });
  renumberPositions(key);
  return getTicketBranch(key, repo, branch)!;
}

/**
 * Reorders one repository's branches into a single linear chain: the first
 * sits on `root` (default: the default branch), each next one on the one
 * before. Every listed branch must be a member.
 */
export async function setChainOrder(
  key: string,
  repo: string,
  order: readonly string[],
  root: string | null = null,
  deps: Pick<DetectDeps, 'defaultBranch'> = defaultDetectDeps,
): Promise<void> {
  syncMembersFromReviews(key);
  const members = listTicketBranches(key).filter((m) => m.repo === repo);
  if (order.length === 0) throw new GroupError('The order is empty');
  if (new Set(order).size !== order.length) throw new GroupError('The order names a branch twice');
  for (const name of order) {
    if (!members.some((m) => m.branch === name)) throw new GroupError(`${repo}#${name} is not a branch of ${key}`, 404);
  }
  const first = members.find((m) => m.branch === order[0]);
  let base = root?.trim() || null;
  if (!base) base = first?.default_branch ?? (await deps.defaultBranch(repo).catch(() => null));
  if (!base) throw new GroupError(`The default branch of ${repo} is unknown; pass root`);
  if (order.includes(base)) throw new GroupError('The root cannot be one of the ordered branches');
  const run = db.transaction(() => {
    for (const step of linearParents(order, base!)) {
      setTicketBranchParent(key, repo, step.branch, step.parent, 'user', { position: step.position });
    }
  });
  run();
}

// --- views -----------------------------------------------------------------

/** The latest run of one branch, as a ticket view shows it. */
export interface BranchRunSummary {
  id: number;
  run_index: number;
  status: ReviewRow['status'];
  verdict: Verdict | null;
  code_verdict: Verdict | null;
  can_merge: boolean | null;
  code_can_merge: boolean | null;
  base_branch: string;
  blocking_count: number | null;
  requirements_met: number | null;
  requirements_total: number | null;
  reviewer: string | null;
  model: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface GroupBranchView {
  repo: string;
  branch: string;
  source: ReviewSource;
  parent: string | null;
  parentReason: ParentReason | null;
  /** True when the parent is another branch of this group in the same repository. */
  parentInGroup: boolean;
  depth: number;
  position: number;
  defaultBranch: string | null;
  prNumber: number | null;
  latest: BranchRunSummary | null;
  latestDone: BranchRunSummary | null;
  /** The latest run of the parent, when the parent is in the group; for "parent not reviewed yet". */
  parentReviewed: boolean | null;
}

export interface TicketGroupView {
  key: string;
  title: string | null;
  ticketUrl: string | null;
  requirementsText: string | null;
  chains: { repo: string; branches: GroupBranchView[] }[];
}

function bool(v: number | null | undefined): boolean | null {
  return v === null || v === undefined ? null : v === 1;
}

export function runSummary(r: ReviewRow): BranchRunSummary {
  return {
    id: r.id, run_index: r.run_index, status: r.status, verdict: r.verdict, code_verdict: r.code_verdict ?? null,
    can_merge: bool(r.can_merge), code_can_merge: bool(r.code_can_merge), base_branch: r.base_branch,
    blocking_count: r.blocking_count, requirements_met: r.requirements_met, requirements_total: r.requirements_total,
    reviewer: r.reviewer, model: r.model, created_at: r.created_at, finished_at: r.finished_at,
  };
}

/** Latest and latest finished run per repo/branch of a group. */
export function groupHeads(key: string): Map<string, { latest: ReviewRow; latestDone: ReviewRow | null }> {
  const rows = db
    .prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE group_key = ? ORDER BY created_at DESC, id DESC`)
    .all(key);
  const out = new Map<string, { latest: ReviewRow; latestDone: ReviewRow | null }>();
  for (const r of rows) {
    const k = memberKey(r.repo, r.branch);
    const hit = out.get(k);
    if (!hit) out.set(k, { latest: r, latestDone: r.status === 'done' ? r : null });
    else if (!hit.latestDone && r.status === 'done') hit.latestDone = r;
  }
  return out;
}

/** The group with its chains in stack order, or null when the key has no group and no runs. */
export function ticketGroupView(key: string): TicketGroupView | null {
  syncMembersFromReviews(key);
  const group = getTicketGroup(key);
  if (!group) return null;
  const heads = groupHeads(key);
  const chains = orderChains(listTicketBranches(key)).map((chain) => ({
    repo: chain.repo,
    branches: chain.nodes.map(({ item, depth, parentInGroup }): GroupBranchView => {
      const head = heads.get(memberKey(item.repo, item.branch));
      const parentHead = parentInGroup && item.parent_branch ? heads.get(memberKey(item.repo, item.parent_branch)) : undefined;
      return {
        repo: item.repo,
        branch: item.branch,
        source: item.source,
        parent: item.parent_branch,
        parentReason: item.parent_reason,
        parentInGroup,
        depth,
        position: item.position,
        defaultBranch: item.default_branch,
        prNumber: item.pr_number ?? null,
        latest: head ? runSummary(head.latest) : null,
        latestDone: head?.latestDone ? runSummary(head.latestDone) : null,
        parentReviewed: parentInGroup ? Boolean(parentHead?.latestDone) : null,
      };
    }),
  }));
  return {
    key: group.key,
    title: group.title,
    ticketUrl: group.ticket_url,
    requirementsText: group.requirements_text,
    chains,
  };
}

/** Group members in stack order (parents first), one list across repositories. */
export function orderedMembers(key: string): TicketBranchRow[] {
  return orderChains(listTicketBranches(key)).flatMap((c) => c.nodes.map((n) => n.item));
}

/** For a review's prompt: where this branch sits among the ticket's slices. */
export function sliceContext(key: string, repo: string, branch: string): { members: TicketBranchRow[]; self: TicketBranchRow | null } {
  syncMembersFromReviews(key);
  const members = orderedMembers(key);
  return { members, self: members.find((m) => m.repo === repo && m.branch === branch) ?? null };
}

/** One target of a batch, and the position in the batch of the target its base belongs to. */
export interface BatchStep<T> {
  target: T;
  /** Index (in the returned order) of the target that is this one's parent branch; null without one. */
  parentIndex: number | null;
}

/**
 * Orders a batch of targets parents first: members of a ticket group in the
 * group's chain order (groups in order of first appearance), anything else
 * after them as given; then a topological pass makes sure that a target whose
 * base is another target of the batch (same repository) always comes after
 * it, whatever the stored positions say. `parentIndex` names that target.
 */
export function orderBatch<T extends Pick<ResolvedTarget, 'repo' | 'branch' | 'baseBranch'>>(
  targets: readonly T[],
  groupOf: (target: T) => string | null,
): BatchStep<T>[] {
  const groupRank = new Map<string, number>();
  const memberRank = new Map<string, Map<string, number>>();
  const rankOf = (t: T, index: number): [number, number, number] => {
    const key = groupOf(t);
    if (!key) return [Number.MAX_SAFE_INTEGER, 0, index];
    if (!groupRank.has(key)) {
      groupRank.set(key, groupRank.size);
      memberRank.set(key, new Map(orderedMembers(key).map((m, i) => [memberKey(m.repo, m.branch), i])));
    }
    const pos = memberRank.get(key)!.get(memberKey(t.repo, t.branch)) ?? Number.MAX_SAFE_INTEGER;
    return [groupRank.get(key)!, pos, index];
  };
  const sorted = targets
    .map((t, i) => ({ t, rank: rankOf(t, i) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .map((x) => x.t);

  const inBatch = (t: T): T | undefined =>
    sorted.find((p) => p !== t && p.repo === t.repo && p.branch === t.baseBranch);
  const out: T[] = [];
  const placed = new Set<T>();
  const place = (t: T, seen: Set<T>): void => {
    if (placed.has(t) || seen.has(t)) return;
    seen.add(t);
    const parent = inBatch(t);
    if (parent) place(parent, seen);
    placed.add(t);
    out.push(t);
  };
  for (const t of sorted) place(t, new Set());
  return out.map((target) => {
    const parent = inBatch(target);
    const parentIndex = parent ? out.indexOf(parent) : -1;
    return { target, parentIndex: parentIndex >= 0 && parentIndex < out.indexOf(target) ? parentIndex : null };
  });
}
