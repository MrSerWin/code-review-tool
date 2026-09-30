import { config } from '../config.js';
import { parseAnthropicStreamLine } from './anthropicStream.js';
import {
  buildBaseChildEnv, cachedModels, dedupeModels, describeAuthFailure, isBinOnPath, runCli,
} from './shared.js';
import type { ModelInfo, ReviewerDefinition } from './types.js';

/**
 * Every Grok tool that could change the checkout, reach the network on its own,
 * spawn another agent, or stop and ask the user something. Read-only work needs
 * none of them; `run_terminal_command` stays enabled because the review reads
 * the diff with git.
 */
export const GROK_DISALLOWED_TOOLS = [
  'write',
  'search_replace',
  'spawn_subagent',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  // The three scheduler tools are one group: removing only create and delete
  // makes the CLI refuse to start the session ("Requirements unsatisfied"),
  // so scheduler_list goes with them.
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'workflow',
  'ask_user_question',
  // MCP tools are only reachable through these two dispatchers. Grok has no
  // flag to skip MCP servers for one run, and it loads the ones configured for
  // Claude Code and Cursor too (this tool's own code-review server included),
  // so the dispatchers go: no review can call an MCP tool.
  'search_tool',
  'use_tool',
] as const;

/** Permission deny rules: every MCP tool, whatever server it comes from. */
export const GROK_DENY_RULES = ['mcp__*'] as const;

/**
 * Stop Grok from importing the MCP servers configured for Claude Code, Cursor,
 * and the organization. `grok inspect` honours these; headless runs of Grok
 * 1.0.13 were seen to connect the Claude-sourced servers anyway, which is why
 * the dispatcher tools and the deny rule above are what actually guard a run.
 */
export const GROK_MCP_OFF_ENV: Record<string, string> = {
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_MANAGED_MCPS_ENABLED: 'false',
};

/** Used when `grok models` cannot be reached. */
export const GROK_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'grok-4.7', label: 'grok-4.7 (default)' },
  { id: 'grok-4.5', label: 'grok-4.5' },
];

/**
 * Parse `grok models`, which prints `Default model: <id>` and then one
 * `  * <id> (default)` / `  - <id>` line per model.
 */
export function parseGrokModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^[*-]\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\(default\))?$/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    models.push({ id, label: match[2] ? `${id} (default)` : id });
  }
  return dedupeModels(models);
}

export const grokReviewer: ReviewerDefinition = {
  name: 'grok',
  label: 'Grok CLI',
  defaultModel: config.grokReviewModel,
  bin: config.grokBin,
  buildChildEnv: () => buildBaseChildEnv(GROK_MCP_OFF_ENV),
  buildArgs(prompt: string, model: string, dir: string): string[] {
    // `--permission-mode plan` plus the disallowed-tools list is what keeps the
    // run read-only; web search is off so the review only sees the checkout.
    // The MCP dispatchers are disallowed and every MCP tool is denied, so no
    // MCP server can be used from a review.
    return [
      '-p', prompt,
      '--output-format', 'streaming-messages-json',
      '--permission-mode', 'plan',
      '--cwd', dir,
      '--disable-web-search',
      '--no-subagents',
      '--model', model,
      '--disallowed-tools', GROK_DISALLOWED_TOOLS.join(','),
      ...GROK_DENY_RULES.flatMap((rule) => ['--deny', rule]),
    ];
  },
  parseStreamLine: parseAnthropicStreamLine,
  listModels: () =>
    cachedModels('grok', async () => {
      if (!isBinOnPath(config.grokBin)) return GROK_FALLBACK_MODELS;
      const out = await runCli(config.grokBin, ['models'], grokReviewer.buildChildEnv());
      const models = parseGrokModels(out.stdout);
      return models.length > 0 ? models : GROK_FALLBACK_MODELS;
    }),
  isAvailable: () => isBinOnPath(config.grokBin),
  describeFailure(stderrTail: string): string | null {
    return describeAuthFailure(stderrTail, `${config.grokBin} login`);
  },
};
