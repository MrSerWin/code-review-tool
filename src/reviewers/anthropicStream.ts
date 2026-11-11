import type { OnLog } from '../types.js';
import type { StreamLineResult } from './types.js';

const MAX_LOG_CHARS = 600;

/**
 * Parse one line of the Anthropic-style `stream-json` protocol. Claude Code,
 * Cursor Agent, and the Grok CLI all emit the same event shapes:
 * `system`/`init`, `assistant` messages with content blocks, `user` tool
 * results, and a final `result` event carrying the answer.
 */
export function parseAnthropicStreamLine(line: string, onLog: OnLog): StreamLineResult {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof event !== 'object' || event === null) return {};
  const e = event as Record<string, any>;

  switch (e.type) {
    case 'system':
      if (e.subtype === 'init') onLog('info', `Reviewer started (model ${e.model ?? 'default'})`);
      return {};
    case 'thinking':
      return {};
    case 'assistant': {
      const content = e.message?.content;
      if (!Array.isArray(content)) return {};
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const text = logProse(block.text);
          if (text) onLog('info', truncate(text, MAX_LOG_CHARS));
        } else if (block?.type === 'tool_use') {
          onLog('info', `tool: ${block.name}${describeToolInput(block.input)}`);
        }
      }
      return {};
    }
    case 'result': {
      if (typeof e.result === 'string') {
        return { result: e.result, isError: e.is_error === true || e.subtype !== 'success' };
      }
      return { result: '', isError: true };
    }
    default:
      return {};
  }
}

export function describeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  // Every key the four CLIs use for "what this tool call is about".
  const hint = i.file_path ?? i.path ?? i.absolute_path ?? i.target_file
    ?? i.pattern ?? i.query ?? i.command;
  return typeof hint === 'string' ? ` ${truncate(hint, 160)}` : '';
}

/**
 * The part of an assistant message worth a log line. A pass ends with its
 * structured answer, which the page renders once parsed, so the JSON payload
 * (a ```json block, closed or not, or a message that is only a JSON object)
 * stays out of the log; the answer itself still reaches the runner untouched.
 */
export function logProse(text: string): string {
  const prose = text.replace(/```json[^\n]*\n[\s\S]*?(?:```|$)/gi, '').trim();
  return /^\{[\s\S]*\}$/.test(prose) ? '' : prose;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export { MAX_LOG_CHARS };
