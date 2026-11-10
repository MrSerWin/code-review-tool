import { config } from '../config.js';
import { parseAnthropicStreamLine } from './anthropicStream.js';
import {
  buildBaseChildEnv, dedupeModels, describeAuthFailure, discoverFromCliCommand, firstLine,
  isBinOnPath, type CliRunner,
} from './shared.js';
import type { ModelDiscovery, ModelInfo, ReviewerDefinition } from './types.js';

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
    const model = { id: match[1]!, label: match[2]!.trim() };
    // The CLI marks its own default in the label; it goes first, so it is ours too.
    if (/\bdefault\b/i.test(model.label)) models.unshift(model);
    else models.push(model);
  }
  return dedupeModels(models);
}

/** `cursor-agent --list-models`; nothing listed is an empty list with a hint, never a guess. */
export function discoverCursorModels(run?: CliRunner, installed?: (bin: string) => boolean): Promise<ModelDiscovery> {
  return discoverFromCliCommand({
    label: 'Cursor Agent',
    bin: config.cursorBin,
    args: ['--list-models'],
    env: cursorReviewer.buildChildEnv(),
    parse: parseCursorModels,
    login: `run \`${config.cursorBin} login\` or set CURSOR_API_KEY`,
    run,
    installed,
  });
}

export const cursorReviewer: ReviewerDefinition = {
  name: 'cursor',
  label: 'Cursor Agent',
  defaultModel: config.cursorReviewModel ?? '',
  defaultModelEnv: 'CURSOR_REVIEW_MODEL',
  bin: config.cursorBin,
  buildChildEnv: () => {
    const extra: Record<string, string> = {};
    if (config.cursorApiKey) extra.CURSOR_API_KEY = config.cursorApiKey;
    return buildBaseChildEnv(extra);
  },
  buildArgs(prompt: string, model: string, dir: string): string[] {
    // No `--approve-mcps`: in --print mode an MCP server only loads once it is
    // approved for the workspace, and every review runs in a fresh checkout
    // directory nobody has approved anything for. So no MCP server (this tool's
    // own code-review server included) is available to the run.
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
  discoverModels: () => discoverCursorModels(),
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
