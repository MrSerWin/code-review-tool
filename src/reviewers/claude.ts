import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseAnthropicStreamLine } from './anthropicStream.js';
import { found, nothingFound } from './discovery.js';
import {
  buildBaseChildEnv, dedupeModels, describeAuthFailure, isBinOnPath, MODEL_LIST_TIMEOUT_MS, runCli,
  type CliRunner,
} from './shared.js';
import type { ModelDiscovery, ModelInfo, ReviewerDefinition } from './types.js';

// --- the Anthropic Models API ---------------------------------------------

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const ANTHROPIC_VERSION = '2023-06-01';
/** The largest page the Models API serves. */
const API_PAGE_LIMIT = 1000;
/** A guard against a server that keeps saying `has_more`. */
const API_MAX_PAGES = 20;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Carries the HTTP status only: a response body may echo request details. */
export class ModelsApiError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = 'ModelsApiError';
  }
}

/**
 * Every model the key can use, newest first as the API returns them, through
 * `GET /v1/models` with `after_id` pagination. The key is sent only as the
 * `x-api-key` header and never logged.
 */
export async function fetchAnthropicModels(
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < API_MAX_PAGES; page += 1) {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set('limit', String(API_PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
    } catch (err) {
      const kind = err instanceof Error ? err.name : 'error';
      throw new ModelsApiError(null, `the Anthropic Models API could not be reached (${kind})`);
    }
    if (!res.ok) throw new ModelsApiError(res.status, `the Anthropic Models API answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      data?: unknown; has_more?: unknown; last_id?: unknown;
    } | null;
    const data: unknown[] = Array.isArray(body?.data) ? body.data : [];
    for (const item of data) {
      const m = item as { id?: unknown; display_name?: unknown } | null;
      if (typeof m?.id !== 'string') continue;
      models.push({ id: m.id, label: typeof m.display_name === 'string' ? m.display_name : m.id });
    }
    if (body?.has_more !== true || typeof body.last_id !== 'string') break;
    afterId = body.last_id;
  }
  return dedupeModels(models);
}

// --- the model catalog Claude Code keeps on disk --------------------------

/** Where Claude Code caches the model catalog it fetched for each signed-in account. */
export function claudeModelCatalogDir(home = os.homedir()): string {
  return path.join(home, '.claude', 'cache', 'model-catalog');
}

/** The only catalog layout this parser knows; another version is skipped, not guessed at. */
const CATALOG_VERSION = 2;

interface CatalogModel {
  id: string;
  name: string;
  disabled: boolean;
  minVersion: string | null;
}

export interface ClaudeCatalog {
  fetchedAt: number;
  models: CatalogModel[];
  /** Alias name to the model id it resolves to. */
  aliases: Map<string, string>;
  /** The model the CLI itself selects now, when the catalog says. */
  selected: string | null;
}

/** Parse one catalog file, or null when it is not a version-2 catalog. */
export function parseClaudeCatalog(text: string): ClaudeCatalog | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.version !== CATALOG_VERSION) return null;
  const body = data?.catalog?.config;
  if (!Array.isArray(body?.models)) return null;
  const models: CatalogModel[] = [];
  for (const m of body.models) {
    if (typeof m?.id !== 'string' || !m.id.trim()) continue;
    models.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name : m.id,
      disabled: m.disabled === true,
      minVersion: typeof m.min_claude_code_version === 'string' ? m.min_claude_code_version : null,
    });
  }
  const aliases = new Map<string, string>();
  const targets = body.provider_alias_targets;
  if (targets && typeof targets === 'object') {
    for (const [alias, target] of Object.entries(targets as Record<string, any>)) {
      if (typeof target?.default === 'string') aliases.set(alias, target.default);
    }
  }
  const selected = typeof data.catalog?.state?.model === 'string' ? data.catalog.state.model : null;
  return { fetchedAt: typeof data.fetchedAt === 'number' ? data.fetchedAt : 0, models, aliases, selected };
}

/** True when `have` is at least `need`, both dotted numbers. An unreadable version never blocks. */
export function versionAtLeast(have: string | null, need: string | null): boolean {
  if (!have || !need) return true;
  const a = have.split('.').map(Number);
  const b = need.split('.').map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * What a catalog offers to this CLI version: the CLI's own selected model
 * first (as its alias when one points at it), then each alias ordered as its
 * target is in the catalog and labelled with the model it resolves to now,
 * then every usable full model id in catalog order. Disabled models (not on the
 * account's plan) and models that need a newer CLI are left out.
 */
export function catalogModels(catalog: ClaudeCatalog, cliVersion: string | null): ModelInfo[] {
  const usable = catalog.models.filter((m) => !m.disabled && versionAtLeast(cliVersion, m.minVersion));
  const index = new Map(usable.map((m, i) => [m.id, i]));
  const rank = (id: string): number => (id === catalog.selected ? -1 : index.get(id)!);
  const aliases = [...catalog.aliases.entries()]
    .filter(([, target]) => index.has(target))
    .sort((a, b) => rank(a[1]) - rank(b[1]))
    .map(([alias, target]) => ({
      id: alias,
      label: `${alias} alias (latest: ${usable[index.get(target)!]!.name})`,
    }));
  const full = usable.map((m) => ({ id: m.id, label: m.name }));
  // A selected model no alias points at leads as itself.
  const selected = full.find((m) => m.id === catalog.selected);
  if (selected && !aliases.some((a) => catalog.aliases.get(a.id) === selected.id)) {
    return dedupeModels([selected, ...aliases, ...full]);
  }
  return dedupeModels([...aliases, ...full]);
}

/** The most recently fetched catalog in `dir`, or null when there is none. */
export async function readNewestClaudeCatalog(dir: string): Promise<ClaudeCatalog | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: ClaudeCatalog | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let catalog: ClaudeCatalog | null;
    try {
      catalog = parseClaudeCatalog(await readFile(path.join(dir, name), 'utf8'));
    } catch {
      catalog = null;
    }
    if (catalog && (!newest || catalog.fetchedAt > newest.fetchedAt)) newest = catalog;
  }
  return newest;
}

// --- the --help text ------------------------------------------------------

/**
 * The aliases `claude --help` gives as examples for `--model` (the text reads
 * "an alias for the latest model (e.g. ...) or a model's full name"). The
 * option's description may wrap over several lines.
 */
export function parseClaudeHelpAliases(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => /^\s*--model\s/.test(l));
  if (start < 0) return [];
  const parts = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*-/.test(line)) break;
    parts.push(line.trim());
  }
  const examples = /e\.g\.\s*([^)]*)\)/.exec(parts.join(' '))?.[1] ?? '';
  const aliases = [...examples.matchAll(/['"`]([A-Za-z0-9][A-Za-z0-9._-]*)['"`]/g)].map((m) => m[1]!);
  return [...new Set(aliases)];
}

// --- discovery ------------------------------------------------------------

export interface ClaudeDiscoveryDeps {
  apiKey?: string;
  bin?: string;
  catalogDir?: string;
  run?: CliRunner;
  fetch?: FetchLike;
  installed?: (bin: string) => boolean;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

function cliVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

/**
 * Claude Code has no list command. In order: the Anthropic Models API when
 * ANTHROPIC_API_KEY is set; the model catalog Claude Code caches on disk; the
 * alias examples of `claude --help`. A full model name typed by hand is still
 * accepted, since `--model` documents it.
 */
export async function discoverClaudeModels(deps: ClaudeDiscoveryDeps = {}): Promise<ModelDiscovery> {
  const apiKey = 'apiKey' in deps ? deps.apiKey : config.anthropicApiKey;
  const bin = deps.bin ?? config.claudeBin;
  const run = deps.run ?? runCli;
  const installed = (deps.installed ?? isBinOnPath)(bin);
  const env = buildBaseChildEnv();
  let apiProblem: string | null = null;

  if (apiKey) {
    try {
      const models = await fetchAnthropicModels(apiKey, deps.fetch);
      if (models.length > 0) return found(models, 'api');
      apiProblem = 'the Anthropic Models API listed no models';
    } catch (err) {
      apiProblem = err instanceof Error ? err.message : String(err);
    }
    warnOnce(`Claude model discovery: ${apiProblem}; asking the Claude Code CLI instead.`);
  }

  const catalog = await readNewestClaudeCatalog(deps.catalogDir ?? claudeModelCatalogDir());
  if (catalog) {
    const needsVersion = catalog.models.some((m) => m.minVersion);
    const version = needsVersion && installed ? cliVersion((await run(bin, ['--version'], env)).stdout) : null;
    const models = catalogModels(catalog, version);
    if (models.length > 0) return found(models, 'cli-cache');
  }

  if (installed) {
    const aliases = parseClaudeHelpAliases((await run(bin, ['--help'], env)).stdout);
    if (aliases.length > 0) {
      return found(aliases.map((id) => ({ id, label: `${id} alias (latest)` })), 'cli-help');
    }
  }

  const cli = installed
    ? `run \`${bin}\` once so it caches its model catalog`
    : `install Claude Code (${bin} not found on PATH)`;
  const api = apiProblem
    ? `check ANTHROPIC_API_KEY (${apiProblem})`
    : 'or set ANTHROPIC_API_KEY to list models from the Anthropic API';
  return nothingFound(
    `Claude Code lists no models: ${cli}, ${api}, then refresh models. A full model name can still be typed.`,
  );
}

export const claudeReviewer: ReviewerDefinition = {
  name: 'claude',
  label: 'Claude Code',
  defaultModel: config.reviewModel ?? '',
  defaultModelEnv: 'REVIEW_MODEL',
  acceptsUnlistedModels: true,
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
  discoverModels: () => discoverClaudeModels(),
  isAvailable: () => isBinOnPath(config.claudeBin),
  describeFailure(stderrTail: string): string | null {
    return describeAuthFailure(stderrTail, `${config.claudeBin} login`);
  },
};
