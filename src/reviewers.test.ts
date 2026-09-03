import './testEnv.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAnthropicStreamLine } from './reviewers/anthropicStream.js';
import { claudeReviewer, CLAUDE_MODELS } from './reviewers/claude.js';
import { codexReviewer, parseCodexModelsCache } from './reviewers/codex.js';
import { parseCodexStreamLine } from './reviewers/codexStream.js';
import { cursorReviewer, parseCursorModels } from './reviewers/cursor.js';
import { grokReviewer, GROK_DISALLOWED_TOOLS, parseGrokModels } from './reviewers/grok.js';
import { getReviewer, REVIEWER_NAMES } from './reviewers/index.js';
import type { OnLog } from './types.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Collect what a parser logged, so a test can assert on it. */
function recorder(): { log: OnLog; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: ((level, message) => lines.push(`${level}: ${message}`)) as OnLog };
}

// --- argv ---------------------------------------------------------------

test('claude reviewer keeps read-only tool restrictions', () => {
  const args = claudeReviewer.buildArgs('review this', 'opus', '/tmp/checkout');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--disallowed-tools'));
  assert.ok(args.some((a) => a.startsWith('Bash(git diff')));
  assert.equal(args[args.indexOf('-p') + 1], 'review this');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('cursor reviewer runs in plan mode with sandbox', () => {
  const args = cursorReviewer.buildArgs('review this', 'auto', '/tmp/checkout');
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('plan'));
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('enabled'));
  assert.equal(args[args.indexOf('--workspace') + 1], '/tmp/checkout');
  assert.equal(args.at(-1), 'review this');
});

test('codex reviewer runs read-only, with the prompt last', () => {
  const args = codexReviewer.buildArgs('review this', 'gpt-5.5', '/tmp/checkout');
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args[args.indexOf('-C') + 1], '/tmp/checkout');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.5');
  assert.equal(args.at(-1), 'review this');
});

test('grok reviewer runs in plan mode with write tools disallowed', () => {
  const args = grokReviewer.buildArgs('review this', 'grok-4.6', '/tmp/checkout');
  assert.equal(args[args.indexOf('-p') + 1], 'review this');
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-messages-json');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--cwd') + 1], '/tmp/checkout');
  assert.ok(args.includes('--disable-web-search'));
  assert.ok(args.includes('--no-subagents'));
  const disallowed = (args[args.indexOf('--disallowed-tools') + 1] ?? '').split(',');
  for (const tool of ['write', 'search_replace', 'spawn_subagent', 'ask_user_question']) {
    assert.ok(disallowed.includes(tool), `${tool} must be disallowed`);
  }
  assert.deepEqual(disallowed, [...GROK_DISALLOWED_TOOLS]);
});

// --- the Anthropic-style stream (claude, cursor, grok) -------------------

test('anthropic parser logs the init event, text, and tool calls', () => {
  const { log, lines } = recorder();
  parseAnthropicStreamLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'grok-4.6' }), log);
  parseAnthropicStreamLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'looking at the diff' },
        { type: 'tool_use', name: 'read_file', input: { path: 'add.js' } },
      ],
    },
  }), log);
  assert.ok(lines[0]?.includes('model grok-4.6'));
  assert.ok(lines.some((l) => l.includes('looking at the diff')));
  assert.ok(lines.some((l) => l === 'info: tool: read_file add.js'));
  // Thinking is never logged.
  assert.ok(!lines.some((l) => l.includes('ignored')));
});

test('anthropic parser returns the final result', () => {
  const { log } = recorder();
  const ok = parseAnthropicStreamLine(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}' }),
    log,
  );
  assert.deepEqual(ok, { result: '{"ok":true}', isError: false });

  const failed = parseAnthropicStreamLine(
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    log,
  );
  assert.deepEqual(failed, { result: 'boom', isError: true });
});

test('anthropic parser ignores lines that are not JSON', () => {
  const { log, lines } = recorder();
  assert.deepEqual(parseAnthropicStreamLine('not json', log), {});
  assert.equal(lines.length, 0);
});

// --- the codex stream ---------------------------------------------------

test('codex parser logs commands and keeps the last agent message', () => {
  const { log, lines } = recorder();
  parseCodexStreamLine(JSON.stringify({ type: 'thread.started', thread_id: 'x' }), log);
  parseCodexStreamLine(JSON.stringify({
    type: 'item.started',
    item: { id: 'item_0', type: 'command_execution', command: 'git diff', status: 'in_progress' },
  }), log);
  const first = parseCodexStreamLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: 'draft' },
  }), log);
  const last = parseCodexStreamLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: '{"ok":true}' },
  }), log);
  assert.ok(lines.some((l) => l === 'info: tool: command git diff'));
  assert.deepEqual(first, { result: 'draft', isError: false });
  // The runner keeps the most recent result, so the last message wins.
  assert.deepEqual(last, { result: '{"ok":true}', isError: false });
});

test('codex parser ignores reasoning and reports a failed turn', () => {
  const { log, lines } = recorder();
  assert.deepEqual(
    parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'r', type: 'reasoning', text: 'thinking out loud' },
    }), log),
    {},
  );
  assert.equal(lines.length, 0);

  const failed = parseCodexStreamLine(
    JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }),
    log,
  );
  assert.equal(failed.isError, true);
  assert.match(String(failed.result), /usage limit reached/);

  const errored = parseCodexStreamLine(JSON.stringify({ type: 'error', message: 'stream broke' }), log);
  assert.deepEqual(errored, { result: 'stream broke', isError: true });
});

// --- model lists --------------------------------------------------------

const CURSOR_MODELS_TEXT = `Available models

auto - Auto (current, default)
gpt-5.3-codex - Codex 5.3
claude-opus-5-high - Claude Opus 5 1M

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`;

test('cursor model list parser reads "id - Label" lines only', () => {
  const models = parseCursorModels(CURSOR_MODELS_TEXT);
  assert.deepEqual(models[0], { id: 'auto', label: 'Auto (current, default)' });
  assert.deepEqual(models.map((m) => m.id), ['auto', 'gpt-5.3-codex', 'claude-opus-5-high']);
});

const GROK_MODELS_TEXT = `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5`;

test('grok model list parser marks the default model', () => {
  const models = parseGrokModels(GROK_MODELS_TEXT);
  assert.deepEqual(models, [
    { id: 'grok-4.6', label: 'grok-4.6 (default)' },
    { id: 'grok-4.5', label: 'grok-4.5' },
  ]);
});

const CODEX_CACHE_TEXT = JSON.stringify({
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 4 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 2 },
  ],
});

test('codex model cache parser keeps listed models, ordered by priority', () => {
  const models = parseCodexModelsCache(CODEX_CACHE_TEXT);
  assert.deepEqual(models, [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ]);
  assert.deepEqual(parseCodexModelsCache('not json'), []);
});

test('claude offers a static model list', async () => {
  assert.deepEqual(await claudeReviewer.listModels(), CLAUDE_MODELS);
});

// --- failures -----------------------------------------------------------

test('cursor describeFailure explains an ActionRequiredError', () => {
  const hint = cursorReviewer.describeFailure(
    "ActionRequiredError: You've hit your usage limit. Upgrade to Pro.",
    1,
  );
  assert.ok(hint);
  assert.match(hint, /Cursor Agent refused the request/);
  assert.match(hint, /hit your usage limit/);
  assert.match(hint, /login/);
});

test('describeFailure maps a generic auth failure to a login command', () => {
  const hint = grokReviewer.describeFailure('Error: unauthorized (401)', 1);
  assert.ok(hint);
  assert.match(hint, /login/);
  assert.equal(codexReviewer.describeFailure('some unrelated crash', 1), null);
});

// --- registry -----------------------------------------------------------

test('getReviewer rejects unknown names', () => {
  assert.throws(() => getReviewer('openai'), /Unknown reviewer/);
});

test('every reviewer name resolves to a definition of that name', () => {
  assert.deepEqual([...REVIEWER_NAMES], ['claude', 'cursor', 'codex', 'grok']);
  for (const name of REVIEWER_NAMES) assert.equal(getReviewer(name).name, name);
});

/**
 * The config schema and the request body both accept reviewer names; both must
 * derive them from REVIEWER_NAMES instead of repeating the literals. Asserting
 * on the source text keeps this check free of the side effects (database file,
 * env) that importing those modules would bring.
 */
test('config and routes derive their reviewer enum from REVIEWER_NAMES', () => {
  const config = readFileSync(path.join(SRC_DIR, 'config.ts'), 'utf8');
  const routes = readFileSync(path.join(SRC_DIR, 'routes', 'reviews.ts'), 'utf8');
  assert.match(config, /DEFAULT_REVIEWER: z\.enum\(REVIEWER_NAMES\)/);
  assert.match(routes, /reviewer: z\.enum\(REVIEWER_NAMES\)/);
});
