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

export function getReviewer(name: string | null | undefined): ReviewerDefinition {
  const key = (name ?? config.defaultReviewer).toLowerCase();
  if (!isReviewerName(key)) {
    throw new Error(
      `Unknown reviewer: ${JSON.stringify(name)}. Use one of: ${REVIEWER_NAMES.join(', ')}.`,
    );
  }
  return REVIEWERS[key];
}

export function defaultReviewer(): ReviewerDefinition {
  return getReviewer(config.defaultReviewer);
}

/** The message a caller gets when it asks for a reviewer that is not installed. */
export function notInstalledMessage(reviewer: ReviewerDefinition): string {
  return `${reviewer.label} is not installed: ${reviewer.bin} not found on PATH`;
}

/**
 * Which reviewer and model a re-run uses. An explicit choice wins; otherwise
 * the previous run's reviewer carries over. The previous model only carries
 * over while the reviewer stays the same: a model id belongs to one CLI, so
 * switching reviewer without naming a model falls back to that reviewer's
 * default (e.g. "opus" must never be handed to codex).
 */
export function resolveRerunChoice(
  previous: { reviewer: string | null; model: string | null },
  override: { reviewer?: string; model?: string } = {},
): { reviewer: ReviewerDefinition; model: string } {
  const reviewer = getReviewer(override.reviewer ?? previous.reviewer);
  if (override.model) return { reviewer, model: override.model };
  const previousName = (previous.reviewer ?? config.defaultReviewer).toLowerCase();
  const sameReviewer = previousName === reviewer.name;
  return {
    reviewer,
    model: sameReviewer && previous.model ? previous.model : reviewer.defaultModel,
  };
}

export interface ReviewerSummary {
  name: ReviewerName;
  label: string;
  defaultModel: string;
  bin: string;
  available: boolean;
}

export interface ReviewerDetail extends ReviewerSummary {
  models: ModelInfo[];
}

/** Cheap: no CLI is started, so this is safe on a health check. */
export function listReviewers(): ReviewerSummary[] {
  return REVIEWER_NAMES.map((name) => {
    const reviewer = REVIEWERS[name];
    return {
      name,
      label: reviewer.label,
      defaultModel: reviewer.defaultModel,
      bin: reviewer.bin,
      available: reviewer.isAvailable(),
    };
  });
}

/** The same list plus each reviewer's models. Model lists are cached per process. */
export async function listReviewersWithModels(): Promise<ReviewerDetail[]> {
  return Promise.all(
    listReviewers().map(async (summary) => ({
      ...summary,
      models: await REVIEWERS[summary.name].listModels(),
    })),
  );
}

export { REVIEWER_NAMES, isReviewerName };
export type { ModelInfo, ReviewerDefinition, ReviewerName };
