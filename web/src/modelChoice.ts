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

/** Where the reviewer's model list came from, for a hint under the picker. */
const SOURCE_TEXT: Record<string, string> = {
  cli: 'its list command',
  'cli-cache': 'the model catalog the CLI keeps on disk',
  'cli-help': 'the CLI help text (aliases for the latest models)',
  api: 'the vendor API',
};

/** "Models from ... at 14:05", or null when the server sent no source. */
export function modelSourceText(info: ReviewerInfo | undefined): string | null {
  if (!info?.source || !info.models?.length) return null;
  const from = SOURCE_TEXT[info.source] ?? info.source;
  const at = info.fetchedAt ? new Date(info.fetchedAt) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? ` at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  const typed = info.acceptsUnlistedModels ? '; a full model name can be typed too' : '';
  return `${info.label} models from ${from}${when}${typed}`;
}

/**
 * True when the run cannot start: no model to fall back on, and none typed
 * that the reviewer would take.
 */
export function runBlocked(info: ReviewerInfo | undefined, model: string): boolean {
  if (!noModelsNotice(info)) return false;
  return !(info?.acceptsUnlistedModels && model.trim());
}

/** Why nothing can be picked, or null when the reviewer has a model to run. */
export function noModelsNotice(info: ReviewerInfo | undefined): string | null {
  if (!info?.models) return null;
  if (info.models.length > 0 || info.defaultModel) return null;
  return info.noModelsHint ? `${NO_MODELS}. ${info.noModelsHint}` : NO_MODELS;
}
