import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type {
  FindingRow, LogLevel, LogRow, RequirementRow, ReviewOutput, ReviewRow,
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
];

export function migrate(): void {
  const run = db.transaction(() => {
    for (const sql of MIGRATIONS) db.prepare(sql).run();
  });
  run();
}

migrate();

const REVIEW_COLUMNS = [
  'ticket_key', 'ticket_title', 'ticket_url', 'ticket_body', 'repo', 'branch', 'base_branch',
  'head_sha', 'base_sha', 'pr_number', 'run_index', 'status', 'verdict', 'can_merge', 'summary',
  'requirements_met', 'requirements_total', 'blocking_count', 'report_path', 'model', 'error',
  'files_changed', 'additions', 'deletions', 'created_at', 'started_at', 'finished_at',
] as const satisfies readonly (keyof ReviewRow)[];

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
    report_path: null, model: null, error: null,
    files_changed: null, additions: null, deletions: null,
    created_at: input.created_at ?? new Date().toISOString(),
    started_at: null, finished_at: null,
  };
  for (const column of REVIEW_COLUMNS) {
    const value = (input as Record<string, unknown>)[column];
    if (value !== undefined) row[column] = value;
  }

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
    ([key, value]) => key !== 'id' && value !== undefined && (REVIEW_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
  const params: Record<string, unknown> = { id };
  for (const [key, value] of entries) params[key] = value;
  db.prepare(`UPDATE reviews SET ${assignments} WHERE id = @id`).run(params);
}

export interface ListReviewsFilter {
  ticket?: string;
  repo?: string;
  branch?: string;
  limit?: number;
  offset?: number;
}

export function listReviews(filter: ListReviewsFilter = {}): { reviews: ReviewRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.ticket) { where.push('ticket_key = @ticket'); params.ticket = filter.ticket; }
  if (filter.repo) { where.push('repo = @repo'); params.repo = filter.repo; }
  if (filter.branch) { where.push('branch = @branch'); params.branch = filter.branch; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM reviews ${clause}`).get(params) as { n: number };
  const reviews = db
    .prepare(`SELECT * FROM reviews ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as ReviewRow[];

  return { reviews, total: total.n };
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

export function getRequirements(reviewId: number): RequirementRow[] {
  return db
    .prepare<[number], RequirementRow>(`SELECT * FROM requirements WHERE review_id = ? ORDER BY ord ASC`)
    .all(reviewId);
}
