import { config } from '../config.js';
import { claudeReviewer } from './claude.js';
import { codexReviewer } from './codex.js';
import { cursorReviewer } from './cursor.js';
import { grokReviewer } from './grok.js';
import {
  isReviewerName, REVIEWER_NAMES,
  type ModelInfo, type ReviewerDefinition, type ReviewerName,
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

function noModelsMessage(reviewer: ReviewerDefinition): string {
  return reviewer.noModelsMessage?.() ?? `${reviewer.label} lists no models`;
}

/** The reviewer's default model as of now; null when it has none. */
export async function resolveDefaultModel(reviewer: ReviewerDefinition): Promise<string | null> {
  if (reviewer.resolveDefaultModel) return reviewer.resolveDefaultModel();
  return reviewer.defaultModel || null;
}

/**
 * Whether `model` is one the reviewer offers now. A miss re-reads the list
 * once, skipping the in-process cache: the CLI may have refreshed its own
 * list since. Returns the list the decision was made on.
 */
async function lookUpModel(
  reviewer: ReviewerDefinition,
  model: string,
): Promise<{ listed: boolean; models: ModelInfo[] }> {
  let models = await reviewer.listModels();
  if (models.some((m) => m.id === model)) return { listed: true, models };
  models = await reviewer.listModels({ refresh: true });
  return { listed: models.some((m) => m.id === model), models };
}

/** Throws a ModelChoiceError naming the available ids when `model` is not offered. */
export async function assertModelAvailable(reviewer: ReviewerDefinition, model: string): Promise<void> {
  if (reviewer.acceptsUnlistedModels) return;
  const { listed, models } = await lookUpModel(reviewer, model);
  if (listed) return;
  if (models.length === 0) throw new ModelChoiceError(noModelsMessage(reviewer));
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
  if (!fallback) throw new ModelChoiceError(noModelsMessage(reviewer));
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
 * to that reviewer's default (e.g. "opus" must never be handed to codex).
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
  /** The configured default; null when it comes from the CLI (see /api/reviewers). */
  defaultModel: string | null;
  bin: string;
  available: boolean;
  /** True when a model id the list lacks is still accepted (typed by hand). */
  acceptsUnlistedModels: boolean;
}

export interface ReviewerDetail extends ReviewerSummary {
  models: ModelInfo[];
  /** Why no model can be chosen, when `models` is empty and nothing else is accepted. */
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
 * The same list plus each reviewer's models, with the default model resolved
 * against them (null when there is none). Model lists are cached per process.
 */
export async function listReviewersWithModels(): Promise<ReviewerDetail[]> {
  return Promise.all(
    listReviewers().map(async (summary) => {
      const reviewer = lookup(summary.name);
      // Default first: it may re-read an empty list, which the models below then reflect.
      const defaultModel = await resolveDefaultModel(reviewer);
      const models = await reviewer.listModels();
      const empty = models.length === 0 && !reviewer.acceptsUnlistedModels;
      return {
        ...summary,
        defaultModel,
        models,
        noModelsHint: empty ? noModelsMessage(reviewer) : null,
      };
    }),
  );
}

export { REVIEWER_NAMES, isReviewerName };
export type { ModelInfo, ReviewerDefinition, ReviewerName };
