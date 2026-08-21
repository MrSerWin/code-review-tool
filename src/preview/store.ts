import { db } from '../db.js';
import type { LogLevel, PreviewLogRow, PreviewRow, PreviewStatus } from '../types.js';

const PREVIEW_COLUMNS = [
  'review_id', 'recipe', 'ticket_key', 'roles_json', 'ports_json', 'url', 'db_name',
  'dump_mode', 'dump_source', 'status', 'error', 'credentials_hint',
  'created_at', 'ready_at', 'expires_at', 'stopped_at',
] as const satisfies readonly (keyof PreviewRow)[];

type PreviewColumn = (typeof PREVIEW_COLUMNS)[number];

/** Statuses that still own resources: a container may be running for them. */
export const LIVE_STATUSES: readonly PreviewStatus[] = [
  'queued', 'preparing', 'starting', 'ready', 'stopping',
];

export type CreatePreviewInput = Partial<PreviewRow> & { recipe: string };

export function createPreview(input: CreatePreviewInput): PreviewRow {
  const row: Record<PreviewColumn, unknown> = {
    review_id: null, recipe: input.recipe, ticket_key: null,
    roles_json: '[]', ports_json: '{}', url: null, db_name: null,
    dump_mode: null, dump_source: null, status: 'queued', error: null,
    credentials_hint: null, created_at: new Date().toISOString(),
    ready_at: null, expires_at: null, stopped_at: null,
  };
  for (const column of PREVIEW_COLUMNS) {
    const value = (input as Record<string, unknown>)[column];
    if (value !== undefined) row[column] = value;
  }
  const info = db
    .prepare(
      `INSERT INTO previews (${PREVIEW_COLUMNS.join(', ')})
       VALUES (${PREVIEW_COLUMNS.map((c) => `@${c}`).join(', ')})`,
    )
    .run(row);
  const created = getPreview(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to create preview row');
  return created;
}

export function getPreview(id: number): PreviewRow | undefined {
  return db.prepare<[number], PreviewRow>(`SELECT * FROM previews WHERE id = ?`).get(id);
}

export function updatePreview(id: number, patch: Partial<PreviewRow>): void {
  const entries = Object.entries(patch).filter(
    ([key, value]) => key !== 'id' && value !== undefined && (PREVIEW_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
  const params: Record<string, unknown> = { id };
  for (const [key, value] of entries) params[key] = value;
  db.prepare(`UPDATE previews SET ${assignments} WHERE id = @id`).run(params);
}

export interface ListPreviewsFilter {
  reviewId?: number;
  ticket?: string;
  recipe?: string;
  limit?: number;
  offset?: number;
}

export function listPreviews(filter: ListPreviewsFilter = {}): { previews: PreviewRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.reviewId !== undefined) { where.push('review_id = @reviewId'); params.reviewId = filter.reviewId; }
  if (filter.ticket) { where.push('ticket_key = @ticket'); params.ticket = filter.ticket; }
  if (filter.recipe) { where.push('recipe = @recipe'); params.recipe = filter.recipe; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM previews ${clause}`).get(params) as { n: number };
  const previews = db
    .prepare(`SELECT * FROM previews ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as PreviewRow[];
  return { previews, total: total.n };
}

export function deletePreviewRow(id: number): void {
  db.prepare(`DELETE FROM previews WHERE id = ?`).run(id);
}

/** Every preview that may still hold a port or a container. */
export function livePreviews(): PreviewRow[] {
  const marks = LIVE_STATUSES.map(() => '?').join(', ');
  return db
    .prepare<string[], PreviewRow>(`SELECT * FROM previews WHERE status IN (${marks}) ORDER BY id ASC`)
    .all(...LIVE_STATUSES);
}

export function countLive(): number {
  const marks = LIVE_STATUSES.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM previews WHERE status IN (${marks})`)
    .get(...LIVE_STATUSES) as { n: number };
  return row.n;
}

/** Host ports held by previews that are not torn down yet. */
export function portsInUse(): Set<number> {
  const used = new Set<number>();
  for (const preview of livePreviews()) {
    for (const port of Object.values(parsePorts(preview.ports_json))) used.add(port);
  }
  return used;
}

export function expiredPreviews(nowIso: string): PreviewRow[] {
  return db
    .prepare<[string], PreviewRow>(
      `SELECT * FROM previews WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(nowIso);
}

export function addPreviewLog(previewId: number, level: LogLevel, message: string): void {
  db.prepare(`INSERT INTO preview_logs (preview_id, ts, level, message) VALUES (?, ?, ?, ?)`)
    .run(previewId, new Date().toISOString(), level, message);
}

export function getPreviewLogs(previewId: number, limit = 2000): PreviewLogRow[] {
  return db
    .prepare<[number, number], PreviewLogRow>(
      `SELECT * FROM (SELECT * FROM preview_logs WHERE preview_id = ? ORDER BY id DESC LIMIT ?)
       ORDER BY id ASC`,
    )
    .all(previewId, limit);
}

export function parsePorts(json: string): Record<string, number> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}
