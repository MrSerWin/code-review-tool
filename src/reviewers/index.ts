import { config } from '../config.js';
import { logger } from '../logger.js';
import { claudeReviewer } from './claude.js';
import { codexReviewer } from './codex.js';
import { cursorReviewer } from './cursor.js';
import { discoverModels, pickDefaultModel } from './discovery.js';
import { grokReviewer } from './grok.js';
import {
  isReviewerName, REVIEWER_NAMES,
  type ModelDiscovery, type ModelInfo, type ModelSource, type ReviewerDefinition, type ReviewerName,
} from './types.js';

const REVIEWERS: Record<ReviewerName, ReviewerDefinition> = {
  claude: claudeReviewer,
  cursor: cursorReviewer,
  codex: codexReviewer,
  grok: grokReviewer,
};

const overrides = new Map<ReviewerName, ReviewerDefinition>();

/** Only for tests: answer `name` with `definition` (null restores the real one). */
export function setReviewerForTests(name: ReviewerName, definition: ReviewerDefinition | null): void {
  if (definition) overrides.set(name, definition);
  else overrides.delete(name);
}

function lookup(name: ReviewerName): ReviewerDefinition {
  return overrides.get(name) ?? REVIEWERS[name];
}

export function getReviewer(name: string | null | undefined): ReviewerDefinition {
  const key = (name ?? config.defaultReviewer).toLowerCase();
  if (!isReviewerName(key)) {
    throw new Error(
      `Unknown reviewer: ${JSON.stringify(name)}. Use one of: ${REVIEWER_NAMES.join(', ')}.`,
    );
  }
  return lookup(key);
}

export function defaultReviewer(): ReviewerDefinition {
  return getReviewer(config.defaultReviewer);
}

/** The message a caller gets when it asks for a reviewer that is not installed. */
export function notInstalledMessage(reviewer: ReviewerDefinition): string {
  return `${reviewer.label} is not installed: ${reviewer.bin} not found on PATH`;
}

/** A model that cannot be used: the caller gets a 400 (or a tool error), nothing is queued. */
export class ModelChoiceError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ModelChoiceError';
  }
}

function noModelsMessage(reviewer: ReviewerDefinition, discovery: ModelDiscovery): string {
  return discovery.hint ?? `${reviewer.label} lists no models`;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

/** The reviewer's discovered models (cached for a while; `refresh` asks again now). */
export function reviewerModels(
  reviewer: ReviewerDefinition,
  opts: { refresh?: boolean } = {},
): Promise<ModelDiscovery> {
  return discoverModels(reviewer, opts);
}

/**
 * The reviewer's default model as of now, null when it has none: the
 * configured one while it is listed (or while the CLI takes unlisted ids),
 * else the first discovered model. An empty cached list is asked again once.
 */
export async function resolveDefaultModel(reviewer: ReviewerDefinition): Promise<string | null> {
  let discovery = await reviewerModels(reviewer);
  if (discovery.models.length === 0) discovery = await reviewerModels(reviewer, { refresh: true });
  return pickDefaultModel(discovery.models, reviewer.defaultModel, {
    label: reviewer.label,
    envName: reviewer.defaultModelEnv,
    acceptsUnlisted: reviewer.acceptsUnlistedModels,
  }, warnOnce);
}

/**
 * Whether `model` is one the reviewer offers now. A miss re-reads the list
 * once, skipping the in-process cache: the CLI may have refreshed its own
 * list since. Returns the discovery the decision was made on.
 */
async function lookUpModel(
  reviewer: ReviewerDefinition,
  model: string,
): Promise<{ listed: boolean; discovery: ModelDiscovery }> {
  let discovery = await reviewerModels(reviewer);
  if (discovery.models.some((m) => m.id === model)) return { listed: true, discovery };
  discovery = await reviewerModels(reviewer, { refresh: true });
  return { listed: discovery.models.some((m) => m.id === model), discovery };
}

/** Throws a ModelChoiceError naming the available ids when `model` is not offered. */
export async function assertModelAvailable(reviewer: ReviewerDefinition, model: string): Promise<void> {
  if (reviewer.acceptsUnlistedModels) return;
  const { listed, discovery } = await lookUpModel(reviewer, model);
  if (listed) return;
  const { models } = discovery;
  if (models.length === 0) throw new ModelChoiceError(noModelsMessage(reviewer, discovery));
  throw new ModelChoiceError(
    `Model ${JSON.stringify(model)} is not available for ${reviewer.label}. ` +
      `Available: ${models.map((m) => m.id).join(', ')}.`,
  );
}

/**
 * The model a run uses. A `requested` model (named by the caller) must be
 * offered, or this throws. An `inherited` one (carried over from an earlier
 * run) is used while it is still offered and otherwise replaced by the
 * default, reported through `onFallback`. With neither, the default; no
 * default at all throws.
 */
export async function chooseModel(
  reviewer: ReviewerDefinition,
  opts: { requested?: string | null; inherited?: string | null; onFallback?: (message: string) => void } = {},
): Promise<string> {
  const requested = opts.requested?.trim();
  if (requested) {
    await assertModelAvailable(reviewer, requested);
    return requested;
  }
  const inherited = opts.inherited?.trim();
  if (inherited) {
    if (reviewer.acceptsUnlistedModels || (await lookUpModel(reviewer, inherited)).listed) return inherited;
  }
  const fallback = await resolveDefaultModel(reviewer);
  if (!fallback) throw new ModelChoiceError(noModelsMessage(reviewer, await reviewerModels(reviewer)));
  if (inherited) {
    opts.onFallback?.(`model ${inherited} is no longer offered by ${reviewer.label}; using ${fallback}`);
  }
  return fallback;
}

/** A reviewer whose CLI is missing has no model list either; say what is actually wrong. */
async function chooseFor(
  reviewer: ReviewerDefinition,
  opts: Parameters<typeof chooseModel>[1],
): Promise<string> {
  try {
    return await chooseModel(reviewer, opts);
  } catch (err) {
    if (err instanceof ModelChoiceError && !reviewer.isAvailable()) throw new ModelChoiceError(notInstalledMessage(reviewer));
    throw err;
  }
}

/** Reviewer and model of a new run: both named by the caller, or the defaults. */
export async function resolveStartChoice(
  reviewerName: string | null | undefined,
  model: string | null | undefined,
): Promise<{ reviewer: ReviewerDefinition; model: string }> {
  const reviewer = getReviewer(reviewerName);
  return { reviewer, model: await chooseFor(reviewer, { requested: model }) };
}

/**
 * Which reviewer and model a re-run uses. An explicit choice wins; otherwise
 * the previous run's reviewer carries over. The previous model only carries
 * over while the reviewer stays the same and still offers it: a model id
 * belongs to one CLI, so switching reviewer without naming a model falls back
 * to that reviewer's default (a Claude alias must never be handed to codex).
 */
export async function resolveRerunChoice(
  previous: { reviewer: string | null; model: string | null },
  override: { reviewer?: string; model?: string } = {},
): Promise<{ reviewer: ReviewerDefinition; model: string }> {
  const reviewer = getReviewer(override.reviewer ?? previous.reviewer);
  if (override.model) return { reviewer, model: await chooseFor(reviewer, { requested: override.model }) };
  const previousName = (previous.reviewer ?? config.defaultReviewer).toLowerCase();
  const sameReviewer = previousName === reviewer.name;
  return {
    reviewer,
    model: await chooseFor(reviewer, { inherited: sameReviewer ? previous.model : null }),
  };
}

export interface ReviewerSummary {
  name: ReviewerName;
  label: string;
  /** The configured default (`*_REVIEW_MODEL`); null when unset. /api/reviewers resolves it. */
  defaultModel: string | null;
  bin: string;
  available: boolean;
  /** True when a model id the list lacks is still accepted (typed by hand). */
  acceptsUnlistedModels: boolean;
}

export interface ReviewerDetail extends ReviewerSummary {
  models: ModelInfo[];
  /** Where `models` came from; null when nothing was found. */
  source: ModelSource | null;
  /** When the list was discovered (ISO 8601). */
  fetchedAt: string;
  /** What to do so the list fills, when `models` is empty. */
  noModelsHint: string | null;
}

/** Cheap: no CLI is started, so this is safe on a health check. */
export function listReviewers(): ReviewerSummary[] {
  return REVIEWER_NAMES.map((name) => {
    const reviewer = lookup(name);
    return {
      name,
      label: reviewer.label,
      defaultModel: reviewer.defaultModel || null,
      bin: reviewer.bin,
      available: reviewer.isAvailable(),
      acceptsUnlistedModels: Boolean(reviewer.acceptsUnlistedModels),
    };
  });
}

/**
 * The same list plus each reviewer's discovered models, where they came
 * from, and the default resolved against them (null when there is none).
 * Discoveries are cached per process; `refresh` discovers every list again.
 */
export async function listReviewersWithModels(opts: { refresh?: boolean } = {}): Promise<ReviewerDetail[]> {
  return Promise.all(
    listReviewers().map(async (summary) => {
      const reviewer = lookup(summary.name);
      if (opts.refresh) await reviewerModels(reviewer, { refresh: true });
      // Default first: it may re-read an empty list, which the discovery below then reflects.
      const defaultModel = await resolveDefaultModel(reviewer);
      const discovery = await reviewerModels(reviewer);
      return {
        ...summary,
        defaultModel,
        models: discovery.models,
        source: discovery.source,
        fetchedAt: new Date(discovery.fetchedAt).toISOString(),
        noModelsHint: discovery.models.length === 0 ? noModelsMessage(reviewer, discovery) : null,
      };
    }),
  );
}

export { REVIEWER_NAMES, isReviewerName };
export type { ModelDiscovery, ModelInfo, ModelSource, ReviewerDefinition, ReviewerName };
