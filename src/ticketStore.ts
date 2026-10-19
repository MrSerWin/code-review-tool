/**
 * Rows of the ticket-group tables (`ticket_groups`, `ticket_branches`,
 * `ticket_coverage`, `ticket_runs`). The tables are created by db.ts; this
 * module only reads and writes them.
 */
import { db } from './db.js';
import { fallbackGroupKey } from './groupKey.js';
import type {
  CoverageRequirement, CoverageVerdict, ParentReason, ReviewRow, ReviewSource, TicketBranchRow, TicketCoverageRow,
  TicketGroupRow, TicketRunRow,
} from './types.js';

const now = (): string => new Date().toISOString();

/** A review's group is a ticket group unless it is the `repo#branch` fallback. */
export function isTicketGroupKey(row: Pick<ReviewRow, 'group_key' | 'repo' | 'branch'>): boolean {
  return Boolean(row.group_key) && row.group_key !== fallbackGroupKey(row.repo, row.branch);
}

export function getTicketGroup(key: string): TicketGroupRow | undefined {
  return db.prepare<[string], TicketGroupRow>(`SELECT * FROM ticket_groups WHERE key = ?`).get(key);
}

/** Creates the group when it is missing; non-null fields of `patch` overwrite. */
export function upsertTicketGroup(
  key: string,
  patch: { title?: string | null; ticket_url?: string | null; requirements_text?: string | null } = {},
): TicketGroupRow {
  const at = now();
  db.prepare(
    `INSERT INTO ticket_groups (key, title, ticket_url, requirements_text, created_at, updated_at)
     VALUES (@key, @title, @ticket_url, @requirements_text, @at, @at)
     ON CONFLICT(key) DO UPDATE SET
       title = COALESCE(@title, title),
       ticket_url = COALESCE(@ticket_url, ticket_url),
       requirements_text = COALESCE(@requirements_text, requirements_text),
       updated_at = @at`,
  ).run({
    key,
    title: patch.title?.trim() || null,
    ticket_url: patch.ticket_url?.trim() || null,
    requirements_text: patch.requirements_text?.trim() || null,
    at,
  });
  return getTicketGroup(key)!;
}

export function listTicketBranches(key: string): TicketBranchRow[] {
  return db
    .prepare<[string], TicketBranchRow>(
      `SELECT * FROM ticket_branches WHERE ticket_key = ? ORDER BY repo, position, branch`,
    )
    .all(key);
}

export function getTicketBranch(key: string, repo: string, branch: string): TicketBranchRow | undefined {
  return db
    .prepare<[string, string, string], TicketBranchRow>(
      `SELECT * FROM ticket_branches WHERE ticket_key = ? AND repo = ? AND branch = ?`,
    )
    .get(key, repo, branch);
}

export interface BranchMember {
  repo: string;
  branch: string;
  source?: ReviewSource;
  prNumber?: number | null;
}

/**
 * Adds a branch to a group (creating the group) or refreshes its source and
 * pull request. The parent is left alone: it is set by detection or by hand.
 * Returns the row and whether it is new.
 */
export function upsertTicketBranch(key: string, member: BranchMember): { row: TicketBranchRow; created: boolean } {
  if (!getTicketGroup(key)) upsertTicketGroup(key);
  const existing = getTicketBranch(key, member.repo, member.branch);
  const at = now();
  if (existing) {
    db.prepare(
      `UPDATE ticket_branches SET source = @source, pr_number = COALESCE(@pr, pr_number), updated_at = @at
       WHERE id = @id`,
    ).run({ id: existing.id, source: member.source ?? existing.source, pr: member.prNumber ?? null, at });
    return { row: getTicketBranch(key, member.repo, member.branch)!, created: false };
  }
  const position = (db
    .prepare<[string, string], { n: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ticket_branches WHERE ticket_key = ? AND repo = ?`,
    )
    .get(key, member.repo)?.n) ?? 0;
  db.prepare(
    `INSERT INTO ticket_branches (ticket_key, repo, branch, source, parent_branch, parent_reason, default_branch,
                                  position, pr_number, created_at, updated_at)
     VALUES (@key, @repo, @branch, @source, NULL, NULL, NULL, @position, @pr, @at, @at)`,
  ).run({
    key, repo: member.repo, branch: member.branch, source: member.source ?? 'github', position,
    pr: member.prNumber ?? null, at,
  });
  return { row: getTicketBranch(key, member.repo, member.branch)!, created: true };
}

export function setTicketBranchParent(
  key: string,
  repo: string,
  branch: string,
  parent: string | null,
  reason: ParentReason | null,
  extra: { defaultBranch?: string | null; position?: number } = {},
): void {
  db.prepare(
    `UPDATE ticket_branches
        SET parent_branch = @parent, parent_reason = @reason,
            default_branch = COALESCE(@default_branch, default_branch),
            position = COALESCE(@position, position), updated_at = @at
      WHERE ticket_key = @key AND repo = @repo AND branch = @branch`,
  ).run({
    key, repo, branch, parent, reason, default_branch: extra.defaultBranch ?? null,
    position: extra.position ?? null, at: now(),
  });
}

export function removeTicketBranch(key: string, repo: string, branch: string): boolean {
  return db.prepare(`DELETE FROM ticket_branches WHERE ticket_key = ? AND repo = ? AND branch = ?`)
    .run(key, repo, branch).changes > 0;
}

/**
 * Branches the review history knows for a group but the group does not:
 * groups older than the group tables, and runs started outside a ticket
 * review. Each joins with the base of its latest run as a stored parent.
 * Returns how many joined.
 */
export function syncMembersFromReviews(key: string): number {
  const heads = db
    .prepare<[string], Pick<ReviewRow, 'repo' | 'branch' | 'source' | 'base_branch' | 'pr_number' | 'ticket_title' | 'ticket_url'>>(
      `SELECT repo, branch, source, base_branch, pr_number, ticket_title, ticket_url FROM (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY repo, branch ORDER BY created_at DESC, id DESC) AS rn
         FROM reviews r WHERE group_key = ?
       ) WHERE rn = 1`,
    )
    .all(key)
    // A `repo#branch` fallback group is a single branch without a ticket, never a ticket group.
    .filter((h) => key !== fallbackGroupKey(h.repo, h.branch));
  if (heads.length === 0) return 0;
  let added = 0;
  const run = db.transaction(() => {
    const title = heads.find((h) => h.ticket_title?.trim())?.ticket_title ?? null;
    const url = heads.find((h) => h.ticket_url?.trim())?.ticket_url ?? null;
    if (!getTicketGroup(key)) upsertTicketGroup(key, { title, ticket_url: url });
    for (const head of heads) {
      const { created } = upsertTicketBranch(key, {
        repo: head.repo, branch: head.branch, source: head.source, prNumber: head.pr_number,
      });
      if (!created) continue;
      setTicketBranchParent(key, head.repo, head.branch, head.base_branch, 'stored');
      added += 1;
    }
  });
  run();
  return added;
}

// --- coverage ----------------------------------------------------------------

export function createCoverage(
  key: string,
  input: { reviewIds: number[]; reviewer: string | null; model: string | null; trigger: string },
): TicketCoverageRow {
  const info = db.prepare(
    `INSERT INTO ticket_coverage (ticket_key, status, review_ids, reviewer, model, trigger, created_at)
     VALUES (?, 'running', ?, ?, ?, ?, ?)`,
  ).run(key, JSON.stringify(input.reviewIds), input.reviewer, input.model, input.trigger, now());
  return getCoverage(Number(info.lastInsertRowid))!;
}

export function getCoverage(id: number): TicketCoverageRow | undefined {
  return db.prepare<[number], TicketCoverageRow>(`SELECT * FROM ticket_coverage WHERE id = ?`).get(id);
}

/** The newest coverage of a group, of any status. */
export function latestCoverage(key: string): TicketCoverageRow | undefined {
  return db
    .prepare<[string], TicketCoverageRow>(`SELECT * FROM ticket_coverage WHERE ticket_key = ? ORDER BY id DESC LIMIT 1`)
    .get(key);
}

/** The newest finished coverage of a group. */
export function latestDoneCoverage(key: string): TicketCoverageRow | undefined {
  return db
    .prepare<[string], TicketCoverageRow>(
      `SELECT * FROM ticket_coverage WHERE ticket_key = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
    )
    .get(key);
}

export function finishCoverage(
  id: number,
  result:
    | { status: 'done'; verdict: CoverageVerdict; summary: string; requirements: CoverageRequirement[]; reportPath: string | null }
    | { status: 'failed'; error: string },
): void {
  if (result.status === 'done') {
    db.prepare(
      `UPDATE ticket_coverage SET status = 'done', verdict = ?, summary = ?, requirements_json = ?, report_path = ?,
              error = NULL, finished_at = ? WHERE id = ?`,
    ).run(result.verdict, result.summary, JSON.stringify(result.requirements), result.reportPath, now(), id);
  } else {
    db.prepare(`UPDATE ticket_coverage SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .run(result.error.slice(0, 4000), now(), id);
  }
}

/** Coverage rows left `running` by a process that is gone. */
export function failRunningCoverage(reason: string): number {
  return db.prepare(`UPDATE ticket_coverage SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`)
    .run(reason, now()).changes;
}

export function parseIds(json: string | null | undefined): number[] {
  try {
    const value = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];
  } catch {
    return [];
  }
}

export function parseCoverageRequirements(row: Pick<TicketCoverageRow, 'requirements_json'>): CoverageRequirement[] {
  try {
    const value = JSON.parse(row.requirements_json ?? '[]') as unknown;
    return Array.isArray(value) ? (value as CoverageRequirement[]) : [];
  } catch {
    return [];
  }
}

// --- ticket runs -------------------------------------------------------------

export function createTicketRun(key: string, reviewIds: number[]): TicketRunRow {
  const info = db.prepare(
    `INSERT INTO ticket_runs (ticket_key, review_ids, status, created_at) VALUES (?, ?, 'running', ?)`,
  ).run(key, JSON.stringify(reviewIds), now());
  return db.prepare<[number], TicketRunRow>(`SELECT * FROM ticket_runs WHERE id = ?`).get(Number(info.lastInsertRowid))!;
}

export function getTicketRun(id: number): TicketRunRow | undefined {
  return db.prepare<[number], TicketRunRow>(`SELECT * FROM ticket_runs WHERE id = ?`).get(id);
}

export function latestTicketRun(key: string): TicketRunRow | undefined {
  return db
    .prepare<[string], TicketRunRow>(`SELECT * FROM ticket_runs WHERE ticket_key = ? ORDER BY id DESC LIMIT 1`)
    .get(key);
}

/** Closes every running batch of the group whose reviews are all in `settled`. */
export function closeTicketRuns(key: string, settled: ReadonlySet<number>, coverageId: number): number[] {
  const open = db
    .prepare<[string], TicketRunRow>(`SELECT * FROM ticket_runs WHERE ticket_key = ? AND status = 'running'`)
    .all(key);
  const closed: number[] = [];
  for (const run of open) {
    if (!parseIds(run.review_ids).every((id) => settled.has(id))) continue;
    db.prepare(`UPDATE ticket_runs SET status = 'done', coverage_id = ?, finished_at = ? WHERE id = ?`)
      .run(coverageId, now(), run.id);
    closed.push(run.id);
  }
  return closed;
}
