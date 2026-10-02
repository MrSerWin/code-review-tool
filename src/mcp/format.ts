/**
 * Pure helpers that turn API payloads into the compact shapes the MCP tools
 * return. Agents pay for every token, so everything here is trimmed: long text
 * is truncated, lists are capped, and fields an agent cannot act on are dropped.
 *
 * Type-only imports from `../types.js` are erased at build time, so this module
 * pulls in nothing that reads configuration or secrets.
 */
import type {
  FindingRow, LogRow, RequirementRow, ReviewGroup, ReviewRow, ReviewStatus, Severity,
} from '../types.js';

export const TERMINAL_STATUSES: readonly ReviewStatus[] = ['done', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly ReviewStatus[] = ['queued', 'fetching', 'reviewing'];
export const ALL_STATUSES: readonly ReviewStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Cut `text` to at most `max` characters, marking the cut. Null stays null. */
export function truncate(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export const DEFAULT_MAX_FINDINGS = 50;
export const FINDING_TEXT_MAX = 300;
export const SUMMARY_MAX = 1_500;

/** `file:line`, `file:line-end`, `file`, or null when a finding has no location. */
export function findingLocation(f: Pick<FindingRow, 'file' | 'line' | 'end_line'>): string | null {
  if (!f.file) return null;
  if (f.line === null || f.line === undefined) return f.file;
  if (f.end_line && f.end_line !== f.line) return `${f.file}:${f.line}-${f.end_line}`;
  return `${f.file}:${f.line}`;
}

export interface CompactFinding {
  severity: Severity;
  title: string;
  location: string | null;
  problem: string | null;
}

/**
 * Most severe first (stable within a severity), capped at `max`. Returns how
 * many were left out so the caller can say so.
 */
export function compactFindings(
  findings: readonly FindingRow[],
  max = DEFAULT_MAX_FINDINGS,
  textMax = FINDING_TEXT_MAX,
): { findings: CompactFinding[]; omitted: number } {
  const sorted = findings
    .map((f, index) => ({ f, index }))
    .sort((a, b) =>
      ((SEVERITY_RANK[a.f.severity] ?? 9) - (SEVERITY_RANK[b.f.severity] ?? 9)) || (a.index - b.index))
    .map(({ f }) => f);
  const kept = sorted.slice(0, Math.max(0, max));
  return {
    findings: kept.map((f) => ({
      severity: f.severity,
      title: truncate(f.title, 160) ?? '',
      location: findingLocation(f),
      problem: truncate(f.problem, textMax),
    })),
    omitted: sorted.length - kept.length,
  };
}

export function severityCounts(findings: readonly Pick<FindingRow, 'severity'>[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) if (f.severity in counts) counts[f.severity] += 1;
  return counts;
}

/** One review in the fewest fields that identify it: what start/list/cancel return. */
export interface ReviewRef {
  id: number;
  status: ReviewStatus;
  ticket: string | null;
  repo: string;
  branch: string;
  base: string;
  source: string;
  reviewer: string | null;
  model: string | null;
  url: string;
}

export function reviewRef(row: ReviewRow, url: string): ReviewRef {
  return {
    id: row.id,
    status: row.status,
    ticket: row.ticket_key,
    repo: row.repo,
    branch: row.branch,
    base: row.base_branch,
    source: row.source ?? 'github',
    reviewer: row.reviewer,
    model: row.model,
    url,
  };
}

/** A row of `list_reviews`: the reference plus the outcome, when there is one. */
export function reviewListRow(row: ReviewRow, url: string): ReviewRef & {
  verdict: string | null;
  can_merge: boolean | null;
  blocking_count: number | null;
  created_at: string;
  finished_at: string | null;
} {
  return {
    ...reviewRef(row, url),
    verdict: row.verdict,
    can_merge: row.can_merge === null || row.can_merge === undefined ? null : row.can_merge === 1,
    blocking_count: row.blocking_count,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

export const DEFAULT_GROUP_BRANCHES = 20;

/** A row of `list_review_groups`: the group, its counts, and the latest run of each branch. */
export function compactGroup(
  group: ReviewGroup,
  urlFor: (id: number) => string,
  maxBranches = DEFAULT_GROUP_BRANCHES,
) {
  const branches = group.branches.slice(0, maxBranches);
  return {
    key: group.key,
    is_ticket: group.isTicket,
    title: truncate(group.title, 160),
    ticket_url: group.ticketUrl || null,
    last_activity: group.lastActivity,
    runs: group.runCount,
    active: group.activeCount,
    branches: branches.map((b) => ({
      repo: b.repo,
      branch: b.branch,
      source: b.source ?? 'github',
      latest: {
        id: b.latest.id,
        run: b.latest.run_index,
        status: b.latest.status,
        verdict: b.latest.verdict,
        can_merge: b.latest.can_merge === null || b.latest.can_merge === undefined ? null : b.latest.can_merge === 1,
        reviewer: b.latest.reviewer,
        model: b.latest.model,
        created_at: b.latest.created_at,
        url: urlFor(b.latest.id),
      },
    })),
    ...(group.branches.length > branches.length ? { branches_omitted: group.branches.length - branches.length } : {}),
  };
}

/** What `GET /api/reviews/:id` returns (the parts the MCP uses). */
export interface ReviewDetailPayload {
  review: ReviewRow;
  requirements?: RequirementRow[];
  findings?: FindingRow[];
  logs?: LogRow[];
}

export interface ReviewDetailOptions {
  maxFindings?: number;
  textMax?: number;
}

/** The compact status + outcome of one review, for `get_review` and `wait_for_review`. */
export function reviewDetail(payload: ReviewDetailPayload, url: string, opts: ReviewDetailOptions = {}) {
  const { review } = payload;
  const findings = payload.findings ?? [];
  const requirements = payload.requirements ?? [];
  const done = review.status === 'done';
  const compact = compactFindings(findings, opts.maxFindings ?? DEFAULT_MAX_FINDINGS, opts.textMax ?? FINDING_TEXT_MAX);
  const lastLog = payload.logs && payload.logs.length > 0 ? payload.logs[payload.logs.length - 1] : undefined;

  const unmet = requirements
    .filter((r) => r.status !== 'met')
    .slice(0, 20)
    .map((r) => ({ status: r.status, text: truncate(r.text, 200) }));

  return {
    ...reviewRef(review, url),
    ticket_title: truncate(review.ticket_title, 160),
    terminal: isTerminalStatus(review.status),
    // Only a finished review has an outcome; before that these are null.
    verdict: done ? review.verdict : null,
    can_merge: done && review.can_merge !== null ? review.can_merge === 1 : null,
    summary: done ? truncate(review.summary, SUMMARY_MAX) : null,
    requirements: done
      ? { met: review.requirements_met ?? 0, total: review.requirements_total ?? 0, unmet }
      : null,
    blocking_count: done ? review.blocking_count ?? 0 : null,
    severity_counts: done ? severityCounts(findings) : null,
    findings: done ? compact.findings : [],
    findings_omitted: done ? compact.omitted : 0,
    diff: review.files_changed !== null && review.files_changed !== undefined
      ? { files: review.files_changed, additions: review.additions ?? 0, deletions: review.deletions ?? 0 }
      : null,
    // While a review runs, its latest log line is the only sign of progress.
    progress: isActiveStatus(review.status) && lastLog ? truncate(lastLog.message, 200) : null,
    error: truncate(review.error, 1_000),
    report_path: review.report_path,
    created_at: review.created_at,
    finished_at: review.finished_at,
  };
}

export type ReviewDetail = ReturnType<typeof reviewDetail>;

export const DEFAULT_REPORT_MAX = 40_000;

/** Cut a Markdown report to `max` characters with a note saying where the rest is. */
export function truncateReport(markdown: string, max: number, fullUrl: string): string {
  if (markdown.length <= max) return markdown;
  return `${markdown.slice(0, max)}\n\n…[truncated: showing the first ${max} of ${markdown.length} characters. ` +
    `Full report: ${fullUrl}]`;
}

// --- reviewers and local repositories --------------------------------------

interface ReviewerPayload {
  name: string;
  label: string;
  defaultModel: string;
  available: boolean;
  models?: { id: string; label?: string }[];
}

export function compactReviewers(payload: { reviewers: ReviewerPayload[]; defaultReviewer: string }, maxModels = 40) {
  return {
    default_reviewer: payload.defaultReviewer,
    reviewers: payload.reviewers.map((r) => ({
      name: r.name,
      label: r.label,
      available: r.available,
      default_model: r.defaultModel,
      models: (r.models ?? []).slice(0, maxModels).map((m) => m.id),
    })),
  };
}

interface LocalBranchPayload {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  unpushed: boolean;
  lastCommit?: { sha: string; subject: string; date: string };
}

interface LocalRepoPayload {
  repo: string;
  path: string;
  currentBranch: string | null;
  baseBranch: string | null;
  dirty: boolean;
  branches: LocalBranchPayload[];
}

export const DEFAULT_MAX_BRANCHES = 30;

export function compactLocalRepos(
  payload: { repos: LocalRepoPayload[]; unavailable?: { repo: string; reason: string }[] },
  opts: { repo?: string; maxBranches?: number } = {},
) {
  const maxBranches = opts.maxBranches ?? DEFAULT_MAX_BRANCHES;
  const repos = payload.repos.filter((r) => !opts.repo || r.repo === opts.repo);
  return {
    repos: repos.map((r) => ({
      repo: r.repo,
      path: r.path,
      current_branch: r.currentBranch,
      default_base: r.baseBranch,
      dirty: r.dirty,
      // The API lists the checked-out branch first, then by most recent commit.
      branches: r.branches.slice(0, maxBranches).map((b) => ({
        name: b.name,
        unpushed: b.unpushed,
        ahead: b.ahead,
        behind: b.behind,
        upstream: b.upstream,
        last_commit: b.lastCommit
          ? { date: b.lastCommit.date, subject: truncate(b.lastCommit.subject, 80) }
          : null,
      })),
      branches_omitted: Math.max(0, r.branches.length - maxBranches),
    })),
    unavailable: (payload.unavailable ?? []).filter((u) => !opts.repo || u.repo === opts.repo),
  };
}

// --- target selection -------------------------------------------------------

export interface TargetSelector {
  repo: string;
  branch: string;
}

/** `repo#branch` or `{ repo, branch }` → a selector; anything else is an error. */
export function parseTargetSelector(value: string | TargetSelector): TargetSelector {
  if (typeof value !== 'string') return { repo: value.repo.trim(), branch: value.branch.trim() };
  const at = value.indexOf('#');
  const repo = at > 0 ? value.slice(0, at).trim() : '';
  const branch = at > 0 ? value.slice(at + 1).trim() : '';
  if (!repo || !branch) throw new Error(`Invalid target "${value}": expected "repo#branch".`);
  return { repo, branch };
}

/** Keep the resolved targets the selectors name; report selectors that matched nothing. */
export function selectTargets<T extends TargetSelector>(
  resolved: readonly T[],
  selectors: readonly TargetSelector[],
): { chosen: T[]; unmatched: TargetSelector[] } {
  const chosen = resolved.filter((t) => selectors.some((s) => s.repo === t.repo && s.branch === t.branch));
  const unmatched = selectors.filter((s) => !resolved.some((t) => s.repo === t.repo && s.branch === t.branch));
  return { chosen, unmatched };
}

// --- recursion guard --------------------------------------------------------

/** Set by the review runner in every reviewer CLI's environment. */
export const REVIEWER_ENV_FLAG = 'CODE_REVIEW_TOOL_REVIEWER';

/**
 * Why a tool that starts, re-runs, or cancels reviews must refuse, or null when
 * it may proceed. A reviewer CLI spawned by this tool must never drive it: a
 * review could start more reviews from inside itself. Read-only tools stay
 * available.
 */
export function mutationRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = (env[REVIEWER_ENV_FLAG] ?? '').trim();
  if (!flag || flag === '0' || /^false$/i.test(flag)) return null;
  return 'Refused: this MCP server is running inside a code-review-tool reviewer ' +
    `(${REVIEWER_ENV_FLAG} is set). Reviews cannot start, re-run, or cancel reviews.`;
}
