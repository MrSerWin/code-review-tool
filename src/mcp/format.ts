/**
 * Pure helpers that turn API payloads into the compact shapes the MCP tools
 * return. Agents pay for every token, so everything here is trimmed: long text
 * is truncated, lists are capped, and fields an agent cannot act on are dropped.
 *
 * Type-only imports from `../types.js` are erased at build time, so this module
 * pulls in nothing that reads configuration or secrets.
 */
import type {
  AnchorStatus, ContractIssue, CoverageRequirement, CoverageStatus, CoverageVerdict, FindingKind, FindingRow, FindingSource, LogRow,
  ParentReason,
  PreviewRole, PreviewStatus, RequirementRow, ReviewGroup, ReviewRow, ReviewSource, ReviewStatus, Severity, Verdict,
} from '../types.js';
import { isSatisfied, type Attribution, type AttributionCounts, type TicketCoverageBadge } from '../coverageView.js';

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
  /** `diff`, or the kind of untouched site the location is (regression, stale_doc, consumer). */
  kind: FindingKind;
  /** For a non-diff kind: the changed line that causes it, as `file:line`. */
  cause: string | null;
  /** How the location checked out at HEAD; `unverified` on rows older than the check. */
  anchor_status: AnchorStatus;
  /** The lens the finding came from; `tool` for a deterministic tool check; null when unknown. */
  lens: FindingSource | null;
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
      kind: f.kind ?? 'diff',
      cause: f.cause_file ? findingLocation({ file: f.cause_file, line: f.cause_line, end_line: null }) : null,
      anchor_status: f.anchor_status ?? 'unverified',
      lens: f.lens ?? null,
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

/** A requirement of a group coverage as one branch reads it (see coverageView.ts). */
export interface BranchCoverageLinePayload {
  requirement_id?: number | null;
  text: string;
  status: CoverageStatus;
  where: 'here' | 'elsewhere' | 'base' | 'nowhere';
  here: 'covered' | 'partial' | null;
  others: string[];
  note: string;
}

/** A slice checklist row attributed against the ticket coverage (see coverageView.ts). */
export interface RowAttributionPayload {
  state: Attribution;
  label: string;
  branches: { repo: string; branch: string; review_id: number | null }[];
  note: string;
}

export interface SliceAttributionPayload {
  fresh: boolean;
  coverage_id: number | null;
  by_attribution: AttributionCounts;
  summary: string;
}

/** `ticket_group` of `GET /api/reviews/:id`: the review's ticket group, null for a branch without one. */
export interface ReviewTicketGroupPayload {
  key: string;
  parent: string | null;
  parent_reason: ParentReason | null;
  coverage: {
    id: number;
    status: string;
    verdict: CoverageVerdict | null;
    summary: string | null;
    created_at: string;
    includes_this_review: boolean;
    requirements: BranchCoverageLinePayload[];
  } | null;
  coverage_pending: boolean;
  checklist?: { id: number; text: string; source: string }[];
  /** Absent from servers older than the attribution. */
  attribution?: SliceAttributionPayload;
  ticket_coverage?: TicketCoverageBadge;
}

/** What `GET /api/reviews/:id` returns (the parts the MCP uses). */
export interface ReviewDetailPayload {
  review: ReviewRow;
  requirements?: (RequirementRow & { attribution?: RowAttributionPayload })[];
  findings?: FindingRow[];
  logs?: LogRow[];
  ticket_group?: ReviewTicketGroupPayload | null;
  proposed_requirements?: { text: string; reason: string }[];
}

/** `R12` for the stored checklist item 12. */
export function requirementRef(id: number | null | undefined): string | null {
  return id ? `R${id}` : null;
}

/** `in this branch`, `in repo#b`, `not covered anywhere`. */
export function coverageWhere(line: BranchCoverageLinePayload): string {
  if (line.where === 'base') return 'already on base';
  if (line.where === 'nowhere') return 'not covered anywhere';
  const others = line.others.join(', ');
  if (line.where === 'elsewhere') return `in ${others}`;
  const here = line.here === 'partial' ? 'partly in this branch' : 'in this branch';
  return others ? `${here} and ${others}` : here;
}

/** The ticket group part of a review, compact. */
export function reviewTicketGroup(group: ReviewTicketGroupPayload | null | undefined, maxRequirements = 30) {
  if (!group) return null;
  const c = group.coverage;
  return {
    key: group.key,
    parent: group.parent,
    parent_reason: group.parent_reason,
    coverage_pending: group.coverage_pending,
    // The ticket's verdict, not this branch's: "pending" until the coverage read this run and every sibling.
    ...(group.ticket_coverage ? { ticket_coverage: group.ticket_coverage.label } : {}),
    coverage: c
      ? {
          id: c.id,
          verdict: c.verdict,
          includes_this_review: c.includes_this_review,
          requirements: c.requirements.slice(0, maxRequirements).map((r) => ({
            ...(r.requirement_id ? { id: requirementRef(r.requirement_id) } : {}),
            status: r.status, text: truncate(r.text, 200), where: coverageWhere(r),
          })),
          ...(c.requirements.length > maxRequirements ? { requirements_omitted: c.requirements.length - maxRequirements } : {}),
        }
      : null,
  };
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

  const attribution = payload.ticket_group?.attribution ?? null;
  // A slice: a row another slice or the base holds is not open work, so only gaps and pending rows are listed.
  const open = (r: (typeof requirements)[number]): boolean => (r.attribution
    ? r.attribution.state === 'nowhere' || r.attribution.state === 'partial' || r.attribution.state === 'pending'
    : r.status !== 'met');
  const unmet = requirements
    .filter(open)
    .slice(0, 20)
    .map((r) => ({
      ...(r.requirement_id ? { id: requirementRef(r.requirement_id) } : {}),
      status: r.status,
      ...(r.attribution ? { where: r.attribution.label } : {}),
      text: truncate(r.text, 200),
    }));
  const byId = requirements.some((r) => r.requirement_id);
  const proposed = payload.proposed_requirements ?? [];

  return {
    ...reviewRef(review, url),
    ticket_title: truncate(review.ticket_title, 160),
    terminal: isTerminalStatus(review.status),
    // Only a finished review has an outcome; before that these are null.
    verdict: done ? review.verdict : null,
    can_merge: done && review.can_merge !== null ? review.can_merge === 1 : null,
    // Findings only; for a branch of a ticket group it equals verdict, and coverage is in ticket_group.
    code_verdict: done ? review.code_verdict ?? review.verdict : null,
    code_can_merge: done ? boolOrNull(review.code_can_merge ?? review.can_merge) : null,
    ticket_group: reviewTicketGroup(payload.ticket_group),
    summary: done ? truncate(review.summary, SUMMARY_MAX) : null,
    requirements: done
      ? {
          met: review.requirements_met ?? 0,
          total: review.requirements_total ?? 0,
          // by_id: the statuses are for the ticket's stored checklist (see get_ticket_requirements).
          ...(byId ? { by_id: true } : {}),
          // A slice of a ticket group: where each item lives, the same counts as the review page.
          ...(attribution
            ? { by_attribution: attribution.by_attribution, attribution_summary: attribution.summary, coverage_fresh: attribution.fresh }
            : {}),
          unmet,
        }
      : null,
    ...(done && proposed.length
      ? { proposed_requirements: proposed.slice(0, 20).map((p) => ({ text: truncate(p.text, 300), reason: truncate(p.reason, 300) })) }
      : {}),
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

function boolOrNull(v: number | null | undefined): boolean | null {
  return v === null || v === undefined ? null : v === 1;
}

// --- ticket groups --------------------------------------------------------------

interface RunSummaryPayload {
  id: number;
  run_index: number;
  status: ReviewStatus;
  verdict: Verdict | null;
  code_verdict: Verdict | null;
  code_can_merge: boolean | null;
  base_branch: string;
  blocking_count: number | null;
  requirements_met?: number | null;
  requirements_total?: number | null;
  /** latestDone only: its checklist against the ticket coverage; absent from older servers. */
  requirements_attribution?: { fresh: boolean; by_attribution: AttributionCounts; summary: string } | null;
}

export interface TicketBranchPayload {
  repo: string;
  branch: string;
  source: ReviewSource;
  parent: string | null;
  parentReason: ParentReason | null;
  parentInGroup: boolean;
  depth: number;
  prNumber: number | null;
  latest: RunSummaryPayload | null;
  latestDone: RunSummaryPayload | null;
  parentReviewed: boolean | null;
}

export interface CoveragePayload {
  id: number;
  status: 'running' | 'done' | 'failed';
  verdict: CoverageVerdict | null;
  summary: string | null;
  requirements: CoverageRequirement[];
  /** null or absent: the pass predates the contract check. */
  contract_issues?: ContractIssue[] | null;
  review_ids: number[];
  reviewer: string | null;
  model: string | null;
  report_path: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TicketRunPayload {
  id: number;
  status: 'running' | 'done';
  review_ids: number[];
  coverage_id: number | null;
  created_at: string;
  finished_at: string | null;
}

/** What `GET /api/ticket-groups/:key` returns. */
export interface TicketPayload {
  group: {
    key: string;
    title: string | null;
    ticketUrl: string | null;
    requirementsText: string | null;
    chains: { repo: string; branches: TicketBranchPayload[] }[];
  };
  coverage: CoveragePayload | null;
  latest_coverage: { id: number; status: string; error: string | null; created_at: string } | null;
  coverage_pending: boolean;
  run: TicketRunPayload | null;
}

export const DEFAULT_MAX_REQUIREMENTS = 40;

/** A coverage, compact: per requirement its status and the branches that cover it, with their evidence. */
export function compactCoverage(c: CoveragePayload | null, maxRequirements = DEFAULT_MAX_REQUIREMENTS) {
  if (!c) return null;
  const reqs = c.requirements.slice(0, maxRequirements);
  return {
    id: c.id,
    status: c.status,
    verdict: c.verdict,
    summary: truncate(c.summary, SUMMARY_MAX),
    requirements: reqs.map((r) => ({
      ...(r.requirement_id ? { id: requirementRef(r.requirement_id) } : {}),
      status: r.status,
      text: truncate(r.text, 200),
      branches: r.branches.map((b) => ({
        branch: `${b.repo}#${b.branch}`,
        status: b.status,
        evidence: b.evidence.slice(0, 5).map((e) => ({
          location: e.line ? `${e.file}:${e.line}` : e.file,
          anchor_status: e.anchor_status,
        })),
      })),
      ...(r.note ? { note: truncate(r.note, 200) } : {}),
      ...(r.base_evidence?.length
        ? {
            base_evidence: r.base_evidence.slice(0, 5).map((e) => ({
              location: `${e.repo}:${e.line ? `${e.file}:${e.line}` : e.file}`,
              at: e.base_sha ? `${e.base_branch ?? 'base'}@${e.base_sha.slice(0, 7)}` : null,
              verified: e.verified,
              ...(e.reason ? { reason: truncate(e.reason, 200) } : {}),
            })),
          }
        : {}),
    })),
    ...(c.requirements.length > reqs.length ? { requirements_omitted: c.requirements.length - reqs.length } : {}),
    // The cross-repository contract check: checked=false for a pass that predates it.
    contract: c.contract_issues
      ? {
          checked: true,
          issues: c.contract_issues.map((i) => ({
            severity: i.severity,
            problem: truncate(i.problem, 400),
            sites: i.sites.map((x) => ({
              branch: `${x.repo}#${x.branch}`,
              location: x.line ? `${x.file}:${x.line}` : x.file,
              anchor_status: x.anchor_status,
            })),
          })),
        }
      : { checked: false, issues: [] },
    // Only `missing` and `partial` keep the ticket from covered.
    open: c.requirements.filter((r) => !isSatisfied(r.status))
      .map((r) => `${r.status}: ${r.requirement_id ? `${requirementRef(r.requirement_id)} ` : ''}${truncate(r.text, 120)}`),
    // Verified at the base commit of the chain root: existed before this ticket, satisfied without a branch.
    already_on_base: c.requirements.filter((r) => r.status === 'already_on_base')
      .map((r) => `${r.requirement_id ? `${requirementRef(r.requirement_id)} ` : ''}${truncate(r.text, 120)}`),
    review_ids: c.review_ids,
    error: truncate(c.error, 600),
    created_at: c.created_at,
    finished_at: c.finished_at,
  };
}

function compactRun(run: RunSummaryPayload | null, urlFor: (id: number) => string) {
  if (!run) return null;
  return {
    id: run.id,
    run: run.run_index,
    status: run.status,
    base: run.base_branch,
    code_verdict: run.status === 'done' ? run.code_verdict ?? run.verdict : null,
    blocking_count: run.status === 'done' ? run.blocking_count : null,
    url: urlFor(run.id),
  };
}

/** A ticket group for `get_ticket`: chains in stack order, the latest run per branch, and the coverage. */
export function compactTicket(
  payload: TicketPayload,
  urls: { review: (id: number) => string; ticket: string },
  maxRequirements = DEFAULT_MAX_REQUIREMENTS,
) {
  return {
    key: payload.group.key,
    title: truncate(payload.group.title, 160),
    ticket_url: payload.group.ticketUrl,
    page: urls.ticket,
    chains: payload.group.chains.map((c) => ({
      repo: c.repo,
      branches: c.branches.map((b) => ({
        branch: b.branch,
        source: b.source,
        parent: b.parent,
        parent_reason: b.parentReason,
        parent_in_group: b.parentInGroup,
        depth: b.depth,
        pr: b.prNumber,
        latest: compactRun(b.latest, urls.review),
        ...(b.latestDone && b.latestDone.id !== b.latest?.id ? { latest_done: compactRun(b.latestDone, urls.review) } : {}),
        ...(b.latestDone?.requirements_attribution
          ? { requirements: { ...b.latestDone.requirements_attribution, met: b.latestDone.requirements_met, total: b.latestDone.requirements_total } }
          : {}),
        ...(b.parentInGroup && b.parentReviewed === false ? { note: 'parent not reviewed yet' } : {}),
      })),
    })),
    coverage: compactCoverage(payload.coverage, maxRequirements),
    ...(payload.latest_coverage ? { latest_coverage: payload.latest_coverage } : {}),
    coverage_pending: payload.coverage_pending,
    run: payload.run,
  };
}

/** Whether a ticket review batch is over: every queued run ended and its coverage was computed. */
export function isTicketRunFinished(payload: TicketPayload): boolean {
  return payload.run?.status === 'done';
}

/** What `GET /api/ticket-groups/:key/requirements` returns. */
export interface ChecklistPayload {
  key: string;
  derived_at: string | null;
  not_verifiable_notes: string[];
  /** Absent from servers older than this field. */
  open_questions?: string[];
  items: { id: number; position: number; text: string; source: 'derived' | 'user'; state: string }[];
  removed: { id: number; text: string; source: 'derived' | 'user' }[];
  deriving: boolean;
  derive_error?: { error: string; at: string } | null;
}

/** A ticket's stored checklist, compact: active items with their ids, then the not verifiable notes. */
export function compactChecklist(c: ChecklistPayload, maxRemoved = 20) {
  return {
    ticket: c.key,
    derived_at: c.derived_at,
    deriving: c.deriving,
    ...(c.derive_error ? { derive_error: c.derive_error } : {}),
    items: c.items.map((r) => ({ id: requirementRef(r.id), text: r.text, source: r.source })),
    not_verifiable_notes: c.not_verifiable_notes,
    // Things the ticket mentions but does not ask to change: confirm the scope, then add them by hand if wanted.
    open_questions: c.open_questions ?? [],
    removed: c.removed.slice(0, maxRemoved).map((r) => ({ id: requirementRef(r.id), text: truncate(r.text, 160) })),
    ...(c.removed.length > maxRemoved ? { removed_omitted: c.removed.length - maxRemoved } : {}),
  };
}

/** `R12`, `r12` or `12` as the item id 12; null for anything else. */
export function parseRequirementRef(value: string | number): number | null {
  const m = /^\s*R?(\d+)\s*$/i.exec(String(value));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

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
  defaultModel: string | null;
  noModelsHint?: string | null;
  available: boolean;
  acceptsUnlistedModels?: boolean;
  models?: { id: string; label?: string }[];
  source?: string | null;
  fetchedAt?: string | null;
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
      source: r.source ?? null,
      fetched_at: r.fetchedAt ?? null,
      ...(r.acceptsUnlistedModels ? { accepts_unlisted_models: true } : {}),
      ...(r.noModelsHint ? { no_models: r.noModelsHint } : {}),
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

// --- previews -----------------------------------------------------------------

/** A preview is settled once it is ready to click or has ended; only then does waiting stop. */
export const PREVIEW_END_STATUSES: readonly PreviewStatus[] = ['stopped', 'failed', 'expired'];
export const PREVIEW_LIVE_STATUSES: readonly PreviewStatus[] = ['queued', 'preparing', 'starting', 'ready', 'stopping'];

export function isPreviewSettled(status: string): boolean {
  return status === 'ready' || (PREVIEW_END_STATUSES as readonly string[]).includes(status);
}

/** A preview as `GET /api/previews/:id` decorates it. */
export interface PreviewPayload {
  id: number;
  review_id: number | null;
  recipe: string;
  ticket_key: string | null;
  url: string | null;
  status: PreviewStatus;
  error: string | null;
  dump_mode: string | null;
  dump_source: string | null;
  credentials_hint: string | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
  stopped_at: string | null;
  roles: (PreviewRole & { url?: string | null })[];
  ports: Record<string, number>;
  /** Every link the preview exposes, the primary one first. Absent from older servers. */
  links?: { label: string; url: string; port_id: string; primary: boolean }[];
  queuePosition?: number;
}

export function compactPreviewRole(r: PreviewPayload['roles'][number]) {
  return {
    role: r.role,
    repo: r.repo,
    // What actually runs: the base branch when the role had no branch of its own.
    branch: r.usedBase ? r.base : r.branch,
    base: r.base,
    used_base: r.usedBase,
    source: r.source ?? 'github',
    sha: r.sha ?? null,
  };
}

/**
 * One preview, compact: what runs where, and how to reach it. `web_url` is the
 * running app and `links` every address it exposes (both only while ready);
 * `page` is the tool's own page for it.
 */
export function compactPreview(
  p: PreviewPayload,
  opts: { page: string; logs?: readonly { message: string }[] } = { page: '' },
) {
  const ready = p.status === 'ready';
  const last = opts.logs?.at(-1)?.message;
  return {
    id: p.id,
    status: p.status,
    recipe: p.recipe,
    ticket: p.ticket_key,
    review_id: p.review_id,
    web_url: ready ? p.url : null,
    // Every exposed link (backend, admin, ...), primary first; empty until ready.
    links: ready ? (p.links ?? []).map((l) => ({ label: l.label, url: l.url, port: l.port_id, primary: l.primary })) : [],
    roles: p.roles.map(compactPreviewRole),
    ports: p.ports,
    data: p.dump_mode,
    error: truncate(p.error, 600),
    queue_position: p.queuePosition || null,
    created_at: p.created_at,
    ready_at: p.ready_at,
    expires_at: p.expires_at,
    ...(ready && p.credentials_hint ? { credentials_hint: truncate(p.credentials_hint, 400) } : {}),
    ...(!isPreviewSettled(p.status) && last ? { progress: truncate(last, 200) } : {}),
    page: opts.page,
  };
}

/** `GET /api/ticket-groups/:key/preview-plan`. */
export interface TicketPlanPayload {
  ticket: string;
  recipe: string;
  roles: {
    role: string; repo: string; branch: string; base: string; defaultBranch: string; usedBase: boolean;
    source: 'github' | 'local'; chain: string[];
  }[];
  request: { ticket: string; recipe: string; roles: { role: string; branch?: string; base?: string; local?: boolean }[] };
  live_preview: PreviewPayload | null;
  other_live: PreviewPayload[];
  notes: string[];
}

/**
 * A ticket preview plan, compact: per role the branch that runs (the tip of
 * its repo's chain, or the base branch) and where it comes from, plus a live
 * preview that already runs exactly these branches.
 */
export function compactTicketPlan(p: TicketPlanPayload, opts: { page: (reviewId: number | null) => string }) {
  return {
    ticket: p.ticket,
    recipe: p.recipe,
    roles: p.roles.map((r) => ({
      role: r.role,
      repo: r.repo,
      branch: r.branch,
      base: r.base,
      used_base: r.usedBase,
      source: r.source,
      chain: r.chain,
    })),
    live_preview: p.live_preview ? compactPreview(p.live_preview, { page: opts.page(p.live_preview.review_id) }) : null,
    other_live: p.other_live.map((o) => ({ id: o.id, status: o.status, roles: o.roles.map(compactPreviewRole) })),
    notes: p.notes,
  };
}

export interface RecipePayload {
  name: string;
  description: string | null;
  roles: { role: string; repo: string }[];
  ports: { id: string; primary?: boolean }[];
  database: { engine: string; version: string | null; mode: string } | null;
  readyTimeoutSec: number;
}

export function compactRecipes(payload: {
  enabled: boolean;
  recipes: RecipePayload[];
  errors?: { name?: string; error: string }[];
}) {
  return {
    enabled: payload.enabled,
    recipes: payload.recipes.map((r) => ({
      name: r.name,
      description: truncate(r.description, 300),
      roles: r.roles,
      primary_port: r.ports.find((p) => p.primary)?.id ?? null,
      database: r.database ? `${r.database.engine}${r.database.version ? ` ${r.database.version}` : ''} (${r.database.mode})` : null,
      ready_timeout_sec: r.readyTimeoutSec,
    })),
    errors: (payload.errors ?? []).map((e) => e.error),
  };
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
    `(${REVIEWER_ENV_FLAG} is set). Reviews cannot start, re-run, or cancel reviews or previews.`;
}
