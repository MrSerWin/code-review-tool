/**
 * Pure views of a ticket coverage: the group verdict, one branch's reading of
 * it ("in this branch / in branch X / already on base / nowhere"), and the
 * attribution of a slice review's own checklist rows. Imports types only, so
 * the MCP formatter can use it too.
 */
import type { CoverageRequirement, CoverageStatus, CoverageVerdict, RequirementStatus } from './types.js';

/** Satisfied for the ticket: implemented by a branch, or verified on the base before the ticket. */
export function isSatisfied(status: CoverageStatus): boolean {
  return status === 'covered' || status === 'already_on_base';
}

/** `needs_work` only for a `missing` or `partial` requirement; an empty list is never covered. */
export function coverageVerdict(requirements: readonly Pick<CoverageRequirement, 'status'>[]): CoverageVerdict {
  return requirements.length > 0 && requirements.every((r) => isSatisfied(r.status)) ? 'covered' : 'needs_work';
}

/** Where a requirement is implemented, seen from one branch. */
export type CoverageWhere = 'here' | 'elsewhere' | 'base' | 'nowhere';

export interface BranchCoverageLine {
  /** The stored checklist item; null when the coverage derived its own list. */
  requirement_id: number | null;
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
    const where: CoverageWhere = r.status === 'already_on_base'
      ? 'base'
      : r.status === 'missing' || r.branches.length === 0
        ? 'nowhere'
        : mine ? 'here' : 'elsewhere';
    return { requirement_id: r.requirement_id ?? null, text: r.text, status: r.status, where, here: mine?.status ?? null, others, note: r.note };
  });
}

/** `in this branch`, `in this branch and repo#b`, `in repo#b`, `already on base`, `not covered anywhere`. */
export function whereLabel(line: BranchCoverageLine): string {
  if (line.where === 'base') return 'already on base';
  if (line.where === 'nowhere') return 'not covered anywhere';
  const others = line.others.join(', ');
  if (line.where === 'elsewhere') return `in ${others}`;
  const here = line.here === 'partial' ? 'partly in this branch' : 'in this branch';
  return others ? `${here} and ${others}` : here;
}

/** The requirements that keep a group from `covered`, missing first. */
export function openRequirements(requirements: readonly CoverageRequirement[]): CoverageRequirement[] {
  const rank: Record<CoverageStatus, number> = { missing: 0, partial: 1, covered: 2, already_on_base: 3 };
  return requirements.filter((r) => !isSatisfied(r.status)).sort((a, b) => rank[a.status] - rank[b.status]);
}

/** The requirements that existed on the base before the ticket. */
export function baseRequirements(requirements: readonly CoverageRequirement[]): CoverageRequirement[] {
  return requirements.filter((r) => r.status === 'already_on_base');
}

// --- attribution of a slice's own checklist ------------------------------------------

/**
 * Where a requirement of a slice review's checklist lives, once the coverage
 * of the whole ticket is known. Only `nowhere` is a gap; `pending` means the
 * coverage does not (yet) cover this run or every sibling.
 */
export const ATTRIBUTIONS = [
  'this_branch', 'other_branch', 'already_on_base', 'not_verifiable', 'nowhere', 'partial', 'pending',
] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export interface RowAttribution {
  state: Attribution;
  label: string;
  /** The branches named by the label (`other_branch`, or the others of a `partial`). */
  branches: { repo: string; branch: string; review_id: number | null }[];
  note: string;
}

export type AttributionCounts = Record<Attribution, number>;

export const PENDING_LABEL = 'not in this slice (coverage pending)';

export interface AttributableRow {
  requirement_id: number | null;
  text: string;
  status: RequirementStatus;
  evidence: string | null;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.;:,!]+$/, '').trim();
}

/** The coverage line of a checklist row: by its stored id, else by its text. */
export function coverageLineFor(
  row: Pick<AttributableRow, 'requirement_id' | 'text'>,
  requirements: readonly CoverageRequirement[],
): CoverageRequirement | undefined {
  if (row.requirement_id) {
    const byId = requirements.find((r) => r.requirement_id === row.requirement_id);
    if (byId) return byId;
  }
  const norm = normalizeText(row.text);
  return requirements.find((r) => normalizeText(r.text) === norm);
}

/** A row read from this branch's own review only: what is not here stays neutral. */
function ownAttribution(row: AttributableRow, label: string): RowAttribution {
  if (row.status === 'met') return { state: 'this_branch', label: 'in this branch', branches: [], note: '' };
  if (row.status === 'partial') return { state: 'partial', label: 'partial', branches: [], note: row.evidence ?? '' };
  if (row.status === 'not_verifiable') return { state: 'not_verifiable', label: 'not verifiable', branches: [], note: row.evidence ?? '' };
  return { state: 'pending', label, branches: [], note: '' };
}

/**
 * One checklist row of a slice review, attributed. `coverage` is the
 * ticket's latest coverage when it is fresh for this run (it read this run
 * and the latest finished run of every sibling, and no pass is pending);
 * null otherwise, and then only this branch's own statuses count.
 */
export function attributeRow(
  row: AttributableRow,
  coverage: readonly CoverageRequirement[] | null,
  repo: string,
  branch: string,
): RowAttribution {
  if (!coverage) return ownAttribution(row, PENDING_LABEL);
  const line = coverageLineFor(row, coverage);
  if (!line) return ownAttribution(row, 'not in this slice (not in the coverage)');
  const others = line.branches
    .filter((b) => !(b.repo === repo && b.branch === branch))
    .map((b) => ({ repo: b.repo, branch: b.branch, review_id: b.review_id }));
  const mine = line.branches.find((b) => b.repo === repo && b.branch === branch);
  switch (line.status) {
    case 'already_on_base':
      return { state: 'already_on_base', label: 'already on base', branches: [], note: line.note };
    case 'covered':
      return mine
        ? { state: 'this_branch', label: 'in this branch', branches: others, note: line.note }
        : { state: 'other_branch', label: `in ${others.map((b) => ref(b.repo, b.branch)).join(', ')}`, branches: others, note: line.note };
    case 'partial':
      return { state: 'partial', label: 'partial', branches: others, note: line.note };
    default:
      return row.status === 'not_verifiable'
        ? { state: 'not_verifiable', label: 'not verifiable', branches: [], note: row.evidence ?? line.note }
        : { state: 'nowhere', label: 'nowhere', branches: [], note: line.note };
  }
}

export function emptyAttributionCounts(): AttributionCounts {
  return Object.fromEntries(ATTRIBUTIONS.map((a) => [a, 0])) as AttributionCounts;
}

export function attributionCounts(rows: readonly Pick<RowAttribution, 'state'>[]): AttributionCounts {
  const counts = emptyAttributionCounts();
  for (const r of rows) counts[r.state] += 1;
  return counts;
}

/**
 * "4 in this slice, 18 in other slices, 9 already on base, 2 nowhere", then
 * the partial, not verifiable and pending counts when there are any. With
 * `fresh` false the coverage is not known yet: only this slice's share and
 * what waits for it.
 */
export function attributionSummary(counts: AttributionCounts, fresh: boolean): string {
  const parts: string[] = [`${counts.this_branch} in this slice`];
  if (fresh) {
    parts.push(`${counts.other_branch} in other slices`, `${counts.already_on_base} already on base`, `${counts.nowhere} nowhere`);
  } else {
    if (counts.other_branch) parts.push(`${counts.other_branch} in other slices`);
    if (counts.already_on_base) parts.push(`${counts.already_on_base} already on base`);
    if (counts.nowhere) parts.push(`${counts.nowhere} nowhere`);
  }
  if (counts.partial) parts.push(`${counts.partial} partial`);
  if (counts.not_verifiable) parts.push(`${counts.not_verifiable} not verifiable`);
  if (counts.pending) parts.push(`${counts.pending} ${fresh ? 'not in the coverage' : 'not in this slice (coverage pending)'}`);
  return parts.join(', ');
}

/** The ticket's coverage in one phrase, for a slice page next to its code verdict. */
export interface TicketCoverageBadge {
  state: CoverageVerdict | 'pending';
  nowhere: number;
  partial: number;
  already_on_base: number;
  label: string;
}

export function ticketCoverageBadge(
  coverage: { verdict: CoverageVerdict | null; requirements: readonly Pick<CoverageRequirement, 'status'>[] } | null,
  fresh: boolean,
): TicketCoverageBadge {
  const count = (s: CoverageStatus): number => coverage?.requirements.filter((r) => r.status === s).length ?? 0;
  const nowhere = count('missing');
  const partial = count('partial');
  const base = count('already_on_base');
  if (!coverage || !coverage.verdict || !fresh) {
    return { state: 'pending', nowhere, partial, already_on_base: base, label: 'ticket coverage: pending' };
  }
  if (coverage.verdict === 'covered') {
    return { state: 'covered', nowhere, partial, already_on_base: base, label: 'ticket coverage: covered' };
  }
  return {
    state: 'needs_work', nowhere, partial, already_on_base: base,
    label: `ticket coverage: needs_work (${nowhere} nowhere, ${partial} partial)`,
  };
}
