/**
 * Pure helpers for the branches of one ticket: the per-repository chains
 * (stack order), cycle checks, and the choice of a parent from GitHub's
 * compare answers. No I/O, so the store, the routes, and the tests share them.
 */

export interface ChainInput {
  repo: string;
  branch: string;
  /** The base the branch is diffed against; null while it is not known yet. */
  parent_branch: string | null;
  position: number;
}

export interface ChainNode<T extends ChainInput> {
  item: T;
  /** 0 for a branch whose parent is not in the group. */
  depth: number;
  /** True when the parent is another branch of the same group and repository. */
  parentInGroup: boolean;
}

export interface Chain<T extends ChainInput> {
  repo: string;
  /** Parents before children: the order a ticket review runs them in. */
  nodes: ChainNode<T>[];
}

function byPosition<T extends ChainInput>(a: T, b: T): number {
  return a.position - b.position || a.branch.localeCompare(b.branch, 'en', { numeric: true });
}

/**
 * One chain per repository (repositories by name), each in stack order: a
 * depth-first walk from the branches whose parent is outside the group, so a
 * parent always comes before its children. A cycle (which the store refuses
 * to create) cannot hide a branch: anything left unvisited is appended as a root.
 */
export function orderChains<T extends ChainInput>(items: readonly T[]): Chain<T>[] {
  const byRepo = new Map<string, T[]>();
  for (const item of items) {
    const list = byRepo.get(item.repo) ?? [];
    list.push(item);
    byRepo.set(item.repo, list);
  }
  const chains: Chain<T>[] = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const list = byRepo.get(repo)!;
    const names = new Set(list.map((i) => i.branch));
    const children = new Map<string, T[]>();
    const roots: T[] = [];
    for (const item of list) {
      const parent = item.parent_branch;
      if (parent && parent !== item.branch && names.has(parent)) {
        const kids = children.get(parent) ?? [];
        kids.push(item);
        children.set(parent, kids);
      } else {
        roots.push(item);
      }
    }
    const nodes: ChainNode<T>[] = [];
    const seen = new Set<string>();
    const visit = (item: T, depth: number, parentInGroup: boolean): void => {
      if (seen.has(item.branch)) return;
      seen.add(item.branch);
      nodes.push({ item, depth, parentInGroup });
      for (const kid of [...(children.get(item.branch) ?? [])].sort(byPosition)) visit(kid, depth + 1, true);
    };
    for (const root of roots.sort(byPosition)) visit(root, 0, false);
    for (const item of [...list].sort(byPosition)) visit(item, 0, false);
    chains.push({ repo, nodes });
  }
  return chains;
}

/**
 * Whether making `parent` the parent of `branch` would close a loop: walking
 * up from `parent` through the group's branches reaches `branch`.
 */
export function wouldCycle(items: readonly ChainInput[], repo: string, branch: string, parent: string | null): boolean {
  if (!parent) return false;
  if (parent === branch) return true;
  const parentOf = new Map(items.filter((i) => i.repo === repo).map((i) => [i.branch, i.parent_branch]));
  const seen = new Set<string>();
  let current: string | null | undefined = parent;
  while (current && parentOf.has(current) && !seen.has(current)) {
    if (current === branch) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return current === branch;
}

/**
 * A linear chain from an ordered branch list: the first sits on `root` (the
 * default branch, or whatever outside base it had), every next one on the one
 * before it.
 */
export function linearParents(order: readonly string[], root: string): { branch: string; parent: string; position: number }[] {
  return order.map((branch, index) => ({ branch, parent: index === 0 ? root : order[index - 1]!, position: index }));
}

/** GitHub's `compare/<base>...<head>` answer, reduced to what parent detection needs. */
export interface CompareResult {
  /** `ahead`: head contains base's tip; `identical`, `behind`, `diverged` otherwise. */
  status: string;
  ahead_by: number;
  behind_by: number;
}

export interface RemoteParentFacts {
  defaultBranch: string;
  /** compare(default...branch); null when GitHub could not answer. */
  defaultCompare: CompareResult | null;
  /** compare(sibling...branch) for every other branch of the group in the same repository. */
  siblings: { name: string; compare: CompareResult | null }[];
  /** The base of the branch's pull request, when it has one. */
  prBase: string | null;
}

export interface RemoteParent {
  parent: string;
  reason: 'pr' | 'detected' | 'default';
  /** Commits of the branch that the parent lacks, when known. */
  distance: number | null;
}

/**
 * The parent of a pushed branch, mirroring local parent detection: a pull
 * request base other than the default branch wins; otherwise the closest
 * sibling whose tip the branch contains (`ahead` in compare) wins when it is
 * strictly closer than the default branch; otherwise the default branch.
 */
export function chooseRemoteParent(facts: RemoteParentFacts): RemoteParent {
  if (facts.prBase && facts.prBase !== facts.defaultBranch) {
    return { parent: facts.prBase, reason: 'pr', distance: null };
  }
  const defaultDistance = facts.defaultCompare ? facts.defaultCompare.ahead_by : Number.POSITIVE_INFINITY;
  const ancestors = facts.siblings
    .filter((s) => s.compare && s.compare.status === 'ahead' && s.compare.ahead_by > 0)
    .map((s) => ({ name: s.name, distance: s.compare!.ahead_by }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const closest = ancestors[0];
  if (closest && closest.distance < defaultDistance) {
    return { parent: closest.name, reason: 'detected', distance: closest.distance };
  }
  return {
    parent: facts.defaultBranch,
    reason: facts.prBase ? 'pr' : 'default',
    distance: Number.isFinite(defaultDistance) ? defaultDistance : null,
  };
}
