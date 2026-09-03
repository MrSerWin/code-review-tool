import type { OnLog } from '../types.js';
import type { StreamLineResult } from './types.js';
import { MAX_LOG_CHARS, truncate } from './anthropicStream.js';

/**
 * Parse one line of `codex exec --json`. Codex speaks its own JSONL: a thread
 * and turn envelope around `item.started` / `item.completed` events, and no
 * single "result" event — the answer is the text of the last `agent_message`
 * item, which is why every one of them is reported as a result. Unknown item
 * types are ignored rather than treated as failures: the CLI adds new ones.
 */
export function parseCodexStreamLine(line: string, onLog: OnLog): StreamLineResult {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof event !== 'object' || event === null) return {};
  const e = event as Record<string, any>;

  switch (e.type) {
    case 'thread.started':
      onLog('info', 'Reviewer started');
      return {};
    case 'turn.started':
    case 'turn.completed':
      return {};
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return handleItem(e.type, e.item, onLog);
    case 'turn.failed': {
      const message = messageOf(e.error) ?? messageOf(e) ?? 'the turn failed';
      return { result: message, isError: true };
    }
    case 'error': {
      const message = messageOf(e) ?? 'unknown error';
      return { result: message, isError: true };
    }
    default:
      return {};
  }
}

function handleItem(eventType: string, item: unknown, onLog: OnLog): StreamLineResult {
  if (typeof item !== 'object' || item === null) return {};
  const it = item as Record<string, any>;

  switch (it.type) {
    case 'command_execution':
      // Log the command once, when it starts, so a long run still shows progress.
      if (eventType === 'item.started' && typeof it.command === 'string') {
        onLog('info', `tool: command ${truncate(it.command, 160)}`);
      }
      return {};
    case 'file_change': {
      // Read-only reviews must not change files; report it instead of hiding it.
      if (eventType !== 'item.completed') return {};
      const paths = Array.isArray(it.changes)
        ? it.changes.map((c: any) => c?.path).filter((p: unknown) => typeof p === 'string').join(', ')
        : '';
      onLog('warn', `tool: file_change${paths ? ` ${truncate(paths, 160)}` : ''}`);
      return {};
    }
    case 'reasoning':
      return {};
    case 'agent_message': {
      if (eventType !== 'item.completed') return {};
      if (typeof it.text !== 'string') return {};
      const text = it.text.trim();
      if (text) onLog('info', truncate(text, MAX_LOG_CHARS));
      // The last agent_message of the run is the answer; the runner keeps the
      // most recent result it was handed.
      return { result: it.text, isError: false };
    }
    case 'error': {
      const message = messageOf(it) ?? 'unknown error';
      return { result: message, isError: true };
    }
    default:
      return {};
  }
}

function messageOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason', 'text']) {
    const found = v[key];
    if (typeof found === 'string' && found.trim()) return found;
  }
  return null;
}
