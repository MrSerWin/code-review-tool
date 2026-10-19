/**
 * Pure views of a ticket coverage: the group verdict, and one branch's
 * reading of it ("in this branch / in branch X / not covered anywhere").
 * Imports types only, so the MCP formatter can use it too.
 */
import type { CoverageRequirement, CoverageStatus, CoverageVerdict } from './types.js';

export function coverageVerdict(requirements: readonly Pick<CoverageRequirement, 'status'>[]): CoverageVerdict {
  return requirements.length > 0 && requirements.every((r) => r.status === 'covered') ? 'covered' : 'needs_work';
}

/** Where a requirement is implemented, seen from one branch. */
export type CoverageWhere = 'here' | 'elsewhere' | 'nowhere';

export interface BranchCoverageLine {
  text: string;
  /** The requirement's status across the whole group. */
  status: CoverageStatus;
  where: CoverageWhere;
  /** This branch's share, when it has one. */
  here: 'covered' | 'partial' | null;
  /** The other branches that implement it, as `repo#branch`. */
  others: string[];
  note: string;
}

const ref = (repo: string, branch: string): string => `${repo}#${branch}`;

export function branchCoverage(
  requirements: readonly CoverageRequirement[],
  repo: string,
  branch: string,
): BranchCoverageLine[] {
  return requirements.map((r) => {
    const mine = r.branches.find((b) => b.repo === repo && b.branch === branch) ?? null;
    const others = r.branches.filter((b) => !(b.repo === repo && b.branch === branch)).map((b) => ref(b.repo, b.branch));
    const where: CoverageWhere = r.status === 'missing' || r.branches.length === 0
      ? 'nowhere'
      : mine ? 'here' : 'elsewhere';
    return { text: r.text, status: r.status, where, here: mine?.status ?? null, others, note: r.note };
  });
}

/** `in this branch`, `in this branch and repo#b`, `in repo#b`, `not covered anywhere`. */
export function whereLabel(line: BranchCoverageLine): string {
  if (line.where === 'nowhere') return 'not covered anywhere';
  const others = line.others.join(', ');
  if (line.where === 'elsewhere') return `in ${others}`;
  const here = line.here === 'partial' ? 'partly in this branch' : 'in this branch';
  return others ? `${here} and ${others}` : here;
}

/** The requirements that keep a group from `covered`, missing first. */
export function openRequirements(requirements: readonly CoverageRequirement[]): CoverageRequirement[] {
  const rank: Record<CoverageStatus, number> = { missing: 0, partial: 1, covered: 2 };
  return requirements.filter((r) => r.status !== 'covered').sort((a, b) => rank[a.status] - rank[b.status]);
}
