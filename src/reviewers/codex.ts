import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseCodexStreamLine } from './codexStream.js';
import {
  buildBaseChildEnv, cachedModels, dedupeModels, describeAuthFailure, isBinOnPath,
} from './shared.js';
import type { ModelInfo, ReviewerDefinition } from './types.js';

/** Where the CLI keeps the model list it last fetched. */
export function codexModelsCachePath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(home, 'models_cache.json');
}

/**
 * Parse `~/.codex/models_cache.json`. Only models marked `visibility: "list"`
 * are offered — the others are internal (`gpt-reserve`, the auto-review model)
 * and picking one is not a choice a reviewer should make. The cache carries no
 * "default" flag, so ordering is by `priority`, and the first one is the
 * default unless `CODEX_REVIEW_MODEL` picks another listed one.
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

/** What a caller is told when the CLI has not written its model cache yet. */
export function codexNoModelsMessage(bin = config.codexBin): string {
  return `Codex has no model list yet: run \`${bin} login\` or \`${bin}\` once, then retry`;
}

/**
 * The default among the listed models: `configured` when it is one of them,
 * else the first. A configured id the list lacks is reported through `warn`
 * and ignored, since the CLI would refuse it.
 */
export function pickCodexDefault(
  models: ModelInfo[],
  configured: string | undefined,
  warn: (message: string) => void = () => {},
): string | null {
  const first = models[0]?.id ?? null;
  const wanted = configured?.trim();
  if (!wanted) return first;
  if (models.some((m) => m.id === wanted)) return wanted;
  if (first) {
    warn(
      `CODEX_REVIEW_MODEL=${wanted} is not in the Codex model list (${models.map((m) => m.id).join(', ')}); ` +
        `using ${first} instead.`,
    );
  }
  return first;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

async function readCodexModels(): Promise<ModelInfo[]> {
  try {
    return parseCodexModelsCache(await readFile(codexModelsCachePath(), 'utf8'));
  } catch {
    return [];
  }
}

export const codexReviewer: ReviewerDefinition = {
  name: 'codex',
  label: 'OpenAI Codex',
  defaultModel: config.codexReviewModel ?? '',
  bin: config.codexBin,
  // CODEX_HOME is where the model list above comes from, so the review must
  // use the same home (login, models) or it would silently fall back to
  // ~/.codex. Only this reviewer gets it: it is not in the shared passthrough.
  buildChildEnv: () => {
    const home = process.env.CODEX_HOME?.trim();
    return buildBaseChildEnv(home ? { CODEX_HOME: home } : {});
  },
  buildArgs(prompt: string, model: string, dir: string): string[] {
    // `-s read-only` is what makes the run read-only: the sandbox refuses every
    // write and every network call. `--ephemeral` keeps the run out of the
    // CLI's session history, `--skip-git-repo-check` allows a bare checkout.
    // `--ignore-user-config` skips `$CODEX_HOME/config.toml`, and with it every
    // `[mcp_servers]` entry (this tool's own code-review server included) and
    // plugin; authentication still comes from CODEX_HOME. The user's default
    // model and reasoning effort are skipped too: `-m` names the model.
    return [
      'exec',
      '--json',
      '-s', 'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-C', dir,
      '-m', model,
      prompt,
    ];
  },
  parseStreamLine: parseCodexStreamLine,
  // No invented fallback: a model the CLI did not list may well be refused
  // (an old id is, on a ChatGPT login), so an empty list means "no model yet".
  listModels: (opts) => cachedModels('codex', readCodexModels, opts?.refresh),
  async resolveDefaultModel(): Promise<string | null> {
    let models = await codexReviewer.listModels();
    if (models.length === 0) models = await codexReviewer.listModels({ refresh: true });
    return pickCodexDefault(models, config.codexReviewModel, warnOnce);
  },
  noModelsMessage: () => codexNoModelsMessage(),
  isAvailable: () => isBinOnPath(config.codexBin),
  describeFailure(stderrTail: string): string | null {
    return describeAuthFailure(stderrTail, `${config.codexBin} login`);
  },
};
