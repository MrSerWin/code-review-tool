import { config } from '../config.js';
import { parseAnthropicStreamLine } from './anthropicStream.js';
import { buildBaseChildEnv, describeAuthFailure, isBinOnPath } from './shared.js';
import type { ModelInfo, ReviewerDefinition } from './types.js';

/**
 * Claude Code has no "list models" command. These aliases always resolve to the
 * current models; a full model id typed by hand is accepted too, which is why
 * the UI keeps the field free text.
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'Opus (most capable)' },
  { id: 'sonnet', label: 'Sonnet (balanced)' },
  { id: 'haiku', label: 'Haiku (fastest)' },
];

export const claudeReviewer: ReviewerDefinition = {
  name: 'claude',
  label: 'Claude Code',
  defaultModel: config.reviewModel,
  bin: config.claudeBin,
  buildChildEnv: () => buildBaseChildEnv(),
  buildArgs(prompt: string, model: string, dir: string): string[] {
    return [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowed-tools', 'Read', 'Grep', 'Glob',
      'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
      '--disallowed-tools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'WebFetch', 'WebSearch', 'Task',
      '--add-dir', dir,
      // No --mcp-config is passed, so this loads no MCP server at all: not the
      // user's (including this tool's own code-review server), not a plugin's,
      // and not a `.mcp.json` shipped in the reviewed repository.
      '--strict-mcp-config',
    ];
  },
  parseStreamLine: parseAnthropicStreamLine,
  listModels: async () => CLAUDE_MODELS,
  isAvailable: () => isBinOnPath(config.claudeBin),
  describeFailure(stderrTail: string): string | null {
    return describeAuthFailure(stderrTail, `${config.claudeBin} login`);
  },
};
