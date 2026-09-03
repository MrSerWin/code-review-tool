import { config } from '../config.js';
import { parseAnthropicStreamLine } from './anthropicStream.js';
import {
  buildBaseChildEnv, cachedModels, dedupeModels, describeAuthFailure, firstLine,
  isBinOnPath, runCli,
} from './shared.js';
import type { ModelInfo, ReviewerDefinition } from './types.js';

/** Used when `cursor-agent --list-models` cannot be reached. */
export const CURSOR_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'auto', label: 'Auto (default)' },
];

/**
 * Parse `cursor-agent --list-models`: a header, then one `id - Label` line per
 * model, then a trailing tip. Anything that is not `id - Label` is skipped.
 */
export function parseCursorModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    models.push({ id: match[1]!, label: match[2]!.trim() });
  }
  return dedupeModels(models);
}

export const cursorReviewer: ReviewerDefinition = {
  name: 'cursor',
  label: 'Cursor Agent',
  defaultModel: config.cursorReviewModel,
  bin: config.cursorBin,
  buildChildEnv: () => {
    const extra: Record<string, string> = {};
    if (config.cursorApiKey) extra.CURSOR_API_KEY = config.cursorApiKey;
    return buildBaseChildEnv(extra);
  },
  buildArgs(prompt: string, model: string, dir: string): string[] {
    return [
      '--print',
      '--trust',
      '--output-format', 'stream-json',
      '--mode', 'plan',
      '--sandbox', 'enabled',
      '--model', model,
      '--workspace', dir,
      prompt,
    ];
  },
  parseStreamLine: parseAnthropicStreamLine,
  listModels: () =>
    cachedModels('cursor', async () => {
      if (!isBinOnPath(config.cursorBin)) return CURSOR_FALLBACK_MODELS;
      const out = await runCli(config.cursorBin, ['--list-models'], cursorReviewer.buildChildEnv());
      const models = parseCursorModels(out.stdout);
      return models.length > 0 ? models : CURSOR_FALLBACK_MODELS;
    }),
  isAvailable: () => isBinOnPath(config.cursorBin),
  describeFailure(stderrTail: string): string | null {
    const refusal = /ActionRequiredError:\s*(.*)/.exec(stderrTail);
    if (refusal) {
      const message = firstLine(refusal[1] ?? '').replace(/\s+$/, '') || 'no details given';
      return `Cursor Agent refused the request: ${message}. ` +
        `Check your Cursor plan/usage or run \`${config.cursorBin} login\`.`;
    }
    return describeAuthFailure(stderrTail, `${config.cursorBin} login`);
  },
};
