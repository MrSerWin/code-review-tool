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

export interface ResolvedTarget {
  repo: string; branch: string; baseBranch: string; prNumber: number | null;
}

export interface CheckoutResult {
  dir: string; headSha: string; baseSha: string;
  filesChanged: number; additions: number; deletions: number;
  changedFiles: string[];
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
  run_index: number;
  status: ReviewStatus;
  verdict: Verdict | null;
  can_merge: number | null;
  summary: string | null;
  requirements_met: number | null;
  requirements_total: number | null;
  blocking_count: number | null;
  report_path: string | null;
  model: string | null;
  error: string | null;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
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
