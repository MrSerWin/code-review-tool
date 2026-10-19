/**
 * Ticket coverage: one reviewer pass per ticket group that reads every
 * branch's finished review (changed files, summary, requirement checklist)
 * and says, per requirement, whether the group covers it and which branch
 * does. Evidence locations are checked like finding anchors, against each
 * branch's own checkout when it is still on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createAnchorContext, checkAnchor } from './anchors.js';
import { config } from './config.js';
import { coverageVerdict, branchCoverage, openRequirements } from './coverageView.js';
import { db, getRequirements, getReviewFiles } from './db.js';
import { checkoutDir, pruneCheckout } from './gitSandbox.js';
import { logger } from './logger.js';
import { livePreviews } from './preview/store.js';
import {
  renderBranchCoverageSection, sanitizeSegment, updateReportCoverage, writeCoverageReport,
  type CoverageForReport, type CoverageReportBranch,
} from './reportWriter.js';
import { getReviewer } from './reviewers/index.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import { loadPromptFile, renderTemplate, runPass } from './reviewRunner.js';
import { orderChains } from './ticketChains.js';
import { groupHeads } from './ticketGroups.js';
import {
  closeTicketRuns, createCoverage, finishCoverage, getCoverage, getTicketGroup, listTicketBranches, parseIds,
  syncMembersFromReviews,
} from './ticketStore.js';
import type {
  AnchorStatus, CoverageBranch, CoverageEvidence, CoverageRequirement, CoverageStatus, OnLog, RequirementRow,
  ReviewFileRow, ReviewRow, TicketBranchRow, TicketCoverageRow,
} from './types.js';

// --- the answer ----------------------------------------------------------------

function coverageStatus(value: unknown): CoverageStatus {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'covered' || v === 'met' || v === 'done' || v === 'implemented') return 'covered';
  if (v === 'partial' || v === 'partially_covered' || v === 'partly') return 'partial';
  return 'missing';
}

const evidenceSchema = z.union([
  z.object({
    file: z.string().min(1),
    line: z.coerce.number().int().nullish().transform((v) => v ?? null),
  }),
  // `path/file.py:42` as one string.
  z.string().min(1).transform((raw) => {
    const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(raw.trim());
    return m ? { file: m[1]!, line: Number(m[2]) } : { file: raw.trim(), line: null };
  }),
]);

const coverageBranchSchema = z.object({
  repo: z.string().nullish().transform((v) => v?.trim() || null),
  branch: z.string().min(1),
  status: z.unknown().optional().transform((v) => (coverageStatus(v) === 'covered' ? 'covered' : 'partial')),
  note: z.string().nullish().transform((v) => v ?? ''),
  evidence: z.array(evidenceSchema).nullish().transform((v) => v ?? []),
});

export const coverageOutputSchema = z.object({
  summary: z.string().nullish().transform((v) => v ?? ''),
  requirements: z.array(z.object({
    text: z.string().min(1),
    status: z.unknown().transform(coverageStatus),
    note: z.string().nullish().transform((v) => v ?? ''),
    branches: z.array(coverageBranchSchema).nullish().transform((v) => v ?? []),
  })).min(1),
});

export type CoverageOutput = z.infer<typeof coverageOutputSchema>;

// --- the inputs -------------------------------------------------------------------

/** One branch of the group as the coverage pass sees it. */
export interface CoverageBranchInput {
  member: TicketBranchRow;
  depth: number;
  /** The latest finished review of the branch; null when it has none. */
  review: ReviewRow | null;
  /** The latest run, finished or not, for "not reviewed yet" / "failed". */
  latest: ReviewRow | null;
  files: ReviewFileRow[];
  requirements: RequirementRow[];
}

export interface CoverageInputs {
  key: string;
  ticket: { key: string; title: string | null; url: string | null; text: string };
  branches: CoverageBranchInput[];
}

/** The group's branches in stack order, each with its latest finished review. */
export function collectCoverageInputs(key: string): CoverageInputs {
  syncMembersFromReviews(key);
  const group = getTicketGroup(key);
  const heads = groupHeads(key);
  const branches: CoverageBranchInput[] = [];
  for (const chain of orderChains(listTicketBranches(key))) {
    for (const node of chain.nodes) {
      const head = heads.get(`${node.item.repo}#${node.item.branch}`);
      const review = head?.latestDone ?? null;
      branches.push({
        member: node.item,
        depth: node.depth,
        review,
        latest: head?.latest ?? null,
        files: review ? getReviewFiles(review.id) : [],
        requirements: review ? getRequirements(review.id) : [],
      });
    }
  }
  const withTicket = db
    .prepare<[string], Pick<ReviewRow, 'ticket_key' | 'ticket_title' | 'ticket_url' | 'ticket_body'>>(
      `SELECT ticket_key, ticket_title, ticket_url, ticket_body FROM reviews
        WHERE group_key = ? AND TRIM(COALESCE(ticket_body, '')) <> '' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(key);
  const title = group?.title ?? withTicket?.ticket_title ?? null;
  const url = group?.ticket_url ?? withTicket?.ticket_url ?? null;
  const parts: string[] = [`**${key}${title ? ` - ${title}` : ''}**`];
  if (url) parts.push(`URL: ${url}`);
  parts.push('', withTicket?.ticket_body?.trim() || '(no ticket text is stored; derive the requirements from the branches below)');
  if (group?.requirements_text?.trim()) {
    parts.push('', '## Added requirements and decisions', '', group.requirements_text.trim());
  }
  return { key, ticket: { key, title, url, text: parts.join('\n') }, branches };
}

const MAX_FILES_PER_BRANCH = 200;
const STATUS_WORD: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

export function renderCoverageBranches(branches: readonly CoverageBranchInput[]): string {
  if (branches.length === 0) return 'No branches are known for this ticket.';
  return branches.map((b, index) => {
    const head = `## ${index + 1}. \`${b.member.repo}#${b.member.branch}\``;
    const base = b.member.parent_branch
      ? `- Diffed against: \`${b.member.parent_branch}\`${b.member.parent_branch === b.member.default_branch ? ' (default branch)' : ''}`
      : '- Diffed against: unknown';
    if (!b.review) {
      const state = b.latest ? `its latest review is ${b.latest.status}` : 'it was never reviewed';
      return [head, base, `- NOT REVIEWED: ${state}. Treat it as implementing nothing.`].join('\n');
    }
    const r = b.review;
    const lines = [
      head,
      base,
      `- Review #${r.id}, run ${r.run_index}, head ${r.head_sha?.slice(0, 7) ?? 'unknown'}, code verdict ${r.code_verdict ?? r.verdict ?? 'unknown'}`,
      `- Diff: ${r.files_changed ?? b.files.length} files, +${r.additions ?? 0} / -${r.deletions ?? 0}`,
      `- Review summary: ${(r.summary ?? '').replace(/\s+/g, ' ').trim() || '(none)'}`,
      '- Requirement checklist of this branch\'s own review:',
      ...(b.requirements.length
        ? b.requirements.map((q) => `  - [${q.status}] ${q.text.replace(/\s+/g, ' ')}${q.evidence ? ` (evidence: ${q.evidence.replace(/\s+/g, ' ')})` : ''}`)
        : ['  - (none recorded)']),
      `- Changed files (${b.files.length}):`,
      ...b.files.slice(0, MAX_FILES_PER_BRANCH).map((f) => {
        const word = STATUS_WORD[f.status];
        const from = f.old_path && f.old_path !== f.path ? ` from \`${f.old_path}\`` : '';
        return `  - \`${f.path}\`${word ? ` (${word}${from})` : ''}`;
      }),
    ];
    if (b.files.length > MAX_FILES_PER_BRANCH) lines.push(`  - ... and ${b.files.length - MAX_FILES_PER_BRANCH} more`);
    return lines.join('\n');
  }).join('\n\n');
}

export async function buildCoveragePrompt(inputs: CoverageInputs): Promise<string> {
  return renderTemplate(await loadPromptFile('coverage.md'), {
    TICKET: inputs.ticket.text,
    BRANCHES: renderCoverageBranches(inputs.branches),
  });
}

// --- evidence anchors -------------------------------------------------------------

export type EvidenceChecker = (file: string, line: number | null) => CoverageEvidence;

function cleanPath(raw: string): string {
  let file = raw.trim().replace(/\\/g, '/');
  while (file.startsWith('./')) file = file.slice(2);
  return file.replace(/^[ab]\//, '');
}

/**
 * Checks a branch's evidence like a finding anchor: inside that branch's
 * checkout at HEAD and in its changed set. Without the checkout only the
 * changed set can be checked: a changed path is `unverified` (the line is not
 * checked), any other path `off_diff`.
 */
export function evidenceChecker(dir: string | null, files: readonly ReviewFileRow[]): EvidenceChecker {
  if (dir && fs.existsSync(path.join(dir, '.git'))) {
    const ctx = createAnchorContext(dir, files);
    return (file, line) => {
      const { finding } = checkAnchor(ctx, {
        file, line, end_line: null, kind: 'diff', cause_file: null, cause_line: null,
      });
      return { file: finding.file ?? file, line: finding.line, anchor_status: finding.anchor_status };
    };
  }
  const changed = new Set(files.map((f) => f.path));
  const renamed = new Map(files.filter((f) => f.old_path).map((f) => [f.old_path!, f.path]));
  return (raw, line) => {
    let file = cleanPath(raw);
    const suffix = /^(.*?):(\d+)$/.exec(file);
    if (suffix && line === null) {
      file = suffix[1]!;
      line = Number(suffix[2]);
    }
    file = renamed.get(file) ?? file;
    const status: AnchorStatus = changed.has(file) ? 'unverified' : 'off_diff';
    return { file, line, anchor_status: status };
  };
}

/**
 * The answer, held to the group: a branch must be a reviewed member (anything
 * else is dropped), a requirement no branch is left to cover is `missing`, and
 * a `missing` one lists no branch.
 */
export function normalizeCoverage(
  output: CoverageOutput,
  branches: readonly CoverageBranchInput[],
  checkerFor: (b: CoverageBranchInput) => EvidenceChecker,
  onLog: OnLog = () => {},
): CoverageRequirement[] {
  const checkers = new Map<CoverageBranchInput, EvidenceChecker>();
  const find = (repo: string | null, branch: string): CoverageBranchInput | undefined => {
    let name = branch.trim();
    let r = repo;
    const hash = name.indexOf('#');
    if (!r && hash > 0) {
      r = name.slice(0, hash);
      name = name.slice(hash + 1);
    } else if (r && name.startsWith(`${r}#`)) {
      name = name.slice(r.length + 1);
    }
    const matches = branches.filter((b) => b.member.branch === name && (!r || b.member.repo === r));
    return matches.length === 1 ? matches[0] : undefined;
  };
  return output.requirements.map((req) => {
    const out: CoverageBranch[] = [];
    if (req.status !== 'missing') {
      for (const b of req.branches) {
        const member = find(b.repo, b.branch);
        if (!member || !member.review) {
          onLog('warn', `coverage: dropped ${b.repo ?? '?'}#${b.branch} for "${req.text.slice(0, 60)}": ` +
            (member ? 'that branch has no finished review' : 'not a branch of this ticket'));
          continue;
        }
        if (out.some((o) => o.repo === member.member.repo && o.branch === member.member.branch)) continue;
        let check = checkers.get(member);
        if (!check) {
          check = checkerFor(member);
          checkers.set(member, check);
        }
        out.push({
          repo: member.member.repo,
          branch: member.member.branch,
          review_id: member.review.id,
          status: b.status,
          note: b.note,
          evidence: b.evidence.slice(0, 10).map((e) => check!(e.file, e.line)),
        });
      }
    }
    const status: CoverageStatus = out.length === 0 ? 'missing' : req.status;
    const note = status === 'missing' && req.status !== 'missing' && !req.note
      ? 'No reviewed branch of this ticket implements it.'
      : req.note;
    return { text: req.text, status, note, branches: status === 'missing' ? [] : out };
  });
}

// --- the pass -----------------------------------------------------------------------

export interface CoverageRunOptions {
  trigger?: string;
  reviewer?: string;
  model?: string;
  /** For tests: the reviewer to run instead of looking one up. */
  reviewerDefinition?: ReviewerDefinition;
  timeoutMs?: number;
}

const ACTIVE_SQL = `status IN ('queued', 'fetching', 'reviewing')`;

export function groupHasActiveReviews(key: string): boolean {
  const row = db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM reviews WHERE group_key = ? AND ${ACTIVE_SQL}`)
    .get(key);
  return (row?.n ?? 0) > 0;
}

/**
 * Runs one coverage pass for a group and stores it. The coverage row is
 * written before the first await, so a caller sees it `running` at once.
 * Never throws for a failed pass: the row says `failed`.
 */
export async function runCoverage(key: string, opts: CoverageRunOptions = {}): Promise<TicketCoverageRow> {
  const inputs = collectCoverageInputs(key);
  const reviewed = inputs.branches.filter((b) => b.review);
  const lastReview = [...reviewed].sort((a, b) => b.review!.id - a.review!.id)[0]?.review ?? null;
  const reviewerName = opts.reviewer ?? lastReview?.reviewer ?? undefined;
  let reviewer: ReviewerDefinition;
  try {
    reviewer = opts.reviewerDefinition ?? getReviewer(reviewerName);
  } catch {
    reviewer = getReviewer(undefined);
  }
  const model = opts.model
    ?? (lastReview?.reviewer === reviewer.name && lastReview.model ? lastReview.model : reviewer.defaultModel);
  const row = createCoverage(key, {
    reviewIds: reviewed.map((b) => b.review!.id),
    reviewer: reviewer.name,
    model,
    trigger: opts.trigger ?? 'manual',
  });
  const log: OnLog = (level, message) => logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
    `coverage #${row.id} ${key}: ${message}`,
  );

  const settle = (): void => {
    const settled = new Set(
      db.prepare<[string], { id: number }>(`SELECT id FROM reviews WHERE group_key = ? AND NOT ${ACTIVE_SQL}`).all(key)
        .map((r) => r.id),
    );
    closeTicketRuns(key, settled, row.id);
  };

  if (reviewed.length === 0) {
    finishCoverage(row.id, { status: 'failed', error: 'No branch of this ticket has a finished review yet.' });
    settle();
    return getCoverage(row.id)!;
  }

  const workDir = path.join(config.DATA_DIR, 'coverage', sanitizeSegment(key), String(row.id));
  try {
    fs.mkdirSync(workDir, { recursive: true });
    log('info', `started with ${reviewed.length} of ${inputs.branches.length} branch(es) reviewed, ${reviewer.label} (${model})`);
    const prompt = await buildCoveragePrompt(inputs);
    const { data } = await runPass('coverage', prompt, coverageOutputSchema, log, {
      dir: workDir,
      reviewer,
      model,
      timeoutMs: opts.timeoutMs ?? config.REVIEW_TIMEOUT_MS,
      signal: undefined,
    });
    const requirements = normalizeCoverage(
      data,
      inputs.branches,
      (b) => evidenceChecker(b.review ? checkoutDir(b.member, b.review.id) : null, b.files),
      log,
    );
    const verdict = coverageVerdict(requirements);
    const open = openRequirements(requirements);
    const summary = data.summary.trim() || (open.length === 0
      ? 'Every requirement is covered by some branch.'
      : `${open.length} requirement(s) are not fully covered.`);
    const report: CoverageForReport = { id: row.id, verdict, summary, requirements, createdAt: row.created_at };
    const reportPath = await writeCoverageReport(
      { key, title: inputs.ticket.title, url: inputs.ticket.url },
      report,
      inputs.branches.map(reportBranch),
      { reviewer: reviewer.name, model },
    );
    finishCoverage(row.id, { status: 'done', verdict, summary, requirements, reportPath });
    log('info', `done: ${verdict}, ${requirements.length} requirement(s), ${open.length} open; report ${reportPath}`);
    for (const b of reviewed) {
      if (!b.review?.report_path) continue;
      await updateReportCoverage(b.review.report_path, renderBranchCoverageSection(key, report, b.member.repo, b.member.branch));
    }
    pruneGroupCheckouts(key, new Set(reviewed.map((b) => b.review!.id)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishCoverage(row.id, { status: 'failed', error: message });
    log('error', `failed: ${message.split('\n')[0]}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    settle();
  }
  return getCoverage(row.id)!;
}

function reportBranch(b: CoverageBranchInput): CoverageReportBranch {
  return {
    repo: b.member.repo,
    branch: b.member.branch,
    base: b.review?.base_branch ?? b.member.parent_branch,
    reviewId: b.review?.id ?? null,
    runIndex: b.review?.run_index ?? null,
    codeVerdict: b.review ? b.review.code_verdict ?? b.review.verdict : null,
    headSha: b.review?.head_sha ?? null,
    depth: b.depth,
    status: b.latest ? `not reviewed (latest run ${b.latest.status})` : 'not reviewed',
  };
}

/**
 * Checkouts of finished group reviews are kept for the coverage pass. Once it
 * has read them they go, and so do those of superseded runs; a checkout a
 * live preview borrows stays, and so does a failed run's (kept for inspection).
 */
export function pruneGroupCheckouts(key: string, used: ReadonlySet<number>): number {
  const borrowed = new Set(livePreviews().map((p) => p.review_id).filter((id): id is number => id !== null));
  const heads = new Set([...groupHeads(key).values()].map((h) => h.latestDone?.id).filter((id): id is number => id !== undefined));
  const rows = db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE group_key = ? AND status = 'done'`).all(key);
  let pruned = 0;
  for (const r of rows) {
    if (borrowed.has(r.id)) continue;
    if (!used.has(r.id) && heads.has(r.id)) continue;
    const dir = checkoutDir(r, r.id);
    if (!fs.existsSync(dir)) continue;
    try {
      pruneCheckout(dir);
      pruned += 1;
    } catch (err) {
      logger.warn(`coverage ${key}: could not remove ${dir}: ${(err as Error).message}`);
    }
  }
  return pruned;
}

// --- debounced scheduling -------------------------------------------------------------

export interface SchedulerDeps {
  run(key: string, trigger: string): Promise<unknown>;
  /** True while a review of the group is queued or running: the last one to settle schedules again. */
  isActive(key: string): boolean;
  delayMs: number;
}

/**
 * Coalesces the "a branch review settled" signals of a group into one
 * coverage pass: each signal restarts the group's timer; when it fires and no
 * review of the group is still active, one pass runs. A signal during a pass
 * runs one more pass after it.
 */
export function createCoverageScheduler(deps: SchedulerDeps) {
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<unknown>>();
  const again = new Map<string, string>();

  const start = (key: string, trigger: string): Promise<unknown> => {
    const promise = deps.run(key, trigger)
      .catch((err: unknown) => logger.error(`coverage ${key}: ${(err as Error).message}`))
      .finally(() => {
        running.delete(key);
        const next = again.get(key);
        if (next !== undefined) {
          again.delete(key);
          schedule(key, next);
        }
      });
    running.set(key, promise);
    return promise;
  };

  const fire = (key: string, trigger: string): void => {
    timers.delete(key);
    if (deps.isActive(key)) return;
    if (running.has(key)) {
      again.set(key, trigger);
      return;
    }
    void start(key, trigger);
  };

  function schedule(key: string, trigger = 'review settled'): void {
    const old = timers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => fire(key, trigger), deps.delayMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  /** Runs now, skipping the timer; joins a running pass (and queues one more) instead of starting a second. */
  function runNow(key: string, trigger = 'manual'): { started: boolean; done: Promise<unknown> } {
    const old = timers.get(key);
    if (old) {
      clearTimeout(old);
      timers.delete(key);
    }
    const current = running.get(key);
    if (current) {
      again.set(key, trigger);
      return { started: false, done: current };
    }
    return { started: true, done: start(key, trigger) };
  }

  function pending(key: string): boolean {
    return timers.has(key) || running.has(key);
  }

  function cancelAll(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { schedule, runNow, pending, cancelAll };
}

export type CoverageScheduler = ReturnType<typeof createCoverageScheduler>;

let scheduler: CoverageScheduler | null = null;

/**
 * Turns on automatic coverage (the server does; the CLI does not, since it
 * exits when its reviews end). Off, finished group reviews prune their
 * checkouts at once and nothing is scheduled.
 */
export function enableCoverageScheduling(delayMs = config.COVERAGE_DEBOUNCE_MS): CoverageScheduler {
  scheduler = createCoverageScheduler({
    run: (key, trigger) => runCoverage(key, { trigger }),
    isActive: groupHasActiveReviews,
    delayMs,
  });
  return scheduler;
}

export function coverageSchedulingEnabled(): boolean {
  return scheduler !== null;
}

/** A review of a ticket group reached done, failed, or cancelled. */
export function onGroupReviewSettled(key: string): void {
  scheduler?.schedule(key, 'review settled');
}

/** Whether a pass is waiting on its timer or running for the group. */
export function coveragePending(key: string): boolean {
  return scheduler?.pending(key) ?? false;
}

/** Starts a pass now (manual recompute). Without the scheduler it simply runs. */
export function recomputeCoverage(key: string, opts: CoverageRunOptions = {}): { started: boolean; done: Promise<unknown> } {
  if (scheduler && !opts.reviewer && !opts.model) return scheduler.runNow(key, opts.trigger ?? 'manual');
  return { started: true, done: runCoverage(key, { trigger: 'manual', ...opts }) };
}

/** One branch's reading of the group's latest coverage, for its review page and report. */
export function coverageForReview(review: Pick<ReviewRow, 'id' | 'repo' | 'branch'>, coverage: TicketCoverageRow, requirements: CoverageRequirement[]) {
  const used = parseIds(coverage.review_ids);
  return {
    id: coverage.id,
    status: coverage.status,
    verdict: coverage.verdict,
    summary: coverage.summary,
    created_at: coverage.created_at,
    finished_at: coverage.finished_at,
    /** False when this run is not the one the coverage read (an older or a newer run of the branch). */
    includes_this_review: used.includes(review.id),
    requirements: branchCoverage(requirements, review.repo, review.branch),
  };
}

