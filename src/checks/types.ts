import type { ChangedFile, Finding, Observation } from '../types.js';

/** A tree to compare against, read with `git ls-tree` in `dir` (never checked out). */
export interface TreeRef {
  /** Shown in findings, e.g. `base commit`, `main (local clone)`, `sibling feat/x`. */
  label: string;
  /** A git work tree or repository to read from. */
  dir: string;
  /** A commit-ish inside `dir`. */
  ref: string;
}

/** Another branch of the same ticket group. */
export interface SiblingBranch {
  repo: string;
  branch: string;
  /** Where its tree can be read, or null when nothing of it is on disk. */
  tree: TreeRef | null;
}

/** Everything a check may read. Checks only read: no write, no checkout, no fetch. */
export interface CheckContext {
  repo: string;
  /** The host-side review checkout at HEAD. */
  checkoutDir: string;
  baseSha: string;
  headSha: string;
  changedFiles: readonly ChangedFile[];
  /** The tip of the base branch as fetched, when known (a commit in the checkout). */
  baseTip: TreeRef | null;
  /** The default branch tip as last fetched, when it can be read. */
  defaultBranch: TreeRef | null;
  siblings: readonly SiblingBranch[];
  /** Commits that are not the author's own work, such as a working-tree snapshot commit. */
  syntheticCommits: readonly string[];
}

/** A tool finding before anchor validation; `lens` is set by the runner. */
export type ToolFinding = Omit<Finding, 'lens' | 'anchor_status'>;
export type ToolObservation = Omit<Observation, 'lens'>;

export interface CheckResult {
  findings: ToolFinding[];
  observations: ToolObservation[];
  /** Run-log lines: what the check could not read, what it skipped. */
  notes?: string[];
}

export interface ToolCheck<C> {
  id: string;
  run(ctx: CheckContext, config: C): Promise<CheckResult>;
}

/** A finding at a changed line, with the fields a tool does not use filled in. */
export function toolFinding(fields: Pick<ToolFinding, 'severity' | 'category' | 'title' | 'problem'> & Partial<ToolFinding>): ToolFinding {
  return {
    file: null,
    line: null,
    end_line: null,
    why: '',
    suggestion: '',
    snippet: null,
    kind: 'diff',
    cause_file: null,
    cause_line: null,
    hunk: null,
    ...fields,
  };
}

export const EMPTY_RESULT: CheckResult = Object.freeze({ findings: [], observations: [] }) as CheckResult;
