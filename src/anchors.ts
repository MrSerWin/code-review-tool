import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { normalizeHunk, normalizeKind, optionalLine, optionalPath } from './findingFields.js';
import type { AnchorStatus, ChangedFile, Finding, OnLog } from './types.js';

// --- validation at HEAD ----------------------------------------------------

/** Files larger than this are not read to count lines; the path check still runs. */
const MAX_COUNTED_BYTES = 20 * 1024 * 1024;

export interface AnchorContext {
  /** The checkout at HEAD. Only read, never written. */
  dir: string;
  realDir: string;
  /** Changed files by HEAD-side path (deleted files by their old path). */
  changed: Map<string, ChangedFile>;
  /** Pre-rename path to the new path. */
  renamedFrom: Map<string, string>;
  lineCounts: Map<string, number | null | undefined>;
}

export function createAnchorContext(dir: string, files: readonly ChangedFile[]): AnchorContext {
  const changed = new Map<string, ChangedFile>();
  const renamedFrom = new Map<string, string>();
  for (const f of files) {
    changed.set(f.path, f);
    if (f.old_path && f.old_path !== f.path) renamedFrom.set(f.old_path, f.path);
  }
  let realDir = dir;
  try { realDir = fs.realpathSync(dir); } catch { /* checked per path */ }
  return { dir, realDir, changed, renamedFrom, lineCounts: new Map() };
}

/** A plain changed-path list (no statuses) as changed files, for callers that have only paths. */
export function changedFilesFromPaths(paths: readonly string[]): ChangedFile[] {
  return paths.map((p) => ({ path: p, status: 'M', old_path: null, additions: null, deletions: null }));
}

/**
 * Line count of a repo-relative file at HEAD, or undefined when the path is
 * not a regular file inside the checkout. Null: the file exists but is too
 * large to count.
 */
function lineCount(ctx: AnchorContext, rel: string): number | null | undefined {
  if (ctx.lineCounts.has(rel)) return ctx.lineCounts.get(rel);
  let result: number | null | undefined;
  try {
    const abs = path.resolve(ctx.dir, rel);
    const real = fs.realpathSync(abs);
    const inside = path.relative(ctx.realDir, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep)[0] === '.git') {
      result = undefined;
    } else {
      const stat = fs.statSync(real);
      if (!stat.isFile()) result = undefined;
      else if (stat.size > MAX_COUNTED_BYTES) result = null;
      else {
        const text = fs.readFileSync(real, 'utf8');
        if (text.length === 0) result = 0;
        else {
          let n = 0;
          for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
          result = text.endsWith('\n') ? n : n + 1;
        }
      }
    }
  } catch {
    result = undefined;
  }
  ctx.lineCounts.set(rel, result);
  return result;
}

function isSafeRelative(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  return !rel.split('/').some((part) => part === '..');
}

export interface ResolvedPath {
  /** The path as it should be stored: repo-relative, renames resolved. */
  file: string;
  /** A trailing `:line` the model put into the path, when it was split off. */
  line: number | null;
  exists: boolean;
}

/**
 * Normalises a model-written path: `./x`, an absolute path inside the
 * checkout, a diff-style `a/` or `b/` prefix, a pre-rename path, and a
 * `path:line` suffix all resolve to the repo-relative HEAD path. Anything
 * that cannot be read safely stays as written and reports `exists: false`.
 */
export function resolvePath(ctx: AnchorContext, raw: string): ResolvedPath {
  let file = raw.trim().replace(/\\/g, '/');
  for (const root of new Set([ctx.dir, ctx.realDir])) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (file.startsWith(prefix)) file = file.slice(prefix.length);
  }
  while (file.startsWith('./')) file = file.slice(2);

  const candidates: { file: string; line: number | null }[] = [{ file, line: null }];
  const suffix = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(file);
  if (suffix) candidates.push({ file: suffix[1]!, line: Number(suffix[2]) });
  for (const c of [...candidates]) {
    const stripped = /^[ab]\/(.+)$/.exec(c.file);
    if (stripped) candidates.push({ file: stripped[1]!, line: c.line });
  }
  for (const c of [...candidates]) {
    const renamed = ctx.renamedFrom.get(c.file);
    if (renamed) candidates.push({ file: renamed, line: c.line });
  }

  for (const c of candidates) {
    if (isSafeRelative(c.file) && lineCount(ctx, c.file) !== undefined) return { ...c, exists: true };
  }
  // Not at HEAD, but a deleted file of this diff is still a real place to point at.
  for (const c of candidates) {
    if (ctx.changed.get(c.file)?.status === 'D') return { ...c, exists: false };
  }
  return { file, line: null, exists: false };
}

type LocationCheck = 'ok' | 'missing_path' | 'line_out_of_range';

function checkLine(ctx: AnchorContext, file: string, line: number | null, endLine: number | null): LocationCheck {
  const count = lineCount(ctx, file);
  if (count === undefined) return 'missing_path';
  if (count === null) return 'ok';
  if (line !== null && (line < 1 || line > Math.max(count, 1))) return 'line_out_of_range';
  if (endLine !== null && line !== null && (endLine < line || endLine > count)) return 'line_out_of_range';
  return 'ok';
}

/** Whether a cause location names a changed line: a changed file, and a line inside it. */
function causeIsValid(ctx: AnchorContext, file: string | null, line: number | null): boolean {
  if (!file) return false;
  const entry = ctx.changed.get(file);
  if (!entry) return false;
  // A deleted file has no lines at HEAD; its cause line refers to the base.
  if (entry.status === 'D') return true;
  return checkLine(ctx, file, line, null) === 'ok';
}

type AnchorFields = Pick<Finding, 'file' | 'line' | 'end_line' | 'kind' | 'cause_file' | 'cause_line'>;

export interface AnchorCheck<T> {
  finding: T & { anchor_status: AnchorStatus };
  causeValid: boolean;
}

/**
 * Checks one finding at HEAD and returns it with normalised paths and its
 * `anchor_status`:
 * - `unverified`: no file to check.
 * - `missing_path` / `line_out_of_range`: the anchor itself is wrong.
 * - `off_diff`: a real place, but outside the changed files, and the finding
 *   is a `diff` finding or names no valid cause in the changed set.
 * - `ok`: otherwise.
 */
export function checkAnchor<T extends AnchorFields>(ctx: AnchorContext, input: T): AnchorCheck<T> {
  const f = { ...input };
  if (f.cause_file) {
    const cause = resolvePath(ctx, f.cause_file);
    f.cause_file = cause.file;
    if (f.cause_line === null && cause.line !== null) f.cause_line = cause.line;
  }
  const causeValid = causeIsValid(ctx, f.cause_file, f.cause_line);
  if (!f.file) return { finding: { ...f, anchor_status: 'unverified' }, causeValid };

  const resolved = resolvePath(ctx, f.file);
  f.file = resolved.file;
  if (f.line === null && resolved.line !== null) f.line = resolved.line;

  let status: AnchorStatus;
  const located = checkLine(ctx, f.file, f.line, f.end_line);
  if (located !== 'ok') status = located;
  else if (ctx.changed.has(f.file)) status = 'ok';
  else if (f.kind !== 'diff' && causeValid) status = 'ok';
  else status = 'off_diff';
  return { finding: { ...f, anchor_status: status }, causeValid };
}

/** Findings with this status get the corrective re-anchor pass. */
export function needsReanchor(status: AnchorStatus): boolean {
  return status === 'off_diff' || status === 'missing_path' || status === 'line_out_of_range';
}

const STATUS_RANK: Record<AnchorStatus, number> = {
  ok: 4, off_diff: 3, line_out_of_range: 2, missing_path: 1, unverified: 0,
};

// --- the corrective re-anchor pass -----------------------------------------

/** At most this many findings go into the one re-anchor pass. */
export const MAX_REANCHOR = 40;

export const reanchorOutputSchema = z.object({
  anchors: z.array(z.object({
    id: z.coerce.number().int(),
    file: optionalPath,
    line: optionalLine,
    end_line: optionalLine,
    // Absent means "keep the current value", unlike in the lens and synthesis schemas.
    kind: z.unknown().optional().transform((v) => (v === undefined || v === null ? null : normalizeKind(v))),
    cause_file: optionalPath,
    cause_line: optionalLine,
    hunk: z.unknown().optional().transform(normalizeHunk),
    note: z.string().nullish().transform((v) => v ?? ''),
  })).nullish().transform((v) => v ?? []),
});
export type ReanchorOutput = z.infer<typeof reanchorOutputSchema>;

const STATUS_TEXT: Record<AnchorStatus, string> = {
  ok: 'ok',
  off_diff: 'the file is not in the changed set, and the finding names no valid cause in the changed set',
  missing_path: 'the path does not exist at HEAD',
  line_out_of_range: 'the line is outside the file at HEAD',
  unverified: 'not checked',
};

/** The `{{FINDINGS}}` block of the re-anchor prompt. */
export function renderReanchorFindings(items: { id: number; finding: Finding & { anchor_status: AnchorStatus } }[]): string {
  return items.map(({ id, finding: f }) => {
    const where = f.file ? `${f.file}${f.line !== null ? `:${f.line}` : ''}${f.end_line ? `-${f.end_line}` : ''}` : 'none';
    const cause = f.cause_file ? `${f.cause_file}${f.cause_line !== null ? `:${f.cause_line}` : ''}` : 'none';
    return [
      `## Finding ${id}: [${f.severity}] ${f.title}`,
      `- current anchor: ${where}`,
      `- kind: ${f.kind}; cause: ${cause}`,
      `- problem with the anchor: ${STATUS_TEXT[f.anchor_status]}`,
      `- finding: ${f.problem.replace(/\s+/g, ' ').slice(0, 1200)}`,
    ].join('\n');
  }).join('\n\n');
}

export interface AnchorRunResult {
  findings: Finding[];
  /** How many findings went into the re-anchor pass (0: it did not run). */
  sent: number;
  /** How many of those got a better anchor. */
  fixed: number;
  /** Findings whose status is still not `ok` / `unverified` afterwards. */
  stillInvalid: number;
}

/**
 * Validates every finding, runs ONE corrective pass for the ones whose anchor
 * is wrong, applies an answer only where it strictly improves the status,
 * and keeps every finding either way. `reanchor` gets the rendered findings
 * block and returns the parsed answer; a failure leaves the first statuses.
 */
export async function anchorFindings(
  ctx: AnchorContext,
  findings: Finding[],
  reanchor: (findingsBlock: string) => Promise<ReanchorOutput>,
  onLog: OnLog,
): Promise<AnchorRunResult> {
  const checked = findings.map((f) => checkAnchor(ctx, f).finding);
  const bad = checked
    .map((finding, index) => ({ id: index + 1, finding }))
    .filter((item) => needsReanchor(item.finding.anchor_status));
  const sent = bad.slice(0, MAX_REANCHOR);
  let fixed = 0;

  if (sent.length > 0) {
    onLog('info', `anchors: ${sent.length} finding(s) with a wrong or off-diff anchor; running one re-anchor pass.`);
    try {
      const answer = await reanchor(renderReanchorFindings(sent));
      const byId = new Map(answer.anchors.map((a) => [a.id, a]));
      for (const item of sent) {
        const a = byId.get(item.id);
        if (!a) continue;
        const before = item.finding;
        const candidate = checkAnchor(ctx, {
          ...before,
          file: a.file,
          line: a.line,
          end_line: a.end_line,
          kind: a.kind ?? before.kind,
          cause_file: a.cause_file,
          cause_line: a.cause_line,
          hunk: a.hunk ?? before.hunk,
        }).finding;
        if (STATUS_RANK[candidate.anchor_status] > STATUS_RANK[before.anchor_status]) {
          checked[item.id - 1] = candidate;
          fixed += 1;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog('warn', `anchors: re-anchor pass failed, keeping the original anchors: ${message.split('\n')[0]}`);
    }
  }

  const stillInvalid = checked.filter((f) => needsReanchor(f.anchor_status)).length;
  const counts = new Map<AnchorStatus, number>();
  for (const f of checked) counts.set(f.anchor_status, (counts.get(f.anchor_status) ?? 0) + 1);
  onLog(
    'info',
    `anchors: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ') || 'no findings'}` +
      (sent.length ? `; re-anchor fixed ${fixed} of ${sent.length}` : ''),
  );
  return { findings: checked, sent: sent.length, fixed, stillInvalid };
}

