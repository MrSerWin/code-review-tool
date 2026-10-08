import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The preview engine reaches db.ts, which opens `<DATA_DIR>/review.db` on
// import: point it at a throwaway directory first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-preview-env-'));
process.env.DATA_DIR = dataDir;
const { buildStepEnv, previewBaseEnv } = await import('./preview/engine.js');
const { FORBIDDEN_ENV, REVIEWER_MARKER_ENV } = await import('./reviewers/shared.js');
const { db } = await import('./db.js');

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type StepEnvInput = Parameters<typeof buildStepEnv>[0];

function stepInput(): StepEnvInput {
  return {
    previewId: 7,
    previewDir: '/tmp/preview-7',
    recipe: { dir: '/tmp/recipes/example-app' } as StepEnvInput['recipe'],
    roles: [{ role: 'backend', repo: 'my-service', branch: 'feat/x', base: 'main', usedBase: false }],
    checkouts: { backend: '/tmp/checkout' },
    ports: { app: 21000 },
    ticketKey: 'ABC-123',
    dbName: 'preview_7',
  };
}

test('preview steps get the sanitized environment without the reviewer marker', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [REVIEWER_MARKER_ENV, ...FORBIDDEN_ENV];
  for (const key of keys) saved[key] = process.env[key];
  try {
    // Even when the server itself carries them, a step must not.
    for (const key of keys) process.env[key] = 'leak';
    for (const env of [previewBaseEnv(), buildStepEnv(stepInput())]) {
      assert.equal(env[REVIEWER_MARKER_ENV], undefined, 'a preview step is not a reviewer');
      for (const key of FORBIDDEN_ENV) assert.equal(env[key], undefined, `${key} must be stripped`);
      assert.equal(env.PATH, process.env.PATH, 'the allowlist still passes through');
    }
    const env = buildStepEnv(stepInput());
    assert.equal(env.PREVIEW_ID, 'preview-7');
    assert.equal(env.CHECKOUT_BACKEND, '/tmp/checkout');
    assert.equal(env.PORT_APP, '21000');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
