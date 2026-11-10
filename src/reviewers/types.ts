import type { OnLog } from '../types.js';

/** Which CLI runs the multi-lens review pipeline. */
export const REVIEWER_NAMES = ['claude', 'cursor', 'codex', 'grok'] as const;
export type ReviewerName = (typeof REVIEWER_NAMES)[number];

/** One selectable model of a reviewer CLI. */
export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * Where a model list came from: a list command of the CLI, a catalog file the
 * CLI keeps on disk, the CLI's own `--help` text, or the vendor's API.
 */
export type ModelSource = 'cli' | 'cli-cache' | 'cli-help' | 'api';

/** One discovery of a reviewer's models. */
export interface ModelDiscovery {
  models: ModelInfo[];
  /** Null when nothing was found. */
  source: ModelSource | null;
  /** Epoch milliseconds. */
  fetchedAt: number;
  /** When `models` is empty: what to do so the list fills (install, log in, set a key). */
  hint: string | null;
}

/** What one line of a reviewer's JSON stream contributed. */
export interface StreamLineResult {
  /** The final answer, once the stream reports it. */
  result?: string;
  /** True when that final answer is a failure, not an answer. */
  isError?: boolean;
}

export interface ReviewerDefinition {
  readonly name: ReviewerName;
  readonly label: string;
  /**
   * The model the environment asks for (`defaultModelEnv`), or '' when unset.
   * The default actually used is resolved against the discovered models.
   */
  readonly defaultModel: string;
  /** The environment key that sets `defaultModel`, for warnings. */
  readonly defaultModelEnv: string;
  readonly bin: string;
  /**
   * True when the CLI takes model ids it does not list (Claude Code resolves
   * full model ids typed by hand), so a requested model is not checked
   * against the discovered list.
   */
  readonly acceptsUnlistedModels?: boolean;
  /** argv before the prompt text */
  buildArgs(prompt: string, model: string, dir: string): string[];
  buildChildEnv(): NodeJS.ProcessEnv;
  /** Parse one line of the CLI's stream, log progress, surface the answer. */
  parseStreamLine(line: string, onLog: OnLog): StreamLineResult;
  /**
   * Ask the CLI (or the vendor API) which models it offers right now. Never
   * throws: a failure is an empty list with a hint. Uncached; callers go
   * through `discovery.ts`, which keeps the result for a while.
   */
  discoverModels(): Promise<ModelDiscovery>;
  /** Whether the binary exists on this machine. Cached after the first call. */
  isAvailable(): boolean;
  /** A human hint for a known failure, or null when the failure is unknown. */
  describeFailure(stderrTail: string, exitCode: number | null): string | null;
}

export function isReviewerName(value: string): value is ReviewerName {
  return (REVIEWER_NAMES as readonly string[]).includes(value);
}
