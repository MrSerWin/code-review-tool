import assert from 'node:assert/strict';
import test from 'node:test';
import { modelOffered, noModelsNotice, pickModel, rememberedModel } from './modelChoice';
import type { ReviewerInfo } from './types';

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
};

const codex: ReviewerInfo = {
  name: 'codex', label: 'OpenAI Codex', defaultModel: 'gpt-6.1-sol', bin: 'codex', available: true,
  models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
};
const claude: ReviewerInfo = {
  name: 'claude', label: 'Claude Code', defaultModel: 'opus', bin: 'claude', available: true,
  acceptsUnlistedModels: true, models: [{ id: 'opus', label: 'Opus' }],
};
const empty: ReviewerInfo = {
  ...codex, defaultModel: null, models: [],
  noModelsHint: 'Codex has no model list yet: run `codex login` or `codex` once, then retry',
};

test('a remembered model the reviewer still lists is kept', () => {
  store.set('crt.model.codex', 'gpt-5.6-sol');
  assert.equal(rememberedModel(codex, 'crt.model.codex'), 'gpt-5.6-sol');
  assert.equal(store.get('crt.model.codex'), 'gpt-5.6-sol');
});

test('a stale remembered model is forgotten and the resolved default selected', () => {
  store.set('crt.model.codex', 'gpt-5.5');
  assert.equal(rememberedModel(codex, 'crt.model.codex'), 'gpt-6.1-sol');
  assert.equal(store.has('crt.model.codex'), false);
});

test('nothing remembered: the resolved default; no default: empty', () => {
  store.clear();
  assert.equal(rememberedModel(codex, 'crt.model.codex'), 'gpt-6.1-sol');
  assert.equal(rememberedModel(empty, 'crt.model.codex'), '');
});

test('a reviewer that takes unlisted ids keeps a model typed by hand', () => {
  store.set('crt.model.claude', 'claude-opus-x');
  assert.equal(rememberedModel(claude, 'crt.model.claude'), 'claude-opus-x');
  assert.equal(modelOffered(claude, 'anything'), true);
});

test('the re-run control drops an old run model the same way', () => {
  assert.equal(pickModel(codex, 'gpt-5.5'), 'gpt-6.1-sol');
  assert.equal(pickModel(codex, 'gpt-5.6-sol'), 'gpt-5.6-sol');
  // No model list from the server (e.g. /api/health): the candidate stays.
  assert.equal(pickModel({ ...codex, models: undefined }, 'gpt-5.5'), 'gpt-5.5');
});

test('an empty list shows "no models available" with the hint', () => {
  assert.equal(
    noModelsNotice(empty),
    'No models available. Codex has no model list yet: run `codex login` or `codex` once, then retry',
  );
  assert.equal(noModelsNotice(codex), null);
  assert.equal(noModelsNotice({ ...claude, models: [] }), null);
});
