import {
  addLog,
  db,
  getFindings,
  getPreviousRun,
  getReview,
  replaceFindings,
  replaceReviewFiles,
  replaceObservations,
  replaceRequirements,
  updateReview,
} from './db.js';
import { config } from './config.js';
import { publish } from './events.js';
import { sanitizeLogMessage } from './logSanitize.js';
import { assertPristine, ensureImage, fetchCheckout, pruneCheckout } from './gitSandbox.js';
import {
  commandMatchesBin, inspectProcess, isOrphanReviewer, isPidAlive, killProcessGroups, parseRecordedGroups,
  SELF, shouldRecover, type ProcessInfo, type RecordedGroup, type RecoveryCaller, type RunnerIdentity,
} from './processOwnership.js';
import { checkoutChangedFiles, runReview, stopAllReviewers, type PreviousFinding } from './reviewRunner.js';
import { writeReport } from './reportWriter.js';
import type {
  LogLevel,
  ResolvedTarget,
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
/** Running reviews already failed by `stopAllReviews`; their pipeline must not write again. */
const interrupted = new Set<number>();
const running = new Map<number, Job>();
let workers = 0;
/** Set by `stopAllReviews`: nothing new starts in this process. */
let stopping = false;

/**
 * How many reviews run at once. Each review fans out to five lens processes
 * plus one synthesis process, so the real process ceiling is this times six.
 */
const CONCURRENCY = config.REVIEW_CONCURRENCY;

/**
 * Queue a review row for processing, in-process. The row is claimed for this
 * process (`runner_pid`): from here on only this process may finish it, and
 * another process's recovery leaves it alone while this one lives.
 */
export function enqueueReview(reviewId: number): void {
  if (stopping) {
    finishRow(reviewId, { status: 'failed', error: 'shutting down', finished_at: nowIso() });
    log(reviewId, 'error', 'Not started: this process is shutting down.');
    status(reviewId, 'failed');
    return;
  }
  finishRow(reviewId, { runner_pid: SELF.pid, runner_started_at: SELF.startedAt, reviewer_pgids: null });
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

export interface RecoveryDeps {
  self: RunnerIdentity;
  isAlive(pid: number): boolean;
  /** `ps` for one pid; null when there is no such process. */
  inspect(pid: number): ProcessInfo | null;
  /** Whether a live process's command line is still the recorded reviewer binary. */
  matches(command: string, bin: string): boolean;
  /** SIGTERM-to-SIGKILL grace for orphaned reviewer processes. */
  graceMs: number;
}

const DEFAULT_RECOVERY_DEPS: RecoveryDeps = {
  self: SELF,
  isAlive: isPidAlive,
  inspect: inspectProcess,
  matches: commandMatchesBin,
  graceMs: 2_000,
};

export interface RecoveryResult {
  /** Review ids marked failed. */
  failed: number[];
  /** Orphaned reviewer process groups that were signalled. */
  killedGroups: number[];
}

/**
 * Fails in-flight rows whose owner can never finish them, and stops the
 * reviewer processes such an owner left running.
 *
 * Every queued, fetching, or reviewing row belongs to the process that
 * enqueued it (`runner_pid`, `runner_started_at`); its queue is in that
 * process's memory. `shouldRecover` (processOwnership.ts) decides per row:
 * rows of this process and rows of a live process are never touched; rows of
 * a dead process are failed by whoever runs this; rows with no recorded owner
 * (written before ownership existed) are failed only by the server, at its
 * startup, never by the CLI, which cannot tell them from a live server's.
 *
 * The server runs this once at startup and the CLI once before it enqueues
 * anything, so a CLI run no longer fails the server's reviews and a server
 * restart no longer fails a running CLI's.
 *
 * For every failed row, the reviewer processes it recorded are stopped
 * (SIGTERM, then SIGKILL after a grace period) when they are still alive,
 * still lead their process group, still run the recorded binary, and started
 * when the row says they did. Anything else is left alone: a pid may have
 * been reused by an unrelated process.
 */
export async function recoverInterrupted(
  caller: RecoveryCaller,
  overrides: Partial<RecoveryDeps> = {},
): Promise<RecoveryResult> {
  const deps: RecoveryDeps = { ...DEFAULT_RECOVERY_DEPS, ...overrides };
  const active = db
    .prepare<[], ReviewRow>(
      `SELECT * FROM reviews WHERE status IN ('queued', 'fetching', 'reviewing') ORDER BY id`,
    )
    .all();

  const failed: number[] = [];
  const orphans = new Map<number, RecordedGroup[]>();
  for (const review of active) {
    if (!shouldRecover(review, { caller, self: deps.self, isAlive: deps.isAlive })) continue;
    updateReview(review.id, {
      status: 'failed',
      error: 'interrupted by restart',
      finished_at: nowIso(),
    });
    log(
      review.id,
      'error',
      review.runner_pid
        ? `Interrupted: the process that ran it (pid ${review.runner_pid}) is gone.`
        : 'Interrupted by restart.',
    );
    status(review.id, 'failed');
    failed.push(review.id);

    const left = parseRecordedGroups(review.reviewer_pgids)
      .filter((group) => isOrphanReviewer(group, deps.inspect(group.pgid), deps.matches));
    if (left.length > 0) orphans.set(review.id, left);
    finishRow(review.id, { reviewer_pgids: null });
  }

  const pgids = [...orphans.values()].flat().map((g) => g.pgid);
  const killedGroups = pgids.length > 0 ? await killProcessGroups(pgids, { graceMs: deps.graceMs }) : [];
  for (const [reviewId, groups] of orphans) {
    const names = groups.map((g) => `${g.bin} (pid ${g.pgid})`).join(', ');
    log(reviewId, 'warn', `Stopped ${groups.length} reviewer process(es) still running from it: ${names}.`);
  }
  return { failed, killedGroups };
}

/**
 * Shutdown: fail every queued and running review of this process with
 * `reason`, stop every reviewer process it started (SIGTERM, then SIGKILL
 * after `graceMs`), and refuse new work. The rows are written before any
 * process is signalled, so they are correct even if the process is killed
 * during the grace period.
 */
export async function stopAllReviews(reason: string, graceMs = 3_000): Promise<void> {
  stopping = true;
  const at = nowIso();
  for (const reviewId of pending.splice(0)) {
    finishRow(reviewId, { status: 'failed', error: reason, finished_at: at });
    log(reviewId, 'error', `Interrupted before it started: ${reason}.`);
    status(reviewId, 'failed');
  }
  for (const reviewId of running.keys()) {
    interrupted.add(reviewId);
    finishRow(reviewId, { status: 'failed', error: reason, finished_at: at });
    log(reviewId, 'error', `Interrupted: ${reason}.`);
    status(reviewId, 'failed');
  }
  // SIGTERM goes out synchronously here, before the aborts below: once the
  // runner is stopping, an abort no longer SIGKILLs on its own.
  const stopped = stopAllReviewers(graceMs);
  for (const job of running.values()) job.controller.abort();
  await stopped;
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
        interrupted.delete(reviewId);
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
  const local = review.source === 'local';
  log(
    reviewId,
    'info',
    local
      ? `Fetching ${review.repo}#${review.branch} from the local clone (unpushed)` +
          `${review.working_tree ? ', with uncommitted changes' : ''} in the git sandbox.`
      : `Fetching ${review.repo}#${review.branch} in the git sandbox.`,
  );
  status(reviewId, 'fetching');

  const target: ResolvedTarget = {
    repo: review.repo,
    branch: review.branch,
    baseBranch: review.base_branch,
    prNumber: review.pr_number ?? null,
    source: local ? 'local' : 'github',
    includeWorkingTree: local && review.working_tree === 1,
    ...(local && review.base_reason ? { baseReason: review.base_reason } : {}),
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
  replaceReviewFiles(reviewId, checkoutChangedFiles(checkout));
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

  const output = await runReview(
    review,
    checkout,
    ticket,
    (level: LogLevel, message: string) => log(reviewId, level, message),
    {
      previousFindings,
      signal,
      model: review.model ?? undefined,
      reviewer: review.reviewer ?? undefined,
      // Persisted so a later recovery can stop them if this process dies.
      onProcessGroups: (groups) => finishRow(reviewId, { reviewer_pgids: JSON.stringify(groups) }),
    },
  );
  throwIfCancelled(signal);

  // The reviewer is read-only; a dirty tree means that guarantee was broken.
  await assertPristine(checkout.dir);
  log(reviewId, 'info', 'Checkout is unchanged — the review did not touch any file.');

  replaceRequirements(reviewId, output.requirements);
  replaceFindings(reviewId, output.findings);
  replaceObservations(reviewId, output.observations);

  const reportPath = await writeReport(review, ticket, checkout, output, {
    lenses: output.lensResults,
    synthesis: output.synthesisRaw,
    reanchor: output.reanchorRaw,
  });
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
  // stopAllReviews already wrote the row; the error here is just the unwinding.
  if (interrupted.has(reviewId)) return;
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
