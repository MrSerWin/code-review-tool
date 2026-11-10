import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { config } from './config.js';
import {
  codexModelsCachePath, codexNoModelsMessage, codexReviewer, discoverCodexModels, parseCodexModelsCache,
} from './reviewers/codex.js';
import { clearDiscoveryCache, pickDefaultModel } from './reviewers/discovery.js';
import {
  assertModelAvailable, chooseModel, listReviewersWithModels, ModelChoiceError, resolveDefaultModel,
  resolveRerunChoice, resolveStartChoice, reviewerModels, setReviewerForTests,
} from './reviewers/index.js';
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
  clearDiscoveryCache();
});

function writeCache(text: string | null): void {
  if (text === null) fs.rmSync(codexModelsCachePath(), { force: true });
  else fs.writeFileSync(codexModelsCachePath(), text);
}

/** A reviewer whose model list the test controls; `calls.discovered` counts discoveries. */
function stubReviewer(models: () => ModelInfo[], extra: Partial<ReviewerDefinition> = {}) {
  const calls = { discovered: 0 };
  const reviewer: ReviewerDefinition = {
    name: 'codex', label: 'OpenAI Codex', defaultModel: '', defaultModelEnv: 'CODEX_REVIEW_MODEL', bin: '/bin/true',
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    discoverModels: async () => {
      calls.discovered += 1;
      const list = models();
      return {
        models: list,
        source: list.length ? 'cli-cache' : null,
        fetchedAt: Date.now(),
        hint: list.length ? null : codexNoModelsMessage('codex'),
      };
    },
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
  const discovery = await discoverCodexModels(() => true);
  assert.deepEqual(discovery.models, []);
  assert.equal(discovery.source, null);
  assert.equal(discovery.hint, codexNoModelsMessage());
  assert.equal(codexReviewer.defaultModel, config.codexReviewModel ?? '');
});

test('codex without its CLI says it is not installed', async () => {
  writeCache(null);
  const discovery = await discoverCodexModels(() => false);
  assert.match(discovery.hint ?? '', /^OpenAI Codex is not installed: codex not found on PATH/);
});

test('codex reads the cache file as cli-cache and re-reads it on refresh', async () => {
  writeCache(null);
  clearDiscoveryCache();
  assert.deepEqual((await reviewerModels(codexReviewer)).models, []);
  writeCache(fs.readFileSync(FIXTURE, 'utf8'));
  // The in-process cache still answers with the old (empty) list.
  assert.deepEqual((await reviewerModels(codexReviewer)).models, []);
  const fresh = await reviewerModels(codexReviewer, { refresh: true });
  assert.deepEqual(fresh.models.map((m) => m.id), LISTED);
  assert.equal(fresh.source, 'cli-cache');
  assert.equal(fresh.hint, null);
});

// --- default resolution --------------------------------------------------

const CODEX = { label: 'OpenAI Codex', envName: 'CODEX_REVIEW_MODEL' };

test('default: the configured model wins when it is listed', () => {
  const warnings: string[] = [];
  assert.equal(pickDefaultModel(ids(LISTED), 'gpt-5.6-sol', CODEX, (m) => warnings.push(m)), 'gpt-5.6-sol');
  assert.deepEqual(warnings, []);
});

test('default: a configured model that is not listed is ignored with a warning', () => {
  const warnings: string[] = [];
  assert.equal(pickDefaultModel(ids(LISTED), 'gpt-5.5', CODEX, (m) => warnings.push(m)), 'gpt-6.1-sol');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /CODEX_REVIEW_MODEL=gpt-5\.5 is not in the OpenAI Codex model list/);
});

test('default: without a configured model the first listed model', () => {
  assert.equal(pickDefaultModel(ids(LISTED), undefined, CODEX), 'gpt-6.1-sol');
  assert.equal(pickDefaultModel(ids(LISTED), '  ', CODEX), 'gpt-6.1-sol');
});

test('default: an empty list has no default, whatever is configured', () => {
  assert.equal(pickDefaultModel([], undefined, CODEX), null);
  assert.equal(pickDefaultModel([], 'gpt-6.1-sol', CODEX), null);
});

test('default: a reviewer that takes unlisted ids keeps the configured one', () => {
  const claude = { label: 'Claude Code', envName: 'REVIEW_MODEL', acceptsUnlisted: true };
  assert.equal(pickDefaultModel(ids(['latest']), 'some-full-name', claude), 'some-full-name');
  assert.equal(pickDefaultModel([], 'some-full-name', claude), 'some-full-name');
  assert.equal(pickDefaultModel(ids(['latest']), undefined, claude), 'latest');
  assert.equal(pickDefaultModel([], undefined, claude), null);
});

test('codex resolves its default from the cache file, re-reading an empty list once', { skip: Boolean(config.codexReviewModel) }, async () => {
  writeCache(null);
  clearDiscoveryCache();
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
  assert.equal(calls.discovered, 2);
  assert.equal(await chooseModel(reviewer, { requested: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
});

test('a miss that the refreshed list knows is accepted', async () => {
  let list = ['gpt-6.1-sol'];
  const { reviewer, calls } = stubReviewer(() => ids(list));
  assert.equal(await chooseModel(reviewer, {}), 'gpt-6.1-sol');
  list = ['gpt-6.1-sol', 'gpt-7-sol'];
  assert.equal(await chooseModel(reviewer, { requested: 'gpt-7-sol' }), 'gpt-7-sol');
  assert.equal(calls.discovered, 2);
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
    assert.equal(codex.source, null);
    assert.ok(!Number.isNaN(Date.parse(codex.fetchedAt)));
  } finally {
    setReviewerForTests('codex', null);
  }
  const claude = stubReviewer(() => [], { name: 'claude', label: 'Claude Code', acceptsUnlistedModels: true });
  setReviewerForTests('claude', claude.reviewer);
  try {
    // Nothing discovered: free-form names are still accepted, but the hint says how to get a list.
    const detail = (await listReviewersWithModels()).find((r) => r.name === 'claude')!;
    assert.equal(detail.acceptsUnlistedModels, true);
    assert.equal(detail.defaultModel, null);
    assert.match(detail.noModelsHint ?? '', /no model list yet/);
  } finally {
    setReviewerForTests('claude', null);
  }
  const listed = stubReviewer(() => ids(['gpt-6.1-sol']));
  setReviewerForTests('codex', listed.reviewer);
  try {
    const codex = (await listReviewersWithModels()).find((r) => r.name === 'codex')!;
    assert.equal(codex.defaultModel, 'gpt-6.1-sol');
    assert.equal(codex.noModelsHint, null);
    assert.equal(codex.source, 'cli-cache');
    // `refresh` discovers again even inside the cache window.
    const before = listed.calls.discovered;
    await listReviewersWithModels({ refresh: true });
    assert.equal(listed.calls.discovered, before + 1);
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
