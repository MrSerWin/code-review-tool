import type { OnLog } from '../types.js';

/** Which CLI runs the multi-lens review pipeline. */
export const REVIEWER_NAMES = ['claude', 'cursor', 'codex', 'grok'] as const;
export type ReviewerName = (typeof REVIEWER_NAMES)[number];

/** One selectable model of a reviewer CLI. */
export interface ModelInfo {
  id: string;
  label: string;
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
  readonly defaultModel: string;
  readonly bin: string;
  /** argv before the prompt text */
  buildArgs(prompt: string, model: string, dir: string): string[];
  buildChildEnv(): NodeJS.ProcessEnv;
  /** Parse one line of the CLI's stream, log progress, surface the answer. */
  parseStreamLine(line: string, onLog: OnLog): StreamLineResult;
  /**
   * The models this CLI offers. Asked of the CLI where it can answer, static
   * otherwise. Never throws and never blocks for long: a failure degrades to
   * the static list.
   */
  listModels(): Promise<ModelInfo[]>;
  /** Whether the binary exists on this machine. Cached after the first call. */
  isAvailable(): boolean;
  /** A human hint for a known failure, or null when the failure is unknown. */
  describeFailure(stderrTail: string, exitCode: number | null): string | null;
}

export function isReviewerName(value: string): value is ReviewerName {
  return (REVIEWER_NAMES as readonly string[]).includes(value);
}
