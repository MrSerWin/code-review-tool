import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ANTHROPIC_MODELS_URL, ANTHROPIC_VERSION, catalogModels, discoverClaudeModels, fetchAnthropicModels,
  parseClaudeCatalog, parseClaudeHelpAliases, versionAtLeast, type FetchLike,
} from './reviewers/claude.js';
import { discoverCursorModels } from './reviewers/cursor.js';
import { clearDiscoveryCache, discoverModels, DISCOVERY_TTL_MS } from './reviewers/discovery.js';
import { discoverGrokModels } from './reviewers/grok.js';
import {
  chooseModel, ModelChoiceError, resolveDefaultModel, resolveStartChoice, setReviewerForTests,
} from './reviewers/index.js';
import { FORBIDDEN_ENV, type CliOutput, type CliRunner } from './reviewers/shared.js';
import type { ModelDiscovery, ReviewerDefinition } from './reviewers/types.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(SRC_DIR, 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A CLI runner answering by argv, recording what it was asked. */
function fakeCli(answers: Record<string, Partial<CliOutput>>): { run: CliRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CliRunner = async (bin, args) => {
    const key = args.join(' ');
    calls.push(`${bin} ${key}`);
    return { stdout: '', stderr: '', code: 0, ...(answers[key] ?? { code: 1 }) };
  };
  return { run, calls };
}

function catalogDir(...files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-claude-catalog-'));
  files.forEach((name, i) => fs.copyFileSync(path.join(FIXTURES, name), path.join(dir, `account-${i}-cc.json`)));
  return dir;
}

const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-claude-empty-'));
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

// --- Claude: --help ------------------------------------------------------------

test('claude --help: the alias examples of --model, across wrapped lines', () => {
  assert.deepEqual(parseClaudeHelpAliases(fixture('claude-help-model-option.txt')), ['fable', 'opus', 'sonnet']);
  assert.deepEqual(parseClaudeHelpAliases('Usage: claude\n  --mcp-config <x>  Load MCP servers'), []);
  // An option whose name only starts with --model is not it.
  assert.deepEqual(parseClaudeHelpAliases("  --model-x <m>  (e.g. 'nope')"), []);
});

test('claude without catalog or key: the --help aliases, labelled as aliases, source cli-help', async () => {
  const { run, calls } = fakeCli({ '--help': { stdout: fixture('claude-help-model-option.txt') } });
  const d = await discoverClaudeModels({ apiKey: undefined, bin: 'claude', catalogDir: EMPTY_DIR, run, installed: () => true });
  assert.equal(d.source, 'cli-help');
  assert.deepEqual(d.models, [
    { id: 'fable', label: 'fable alias (latest)' },
    { id: 'opus', label: 'opus alias (latest)' },
    { id: 'sonnet', label: 'sonnet alias (latest)' },
  ]);
  assert.equal(d.hint, null);
  assert.deepEqual(calls, ['claude --help']);
});

test('claude with nothing to read: an empty list and a hint, never an invented id', async () => {
  const { run } = fakeCli({ '--help': { stdout: 'Usage: claude [options]\n' } });
  const installed = await discoverClaudeModels({ apiKey: undefined, bin: 'claude', catalogDir: EMPTY_DIR, run, installed: () => true });
  assert.deepEqual(installed.models, []);
  assert.equal(installed.source, null);
  assert.match(installed.hint ?? '', /run `claude` once so it caches its model catalog/);
  assert.match(installed.hint ?? '', /set ANTHROPIC_API_KEY/);
  assert.match(installed.hint ?? '', /full model name can still be typed/);

  const missing = await discoverClaudeModels({ apiKey: undefined, bin: 'claude', catalogDir: EMPTY_DIR, run, installed: () => false });
  assert.match(missing.hint ?? '', /install Claude Code \(claude not found on PATH\)/);
});

// --- Claude: the on-disk catalog ----------------------------------------------

test('claude catalog: aliases first with the model they point at, then full ids; selected model leads', () => {
  const catalog = parseClaudeCatalog(fixture('claude-model-catalog.json'))!;
  const models = catalogModels(catalog, '2.1.292');
  assert.deepEqual(models.slice(0, 4), [
    { id: 'opus', label: 'opus alias (latest: Opus 5.5)' },
    { id: 'fable', label: 'fable alias (latest: Fable 5.2)' },
    { id: 'sonnet', label: 'sonnet alias (latest: Sonnet 5.5)' },
    { id: 'haiku', label: 'haiku alias (latest: Haiku 5.5)' },
  ]);
  assert.deepEqual(models[4], { id: 'claude-opus-5-5', label: 'Opus 5.5' });
  assert.equal(models.length, 4 + catalog.models.length);
});

test('claude catalog: disabled models and models newer than the CLI are left out', () => {
  const pro = parseClaudeCatalog(fixture('claude-model-catalog-pro-plan.json'))!;
  const ids = catalogModels(pro, '2.1.292').map((m) => m.id);
  assert.ok(!ids.includes('claude-opus-5-5'), 'disabled on the plan');
  assert.ok(!ids.includes('opus'), 'its alias target is disabled');
  // The CLI's selected model has no alias pointing at it, so it leads as itself.
  assert.equal(ids[0], 'claude-sonnet-4-6');

  const current = parseClaudeCatalog(fixture('claude-model-catalog.json'))!;
  const old = catalogModels(current, '2.1.285').map((m) => m.id);
  assert.ok(!old.includes('claude-fable-5-2'), 'needs 2.1.290');
  assert.ok(!old.includes('fable') || old.indexOf('fable') > old.indexOf('opus'));
  assert.ok(old.includes('claude-opus-5-5'));
});

test('claude catalog: an unknown layout version or broken file is ignored', () => {
  assert.equal(parseClaudeCatalog('{"version": 3, "catalog": {"config": {"models": []}}}'), null);
  assert.equal(parseClaudeCatalog('not json'), null);
  assert.equal(versionAtLeast('2.1.292', '2.1.290'), true);
  assert.equal(versionAtLeast('2.1.285', '2.1.290'), false);
  assert.equal(versionAtLeast(null, '2.1.290'), true);
});

test('claude discovery reads the newest catalog on disk as cli-cache', async () => {
  const dir = catalogDir('claude-model-catalog-pro-plan.json', 'claude-model-catalog.json');
  try {
    const { run, calls } = fakeCli({ '--version': { stdout: '2.1.292 (Claude Code)\n' } });
    const d = await discoverClaudeModels({ apiKey: undefined, bin: 'claude', catalogDir: dir, run, installed: () => true });
    assert.equal(d.source, 'cli-cache');
    assert.equal(d.models[0]!.id, 'opus');
    assert.ok(d.models.some((m) => m.id === 'claude-fable-5-2'));
    assert.deepEqual(calls, ['claude --version']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Claude: the Models API ----------------------------------------------------

function fakeApi(pages: Array<{ data: Array<{ id: string; display_name?: string }>; has_more: boolean; last_id?: string }>, status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    const page = pages[seen.length - 1] ?? { data: [], has_more: false };
    return { ok: status === 200, status, json: async () => page };
  };
  return { impl, seen };
}

test('claude API: every page, with the version header and the key only in x-api-key', async () => {
  const { impl, seen } = fakeApi([
    { data: [{ id: 'model-c', display_name: 'Model C' }, { id: 'model-b', display_name: 'Model B' }], has_more: true, last_id: 'model-b' },
    { data: [{ id: 'model-a' }], has_more: false, last_id: 'model-a' },
  ]);
  const models = await fetchAnthropicModels('sk-test', impl);
  assert.deepEqual(models, [
    { id: 'model-c', label: 'Model C' }, { id: 'model-b', label: 'Model B' }, { id: 'model-a', label: 'model-a' },
  ]);
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.url.startsWith(`${ANTHROPIC_MODELS_URL}?`));
  assert.equal(new URL(seen[0]!.url).searchParams.get('after_id'), null);
  assert.equal(new URL(seen[1]!.url).searchParams.get('after_id'), 'model-b');
  assert.deepEqual(seen[0]!.headers, { 'x-api-key': 'sk-test', 'anthropic-version': ANTHROPIC_VERSION });
  assert.ok(!seen[0]!.url.includes('sk-test'));
});

test('claude discovery prefers the API when a key is set', async () => {
  const { impl } = fakeApi([{ data: [{ id: 'model-x', display_name: 'Model X' }], has_more: false }]);
  const { run, calls } = fakeCli({});
  const d = await discoverClaudeModels({ apiKey: 'sk-test', bin: 'claude', catalogDir: EMPTY_DIR, run, fetch: impl, installed: () => true });
  assert.equal(d.source, 'api');
  assert.deepEqual(d.models, [{ id: 'model-x', label: 'Model X' }]);
  assert.deepEqual(calls, [], 'the CLI is not asked');
});

test('claude discovery: a refused key falls back to the CLI, and the hint names the HTTP status', async () => {
  const { impl } = fakeApi([], 401);
  const help = fakeCli({ '--help': { stdout: fixture('claude-help-model-option.txt') } });
  const d = await discoverClaudeModels({ apiKey: 'sk-test', bin: 'claude', catalogDir: EMPTY_DIR, run: help.run, fetch: impl, installed: () => true });
  assert.equal(d.source, 'cli-help');

  const none = fakeCli({});
  const empty = await discoverClaudeModels({ apiKey: 'sk-test', bin: 'claude', catalogDir: EMPTY_DIR, run: none.run, fetch: impl, installed: () => true });
  assert.deepEqual(empty.models, []);
  assert.match(empty.hint ?? '', /check ANTHROPIC_API_KEY \(the Anthropic Models API answered HTTP 401\)/);
  assert.ok(!(empty.hint ?? '').includes('sk-test'));
});

test('the API key never reaches a review process', () => {
  assert.ok((FORBIDDEN_ENV as readonly string[]).includes('ANTHROPIC_API_KEY'));
});

// --- Cursor and Grok -----------------------------------------------------------

const CURSOR_LIST = `Available models

auto - Auto (current, default)
gpt-5.3-codex - Codex 5.3

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`;

const GROK_LIST = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  - grok-4.5
  * grok-4.7 (default)`;

test('cursor: models from --list-models as cli, the CLI default first', async () => {
  const { run, calls } = fakeCli({ '--list-models': { stdout: CURSOR_LIST } });
  const d = await discoverCursorModels(run, () => true);
  assert.equal(d.source, 'cli');
  assert.deepEqual(d.models.map((m) => m.id), ['auto', 'gpt-5.3-codex']);
  assert.match(calls[0]!, / --list-models$/);
});

test('grok: models from `grok models` as cli, the marked default first', async () => {
  const { run } = fakeCli({ models: { stdout: GROK_LIST } });
  const d = await discoverGrokModels(run, () => true);
  assert.equal(d.source, 'cli');
  assert.deepEqual(d.models.map((m) => m.id), ['grok-4.7', 'grok-4.5']);
});

test('cursor and grok: missing, timed out, logged out, or silent CLIs give an empty list with a hint', async () => {
  const cases: Array<[string, Partial<CliOutput>, boolean, RegExp]> = [
    ['missing', {}, false, /is not installed: \S+ not found on PATH/],
    ['timeout', { code: null, timedOut: true }, true, /did not answer within 20 s/],
    ['logged out', { code: 1, stderr: 'Error: Not logged in' }, true, /is not logged in: run `\S+ login`/],
    ['silent', { code: 0, stdout: 'nothing here' }, true, /listed no models \(`\S+ [-a-z]+` exited with 0\)/],
  ];
  for (const [name, out, installed, hint] of cases) {
    for (const discover of [discoverCursorModels, discoverGrokModels]) {
      const run: CliRunner = async () => ({ stdout: '', stderr: '', code: 0, ...out });
      const d = await discover(run, () => installed);
      assert.deepEqual(d.models, [], name);
      assert.equal(d.source, null, name);
      assert.match(d.hint ?? '', hint, name);
    }
  }
  const cursorLogin = await discoverCursorModels(async () => ({ stdout: '', stderr: 'unauthorized', code: 1 }), () => true);
  assert.match(cursorLogin.hint ?? '', /CURSOR_API_KEY/);
});

// --- the cache -----------------------------------------------------------------

function countingReviewer(result: () => ModelDiscovery, extra: Partial<ReviewerDefinition> = {}) {
  const calls = { n: 0 };
  const reviewer: ReviewerDefinition = {
    name: 'grok', label: 'Grok CLI', defaultModel: '', defaultModelEnv: 'GROK_REVIEW_MODEL', bin: '/bin/true',
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    discoverModels: async () => { calls.n += 1; return result(); },
    isAvailable: () => true, describeFailure: () => null,
    ...extra,
  };
  return { reviewer, calls };
}

const listing = (ids: string[], source: ModelDiscovery['source'] = 'cli'): ModelDiscovery => ({
  models: ids.map((id) => ({ id, label: id })), source, fetchedAt: Date.now(), hint: null,
});

test('discovery is cached for the TTL, refresh asks again, concurrent callers share one call', async (t) => {
  clearDiscoveryCache();
  const { reviewer, calls } = countingReviewer(() => listing(['m1']));
  const [a, b] = await Promise.all([discoverModels(reviewer), discoverModels(reviewer)]);
  assert.equal(calls.n, 1);
  assert.equal(a, b);
  assert.equal(a.source, 'cli');
  await discoverModels(reviewer);
  assert.equal(calls.n, 1);
  await discoverModels(reviewer, { refresh: true });
  assert.equal(calls.n, 2);

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + DISCOVERY_TTL_MS + 1 });
  await discoverModels(reviewer);
  assert.equal(calls.n, 3);
});

test('a discovery that throws is an empty list with a hint', async () => {
  const { reviewer } = countingReviewer(() => { throw new Error('boom'); });
  const d = await discoverModels(reviewer);
  assert.deepEqual(d.models, []);
  assert.equal(d.hint, 'Grok CLI model discovery failed: boom');
});

// --- defaults and validation per reviewer -----------------------------------------

for (const [name, label, env] of [
  ['cursor', 'Cursor Agent', 'CURSOR_REVIEW_MODEL'],
  ['grok', 'Grok CLI', 'GROK_REVIEW_MODEL'],
  ['codex', 'OpenAI Codex', 'CODEX_REVIEW_MODEL'],
] as const) {
  test(`${name}: default is the configured listed model, else the first; unlisted ids are refused`, async () => {
    const listed = countingReviewer(() => listing(['first', 'second']), { name, label, defaultModelEnv: env });
    assert.equal(await resolveDefaultModel(listed.reviewer), 'first');
    const configured = countingReviewer(() => listing(['first', 'second']), { name, label, defaultModelEnv: env, defaultModel: 'second' });
    assert.equal(await resolveDefaultModel(configured.reviewer), 'second');
    const stale = countingReviewer(() => listing(['first']), { name, label, defaultModelEnv: env, defaultModel: 'gone' });
    assert.equal(await resolveDefaultModel(stale.reviewer), 'first');

    setReviewerForTests(name, listed.reviewer);
    try {
      assert.deepEqual((await resolveStartChoice(name, undefined)).model, 'first');
      assert.equal((await resolveStartChoice(name, 'second')).model, 'second');
      await assert.rejects(resolveStartChoice(name, 'other'), (err: Error) => {
        assert.ok(err instanceof ModelChoiceError);
        assert.equal(err.message, `Model "other" is not available for ${label}. Available: first, second.`);
        return true;
      });
    } finally {
      setReviewerForTests(name, null);
    }

    const empty = countingReviewer(() => ({ ...listing([]), source: null, hint: `${label} needs a login` }), { name, label, defaultModelEnv: env });
    await assert.rejects(chooseModel(empty.reviewer, {}), { message: `${label} needs a login` });
    await assert.rejects(chooseModel(empty.reviewer, { requested: 'first' }), { message: `${label} needs a login` });
  });
}

test('claude: listed aliases are the choices, a typed full name is accepted, REVIEW_MODEL wins', async () => {
  const base = { name: 'claude', label: 'Claude Code', defaultModelEnv: 'REVIEW_MODEL', acceptsUnlistedModels: true } as const;
  const listed = countingReviewer(() => listing(['alias-a', 'alias-b'], 'cli-help'), base);
  assert.equal(await resolveDefaultModel(listed.reviewer), 'alias-a');
  assert.equal(await chooseModel(listed.reviewer, { requested: 'some-full-model-name' }), 'some-full-model-name');
  const configured = countingReviewer(() => listing(['alias-a'], 'cli-help'), { ...base, defaultModel: 'pinned-full-name' });
  assert.equal(await resolveDefaultModel(configured.reviewer), 'pinned-full-name');
  const empty = countingReviewer(() => ({ ...listing([]), source: null, hint: 'Claude Code lists no models: x' }), base);
  await assert.rejects(chooseModel(empty.reviewer, {}), { message: 'Claude Code lists no models: x' });
  assert.equal(await chooseModel(empty.reviewer, { requested: 'typed-name' }), 'typed-name');
});

// --- no model id is written into the source ------------------------------------------

const MODEL_LITERAL = /\b(?:gpt-|claude-|grok-|o[0-9]-)|\b(?:opus|sonnet|haiku|fable)\b/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(full);
    return entry.name.endsWith('.test.ts') ? [] : [full];
  });
}

test('no model id or model family name is written anywhere in src/ outside tests and fixtures', () => {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (MODEL_LITERAL.test(line)) hits.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// --- what /api/reviewers and the MCP tool return ----------------------------------

test('GET /api/reviewers: models, default, source, fetchedAt and hint per reviewer; ?refresh=1 discovers again', async () => {
  const { default: Fastify } = await import('fastify');
  const { reviewerRoutes } = await import('./routes/reviewers.js');
  const stubs = {
    claude: countingReviewer(() => listing(['alias-a'], 'cli-help'), { name: 'claude', label: 'Claude Code', acceptsUnlistedModels: true, defaultModelEnv: 'REVIEW_MODEL' }),
    cursor: countingReviewer(() => ({ ...listing([]), source: null, hint: 'Cursor Agent is not logged in: x' }), { name: 'cursor', label: 'Cursor Agent' }),
    codex: countingReviewer(() => listing(['c1', 'c2'], 'cli-cache'), { name: 'codex', label: 'OpenAI Codex' }),
    grok: countingReviewer(() => listing(['g1'], 'cli'), { name: 'grok', label: 'Grok CLI' }),
  };
  for (const [name, stub] of Object.entries(stubs)) setReviewerForTests(name as keyof typeof stubs, stub.reviewer);
  const app = Fastify();
  await app.register(reviewerRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/reviewers' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { reviewers: Array<Record<string, unknown>> };
    const by = Object.fromEntries(body.reviewers.map((r) => [r.name, r]));
    assert.deepEqual(by.claude!.models, [{ id: 'alias-a', label: 'alias-a' }]);
    assert.equal(by.claude!.source, 'cli-help');
    assert.equal(by.claude!.defaultModel, 'alias-a');
    assert.equal(by.claude!.noModelsHint, null);
    assert.equal(by.codex!.defaultModel, 'c1');
    assert.equal(by.codex!.source, 'cli-cache');
    assert.equal(by.grok!.source, 'cli');
    assert.equal(by.cursor!.defaultModel, null);
    assert.equal(by.cursor!.source, null);
    assert.equal(by.cursor!.noModelsHint, 'Cursor Agent is not logged in: x');
    assert.ok(!Number.isNaN(Date.parse(String(by.grok!.fetchedAt))));

    const before = stubs.grok.calls.n;
    await app.inject({ method: 'GET', url: '/api/reviewers' });
    assert.equal(stubs.grok.calls.n, before, 'answered from the cache');
    await app.inject({ method: 'GET', url: '/api/reviewers?refresh=1' });
    assert.equal(stubs.grok.calls.n, before + 1, 'refresh discovers again');
  } finally {
    await app.close();
    for (const name of Object.keys(stubs)) setReviewerForTests(name as keyof typeof stubs, null);
  }
});

test('MCP list_reviewers format: source, fetched_at, hint and typed-name flag', async () => {
  const { compactReviewers } = await import('./mcp/format.js');
  const out = compactReviewers({
    defaultReviewer: 'claude',
    reviewers: [
      { name: 'claude', label: 'Claude Code', defaultModel: 'alias-a', available: true, acceptsUnlistedModels: true,
        models: [{ id: 'alias-a' }], source: 'cli-help', fetchedAt: '2026-11-10T19:00:00.000Z' },
      { name: 'cursor', label: 'Cursor Agent', defaultModel: null, available: false, models: [], source: null,
        fetchedAt: '2026-11-10T19:00:00.000Z', noModelsHint: 'Cursor Agent is not installed' },
    ],
  });
  assert.deepEqual(out.reviewers[0], {
    name: 'claude', label: 'Claude Code', available: true, default_model: 'alias-a', models: ['alias-a'],
    source: 'cli-help', fetched_at: '2026-11-10T19:00:00.000Z', accepts_unlisted_models: true,
  });
  assert.equal(out.reviewers[1]!.source, null);
  assert.equal(out.reviewers[1]!.no_models, 'Cursor Agent is not installed');
});
