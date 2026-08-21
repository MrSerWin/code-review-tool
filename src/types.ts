export type ReviewStatus = 'queued' | 'fetching' | 'reviewing' | 'done' | 'failed' | 'cancelled';
export type Verdict = 'approve' | 'changes_requested' | 'blocked';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type RequirementStatus = 'met' | 'partial' | 'missing' | 'not_verifiable';

/** The independent review passes that run before synthesis. */
export const LENS_NAMES = ['correctness', 'security', 'tests', 'contracts', 'regressions'] as const;
export type LensName = (typeof LENS_NAMES)[number];

export interface TicketInfo {
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
