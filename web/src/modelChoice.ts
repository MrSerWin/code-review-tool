import { readStored, removeStored } from './storage';
import type { ReviewerInfo } from './types';

/** Shown when a reviewer offers no model at all and the server gave no hint. */
export const NO_MODELS = 'No models available';

/** True when the reviewer can take `model`: it lists it, or takes ids it does not list. */
export function modelOffered(info: ReviewerInfo | undefined, model: string): boolean {
  if (!info) return true;
  if (info.acceptsUnlistedModels) return true;
  return (info.models ?? []).some((m) => m.id === model);
}

/**
 * The model to preselect: `candidate` (remembered, or an earlier run's) while
 * the reviewer still offers it, else the reviewer's resolved default, else
 * nothing. Without a model list (the server answered without one), the
 * candidate is kept.
 */
export function pickModel(info: ReviewerInfo | undefined, candidate: string | null | undefined): string {
  const value = candidate?.trim() ?? '';
  if (value && (!info?.models || modelOffered(info, value))) return value;
  return info?.defaultModel ?? '';
}

/** The remembered model for this reviewer; one it no longer offers is forgotten. */
export function rememberedModel(info: ReviewerInfo | undefined, key: string): string {
  const stored = readStored(key);
  const picked = pickModel(info, stored);
  if (stored !== null && picked !== stored.trim()) removeStored(key);
  return picked;
}

/** Why nothing can be picked, or null when the reviewer has a model to run. */
export function noModelsNotice(info: ReviewerInfo | undefined): string | null {
  if (!info?.models || info.acceptsUnlistedModels) return null;
  if (info.models.length > 0 || info.defaultModel) return null;
  return info.noModelsHint ? `${NO_MODELS}. ${info.noModelsHint}` : NO_MODELS;
}
