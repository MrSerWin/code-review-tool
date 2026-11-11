import type { Review, ReviewStatus } from './types';

const ACTIVE: ReadonlySet<ReviewStatus> = new Set(['queued', 'fetching', 'reviewing']);

export function isActive(status: ReviewStatus): boolean {
  return ACTIVE.has(status);
}

/** Where a run has no value: still coming while it runs, absent once it ended without one. */
function missing(status: ReviewStatus): string {
  return isActive(status) ? 'pending' : '—';
}

type RunFields = Pick<
  Review,
  'status' | 'head_sha' | 'files_changed' | 'additions' | 'deletions' | 'requirements_met' | 'requirements_total'
>;

/** The placeholder for the head / base pair, or null once the checkout recorded it. */
export function shaPair(r: RunFields): string | null {
  return r.head_sha ? null : missing(r.status);
}

/** The diff counts once the checkout recorded them, else a placeholder. */
export function diffCounts(r: RunFields): { files: number; additions: number; deletions: number } | string {
  if (r.files_changed === null || r.files_changed === undefined) return missing(r.status);
  return { files: r.files_changed, additions: r.additions ?? 0, deletions: r.deletions ?? 0 };
}

export function requirementsCount(r: RunFields): string {
  if (r.requirements_total === null || r.requirements_total === undefined) return missing(r.status);
  return `${r.requirements_met ?? 0}/${r.requirements_total} met`;
}

const EMPTY: Record<'findings' | 'requirements', Record<'done' | 'active' | 'ended', string>> = {
  findings: {
    done: 'No issues found.',
    active: 'Findings appear once the review finishes.',
    ended: 'No findings were recorded for this run.',
  },
  requirements: {
    done: 'No requirements recorded.',
    active: 'Requirements are checked once the review finishes.',
    ended: 'No requirements were recorded for this run.',
  },
};

/** What an empty list says: only a finished review can report that it found nothing. */
export function emptyNote(what: 'findings' | 'requirements', status: ReviewStatus): string {
  return EMPTY[what][status === 'done' ? 'done' : isActive(status) ? 'active' : 'ended'];
}

/** A card title with its count; a run in progress has nothing to count yet. */
export function cardCount(label: string, count: number, status: ReviewStatus): string {
  return isActive(status) ? label : `${label} (${count})`;
}
