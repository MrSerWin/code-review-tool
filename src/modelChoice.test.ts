import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { config } from './config.js';
import {
  codexModelsCachePath, codexNoModelsMessage, codexReviewer, parseCodexModelsCache, pickCodexDefault,
} from './reviewers/codex.js';
import {
  assertModelAvailable, chooseModel, listReviewersWithModels, ModelChoiceError, resolveDefaultModel,
  resolveRerunChoice, resolveStartChoice, setReviewerForTests,
} from './reviewers/index.js';
import { clearModelCache } from './reviewers/shared.js';
import type { ModelInfo, ReviewerDefinition } from './reviewers/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-models-cache.json');
const LISTED = [
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-codex-home-'));
const savedHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = home;

test.after(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  clearModelCache();
});

function writeCache(text: string | null): void {
  if (text === null) fs.rmSync(codexModelsCachePath(), { force: true });
  else fs.writeFileSync(codexModelsCachePath(), text);
}

/** A reviewer whose model list the test controls; `calls` counts list reads, refreshes apart. */
function stubReviewer(models: () => ModelInfo[], extra: Partial<ReviewerDefinition> = {}) {
  const calls = { cached: 0, refresh: 0 };
  let cached: ModelInfo[] | null = null;
  const reviewer: ReviewerDefinition = {
    name: 'codex', label: 'OpenAI Codex', defaultModel: '', bin: '/bin/true',
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    listModels: async (opts) => {
      if (opts?.refresh || cached === null) {
        if (opts?.refresh) calls.refresh += 1;
        cached = models();
      }
      calls.cached += 1;
      return cached;
    },
    resolveDefaultModel: async () => (await reviewer.listModels())[0]?.id ?? null,
    noModelsMessage: () => codexNoModelsMessage('codex'),
    isAvailable: () => true,
    describeFailure: () => null,
    ...extra,
  };
  return { reviewer, calls };
}

const ids = (list: string[]): ModelInfo[] => list.map((id) => ({ id, label: id }));

// --- the cache file ------------------------------------------------------

test('the real cache shape: listed models only, by priority, hidden ones dropped', () => {
  const models = parseCodexModelsCache(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(models.map((m) => m.id), LISTED);
  assert.equal(models[1]!.label, 'GPT-6.1 Terra');
  assert.deepEqual(parseCodexModelsCache('{}'), []);
  assert.deepEqual(parseCodexModelsCache('{"models": "x"}'), []);
});

test('codex lists nothing without a cache file, and no invented fallback model', async () => {
  writeCache(null);
  clearModelCache();
  assert.deepEqual(await codexReviewer.listModels(), []);
  assert.equal(codexReviewer.defaultModel, config.codexReviewModel ?? '');
});

test('codex reads the cache file and re-reads it on refresh', async () => {
  writeCache(null);
  clearModelCache();
  assert.deepEqual(await codexReviewer.listModels(), []);
  writeCache(fs.readFileSync(FIXTURE, 'utf8'));
  // The in-process cache still answers with the old (empty) list.
  assert.deepEqual(await codexReviewer.listModels(), []);
  assert.deepEqual((await codexReviewer.listModels({ refresh: true })).map((m) => m.id), LISTED);
});

// --- default resolution --------------------------------------------------

test('default: CODEX_REVIEW_MODEL wins when it is listed', () => {
  const warnings: string[] = [];
  assert.equal(pickCodexDefault(ids(LISTED), 'gpt-5.6-sol', (m) => warnings.push(m)), 'gpt-5.6-sol');
  assert.deepEqual(warnings, []);
});

test('default: CODEX_REVIEW_MODEL that is not listed is ignored with a warning', () => {
  const warnings: string[] = [];
  assert.equal(pickCodexDefault(ids(LISTED), 'gpt-5.5', (m) => warnings.push(m)), 'gpt-6.1-sol');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /CODEX_REVIEW_MODEL=gpt-5\.5 is not in the Codex model list/);
});

test('default: without CODEX_REVIEW_MODEL the first listed model', () => {
  assert.equal(pickCodexDefault(ids(LISTED), undefined), 'gpt-6.1-sol');
  assert.equal(pickCodexDefault(ids(LISTED), '  '), 'gpt-6.1-sol');
});

test('default: an empty cache has no default, whatever is configured', () => {
  assert.equal(pickCodexDefault([], undefined), null);
  assert.equal(pickCodexDefault([], 'gpt-6.1-sol'), null);
});

test('codex resolves its default from the cache file, re-reading an empty list once', { skip: Boolean(config.codexReviewModel) }, async () => {
  writeCache(null);
  clearModelCache();
  assert.equal(await resolveDefaultModel(codexReviewer), null);
  writeCache(fs.readFileSync(FIXTURE, 'utf8'));
  // The cached empty list is not trusted: the file is read again.
  assert.equal(await resolveDefaultModel(codexReviewer), 'gpt-6.1-sol');
});

// --- choosing and validating ---------------------------------------------

test('a requested model the list lacks is refused, naming the available ids', async () => {
  const { reviewer, calls } = stubReviewer(() => ids(['gpt-6.1-sol', 'gpt-5.6-sol']));
  await assert.rejects(chooseModel(reviewer, { requested: 'gpt-5.5' }), (err: Error) => {
    assert.ok(err instanceof ModelChoiceError);
    assert.equal(err.message, 'Model "gpt-5.5" is not available for OpenAI Codex. Available: gpt-6.1-sol, gpt-5.6-sol.');
    return true;
  });
  // The miss re-read the list once before deciding.
  assert.equal(calls.refresh, 1);
  assert.equal(await chooseModel(reviewer, { requested: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
});

test('a miss that the refreshed list knows is accepted', async () => {
  let list = ['gpt-6.1-sol'];
  const { reviewer, calls } = stubReviewer(() => ids(list));
  assert.equal(await chooseModel(reviewer, {}), 'gpt-6.1-sol');
  list = ['gpt-6.1-sol', 'gpt-7-sol'];
  assert.equal(await chooseModel(reviewer, { requested: 'gpt-7-sol' }), 'gpt-7-sol');
  assert.equal(calls.refresh, 1);
});

test('no model list: no default, and every choice fails with the login hint', async () => {
  const { reviewer } = stubReviewer(() => []);
  const hint = 'Codex has no model list yet: run `codex login` or `codex` once, then retry';
  await assert.rejects(chooseModel(reviewer, {}), { message: hint });
  await assert.rejects(chooseModel(reviewer, { requested: 'gpt-6.1-sol' }), { message: hint });
  await assert.rejects(chooseModel(reviewer, { inherited: 'gpt-6.1-sol' }), { message: hint });
});

test('an inherited model no longer offered falls back to the default and says so', async () => {
  const { reviewer } = stubReviewer(() => ids(['gpt-6.1-sol', 'gpt-5.6-sol']));
  const notes: string[] = [];
  assert.equal(await chooseModel(reviewer, { inherited: 'gpt-5.5', onFallback: (m) => notes.push(m) }), 'gpt-6.1-sol');
  assert.deepEqual(notes, ['model gpt-5.5 is no longer offered by OpenAI Codex; using gpt-6.1-sol']);
  assert.equal(await chooseModel(reviewer, { inherited: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
});

test('a reviewer that accepts unlisted ids takes any requested model', async () => {
  const { reviewer } = stubReviewer(() => ids(['opus']), { name: 'claude', acceptsUnlistedModels: true });
  await assertModelAvailable(reviewer, 'claude-opus-x');
  assert.equal(await chooseModel(reviewer, { requested: 'claude-opus-x' }), 'claude-opus-x');
});

test('start and re-run choices go through the same check', async () => {
  const { reviewer } = stubReviewer(() => ids(['gpt-6.1-sol', 'gpt-5.6-sol']));
  setReviewerForTests('codex', reviewer);
  try {
    assert.deepEqual((await resolveStartChoice('codex', undefined)).model, 'gpt-6.1-sol');
    await assert.rejects(resolveStartChoice('codex', 'gpt-5.5'), /Available: gpt-6\.1-sol, gpt-5\.6-sol/);
    // The previous run's stale model is replaced by the default; a named one is checked.
    assert.equal((await resolveRerunChoice({ reviewer: 'codex', model: 'gpt-5.5' })).model, 'gpt-6.1-sol');
    assert.equal((await resolveRerunChoice({ reviewer: 'codex', model: 'gpt-5.6-sol' })).model, 'gpt-5.6-sol');
    assert.equal((await resolveRerunChoice({ reviewer: 'codex', model: null })).model, 'gpt-6.1-sol');
    // Switching reviewer drops the previous model ("opus" must never reach codex).
    assert.equal((await resolveRerunChoice({ reviewer: 'claude', model: 'opus' }, { reviewer: 'codex' })).model, 'gpt-6.1-sol');
    await assert.rejects(resolveRerunChoice({ reviewer: 'codex', model: 'gpt-6.1-sol' }, { model: 'gpt-5.5' }), ModelChoiceError);
  } finally {
    setReviewerForTests('codex', null);
  }
});

test('/api/reviewers payload: resolved default, or null with a hint when nothing is listed', async () => {
  const { reviewer } = stubReviewer(() => []);
  setReviewerForTests('codex', reviewer);
  try {
    const codex = (await listReviewersWithModels()).find((r) => r.name === 'codex')!;
    assert.equal(codex.defaultModel, null);
    assert.deepEqual(codex.models, []);
    assert.equal(codex.noModelsHint, 'Codex has no model list yet: run `codex login` or `codex` once, then retry');
    const claude = (await listReviewersWithModels()).find((r) => r.name === 'claude')!;
    assert.equal(claude.acceptsUnlistedModels, true);
    assert.equal(claude.noModelsHint, null);
  } finally {
    setReviewerForTests('codex', null);
  }
  const listed = stubReviewer(() => ids(['gpt-6.1-sol']));
  setReviewerForTests('codex', listed.reviewer);
  try {
    const codex = (await listReviewersWithModels()).find((r) => r.name === 'codex')!;
    assert.equal(codex.defaultModel, 'gpt-6.1-sol');
    assert.equal(codex.noModelsHint, null);
  } finally {
    setReviewerForTests('codex', null);
  }
});

test('a reviewer that is not installed is reported as such, not as missing models', async () => {
  const { reviewer } = stubReviewer(() => [], { isAvailable: () => false, bin: 'codex-missing' });
  setReviewerForTests('codex', reviewer);
  try {
    await assert.rejects(resolveStartChoice('codex', undefined), { message: 'OpenAI Codex is not installed: codex-missing not found on PATH' });
    await assert.rejects(resolveRerunChoice({ reviewer: 'codex', model: 'gpt-5.5' }), /is not installed/);
  } finally {
    setReviewerForTests('codex', null);
  }
});
