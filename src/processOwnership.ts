import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Which process owns an in-flight review row, and which reviewer processes a
 * dead owner left behind.
 *
 * The server and the CLI share one SQLite database. Each keeps its queue in
 * memory, so a queued, fetching, or reviewing row can only ever be finished by
 * the process that enqueued it. Every row records that process as
 * `runner_pid` + `runner_started_at` (see `SELF`). The decisions below are
 * pure; the process probes are injectable so tests never depend on real pids.
 */

/** The process that enqueues and runs a review. */
export interface RunnerIdentity {
  pid: number;
  /**
   * When the process started, as an ISO string fixed at module load. Two
   * processes that got the same pid at different times never share it.
   */
  startedAt: string;
}

/**
 * This process. The start time is computed once, while `process.uptime()` is
 * still tiny: on macOS the monotonic clock behind it stops during sleep, so a
 * later computation would drift.
 */
export const SELF: RunnerIdentity = Object.freeze({
  pid: process.pid,
  startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
});

/** Who runs a recovery: the server at startup, or a CLI run at its start. */
export type RecoveryCaller = 'server' | 'cli';

export interface OwnedRow {
  runner_pid: number | null;
  runner_started_at: string | null;
}

export interface RecoveryContext {
  caller: RecoveryCaller;
  self: RunnerIdentity;
  /** Whether a process with this pid exists. See `isPidAlive`. */
  isAlive(pid: number): boolean;
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/** A group id that is safe to signal: `kill(-1)` would reach every process we may signal. */
function validPgid(pgid: unknown): pgid is number {
  return validPid(pgid) && pgid > 1 && pgid !== process.pid && pgid !== process.ppid;
}

/**
 * Whether a recovery run by `ctx.caller` may fail this in-flight row. The rule:
 *
 * - No owner recorded (rows written before ownership existed, or garbage):
 *   only the server, at its startup, fails them, as it always did. The CLI
 *   never does, because it cannot tell them from a live server's rows.
 * - Owned by this very process (same pid and start time): never. It is in this
 *   process's in-memory queue.
 * - Same pid as this process but another start time: an earlier process that
 *   had this pid. It is certainly gone, so the row is failed.
 * - Any other pid: failed only when no such process exists (ESRCH). A live
 *   owner, whatever it is, keeps its rows. A reused pid can therefore keep a
 *   dead owner's row active until the next start; cancelling it in the UI, or
 *   any later recovery once the pid is free, clears it.
 *
 * The server and the CLI apply the same rule to owned rows: a provably dead
 * owner never comes back, whoever notices it.
 */
export function shouldRecover(row: OwnedRow, ctx: RecoveryContext): boolean {
  if (!validPid(row.runner_pid)) return ctx.caller === 'server';
  if (row.runner_pid === ctx.self.pid) {
    return row.runner_started_at !== null && row.runner_started_at !== ctx.self.startedAt;
  }
  return !ctx.isAlive(row.runner_pid);
}

/**
 * `kill(pid, 0)`: ESRCH means no such process; EPERM means it exists but
 * belongs to someone else. Any other error is taken as alive, because the
 * safe mistake is to leave a row alone, never to fail a live review.
 */
export function isPidAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Whether any process is left in process group `pgid`. Same error rule as `isPidAlive`. */
export function isGroupAlive(pgid: number): boolean {
  if (!validPgid(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// --- reviewer process groups ----------------------------------------------

/**
 * One reviewer CLI process this tool started, recorded on its review row
 * (`reviewer_pgids`, a JSON array) while it runs. The process is the leader
 * of its own group, so `pgid` is also its pid.
 */
export interface RecordedGroup {
  pgid: number;
  /** Basename of the binary it was started from, e.g. `claude`. */
  bin: string;
  /** ISO time of the spawn. */
  spawnedAt: string;
}

/** Tolerant: a malformed column yields no group rather than an error. */
export function parseRecordedGroups(json: string | null | undefined): RecordedGroup[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: RecordedGroup[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { pgid, bin, spawnedAt } = item as Record<string, unknown>;
    if (!validPgid(pgid) || typeof bin !== 'string' || !bin.trim()) continue;
    out.push({ pgid, bin, spawnedAt: typeof spawnedAt === 'string' ? spawnedAt : '' });
  }
  return out;
}

/** What `ps` says about one process. */
export interface ProcessInfo {
  pid: number;
  pgid: number;
  /** Wall-clock start, or null when it could not be read. */
  startedAtMs: number | null;
  command: string;
}

const PS_LINE = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/s;

/** Parse `ps -o pgid= -o lstart= -o command=` output for one pid (LC_ALL=C). */
export function parsePsLine(pid: number, output: string): ProcessInfo | null {
  const line = output.split('\n').find((l) => l.trim()) ?? '';
  const match = PS_LINE.exec(line);
  if (match) {
    const started = Date.parse(match[2]!.replace(/\s+/g, ' '));
    return {
      pid,
      pgid: Number(match[1]),
      startedAtMs: Number.isNaN(started) ? null : started,
      command: match[3]!.trim(),
    };
  }
  // An unexpected date format: keep the pgid and command, drop the start time.
  const loose = /^\s*(\d+)\s+(.*)$/s.exec(line);
  if (!loose) return null;
  return { pid, pgid: Number(loose[1]), startedAtMs: null, command: loose[2]!.trim() };
}

/** Ask `ps` about one process; null when it does not exist or `ps` fails. */
export function inspectProcess(pid: number): ProcessInfo | null {
  if (!validPid(pid)) return null;
  try {
    const out = execFileSync(
      'ps',
      ['-ww', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // A fixed locale keeps `lstart` in one parseable format; `TZ` keeps it
        // in the zone `Date.parse` reads it in.
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LC_ALL: 'C',
          LANG: 'C',
          ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
        },
      },
    );
    return parsePsLine(pid, out);
  } catch {
    return null; // `ps -p` exits 1 when there is no such process.
  }
}

/** Default check that a live process is still the reviewer CLI that was recorded. */
export function commandMatchesBin(command: string, bin: string): boolean {
  const name = path.basename(bin.trim());
  return name.length > 0 && command.includes(name);
}

/** How far the recorded spawn time and the `ps` start time may differ. */
export const START_TOLERANCE_MS = 10_000;

/**
 * Whether a recorded reviewer group is still that reviewer and may be killed.
 * Every condition guards against a reused pid; failing any of them leaves the
 * process alone, because killing a stranger is the one unacceptable mistake.
 * - the leader is still alive and still leads group `pgid`;
 * - its command line still names the recorded binary (`matches`);
 * - when `ps` reports a start time, it is the recorded spawn time.
 */
export function isOrphanReviewer(
  group: RecordedGroup,
  info: ProcessInfo | null,
  matches: (command: string, bin: string) => boolean = commandMatchesBin,
  toleranceMs = START_TOLERANCE_MS,
): boolean {
  if (!info || info.pid !== group.pgid || info.pgid !== group.pgid) return false;
  if (!matches(info.command, group.bin)) return false;
  const spawned = Date.parse(group.spawnedAt);
  if (info.startedAtMs !== null && !Number.isNaN(spawned)) {
    if (Math.abs(info.startedAtMs - spawned) > toleranceMs) return false;
  }
  return true;
}

export interface KillGroupsOptions {
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
  pollMs?: number;
  isAlive?: (pgid: number) => boolean;
  signal?: (pgid: number, sig: NodeJS.Signals) => void;
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // Already gone, or not ours to signal.
  }
}

/**
 * SIGTERM every group, wait up to `graceMs` for them to exit, then SIGKILL the
 * ones still there. Never signals pid 0/1, this process, or its parent.
 * Returns the groups it signalled.
 */
export async function killProcessGroups(pgids: number[], opts: KillGroupsOptions = {}): Promise<number[]> {
  const graceMs = opts.graceMs ?? 3_000;
  const pollMs = opts.pollMs ?? 100;
  const isAlive = opts.isAlive ?? isGroupAlive;
  const send = opts.signal ?? signalGroup;
  const targets = [...new Set(pgids)].filter(validPgid);
  if (targets.length === 0) return [];

  for (const pgid of targets) send(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let left = targets.filter(isAlive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    left = left.filter(isAlive);
  }
  for (const pgid of left) send(pgid, 'SIGKILL');
  return targets;
}

/** Synchronous last resort (an `exit` handler cannot wait): SIGKILL every group. */
export function killProcessGroupsNow(pgids: Iterable<number>): void {
  for (const pgid of pgids) {
    if (validPgid(pgid)) signalGroup(pgid, 'SIGKILL');
  }
}
