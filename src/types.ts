export type ReviewStatus = 'queued' | 'fetching' | 'reviewing' | 'done' | 'failed' | 'cancelled';
export type Verdict = 'approve' | 'changes_requested' | 'blocked';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type RequirementStatus = 'met' | 'partial' | 'missing' | 'not_verifiable';

/** The independent review passes that run before synthesis. */
export const LENS_NAMES = ['correctness', 'security', 'tests', 'contracts', 'regressions'] as const;
export type LensName = (typeof LENS_NAMES)[number];

export interface TicketInfo {
  /** Which tracker produced this ticket, or 'manual' for pasted requirements. */
  provider: string;
  key: string; title: string; url: string; body: string;
  state: string; branchName: string | null;
  comments: { author: string; body: string }[];
  attachmentUrls: string[];
}

/** Where the reviewed branch comes from: GitHub, or a local clone (unpushed work). */
export type ReviewSource = 'github' | 'local';

/** How the base of a local review was picked: the detected parent, picked by the user, or the default branch. */
export type BaseReason = 'parent' | 'chosen' | 'default';

export interface ResolvedTarget {
  repo: string; branch: string; baseBranch: string; prNumber: number | null;
  /** Absent means 'github'. */
  source?: ReviewSource;
  /** Local targets only: apply the clone's uncommitted changes on top of the branch. */
  includeWorkingTree?: boolean;
  /** Local targets: how `baseBranch` was picked. */
  baseReason?: BaseReason;
  /** Local targets with a detected base: commits of the branch the base lacks. */
  baseDistance?: number;
}

/**
 * How a finding relates to the diff. `diff`: the anchor is a changed line.
 * The others anchor at an untouched site that the diff affects, and name the
 * changed line that causes it in `cause_file` / `cause_line`.
 */
export const FINDING_KINDS = ['diff', 'regression', 'stale_doc', 'consumer'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * What the post-synthesis check found about a finding's `file` / `line` at
 * HEAD. `unverified`: not checked (no location, or a row older than the check).
 */
export const ANCHOR_STATUSES = ['ok', 'off_diff', 'missing_path', 'line_out_of_range', 'unverified'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

/** One file of `git diff <base>..HEAD`, renames resolved to the new path. */
export interface ChangedFile {
  path: string;
  /** git's status letter: A, M, D, R, C, T. */
  status: string;
  /** The pre-rename path of an R or C entry, else null. */
  old_path: string | null;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
}

export interface CheckoutResult {
  dir: string; headSha: string; baseSha: string;
  filesChanged: number; additions: number; deletions: number;
  /** HEAD-side paths of every changed file, in `changedFileList` order. */
  changedFiles: string[];
  /** The same files with status and rename source; absent on hand-built results. */
  changedFileList?: ChangedFile[];
  /** Local targets: a synthetic commit holding the uncommitted changes, when one was added. */
  workingTreeSnapshot?: { sha: string; files: number } | null;
}

/**
 * A remark a reviewer would leave as a PR comment but would not block a merge
 * on. Observations never influence `verdict` or `can_merge`.
 */
export interface Observation {
  file: string | null;
  line: number | null;
  note: string;
  rationale: string;
}

export interface Finding {
  severity: Severity;
  category: string;
  file: string | null;
  line: number | null;
  end_line: number | null;
  title: string;
  problem: string;
  why: string;
  suggestion: string;
  snippet: string | null;
  kind: FindingKind;
  /** For a non-diff kind: the changed line that causes the finding. */
  cause_file: string | null;
  cause_line: number | null;
  /** The diff hunk header (`@@ -a,b +c,d @@`) a diff finding sits in, when given. */
  hunk: string | null;
  /** The lens whose candidate (and anchor) synthesis kept, when known. */
  lens: LensName | null;
  /** Set by anchor validation after synthesis; lens output carries none. */
  anchor_status?: AnchorStatus;
}

/** The exact JSON one lens pass must return: candidates, not verdicts. */
export interface LensOutput {
  findings: Finding[];
  observations: Observation[];
}

// The exact JSON the synthesis pass must return.
export interface ReviewOutput {
  summary: string;
  requirements: { text: string; status: RequirementStatus; evidence: string }[];
  findings: Finding[];
  observations: Observation[];
  verdict: Verdict;
  can_merge: boolean;
  conclusion: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Mirrors a row of the `reviews` table. */
export interface ReviewRow {
  id: number;
  ticket_key: string | null;
  ticket_title: string | null;
  ticket_url: string | null;
  ticket_body: string | null;
  repo: string;
  branch: string;
  base_branch: string;
  head_sha: string | null;
  base_sha: string | null;
  pr_number: number | null;
  source: ReviewSource;
  /** 1 when the clone's uncommitted changes were requested (local reviews only). */
  working_tree: number;
  /** Local reviews: how base_branch was picked; null for GitHub reviews and older rows. */
  base_reason: BaseReason | null;
  run_index: number;
  status: ReviewStatus;
  verdict: Verdict | null;
  can_merge: number | null;
  summary: string | null;
  requirements_met: number | null;
  requirements_total: number | null;
  blocking_count: number | null;
  report_path: string | null;
  reviewer: string | null;
  model: string | null;
  error: string | null;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /**
   * What the history groups this run under: the ticket key, else a ticket-like
   * key from the branch name, else `repo#branch`. Derived (see groupKey.ts).
   */
  group_key: string | null;
  /**
   * The process that enqueued the run and holds it in its in-memory queue,
   * with that process's start time (see processOwnership.ts). NULL on rows
   * written before ownership was recorded.
   */
  runner_pid: number | null;
  runner_started_at: string | null;
  /** JSON array of the reviewer processes running for it: `{ pgid, bin, spawnedAt }`. */
  reviewer_pgids: string | null;
}

/** `active`: a run is queued/fetching/reviewing; `failed`: some branch's latest run failed; `done`: see db.ts. */
export type GroupStatusFilter = 'active' | 'failed' | 'done';

/** The latest run of one branch of a review group. */
export interface ReviewGroupRun {
  id: number;
  run_index: number;
  status: ReviewStatus;
  verdict: Verdict | null;
  can_merge: number | null;
  reviewer: string | null;
  model: string | null;
  created_at: string;
}

export interface ReviewGroupBranch {
  repo: string;
  branch: string;
  /** Source of the latest run; local and GitHub runs of one repo/branch share a run sequence. */
  source: ReviewSource;
  /** The newest pull request number any run of this branch in the group knew. */
  prNumber: number | null;
  latest: ReviewGroupRun;
}

/** One row of `GET /api/review-groups`. */
export interface ReviewGroup {
  key: string;
  title: string | null;
  ticketUrl: string | null;
  /** False only for the `repo#branch` fallback. */
  isTicket: boolean;
  lastActivity: string;
  runCount: number;
  activeCount: number;
  /** One entry per repo/branch, most recently active first. */
  branches: ReviewGroupBranch[];
}

/** Mirrors a row of the `findings` table. */
export interface FindingRow {
  id: number;
  review_id: number;
  severity: Severity;
  category: string | null;
  file: string | null;
  line: number | null;
  end_line: number | null;
  title: string;
  problem: string;
  why: string | null;
  suggestion: string | null;
  snippet: string | null;
  /** 'diff' on rows written before kinds existed. */
  kind: FindingKind;
  cause_file: string | null;
  cause_line: number | null;
  hunk: string | null;
  /** 'unverified' on rows written before anchor validation existed. */
  anchor_status: AnchorStatus;
  lens: LensName | null;
  ord: number;
}

/** Mirrors a row of the `review_files` table: one changed file of a review. */
export interface ReviewFileRow extends ChangedFile {
  review_id: number;
  ord: number;
}

/** Mirrors a row of the `observations` table. */
export interface ObservationRow {
  id: number;
  review_id: number;
  file: string | null;
  line: number | null;
  note: string;
  rationale: string | null;
  ord: number;
}

/** Mirrors a row of the `requirements` table. */
export interface RequirementRow {
  id: number;
  review_id: number;
  text: string;
  status: RequirementStatus;
  evidence: string | null;
  ord: number;
}

/** Mirrors a row of the `review_logs` table. */
export interface LogRow {
  id: number;
  review_id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

export type OnLog = (level: LogLevel, message: string) => void;

// --- preview environments ---

export type PreviewStatus =
  | 'queued' | 'preparing' | 'starting' | 'ready'
  | 'stopping' | 'stopped' | 'failed' | 'expired';

/** How the preview database was populated. */
export type DumpMode = 'dump-dir' | 'pg_dump' | 'clean';

/** One repository taking part in a preview. */
export interface PreviewRole {
  role: string;
  repo: string;
  branch: string;
  base: string;
  /** True when the repo had no branch for this ticket and its base branch is used. */
  usedBase: boolean;
  /** 'local' when the branch is copied from the local clone (possibly unpushed); absent means 'github'. */
  source?: ReviewSource;
  /** The commit the preview runs, recorded once the checkout exists. */
  sha?: string;
}

/** Mirrors a row of the `previews` table. */
export interface PreviewRow {
  id: number;
  review_id: number | null;
  recipe: string;
  ticket_key: string | null;
  /** JSON-encoded `PreviewRole[]`. */
  roles_json: string;
  /** JSON-encoded `Record<string, number>` of logical port id to host port. */
  ports_json: string;
  url: string | null;
  db_name: string | null;
  dump_mode: DumpMode | null;
  dump_source: string | null;
  status: PreviewStatus;
  error: string | null;
  credentials_hint: string | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
  stopped_at: string | null;
}

/** Mirrors a row of the `preview_logs` table. */
export interface PreviewLogRow {
  id: number;
  preview_id: number;
  ts: string;
  level: LogLevel;
  message: string;
}
