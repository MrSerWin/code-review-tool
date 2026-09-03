export type ReviewStatus = 'queued' | 'fetching' | 'reviewing' | 'done' | 'failed' | 'cancelled';
export type Verdict = 'approve' | 'changes_requested' | 'blocked';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type RequirementStatus = 'met' | 'partial' | 'missing' | 'not_verifiable';

export interface TicketInfo {
  /** Which tracker produced this ticket, or 'manual' for pasted requirements. */
  provider: string;
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
  reviewer: string | null;
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

/** Non-blocking remark from a lens pass. Never affects the verdict. */
export interface Observation {
  id: number;
  review_id: number;
  file: string | null;
  line: number | null;
  note: string;
  rationale: string | null;
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
  observations: Observation[];
  logs: LogLine[];
  comparison: RunComparison | null;
}

/** How this run's findings differ from the previous run of the same branch. */
export interface RunComparison {
  previousRunId: number;
  previousRunIndex: number;
  resolved: ComparedFinding[];
  new: ComparedFinding[];
  persistent: ComparedFinding[];
}

export interface ComparedFinding {
  severity: Severity;
  title: string;
  file: string | null;
  line: number | null;
  problem: string;
}

export interface Health {
  ok: boolean;
  version: string;
  dockerImage: string;
  /** Names of the trackers that are configured; never any credential. */
  trackers: string[];
  reviewers: ReviewerInfo[];
  defaultReviewer: string;
  repos: number;
  previews?: PreviewsSummary;
}

/** One model a reviewer CLI can be pointed at. */
export interface ModelInfo {
  id: string;
  label: string;
}

export interface ReviewerInfo {
  name: string;
  label: string;
  defaultModel: string;
  bin: string;
  /** Whether the reviewer's CLI was found on the server. */
  available: boolean;
  /** Only served by /api/reviewers; /api/health omits it to stay cheap. */
  models?: ModelInfo[];
}

/** Response of GET /api/reviewers. */
export interface ReviewersPayload {
  reviewers: ReviewerInfo[];
  defaultReviewer: string;
}

export interface PreviewsSummary {
  enabled: boolean;
  recipes: string[];
  running: number;
  queued: number;
}

export type PreviewStatus =
  | 'queued' | 'preparing' | 'starting' | 'ready'
  | 'stopping' | 'stopped' | 'failed' | 'expired';

/** How the preview database was populated. */
export type DumpMode = 'dump-dir' | 'pg_dump' | 'clean';

/** What the caller may ask for; the engine resolves 'auto' to one of the above. */
export type DumpModeRequest = 'auto' | 'dump-dir' | 'pg_dump' | 'none' | 'clean';

/** One repository taking part in a preview. */
export interface PreviewRole {
  role: string;
  repo: string;
  branch: string;
  base: string;
  /** True when the repo had no branch of its own and its base branch is used. */
  usedBase: boolean;
}

export interface Preview {
  id: number;
  review_id: number | null;
  recipe: string;
  ticket_key: string | null;
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
  /** Decorated by the API from roles_json / ports_json. */
  roles: PreviewRole[];
  ports: Record<string, number>;
  /** 1-based place in the queue, 0 when not waiting. */
  queuePosition: number;
}

export interface PreviewLogLine {
  id: number;
  preview_id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PreviewDetailPayload {
  preview: Preview;
  logs: PreviewLogLine[];
}

export interface RecipePort {
  id: string;
  internal: number;
  primary: boolean;
}

export interface RecipeDatabase {
  engine: string;
  version: string | null;
  mode: string;
  onFailure: string;
  hasDumpDir: boolean;
  hasPgDump: boolean;
}

export interface Recipe {
  name: string;
  description: string | null;
  roles: { role: string; repo: string }[];
  ports: RecipePort[];
  database: RecipeDatabase | null;
  readyTimeoutSec: number;
  credentialsHint: string | null;
}

export interface RecipesPayload {
  enabled: boolean;
  dir: string;
  recipes: Recipe[];
  errors: { name: string; file: string; error: string }[];
}

export type PreviewSseEvent =
  | { type: 'log'; previewId: number; level?: string; message?: string; ts?: string }
  | { type: 'status'; previewId: number; status: PreviewStatus };

export type SseEvent =
  | { type: 'log'; reviewId: number; level?: string; message?: string; ts?: string }
  | { type: 'status'; reviewId: number; status: ReviewStatus }
  | { type: 'done'; reviewId: number; status?: ReviewStatus };
