import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { cleanGroupTitle, groupKeyFor } from './groupKey.js';
import type {
  FindingRow, GroupStatusFilter, LogLevel, LogRow, ObservationRow, RequirementRow, ReviewGroup,
  ReviewGroupBranch, ReviewOutput, ReviewRow,
} from './types.js';

fs.mkdirSync(config.DATA_DIR, { recursive: true });

export const db = new Database(path.join(config.DATA_DIR, 'review.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS reviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_key TEXT,
     ticket_title TEXT,
     ticket_url TEXT,
     ticket_body TEXT,
     repo TEXT NOT NULL,
     branch TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     head_sha TEXT,
     base_sha TEXT,
     pr_number INTEGER,
     run_index INTEGER NOT NULL,
     status TEXT NOT NULL,
     verdict TEXT,
     can_merge INTEGER,
     summary TEXT,
     requirements_met INTEGER,
     requirements_total INTEGER,
     blocking_count INTEGER,
     report_path TEXT,
     reviewer TEXT,
     model TEXT,
     error TEXT,
     files_changed INTEGER,
     additions INTEGER,
     deletions INTEGER,
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_ticket ON reviews(ticket_key)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_branch ON reviews(repo, branch)`,
  `CREATE TABLE IF NOT EXISTS findings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
     severity TEXT NOT NULL,
     category TEXT,
     file TEXT,
     line INTEGER,
     end_line INTEGER,
     title TEXT NOT NULL,
     problem TEXT NOT NULL,
     why TEXT,
     suggestion TEXT,
     snippet TEXT,
     ord INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id)`,
  `CREATE TABLE IF NOT EXISTS requirements (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     status TEXT NOT NULL,
     evidence TEXT,
     ord INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_requirements_review ON requirements(review_id)`,
  `CREATE TABLE IF NOT EXISTS review_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
     ts TEXT NOT NULL,
     level TEXT NOT NULL,
     message TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_review ON review_logs(review_id)`,
  // Added with the multi-lens pipeline. Non-blocking remarks: never part of
  // the merge gate.
  `CREATE TABLE IF NOT EXISTS observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
     file TEXT,
     line INTEGER,
     note TEXT NOT NULL,
     rationale TEXT,
     ord INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_observations_review ON observations(review_id)`,
  // Preview environments. A preview outlives the review it came from, so the
  // reference is nulled rather than cascaded when the review row is deleted.
  `CREATE TABLE IF NOT EXISTS previews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     review_id INTEGER REFERENCES reviews(id) ON DELETE SET NULL,
     recipe TEXT NOT NULL,
     ticket_key TEXT,
     roles_json TEXT NOT NULL,
     ports_json TEXT NOT NULL,
     url TEXT,
     db_name TEXT,
     dump_mode TEXT,
     dump_source TEXT,
     status TEXT NOT NULL,
     error TEXT,
     credentials_hint TEXT,
     created_at TEXT NOT NULL,
     ready_at TEXT,
     expires_at TEXT,
     stopped_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_previews_status ON previews(status)`,
  `CREATE INDEX IF NOT EXISTS idx_previews_review ON previews(review_id)`,
  `CREATE TABLE IF NOT EXISTS preview_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     preview_id INTEGER NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
     ts TEXT NOT NULL,
     level TEXT NOT NULL,
     message TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_preview_logs_preview ON preview_logs(preview_id)`,
];

export function migrate(): void {
  const run = db.transaction(() => {
    for (const sql of MIGRATIONS) db.prepare(sql).run();
    ensureColumn('reviews', 'reviewer', `ALTER TABLE reviews ADD COLUMN reviewer TEXT`);
    ensureColumn('reviews', 'source', `ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'github'`);
    ensureColumn('reviews', 'working_tree', `ALTER TABLE reviews ADD COLUMN working_tree INTEGER NOT NULL DEFAULT 0`);
    ensureColumn('reviews', 'base_reason', `ALTER TABLE reviews ADD COLUMN base_reason TEXT`);
    ensureColumn('reviews', 'group_key', `ALTER TABLE reviews ADD COLUMN group_key TEXT`);
    // After ensureColumn: on an older database the column only exists from here on.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_reviews_group ON reviews(group_key, created_at)`).run();
    syncGroupKeys();
  });
  run();
}

/**
 * group_key is derived from ticket_key, repo, and branch. Rows written before
 * the column existed (NULL) get theirs here, and a change to the derivation
 * rules reaches old rows on the next start. Only rows whose key differs are
 * written, so a second call changes nothing. Returns how many rows changed.
 */
export function syncGroupKeys(): number {
  const rows = db
    .prepare(`SELECT id, ticket_key, repo, branch, group_key FROM reviews`)
    .all() as Pick<ReviewRow, 'id' | 'ticket_key' | 'repo' | 'branch' | 'group_key'>[];
  const update = db.prepare(`UPDATE reviews SET group_key = ? WHERE id = ?`);
  let changed = 0;
  const apply = db.transaction(() => {
    for (const row of rows) {
      const key = groupKeyFor(row);
      if (key === row.group_key) continue;
      update.run(key, row.id);
      changed += 1;
    }
  });
  apply();
  return changed;
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}

migrate();

const REVIEW_COLUMNS = [
  'ticket_key', 'ticket_title', 'ticket_url', 'ticket_body', 'repo', 'branch', 'base_branch',
  'head_sha', 'base_sha', 'pr_number', 'run_index', 'status', 'verdict', 'can_merge', 'summary',
  'requirements_met', 'requirements_total', 'blocking_count', 'report_path', 'reviewer', 'model', 'error',
  'files_changed', 'additions', 'deletions', 'created_at', 'started_at', 'finished_at',
  'source', 'working_tree', 'base_reason', 'group_key',
] as const satisfies readonly (keyof ReviewRow)[];

/** Columns group_key is derived from; changing one of them re-derives it. */
const GROUP_KEY_SOURCES = new Set<string>(['ticket_key', 'repo', 'branch']);

type ReviewColumn = (typeof REVIEW_COLUMNS)[number];

type CreateReviewInput = Partial<ReviewRow> & { repo: string; branch: string; base_branch: string };

export function createReview(input: CreateReviewInput): ReviewRow {
  const nextRunIndex = db
    .prepare<[string, string], { next: number }>(
      `SELECT COALESCE(MAX(run_index), 0) + 1 AS next FROM reviews WHERE repo = ? AND branch = ?`,
    )
    .get(input.repo, input.branch);

  const row: Record<ReviewColumn, unknown> = {
    ticket_key: null, ticket_title: null, ticket_url: null, ticket_body: null,
    repo: input.repo, branch: input.branch, base_branch: input.base_branch,
    head_sha: null, base_sha: null, pr_number: null,
    run_index: input.run_index ?? nextRunIndex?.next ?? 1,
    status: input.status ?? 'queued',
    verdict: null, can_merge: null, summary: null,
    requirements_met: null, requirements_total: null, blocking_count: null,
    report_path: null, reviewer: null, model: null, error: null,
    files_changed: null, additions: null, deletions: null,
    created_at: input.created_at ?? new Date().toISOString(),
    started_at: null, finished_at: null,
    source: 'github', working_tree: 0, base_reason: null, group_key: null,
  };
  for (const column of REVIEW_COLUMNS) {
    const value = (input as Record<string, unknown>)[column];
    if (value !== undefined) row[column] = value;
  }
  // Always derived, never taken from the input.
  row.group_key = groupKeyFor({
    ticket_key: row.ticket_key as string | null,
    repo: row.repo as string,
    branch: row.branch as string,
  });

  const info = db
    .prepare(
      `INSERT INTO reviews (${REVIEW_COLUMNS.join(', ')})
       VALUES (${REVIEW_COLUMNS.map((c) => `@${c}`).join(', ')})`,
    )
    .run(row);

  const created = getReview(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to create review row');
  return created;
}

export function getReview(id: number): ReviewRow | undefined {
  return db.prepare<[number], ReviewRow>(`SELECT * FROM reviews WHERE id = ?`).get(id);
}

export function updateReview(id: number, patch: Partial<ReviewRow>): void {
  const entries = Object.entries(patch).filter(
    ([key, value]) =>
      key !== 'id' && key !== 'group_key' && value !== undefined &&
      (REVIEW_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
  const params: Record<string, unknown> = { id };
  for (const [key, value] of entries) params[key] = value;
  db.prepare(`UPDATE reviews SET ${assignments} WHERE id = @id`).run(params);

  if (entries.some(([key]) => GROUP_KEY_SOURCES.has(key))) {
    const row = getReview(id);
    if (row) db.prepare(`UPDATE reviews SET group_key = ? WHERE id = ?`).run(groupKeyFor(row), id);
  }
}

/** A case-insensitive substring pattern for `LIKE @q ESCAPE '\'`, with % and _ taken literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The free-text filter shared by the run list and the group list. */
const Q_MATCH = `(ticket_key LIKE @q ESCAPE '\\' OR ticket_title LIKE @q ESCAPE '\\'
  OR repo LIKE @q ESCAPE '\\' OR branch LIKE @q ESCAPE '\\' OR group_key LIKE @q ESCAPE '\\')`;

export interface ListReviewsFilter {
  ticket?: string;
  repo?: string;
  branch?: string;
  /** Exact group key: every run the history groups together. */
  group?: string;
  /** Case-insensitive substring match across ticket key, title, repo, branch, and group key. */
  q?: string;
  limit?: number;
  offset?: number;
}

export function listReviews(filter: ListReviewsFilter = {}): { reviews: ReviewRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.ticket) { where.push('ticket_key = @ticket'); params.ticket = filter.ticket; }
  if (filter.repo) { where.push('repo = @repo'); params.repo = filter.repo; }
  if (filter.branch) { where.push('branch = @branch'); params.branch = filter.branch; }
  if (filter.group) { where.push('group_key = @group'); params.group = filter.group; }
  if (filter.q) {
    where.push(Q_MATCH);
    params.q = likePattern(filter.q);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM reviews ${clause}`).get(params) as { n: number };
  const reviews = db
    .prepare(`SELECT * FROM reviews ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as ReviewRow[];

  return { reviews, total: total.n };
}

export interface ListGroupsFilter {
  /** Keeps groups with at least one run matching, as in `listReviews`. */
  q?: string;
  status?: GroupStatusFilter;
  limit?: number;
  offset?: number;
}

/**
 * What a status filter keeps, judged per group. "Head" = the latest run of a
 * repo/branch. `active`: some run is queued, fetching, or reviewing. `failed`:
 * some head failed. `done`: nothing is running or failed, and at least one
 * head has a verdict to read.
 */
const GROUP_STATUS_WHERE: Record<GroupStatusFilter, string> = {
  active: 'active_count > 0',
  failed: 'failed_heads > 0',
  done: 'active_count = 0 AND failed_heads = 0 AND done_heads > 0',
};

const ACTIVE_SQL = `status IN ('queued', 'fetching', 'reviewing')`;

interface GroupAggregateRow {
  key: string;
  last_activity: string;
  run_count: number;
  active_count: number;
  is_fallback: number;
  title: string | null;
  ticket_url: string | null;
}

type BranchHeadRow = ReviewGroupBranch['latest'] & Pick<ReviewRow, 'group_key' | 'repo' | 'branch' | 'source'>;

/**
 * The review history grouped by `group_key`, most recently active group first,
 * with the latest run of every repo/branch in each group. Everything is
 * aggregated in SQL; only the page's groups have their branches and titles read.
 */
export function listReviewGroups(filter: ListGroupsFilter = {}): { groups: ReviewGroup[]; total: number } {
  const params: Record<string, unknown> = {};
  const scope = ['group_key IS NOT NULL'];
  if (filter.q) {
    scope.push(`group_key IN (SELECT group_key FROM reviews WHERE ${Q_MATCH})`);
    params.q = likePattern(filter.q);
  }
  const statusWhere = filter.status ? `WHERE ${GROUP_STATUS_WHERE[filter.status]}` : '';

  const matched = `
    WITH scoped AS (
      SELECT id, group_key, repo, branch, status, created_at FROM reviews WHERE ${scope.join(' AND ')}
    ),
    heads AS (
      SELECT group_key, status,
             ROW_NUMBER() OVER (PARTITION BY group_key, repo, branch ORDER BY created_at DESC, id DESC) AS rn
      FROM scoped
    ),
    head_counts AS (
      SELECT group_key, SUM(status = 'failed') AS failed_heads, SUM(status = 'done') AS done_heads
      FROM heads WHERE rn = 1 GROUP BY group_key
    ),
    grouped AS (
      SELECT group_key AS key,
             MAX(created_at) AS last_activity,
             MAX(id) AS last_id,
             COUNT(*) AS run_count,
             SUM(${ACTIVE_SQL}) AS active_count,
             -- Only the repo#branch fallback equals a row's own repo#branch.
             MAX(group_key = repo || '#' || branch) AS is_fallback
      FROM scoped GROUP BY group_key
    ),
    matched AS (
      SELECT g.*, h.failed_heads, h.done_heads
      FROM grouped g JOIN head_counts h ON h.group_key = g.key
      ${statusWhere}
    )`;

  const total = db.prepare(`${matched} SELECT COUNT(*) AS n FROM matched`).get(params) as { n: number };

  const rows = db
    .prepare(
      `${matched}
       SELECT p.key, p.last_activity, p.run_count, p.active_count, p.is_fallback,
              (SELECT t.ticket_title FROM reviews t
                WHERE t.group_key = p.key AND TRIM(COALESCE(t.ticket_title, '')) <> ''
                ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS title,
              (SELECT t.ticket_url FROM reviews t
                WHERE t.group_key = p.key AND TRIM(COALESCE(t.ticket_url, '')) <> ''
                ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS ticket_url
       FROM (SELECT * FROM matched ORDER BY last_activity DESC, last_id DESC LIMIT @limit OFFSET @offset) p
       ORDER BY p.last_activity DESC, p.last_id DESC`,
    )
    .all({ ...params, limit: filter.limit ?? 20, offset: filter.offset ?? 0 }) as GroupAggregateRow[];

  if (rows.length === 0) return { groups: [], total: total.n };

  const heads = db
    .prepare(
      `SELECT group_key, repo, branch, source, id, run_index, status, verdict, can_merge, reviewer, model, created_at
       FROM (
         SELECT r.*, ROW_NUMBER() OVER (
                  PARTITION BY group_key, repo, branch ORDER BY created_at DESC, id DESC) AS rn
         FROM reviews r WHERE group_key IN (${rows.map(() => '?').join(', ')})
       )
       WHERE rn = 1
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...rows.map((r) => r.key)) as BranchHeadRow[];

  const branchesByGroup = new Map<string, ReviewGroupBranch[]>();
  for (const head of heads) {
    const list = branchesByGroup.get(head.group_key as string) ?? [];
    list.push({
      repo: head.repo,
      branch: head.branch,
      source: head.source,
      latest: {
        id: head.id,
        run_index: head.run_index,
        status: head.status,
        verdict: head.verdict,
        can_merge: head.can_merge,
        reviewer: head.reviewer,
        model: head.model,
        created_at: head.created_at,
      },
    });
    branchesByGroup.set(head.group_key as string, list);
  }

  return {
    total: total.n,
    groups: rows.map((row) => ({
      key: row.key,
      title: cleanGroupTitle(row.title, row.key),
      ticketUrl: row.ticket_url?.trim() || null,
      isTicket: row.is_fallback !== 1,
      lastActivity: row.last_activity,
      runCount: row.run_count,
      activeCount: row.active_count ?? 0,
      branches: branchesByGroup.get(row.key) ?? [],
    })),
  };
}

export function deleteReview(id: number): void {
  db.prepare(`DELETE FROM reviews WHERE id = ?`).run(id);
}

export function getPreviousRun(repo: string, branch: string, beforeRunIndex: number): ReviewRow | undefined {
  return db
    .prepare<[string, string, number], ReviewRow>(
      `SELECT * FROM reviews
       WHERE repo = ? AND branch = ? AND run_index < ? AND status = 'done'
       ORDER BY run_index DESC LIMIT 1`,
    )
    .get(repo, branch, beforeRunIndex);
}

export function addLog(reviewId: number, level: LogLevel, message: string): void {
  db.prepare(`INSERT INTO review_logs (review_id, ts, level, message) VALUES (?, ?, ?, ?)`)
    .run(reviewId, new Date().toISOString(), level, message);
}

export function getLogs(reviewId: number): LogRow[] {
  return db.prepare<[number], LogRow>(`SELECT * FROM review_logs WHERE review_id = ? ORDER BY id ASC`).all(reviewId);
}

export function replaceFindings(reviewId: number, findings: ReviewOutput['findings']): void {
  const insert = db.prepare(
    `INSERT INTO findings (review_id, severity, category, file, line, end_line, title, problem, why, suggestion, snippet, ord)
     VALUES (@review_id, @severity, @category, @file, @line, @end_line, @title, @problem, @why, @suggestion, @snippet, @ord)`,
  );
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM findings WHERE review_id = ?`).run(reviewId);
    findings.forEach((finding, index) => {
      insert.run({
        review_id: reviewId,
        severity: finding.severity,
        category: finding.category ?? null,
        file: finding.file ?? null,
        line: finding.line ?? null,
        end_line: finding.end_line ?? null,
        title: finding.title,
        problem: finding.problem,
        why: finding.why ?? null,
        suggestion: finding.suggestion ?? null,
        snippet: finding.snippet ?? null,
        ord: index,
      });
    });
  });
  run();
}

export function getFindings(reviewId: number): FindingRow[] {
  return db.prepare<[number], FindingRow>(`SELECT * FROM findings WHERE review_id = ? ORDER BY ord ASC`).all(reviewId);
}

export function replaceRequirements(reviewId: number, reqs: ReviewOutput['requirements']): void {
  const insert = db.prepare(
    `INSERT INTO requirements (review_id, text, status, evidence, ord)
     VALUES (@review_id, @text, @status, @evidence, @ord)`,
  );
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM requirements WHERE review_id = ?`).run(reviewId);
    reqs.forEach((req, index) => {
      insert.run({
        review_id: reviewId,
        text: req.text,
        status: req.status,
        evidence: req.evidence ?? null,
        ord: index,
      });
    });
  });
  run();
}

export function replaceObservations(reviewId: number, rows: ReviewOutput['observations']): void {
  const insert = db.prepare(
    `INSERT INTO observations (review_id, file, line, note, rationale, ord)
     VALUES (@review_id, @file, @line, @note, @rationale, @ord)`,
  );
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM observations WHERE review_id = ?`).run(reviewId);
    rows.forEach((observation, index) => {
      insert.run({
        review_id: reviewId,
        file: observation.file ?? null,
        line: observation.line ?? null,
        note: observation.note,
        rationale: observation.rationale ?? null,
        ord: index,
      });
    });
  });
  run();
}

export function getObservations(reviewId: number): ObservationRow[] {
  return db
    .prepare<[number], ObservationRow>(`SELECT * FROM observations WHERE review_id = ? ORDER BY ord ASC`)
    .all(reviewId);
}

export function getRequirements(reviewId: number): RequirementRow[] {
  return db
    .prepare<[number], RequirementRow>(`SELECT * FROM requirements WHERE review_id = ? ORDER BY ord ASC`)
    .all(reviewId);
}
