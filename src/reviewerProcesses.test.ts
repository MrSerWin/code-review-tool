import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecordedGroup } from './processOwnership.js';
import { isGroupAlive } from './processOwnership.js';
import {
  liveReviewerGroups, ReviewGroupTracker, spawnReviewer, stopAllReviewers, type PassOptions,
} from './reviewRunner.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import type { OnLog } from './types.js';

/**
 * A stand-in reviewer CLI: `/bin/sh -c '<script>'`. The script ignores the
 * prompt; `trap` lets a test choose how the process reacts to SIGTERM.
 */
/** Every stdout line any fake reviewer printed. */
const printed: string[] = [];

function fakeReviewer(script: string): ReviewerDefinition {
  return {
    name: 'claude',
    label: 'Fake reviewer',
    defaultModel: 'fake',
    bin: '/bin/sh',
    buildArgs: () => ['-c', script],
    buildChildEnv: () => ({ PATH: process.env.PATH }),
    parseStreamLine: (line) => { printed.push(line); return {}; },
    listModels: async () => [],
    isAvailable: () => true,
    describeFailure: () => null,
  };
}

const noLog: OnLog = () => undefined;

function passOptions(
  script: string,
  extra: { signal?: AbortSignal; timeoutMs?: number; history?: RecordedGroup[][] } = {},
): PassOptions {
  return {
    dir: process.cwd(),
    reviewer: fakeReviewer(script),
    model: 'fake',
    timeoutMs: extra.timeoutMs ?? 30_000,
    signal: extra.signal,
    groups: new ReviewGroupTracker((groups) => extra.history?.push(groups)),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('a reviewer process is tracked while it runs and reported to its review', async () => {
  const history: RecordedGroup[][] = [];
  const run = spawnReviewer('prompt', passOptions('exit 0', { history }), noLog);
  await assert.rejects(run); // no answer on stdout: a failed pass, which is fine here
  assert.equal(history.length, 2, 'one report on spawn, one on exit');
  const [started, ended] = history;
  assert.equal(started!.length, 1);
  assert.equal(started![0]!.bin, 'sh');
  assert.ok(Number.isInteger(started![0]!.pgid));
  assert.ok(!Number.isNaN(Date.parse(started![0]!.spawnedAt)));
  assert.deepEqual(ended, []);
  assert.deepEqual(liveReviewerGroups(), []);
});

test('cancelling still kills the whole process group at once', async () => {
  const controller = new AbortController();
  const history: RecordedGroup[][] = [];
  // The group has background grandchildren; they must die too.
  const run = spawnReviewer(
    'prompt',
    passOptions('sleep 37 & sleep 37 & wait', { signal: controller.signal, history }),
    noLog,
  ).catch((err: Error) => err);
  assert.equal(await waitFor(() => history.length > 0), true);
  const pgid = history[0]![0]!.pgid;
  assert.equal(isGroupAlive(pgid), true);
  controller.abort();
  const err = await run;
  assert.match((err as Error).message, /cancelled/);
  assert.equal(await waitFor(() => !isGroupAlive(pgid)), true, 'every process of the group is gone');
  assert.equal(await waitFor(() => !liveReviewerGroups().includes(pgid)), true);
});

test('stopAllReviewers sends SIGTERM, then SIGKILL to what ignores it, and refuses new processes', async () => {
  const politeHistory: RecordedGroup[][] = [];
  const stubbornHistory: RecordedGroup[][] = [];
  const polite = spawnReviewer('prompt', passOptions('sleep 37 & wait', { history: politeHistory }), noLog)
    .catch((err: Error) => err);
  const stubborn = spawnReviewer(
    'prompt',
    // `trap ''` is inherited by the sleep, so the whole group ignores SIGTERM.
    passOptions("trap '' TERM; echo stubborn-ready; sleep 37 & wait", { history: stubbornHistory }),
    noLog,
  ).catch((err: Error) => err);
  assert.equal(
    await waitFor(() => politeHistory.length > 0 && printed.includes('stubborn-ready')),
    true,
    'both fake reviewers started',
  );
  const politePgid = politeHistory[0]![0]!.pgid;
  const stubbornPgid = stubbornHistory[0]![0]!.pgid;
  assert.deepEqual(liveReviewerGroups().sort(), [politePgid, stubbornPgid].sort());

  const started = Date.now();
  const signalled = await stopAllReviewers(400);
  assert.deepEqual(signalled.sort(), [politePgid, stubbornPgid].sort());
  assert.ok(Date.now() - started >= 300, 'the stubborn group used up the grace period');
  assert.equal(await waitFor(() => !isGroupAlive(politePgid) && !isGroupAlive(stubbornPgid)), true);
  await polite;
  await stubborn;
  assert.deepEqual(liveReviewerGroups(), []);

  await assert.rejects(
    spawnReviewer('prompt', passOptions('exit 0'), noLog),
    /Shutting down/,
  );
});
