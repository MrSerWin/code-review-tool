import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { parseCodexStreamLine } from './codexStream.js';
import {
  buildBaseChildEnv, cachedModels, dedupeModels, describeAuthFailure, isBinOnPath,
} from './shared.js';
import type { ModelInfo, ReviewerDefinition } from './types.js';

/** Used when the models cache is missing or unreadable. */
export const CODEX_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

/** Where the CLI keeps the model list it last fetched. */
export function codexModelsCachePath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(home, 'models_cache.json');
}

/**
 * Parse `~/.codex/models_cache.json`. Only models marked `visibility: "list"`
 * are offered — the others are internal (`gpt-reserve`, the auto-review model)
 * and picking one is not a choice a reviewer should make. The cache carries no
 * "default" flag, so ordering is by `priority` and the configured default model
 * stays whatever `CODEX_REVIEW_MODEL` says.
 */
export function parseCodexModelsCache(text: string): ModelInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const raw = (data as { models?: unknown })?.models;
  if (!Array.isArray(raw)) return [];

  const listed = raw
    .filter((m): m is Record<string, any> => typeof m === 'object' && m !== null)
    .filter((m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug.trim())
    .map((m, index) => ({
      id: String(m.slug),
      label: typeof m.display_name === 'string' && m.display_name.trim()
        ? String(m.display_name)
        : String(m.slug),
      priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER,
      index,
    }));

  listed.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
  return dedupeModels(listed.map(({ id, label }) => ({ id, label })));
}

export const codexReviewer: ReviewerDefinition = {
  name: 'codex',
  label: 'OpenAI Codex',
  defaultModel: config.codexReviewModel,
  bin: config.codexBin,
  buildChildEnv: () => buildBaseChildEnv(),
  buildArgs(prompt: string, model: string, dir: string): string[] {
    // `-s read-only` is what makes the run read-only: the sandbox refuses every
    // write and every network call. `--ephemeral` keeps the run out of the
    // CLI's session history, `--skip-git-repo-check` allows a bare checkout.
    return [
      'exec',
      '--json',
      '-s', 'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '-C', dir,
      '-m', model,
      prompt,
    ];
  },
  parseStreamLine: parseCodexStreamLine,
  listModels: () =>
    cachedModels('codex', async () => {
      try {
        const text = await readFile(codexModelsCachePath(), 'utf8');
        const models = parseCodexModelsCache(text);
        return models.length > 0 ? models : CODEX_FALLBACK_MODELS;
      } catch {
        return CODEX_FALLBACK_MODELS;
      }
    }),
  isAvailable: () => isBinOnPath(config.codexBin),
  describeFailure(stderrTail: string): string | null {
    return describeAuthFailure(stderrTail, `${config.codexBin} login`);
  },
};
