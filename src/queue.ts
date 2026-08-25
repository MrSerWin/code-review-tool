import {
  addLog,
  db,
  getFindings,
  getPreviousRun,
  getReview,
  replaceFindings,
  replaceObservations,
  replaceRequirements,
  updateReview,
} from './db.js';
import { config } from './config.js';
import { publish } from './events.js';
import { sanitizeLogMessage } from './logSanitize.js';
import { assertPristine, ensureImage, fetchCheckout, pruneCheckout } from './gitSandbox.js';
import { runReview, type PreviousFinding } from './reviewRunner.js';
import { writeReport } from './reportWriter.js';
import type {
  LogLevel,
  ResolvedTarget,
  ReviewOutput,
  ReviewRow,
  ReviewStatus,
  TicketInfo,
} from './types.js';

interface Job {
  reviewId: number;
  controller: AbortController;
}

const pending: number[] = [];
const cancelling = new Set<number>();
const running = new Map<number, Job>();
let workers = 0;

/**
 * How many reviews run at once. Each review fans out to four lens processes
 * plus one synthesis process, so the real process ceiling is this times four.
 */
const CONCURRENCY = config.REVIEW_CONCURRENCY;

/** Queue a review row for processing, in-process. */
export function enqueueReview(reviewId: number): void {
  pending.push(reviewId);
  log(reviewId, 'info', 'Queued.');
  status(reviewId, 'queued');
  spawnWorkers();
}

/** Cancel a queued or running review. Returns false if it is neither. */
export function cancelReview(reviewId: number): boolean {
  const queuedAt = pending.indexOf(reviewId);
  if (queuedAt >= 0) {
    pending.splice(queuedAt, 1);
    finishRow(reviewId, { status: 'cancelled', finished_at: nowIso() });
    log(reviewId, 'warn', 'Cancelled before it started.');
    status(reviewId, 'cancelled');
    return true;
  }
  const job = running.get(reviewId);
  if (job) {
    cancelling.add(reviewId);
    job.controller.abort();
    log(reviewId, 'warn', 'Cancellation requested.');
    return true;
  }
  return false;
}

/**
 * Rows left mid-flight by a crash or restart can never finish: nothing owns
 * their child process any more, so they are failed at startup.
 */
export function recoverInterrupted(): void {
  const stale = db
    .prepare<[], ReviewRow>(
      `SELECT * FROM reviews WHERE status IN ('queued', 'fetching', 'reviewing')`,
    )
    .all();
  for (const review of stale) {
    updateReview(review.id, {
      status: 'failed',
      error: 'interrupted by restart',
      finished_at: nowIso(),
    });
    log(review.id, 'error', 'Interrupted by restart.');
    status(review.id, 'failed');
  }
}

/** Top up the worker pool to `CONCURRENCY` while there is queued work. */
function spawnWorkers(): void {
  while (workers < CONCURRENCY && pending.length > 0) {
    workers += 1;
    void worker();
  }
}

async function worker(): Promise<void> {
  try {
    while (pending.length > 0) {
      const reviewId = pending.shift()!;
      const controller = new AbortController();
      running.set(reviewId, { reviewId, controller });
      try {
        await processReview(reviewId, controller.signal);
      } catch (err) {
        handleFailure(reviewId, err);
      } finally {
        running.delete(reviewId);
        cancelling.delete(reviewId);
      }
    }
  } finally {
    workers -= 1;
  }
}

async function processReview(reviewId: number, signal: AbortSignal): Promise<void> {
  const review = getReview(reviewId);
  if (!review) throw new Error(`Review ${reviewId} no longer exists`);
  if (review.status === 'cancelled') return;

  updateReview(reviewId, { status: 'fetching', started_at: nowIso(), error: null });
  log(reviewId, 'info', `Fetching ${review.repo}#${review.branch} in the git sandbox.`);
  status(reviewId, 'fetching');

  const target: ResolvedTarget = {
    repo: review.repo,
    branch: review.branch,
    baseBranch: review.base_branch,
    prNumber: review.pr_number ?? null,
  };

  await ensureImage();
  const checkout = await fetchCheckout(target, reviewId, (level, message) =>
    log(reviewId, level, message),
  );
  throwIfCancelled(signal);

  updateReview(reviewId, {
    status: 'reviewing',
    head_sha: checkout.headSha,
    base_sha: checkout.baseSha,
    files_changed: checkout.filesChanged,
    additions: checkout.additions,
    deletions: checkout.deletions,
  });
  log(
    reviewId,
    'info',
    `Checked out ${checkout.headSha.slice(0, 7)} — ${checkout.filesChanged} files, ` +
      `+${checkout.additions} / -${checkout.deletions}. Starting the review.`,
  );
  status(reviewId, 'reviewing');

  const ticket = loadTicket(review);
  const previousFindings = loadPreviousFindings(review.repo, review.branch, review.run_index);
  if (previousFindings.length) {
    log(reviewId, 'info', `Carrying ${previousFindings.length} open finding(s) from the previous run.`);
  }

  const output: ReviewOutput = await runReview(
    review,
    checkout,
    ticket,
    (level: LogLevel, message: string) => log(reviewId, level, message),
    { previousFindings, signal, model: review.model ?? undefined },
  );
  throwIfCancelled(signal);

  // The reviewer is read-only; a dirty tree means that guarantee was broken.
  await assertPristine(checkout.dir);
  log(reviewId, 'info', 'Checkout is unchanged — the review did not touch any file.');

  replaceRequirements(reviewId, output.requirements);
  replaceFindings(reviewId, output.findings);
  replaceObservations(reviewId, output.observations);

  const reportPath = await writeReport(review, ticket, checkout, output);
  log(reviewId, 'info', `Report written to ${reportPath}`);

  updateReview(reviewId, {
    status: 'done',
    verdict: output.verdict,
    can_merge: output.can_merge ? 1 : 0,
    summary: output.summary,
    requirements_met: output.requirements.filter((r) => r.status === 'met').length,
    requirements_total: output.requirements.length,
    blocking_count: output.findings.filter(
      (f) => f.severity === 'blocker' || f.severity === 'major',
    ).length,
    report_path: reportPath,
    finished_at: nowIso(),
    error: null,
  });
  log(
    reviewId,
    'info',
    `Done — verdict ${output.verdict}, can_merge=${output.can_merge}, ` +
      `${output.findings.length} finding(s), ${output.observations.length} observation(s).`,
  );
  publish(reviewId, {
    type: 'done',
    reviewId,
    status: 'done',
    verdict: output.verdict,
    canMerge: output.can_merge,
    reportPath,
  });

  pruneCheckout(checkout.dir);
}

function handleFailure(reviewId: number, err: unknown): void {
  const cancelled = cancelling.has(reviewId);
  const message = err instanceof Error ? err.message : String(err);
  const finalStatus = cancelled ? 'cancelled' : 'failed';
  // The checkout is deliberately kept on failure so the run can be inspected.
  finishRow(reviewId, {
    status: finalStatus,
    error: cancelled ? 'cancelled' : message,
    finished_at: nowIso(),
  });
  log(reviewId, 'error', cancelled ? 'Cancelled.' : `Failed: ${message}`);
  status(reviewId, finalStatus);
}

function loadTicket(review: ReviewRow): TicketInfo | null {
  if (!review.ticket_key) return null;
  return {
    provider: 'stored',
    key: review.ticket_key,
    title: review.ticket_title ?? '',
    url: review.ticket_url ?? '',
    body: review.ticket_body ?? '',
    state: '',
    branchName: review.branch,
    comments: [],
    attachmentUrls: [],
  };
}

function loadPreviousFindings(repo: string, branch: string, runIndex: number): PreviousFinding[] {
  const previous = getPreviousRun(repo, branch, runIndex);
  if (!previous) return [];
  return getFindings(previous.id)
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .map((f) => ({
      severity: f.severity,
      title: f.title,
      file: f.file ?? null,
      line: f.line ?? null,
      problem: f.problem,
    }));
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Review cancelled');
}

function finishRow(reviewId: number, patch: Partial<ReviewRow>): void {
  try {
    updateReview(reviewId, patch);
  } catch {
    // The row may have been deleted mid-run; nothing else to do.
  }
}

function log(reviewId: number, level: LogLevel, rawMessage: string): void {
  const ts = nowIso();
  const message = sanitizeLogMessage(rawMessage);
  try {
    addLog(reviewId, level, message);
  } catch {
    // Logging must never break the pipeline.
  }
  publish(reviewId, { type: 'log', reviewId, ts, level, message });
}

function status(reviewId: number, value: ReviewStatus): void {
  publish(reviewId, { type: 'status', reviewId, status: value });
}

function nowIso(): string {
  return new Date().toISOString();
}
