import type {
  Attribution, BaseEvidence, CoverageRequirement, CoverageStatus, RowAttribution, TicketCoverageBadge,
} from './types';

/**
 * One palette for "where is this requirement": green only for this branch,
 * amber for partial, red only for nowhere, neutral for everything that is
 * not a gap (another slice, the base, not verifiable, pending).
 */
const ATTRIBUTION_CLASS: Record<Attribution, string> = {
  this_branch: 'attr-here',
  other_branch: 'attr-neutral',
  already_on_base: 'attr-neutral',
  not_verifiable: 'attr-neutral',
  pending: 'attr-neutral',
  partial: 'attr-partial',
  nowhere: 'attr-nowhere',
};

export function attributionClass(state: Attribution): string {
  return ATTRIBUTION_CLASS[state] ?? 'attr-neutral';
}

/** The link target of an attribution that names other slices: their review pages. */
export function attributionLinks(a: RowAttribution): { label: string; to: string | null }[] {
  return a.branches.map((b) => ({ label: `${b.repo}#${b.branch}`, to: b.review_id ? `/review/${b.review_id}` : null }));
}

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'covered',
  partial: 'partial',
  missing: 'nowhere',
  already_on_base: 'already on base',
};

const STATUS_CLASS: Record<CoverageStatus, string> = {
  covered: 'attr-here',
  partial: 'attr-partial',
  missing: 'attr-nowhere',
  already_on_base: 'attr-neutral',
};

/** The ticket coverage table's status cell, in the same palette as the slice attribution. */
export function coverageStatusLabel(status: CoverageStatus): string {
  return STATUS_LABEL[status] ?? status;
}

export function coverageStatusClass(status: CoverageStatus): string {
  return STATUS_CLASS[status] ?? 'attr-neutral';
}

/** The requirements a branch or the base still has to answer for, and those that were already on the base. */
export function splitBaseRequirements(requirements: readonly CoverageRequirement[]): {
  open: CoverageRequirement[];
  onBase: CoverageRequirement[];
} {
  return {
    open: requirements.filter((r) => r.status !== 'already_on_base'),
    onBase: requirements.filter((r) => r.status === 'already_on_base'),
  };
}

/** "Already on main before this ticket", or "on the base" when the verified sites name no single base. */
export function baseGroupTitle(onBase: readonly CoverageRequirement[]): string {
  const names = new Set(onBase.flatMap((r) => (r.base_evidence ?? []).filter((e) => e.verified).map((e) => e.base_branch ?? '')));
  const name = names.size === 1 ? [...names][0] : '';
  return `Already on ${name || 'the base'} before this ticket`;
}

export function baseLocation(e: BaseEvidence): string {
  return `${e.repo} ${e.line ? `${e.file}:${e.line}` : e.file}`;
}

const BADGE_CLASS: Record<TicketCoverageBadge['state'], string> = {
  covered: 'attr-here',
  needs_work: 'attr-nowhere',
  pending: 'attr-neutral',
};

/** The ticket coverage badge on a slice page: red only when the ticket has a real gap. */
export function ticketCoverageClass(badge: TicketCoverageBadge): string {
  if (badge.state === 'needs_work' && badge.nowhere === 0) return 'attr-partial';
  return BADGE_CLASS[badge.state] ?? 'attr-neutral';
}
