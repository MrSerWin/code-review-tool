import './testEnv.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// db.ts opens `<DATA_DIR>/review.db` on import, so point it at a throwaway
// directory first. Each test file runs in its own process.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-recovery-'));
process.env.DATA_DIR = dataDir;
const store = await import('./db.js');
const { recoverInterrupted } = await import('./queue.js');
const { SELF, isPidAlive } = await import('./processOwnership.js');

const children: ChildProcess[] = [];

/** A long-running process in its own process group, like a reviewer CLI. */
function spawnSleeper(): ChildProcess & { pid: number } {
  const child = spawn('sleep', ['37'], { detached: true, stdio: 'ignore' });
  children.push(child);
  assert.ok(child.pid, 'sleep must start');
  return child as ChildProcess & { pid: number };
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn('true');
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(isPidAlive(pid), false);
  return pid;
}

function exited(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

test.after(() => {
  for (const child of children) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface Seeded { dead: number; own: number; earlierSelf: number; live: number; legacy: number }

async function seed(liveOwner: number): Promise<Seeded> {
  store.db.prepare('DELETE FROM reviews').run();
  const make = (runner_pid: number | null, runner_started_at: string | null, status = 'reviewing') =>
    store.createReview({
      repo: 'my-service', branch: `feat/x-${Math.random()}`, base_branch: 'main',
      status: status as 'reviewing', runner_pid, runner_started_at,
    }).id;
  return {
    dead: make(await deadPid(), '2026-01-01T00:00:00.000Z'),
    own: make(SELF.pid, SELF.startedAt),
    earlierSelf: make(SELF.pid, '2020-01-01T00:00:00.000Z', 'fetching'),
    live: make(liveOwner, '2026-01-01T00:00:00.000Z', 'queued'),
    legacy: make(null, null),
  };
}

const statusOf = (id: number): string | undefined => store.getReview(id)?.status;

test('createReview records this process as the owner', () => {
  const review = store.createReview({ repo: 'my-service', branch: 'feat/owner', base_branch: 'main' });
  assert.equal(review.runner_pid, process.pid);
  assert.equal(review.runner_started_at, SELF.startedAt);
  assert.equal(review.reviewer_pgids, null);
});

test('the CLI fails only rows of dead owners: never its own, a live process\'s, or unowned rows', async () => {
  const liveOwner = spawnSleeper();
  const ids = await seed(liveOwner.pid);
  const result = await recoverInterrupted('cli', { graceMs: 200 });
  assert.deepEqual(result.failed.sort(), [ids.dead, ids.earlierSelf].sort());
  assert.equal(statusOf(ids.dead), 'failed');
  assert.equal(store.getReview(ids.dead)?.error, 'interrupted by restart');
  assert.equal(statusOf(ids.earlierSelf), 'failed');
  assert.equal(statusOf(ids.own), 'reviewing');
  assert.equal(statusOf(ids.live), 'queued');
  assert.equal(statusOf(ids.legacy), 'reviewing');
  assert.ok(store.getLogs(ids.dead).some((l) => /process that ran it \(pid \d+\) is gone/.test(l.message)));
});

test('the server also fails unowned (legacy) rows, but still not its own or a live process\'s', async () => {
  const liveOwner = spawnSleeper();
  const ids = await seed(liveOwner.pid);
  const result = await recoverInterrupted('server', { graceMs: 200 });
  assert.deepEqual(result.failed.sort(), [ids.dead, ids.earlierSelf, ids.legacy].sort());
  assert.equal(statusOf(ids.legacy), 'failed');
  assert.equal(statusOf(ids.own), 'reviewing');
  assert.equal(statusOf(ids.live), 'queued');
  // The live owner itself is never touched.
  assert.equal(isPidAlive(liveOwner.pid), true);
});

test('finished rows are never touched', async () => {
  store.db.prepare('DELETE FROM reviews').run();
  const done = store.createReview({
    repo: 'my-service', branch: 'feat/done', base_branch: 'main', status: 'done', runner_pid: await deadPid(),
  });
  const result = await recoverInterrupted('server', { graceMs: 200 });
  assert.deepEqual(result.failed, []);
  assert.equal(statusOf(done.id), 'done');
});

/** A row of a dead owner that recorded `child` as one of its reviewer processes. */
async function orphanRow(child: ChildProcess & { pid: number }, bin: string): Promise<number> {
  store.db.prepare('DELETE FROM reviews').run();
  return store.createReview({
    repo: 'my-service', branch: 'feat/orphan', base_branch: 'main', status: 'reviewing',
    runner_pid: await deadPid(), runner_started_at: '2026-01-01T00:00:00.000Z',
    reviewer_pgids: JSON.stringify([{ pgid: child.pid, bin, spawnedAt: new Date().toISOString() }]),
  }).id;
}

test('a recorded process whose command is not the recorded reviewer is left alone', async () => {
  const sleeper = spawnSleeper();
  const id = await orphanRow(sleeper, 'claude');
  const result = await recoverInterrupted('cli', { graceMs: 200 });
  assert.deepEqual(result.failed, [id]);
  assert.deepEqual(result.killedGroups, []);
  assert.equal(await exited(sleeper, 300), false, '"sleep 37" is not "claude": it must survive');
  assert.equal(isPidAlive(sleeper.pid), true);
  assert.equal(store.getReview(id)?.reviewer_pgids, null);
});

test('a recorded reviewer process still running is stopped when its row is failed', async () => {
  const sleeper = spawnSleeper();
  const id = await orphanRow(sleeper, 'claude');
  const result = await recoverInterrupted('cli', {
    graceMs: 2_000,
    matches: (command) => command.includes('sleep'),
  });
  assert.deepEqual(result.failed, [id]);
  assert.deepEqual(result.killedGroups, [sleeper.pid]);
  assert.equal(await exited(sleeper), true, 'the orphan must be stopped');
  assert.equal(sleeper.signalCode, 'SIGTERM', 'SIGTERM first; SIGKILL only after the grace period');
  assert.ok(store.getLogs(id).some((l) => /Stopped 1 reviewer process/.test(l.message)));
});

test('the reviewer processes of a live owner are never stopped', async () => {
  const sleeper = spawnSleeper();
  const liveOwner = spawnSleeper();
  store.db.prepare('DELETE FROM reviews').run();
  store.createReview({
    repo: 'my-service', branch: 'feat/live', base_branch: 'main', status: 'reviewing',
    runner_pid: liveOwner.pid, runner_started_at: '2026-01-01T00:00:00.000Z',
    reviewer_pgids: JSON.stringify([{ pgid: sleeper.pid, bin: 'sleep', spawnedAt: new Date().toISOString() }]),
  });
  const result = await recoverInterrupted('server', { graceMs: 200, matches: () => true });
  assert.deepEqual(result, { failed: [], killedGroups: [] });
  assert.equal(isPidAlive(sleeper.pid), true);
});
