export type ReviewStatus = 'queued' | 'fetching' | 'reviewing' | 'done' | 'failed' | 'cancelled';
export type Verdict = 'approve' | 'changes_requested' | 'blocked';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type RequirementStatus = 'met' | 'partial' | 'missing' | 'not_verifiable';

export interface TicketInfo {
  key: string;
  title: string;
  url: string;
  body: string;
  state: string;
  branchName: string | null;
  comments: { author: string; body: string }[];
  attachmentUrls: string[];
}

export interface ResolvedTarget {
  repo: string;
  branch: string;
  baseBranch: string;
  prNumber: number | null;
}

export interface Review {
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

export interface Finding {
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

export interface Requirement {
  id: number;
  review_id: number;
  text: string;
  status: RequirementStatus;
  evidence: string | null;
  ord: number;
}

export interface LogLine {
  id: number;
  review_id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ReviewDetailPayload {
  review: Review;
  requirements: Requirement[];
  findings: Finding[];
  logs: LogLine[];
}

export interface Health {
  ok: boolean;
  version: string;
  dockerImage: string;
  linear: boolean;
}

export type SseEvent =
  | { type: 'log'; reviewId: number; level?: string; message?: string; ts?: string }
  | { type: 'status'; reviewId: number; status: ReviewStatus }
  | { type: 'done'; reviewId: number; status?: ReviewStatus };
