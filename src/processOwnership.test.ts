import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  commandMatchesBin, isOrphanReviewer, isPidAlive, killProcessGroups, parsePsLine, parseRecordedGroups,
  SELF, shouldRecover, type ProcessInfo, type RecordedGroup, type RecoveryCaller, type RunnerIdentity,
} from './processOwnership.js';

const self: RunnerIdentity = { pid: 4242, startedAt: '2026-01-01T10:00:00.000Z' };
const LIVE = 5555;
const DEAD = 6666;
const isAlive = (pid: number): boolean => pid === LIVE || pid === self.pid;
const ctx = (caller: RecoveryCaller) => ({ caller, self, isAlive });
const row = (runner_pid: number | null, runner_started_at: string | null = '2026-01-01T09:00:00.000Z') =>
  ({ runner_pid, runner_started_at });

// --- which rows a recovery may fail ---------------------------------------

test('a row whose owner is dead is failed by the server and by the CLI', () => {
  assert.equal(shouldRecover(row(DEAD), ctx('server')), true);
  assert.equal(shouldRecover(row(DEAD), ctx('cli')), true);
});

test('a row of a live other process is never failed, whoever recovers', () => {
  assert.equal(shouldRecover(row(LIVE), ctx('server')), false);
  assert.equal(shouldRecover(row(LIVE), ctx('cli')), false);
});

test('a row of this very process is never failed', () => {
  const own = row(self.pid, self.startedAt);
  assert.equal(shouldRecover(own, ctx('server')), false);
  assert.equal(shouldRecover(own, ctx('cli')), false);
});

test('a row of an earlier process that had this pid is failed', () => {
  const earlier = row(self.pid, '2025-12-31T08:00:00.000Z');
  assert.equal(shouldRecover(earlier, ctx('server')), true);
  assert.equal(shouldRecover(earlier, ctx('cli')), true);
});

test('a row with no recorded owner is failed by the server only', () => {
  assert.equal(shouldRecover(row(null, null), ctx('server')), true);
  assert.equal(shouldRecover(row(null, null), ctx('cli')), false);
});

test('an invalid pid counts as no owner and is never probed', () => {
  const probed: number[] = [];
  const probe = { self, isAlive: (pid: number) => { probed.push(pid); return false; } };
  for (const pid of [0, -1, 1.5]) {
    assert.equal(shouldRecover(row(pid), { ...probe, caller: 'cli' }), false);
    assert.equal(shouldRecover(row(pid), { ...probe, caller: 'server' }), true);
  }
  assert.deepEqual(probed, []);
});

// --- liveness -------------------------------------------------------------

test('isPidAlive: this process is alive, an exited child is not, EPERM counts as alive', async () => {
  assert.equal(isPidAlive(process.pid), true);
  // pid 1 (launchd/init) exists but is not ours to signal: EPERM, still alive.
  assert.equal(isPidAlive(1), true);
  const child = spawn('true');
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(isPidAlive(pid), false);
  assert.equal(isPidAlive(0), false);
});

test('SELF names this process with a start time in the past', () => {
  assert.equal(SELF.pid, process.pid);
  assert.ok(Date.parse(SELF.startedAt) <= Date.now());
});

// --- recorded reviewer processes ------------------------------------------

test('parseRecordedGroups keeps well-formed entries and drops the rest', () => {
  const json = JSON.stringify([
    { pgid: 1234, bin: 'claude', spawnedAt: '2026-01-01T00:00:00.000Z' },
    { pgid: 1, bin: 'claude', spawnedAt: 'x' },
    { pgid: process.pid, bin: 'claude' },
    { pgid: 77, bin: '' },
    'junk',
    { pgid: 5678, bin: 'codex' },
  ]);
  assert.deepEqual(parseRecordedGroups(json), [
    { pgid: 1234, bin: 'claude', spawnedAt: '2026-01-01T00:00:00.000Z' },
    { pgid: 5678, bin: 'codex', spawnedAt: '' },
  ]);
  assert.deepEqual(parseRecordedGroups(null), []);
  assert.deepEqual(parseRecordedGroups('{not json'), []);
  assert.deepEqual(parseRecordedGroups('{"pgid":1}'), []);
});

test('parsePsLine reads pgid, start time, and the full command', () => {
  const info = parsePsLine(321, '  321 Thu Oct  8 14:03:12 2026     claude -p review this --model opus\n');
  assert.ok(info);
  assert.equal(info.pgid, 321);
  assert.equal(info.command, 'claude -p review this --model opus');
  assert.equal(info.startedAtMs, new Date(2026, 9, 8, 14, 3, 12).getTime());
  // An unknown date format keeps the command and drops the start time.
  const loose = parsePsLine(9, '9 2026-10-08T14:03:12 codex exec');
  assert.deepEqual(loose, { pid: 9, pgid: 9, startedAtMs: null, command: '2026-10-08T14:03:12 codex exec' });
  assert.equal(parsePsLine(9, ''), null);
});

test('commandMatchesBin compares the basename of the recorded binary', () => {
  assert.equal(commandMatchesBin('node /usr/local/bin/codex exec --json', 'codex'), true);
  assert.equal(commandMatchesBin('/opt/tools/claude -p x', '/opt/tools/claude'), true);
  assert.equal(commandMatchesBin('sleep 30', 'claude'), false);
  assert.equal(commandMatchesBin('anything', ''), false);
});

test('isOrphanReviewer: only a live group leader still running the recorded binary, started then', () => {
  const spawnedAt = '2026-10-08T21:03:12.400Z';
  const group: RecordedGroup = { pgid: 500, bin: 'claude', spawnedAt };
  const info = (over: Partial<ProcessInfo> = {}): ProcessInfo => ({
    pid: 500, pgid: 500, startedAtMs: Date.parse('2026-10-08T21:03:12.000Z'), command: 'claude -p x', ...over,
  });
  assert.equal(isOrphanReviewer(group, info()), true);
  assert.equal(isOrphanReviewer(group, null), false, 'gone');
  assert.equal(isOrphanReviewer(group, info({ pgid: 499 })), false, 'no longer leads that group');
  assert.equal(isOrphanReviewer(group, info({ command: 'sleep 30' })), false, 'another program');
  assert.equal(
    isOrphanReviewer(group, info({ startedAtMs: Date.parse('2026-10-09T08:00:00.000Z') })),
    false,
    'same pid and program, started much later: a reused pid',
  );
  assert.equal(isOrphanReviewer(group, info({ startedAtMs: null })), true, 'no start time: command decides');
  assert.equal(isOrphanReviewer(group, info({ command: 'sleep 30' }), () => true), true, 'injected matcher');
});

// --- killing groups --------------------------------------------------------

test('killProcessGroups sends SIGTERM, then SIGKILL only to groups that outlive the grace', async () => {
  const sent: string[] = [];
  const alive = new Set([1001, 1002]);
  const signalled = await killProcessGroups([1001, 1002, 1002, 1, 0, process.pid], {
    graceMs: 50,
    pollMs: 10,
    isAlive: (pgid) => alive.has(pgid),
    signal: (pgid, sig) => {
      sent.push(`${sig}:${pgid}`);
      if (sig === 'SIGTERM' && pgid === 1001) alive.delete(pgid); // exits on SIGTERM
    },
  });
  assert.deepEqual(signalled, [1001, 1002]);
  assert.deepEqual(sent, ['SIGTERM:1001', 'SIGTERM:1002', 'SIGKILL:1002']);
});
