import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { branchCoverage, openRequirements, whereLabel } from './coverageView.js';
import { listReviewers } from './reviewers/index.js';
import type {
  AnchorStatus, CheckoutResult, CoverageRequirement, CoverageVerdict, Finding, FindingKind, ReviewOutput, ReviewRow,
  Severity, TicketInfo,
} from './types.js';

/** Minimal shape the report needs from a `reviews` row. */
export type ReportableReview = Pick<
  ReviewRow,
  | 'id' | 'repo' | 'branch' | 'base_branch' | 'run_index'
  | 'head_sha' | 'base_sha' | 'reviewer' | 'model' | 'ticket_key' | 'ticket_title' | 'ticket_url'
> & Partial<Pick<ReviewRow, 'source' | 'working_tree' | 'base_reason'>>;

const BASE_REASON_LABEL: Record<string, string> = {
  parent: 'detected parent',
  chosen: 'chosen',
  default: 'default',
};

const VERDICT_BANNER: Record<string, string> = {
  approve: 'APPROVED — safe to merge',
  changes_requested: 'CHANGES REQUESTED — do not merge yet',
  blocked: 'BLOCKED — do not merge',
};

/** A slice of a ticket group: the verdict judges its code only. */
const CODE_VERDICT_BANNER: Record<string, string> = {
  approve: 'CODE APPROVED: no blocking findings in this branch',
  changes_requested: 'CHANGES REQUESTED: fix the findings below',
  blocked: 'BLOCKED: do not merge',
};

/** The ticket coverage section of a branch report sits between these markers, so it can be refreshed. */
export const COVERAGE_START = '<!-- ticket-coverage:start -->';
export const COVERAGE_END = '<!-- ticket-coverage:end -->';

const COVERAGE_ICON: Record<string, string> = {
  covered: '✅ Covered',
  partial: '⚠️ Partial',
  missing: '❌ Missing',
};

const REQ_ICON: Record<string, string> = {
  met: '✅ Met',
  partial: '⚠️ Partial',
  missing: '❌ Missing',
  not_verifiable: '❓ Not verifiable',
};

const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];

function sourceCell(review: ReportableReview, checkout: CheckoutResult): string {
  const snapshot = checkout.workingTreeSnapshot;
  const tree = !review.working_tree
    ? 'working-tree changes not included'
    : snapshot
      ? `working-tree changes included (${snapshot.files} file(s), snapshot ${shortSha(snapshot.sha)})`
      : 'working-tree changes requested, but the tree was clean';
  return `local clone (unpushed) · ${tree}`;
}

export function sanitizeSegment(value: string): string {
  return value.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function reportRelativePath(review: ReportableReview, now: Date = new Date()): string {
  const group = sanitizeSegment(review.ticket_key || review.repo);
  const branchDir = `${sanitizeSegment(review.repo)}__${sanitizeSegment(review.branch)}`;
  return path.posix.join(
    'reports',
    group,
    branchDir,
    `run-${review.run_index}-${stamp(now)}.md`,
  );
}

/** `run-N-<ts>.md` -> `run-N-<ts>.lenses`: where a run's raw pass outputs sit. */
export function rawOutputDir(reportRelative: string): string {
  return reportRelative.replace(/\.md$/, '') + '.lenses';
}

/** The raw answers of the passes, kept beside the report for debugging. */
export interface RawPassOutputs {
  lenses: { lens: string; raw?: unknown; error: string | null }[];
  synthesis?: unknown;
  reanchor?: unknown;
}

/** A branch report written in the context of a ticket group. */
export interface ReportGroupContext {
  ticketKey: string;
  /** The ticket coverage section; a pending note when absent. */
  coverageSection?: string;
}

export async function writeReport(
  review: ReportableReview,
  ticket: TicketInfo | null,
  checkout: CheckoutResult,
  output: ReviewOutput,
  raw?: RawPassOutputs,
  group?: ReportGroupContext,
): Promise<string> {
  const now = new Date();
  const relative = reportRelativePath(review, now);
  const absolute = path.join(config.DATA_DIR, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, renderReport(review, ticket, checkout, output, now, group), 'utf8');
  if (raw) await writeRawOutputs(path.join(config.DATA_DIR, rawOutputDir(relative)), raw);
  return relative;
}

async function writeRawOutputs(dir: string, raw: RawPassOutputs): Promise<void> {
  await mkdir(dir, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  for (const lens of raw.lenses) {
    const body = lens.error !== null || lens.raw === undefined ? { error: lens.error ?? 'no output' } : lens.raw;
    await writeFile(path.join(dir, `${sanitizeSegment(lens.lens)}.json`), json(body), 'utf8');
  }
  if (raw.synthesis !== undefined) await writeFile(path.join(dir, 'synthesis.json'), json(raw.synthesis), 'utf8');
  if (raw.reanchor !== undefined && raw.reanchor !== null) {
    await writeFile(path.join(dir, 'reanchor.json'), json(raw.reanchor), 'utf8');
  }
}

export function renderReport(
  review: ReportableReview,
  ticket: TicketInfo | null,
  checkout: CheckoutResult,
  output: ReviewOutput,
  now: Date = new Date(),
  group?: ReportGroupContext,
): string {
  const title = [review.ticket_key, review.repo, review.branch].filter(Boolean).join(' · ');
  const lines: string[] = [];

  lines.push(`# Code Review — ${title}`, '');
  if (group) {
    const code = output.code_verdict ?? output.verdict;
    lines.push(`**Code verdict: ${CODE_VERDICT_BANNER[code] ?? code.toUpperCase()}**`, '');
    lines.push(
      `This branch is one slice of ticket ${group.ticketKey}. Its verdict judges its code only; ` +
        'whether the ticket is fully implemented is judged across all of its branches (Ticket coverage, below).',
      '',
    );
  } else {
    lines.push(`**Verdict: ${VERDICT_BANNER[output.verdict] ?? output.verdict.toUpperCase()}**`, '');
  }

  lines.push('| | |', '|---|---|');
  lines.push(`| Ticket | ${ticketCell(review, ticket)} |`);
  lines.push(`| Repository | ${review.repo} |`);
  if (review.source === 'local') lines.push(`| Source | ${sourceCell(review, checkout)} |`);
  lines.push(
    `| Branch | ${review.branch} (head ${shortSha(checkout.headSha ?? review.head_sha)}, ` +
      `base ${review.base_branch} ${shortSha(checkout.baseSha ?? review.base_sha)}) |`,
  );
  if (review.base_reason) {
    lines.push(`| Base | ${review.base_branch} (${BASE_REASON_LABEL[review.base_reason] ?? review.base_reason}) |`);
  }
  lines.push(
    `| Diff | ${checkout.filesChanged} files, +${checkout.additions} / -${checkout.deletions} |`,
  );
  lines.push(
    `| Run | #${review.run_index} · ${humanStamp(now)} UTC · ` +
      `${reviewerLabel(review.reviewer)} · model ${review.model ?? 'unknown'} |`,
  );
  lines.push('');

  lines.push('## Summary', '', output.summary.trim() || '(no summary)', '');

  lines.push(group ? '## Ticket requirements (this branch)' : '## Ticket requirements', '');
  if (group) {
    lines.push('What this branch implements. A requirement marked missing here may be covered by another branch.', '');
  }
  if (output.requirements.length === 0) {
    lines.push('No requirements were extracted from the ticket.', '');
  } else {
    lines.push('| # | Requirement | Status | Evidence |', '|---|---|---|---|');
    output.requirements.forEach((req, index) => {
      lines.push(
        `| ${index + 1} | ${cell(req.text)} | ${REQ_ICON[req.status] ?? req.status} | ${cell(req.evidence) || '—'} |`,
      );
    });
    lines.push('');
  }

  if (group) {
    lines.push(COVERAGE_START);
    lines.push(group.coverageSection ?? pendingCoverageSection(group.ticketKey));
    lines.push(COVERAGE_END, '');
  }

  lines.push('## Issues to fix', '');
  const findings = [...output.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  if (findings.length === 0) {
    lines.push('No issues found.', '');
  } else {
    findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`, '');
      lines.push(`- **File:** ${location(finding.file, finding.line, finding.end_line)}${anchorNote(finding)}`);
      if (finding.kind && finding.kind !== 'diff') lines.push(`- **Caused by:** ${causeText(finding)}`);
      if (finding.hunk) lines.push(`- **Hunk:** \`${finding.hunk}\``);
      if (finding.category) lines.push(`- **Category:** ${finding.category}`);
      lines.push(`- **Problem:** ${finding.problem}`);
      if (finding.why) lines.push(`- **Why it matters:** ${finding.why}`);
      if (finding.suggestion) lines.push(`- **Suggested fix:** ${finding.suggestion}`);
      lines.push('');
      if (finding.snippet) {
        lines.push('```', finding.snippet.replace(/```/g, "'''"), '```', '');
      }
    });
  }

  // Non-blocking by construction: nothing here feeds the merge gate.
  lines.push('## Suggestions (non-blocking)', '');
  if (output.observations.length === 0) {
    lines.push('None.', '');
  } else {
    output.observations.forEach((observation) => {
      lines.push(`- ${location(observation.file, observation.line, null)} — ${inline(observation.note)}`);
      if (observation.rationale) lines.push(`  ${inline(observation.rationale)}`);
    });
    lines.push('');
  }

  lines.push('## Conclusion', '');
  lines.push(output.conclusion.trim() || VERDICT_BANNER[output.verdict] || '');
  lines.push('');

  return lines.join('\n');
}

function ticketCell(review: ReportableReview, ticket: TicketInfo | null): string {
  const key = ticket?.key ?? review.ticket_key;
  if (!key) return 'none';
  const url = ticket?.url ?? review.ticket_url;
  const label = url ? `[${key}](${url})` : key;
  const title = ticket?.title ?? review.ticket_title;
  return title ? `${label} — ${cell(title)}` : label;
}

/** Keep a list item on one line. */
function inline(value: string | null | undefined): string {
  return (value ?? '').replace(/\r?\n+/g, ' ').trim();
}

function location(file: string | null, line: number | null, endLine: number | null): string {
  if (!file) return '_not tied to a single file_';
  if (line && endLine && endLine > line) return `\`${file}:${line}-${endLine}\``;
  if (line) return `\`${file}:${line}\``;
  return `\`${file}\``;
}

const KIND_LABEL: Record<FindingKind, string> = {
  diff: 'in the diff',
  regression: 'dependent site',
  stale_doc: 'stale doc',
  consumer: 'consumer',
};

const ANCHOR_WARNING: Partial<Record<AnchorStatus, string>> = {
  missing_path: 'path not found at HEAD',
  line_out_of_range: 'line out of range at HEAD',
  off_diff: 'outside the diff',
};

export function kindLabel(kind: FindingKind | null | undefined): string | null {
  return kind && kind !== 'diff' ? KIND_LABEL[kind] ?? kind : null;
}

export function anchorWarning(status: AnchorStatus | null | undefined): string | null {
  return status ? ANCHOR_WARNING[status] ?? null : null;
}

/** ` (dependent site)` and/or ` **[anchor: path not found at HEAD]**`; empty for a plain diff finding. */
function anchorNote(f: Pick<Finding, 'kind' | 'anchor_status'>): string {
  const kind = kindLabel(f.kind);
  const warning = anchorWarning(f.anchor_status);
  return `${kind ? ` (${kind})` : ''}${warning ? ` **[anchor: ${warning}]**` : ''}`;
}

function causeText(f: Pick<Finding, 'cause_file' | 'cause_line'>): string {
  return f.cause_file ? location(f.cause_file, f.cause_line, null) : '_no cause location given_';
}

/** Keep table cells on one line and stop `|` from splitting a column. */
function cell(value: string | null | undefined): string {
  return (value ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function reviewerLabel(reviewer: string | null | undefined): string {
  if (!reviewer) return 'unknown reviewer';
  // An old row can name a reviewer that no longer exists; show it verbatim.
  return listReviewers().find((r) => r.name === reviewer)?.label ?? reviewer;
}

function stamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function humanStamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

// --- ticket coverage -----------------------------------------------------------

function pendingCoverageSection(ticketKey: string): string {
  return [
    '## Ticket coverage',
    '',
    `Pending: coverage of ${ticketKey} is computed once every branch of the ticket has been reviewed.`,
    '',
  ].join('\n');
}

export interface CoverageForReport {
  id: number;
  verdict: CoverageVerdict;
  summary: string;
  requirements: CoverageRequirement[];
  createdAt: string;
}

const COVERAGE_VERDICT_TEXT: Record<CoverageVerdict, string> = {
  covered: 'COVERED: every requirement is implemented by some branch',
  needs_work: 'NEEDS WORK: not every requirement is implemented yet',
};

/** The coverage section of one branch's report: each requirement seen from this branch. */
export function renderBranchCoverageSection(
  ticketKey: string,
  coverage: CoverageForReport,
  repo: string,
  branch: string,
): string {
  const lines: string[] = ['## Ticket coverage', ''];
  lines.push(`**${ticketKey}: ${COVERAGE_VERDICT_TEXT[coverage.verdict]}** (coverage #${coverage.id}, ${coverage.createdAt.slice(0, 16).replace('T', ' ')} UTC)`, '');
  lines.push('| # | Requirement | Ticket status | Where |', '|---|---|---|---|');
  branchCoverage(coverage.requirements, repo, branch).forEach((line, index) => {
    lines.push(`| ${index + 1} | ${cell(line.text)} | ${COVERAGE_ICON[line.status] ?? line.status} | ${cell(whereLabel(line))} |`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Replaces the coverage section of a branch report; a report without one gets it before the issues. */
export function replaceCoverageSection(markdown: string, section: string): string {
  const start = markdown.indexOf(COVERAGE_START);
  const end = markdown.indexOf(COVERAGE_END);
  const block = `${COVERAGE_START}\n${section}\n${COVERAGE_END}`;
  if (start >= 0 && end > start) return markdown.slice(0, start) + block + markdown.slice(end + COVERAGE_END.length);
  const issues = markdown.indexOf('## Issues to fix');
  if (issues >= 0) return `${markdown.slice(0, issues)}${block}\n\n${markdown.slice(issues)}`;
  return `${markdown.trimEnd()}\n\n${block}\n`;
}

/** Rewrites the coverage section of a stored branch report (a path relative to DATA_DIR). */
export async function updateReportCoverage(reportRelative: string, section: string): Promise<boolean> {
  const abs = path.resolve(config.DATA_DIR, reportRelative);
  if (!abs.startsWith(path.resolve(config.DATA_DIR) + path.sep)) return false;
  try {
    const md = await readFile(abs, 'utf8');
    await writeFile(abs, replaceCoverageSection(md, section), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface CoverageReportBranch {
  repo: string;
  branch: string;
  base: string | null;
  reviewId: number | null;
  runIndex: number | null;
  codeVerdict: string | null;
  headSha: string | null;
  depth: number;
  status: string;
}

/** `reports/<ticket>/coverage-<ts>-<id>.md`: the id keeps two passes of one second apart. */
export function coverageReportPath(ticketKey: string, coverageId: number, now: Date = new Date()): string {
  return path.posix.join('reports', sanitizeSegment(ticketKey), `coverage-${stamp(now)}-${coverageId}.md`);
}

export function renderCoverageReport(
  ticket: { key: string; title: string | null; url: string | null },
  coverage: CoverageForReport,
  branches: readonly CoverageReportBranch[],
  meta: { reviewer: string | null; model: string | null },
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  lines.push(`# Ticket coverage: ${ticket.key}`, '');
  lines.push(`**${COVERAGE_VERDICT_TEXT[coverage.verdict]}**`, '');
  lines.push('| | |', '|---|---|');
  const label = ticket.url ? `[${ticket.key}](${ticket.url})` : ticket.key;
  lines.push(`| Ticket | ${ticket.title ? `${label}: ${cell(ticket.title)}` : label} |`);
  lines.push(`| Coverage | #${coverage.id} · ${humanStamp(now)} UTC · ${reviewerLabel(meta.reviewer)} · model ${meta.model ?? 'unknown'} |`);
  lines.push('');

  lines.push('## Branches', '');
  lines.push('| Branch | Diffed against | Review | Code verdict |', '|---|---|---|---|');
  for (const b of branches) {
    const indent = b.depth > 0 ? `${'↳ '.repeat(b.depth)}` : '';
    const review = b.reviewId ? `#${b.reviewId} (run ${b.runIndex ?? '?'}, ${shortSha(b.headSha)})` : `_${b.status}_`;
    lines.push(`| ${indent}${b.repo}#${b.branch} | ${b.base ?? '-'} | ${review} | ${b.codeVerdict ?? '-'} |`);
  }
  lines.push('');

  lines.push('## Summary', '', coverage.summary.trim() || '(no summary)', '');

  lines.push('## Requirements', '');
  lines.push('| # | Requirement | Status | Covered by | Note |', '|---|---|---|---|---|');
  coverage.requirements.forEach((r, index) => {
    const by = r.branches.length === 0
      ? 'not covered anywhere'
      : r.branches.map((b) => {
          const where = b.evidence.map((e) => {
            const loc = e.line ? `${e.file}:${e.line}` : e.file;
            const warn = anchorWarning(e.anchor_status);
            return warn ? `\`${loc}\` [${warn}]` : `\`${loc}\``;
          }).join(', ');
          return `${b.repo}#${b.branch}${b.status === 'partial' ? ' (partial)' : ''}${where ? `: ${where}` : ''}`;
        }).join('; ');
    lines.push(`| ${index + 1} | ${cell(r.text)} | ${COVERAGE_ICON[r.status] ?? r.status} | ${cell(by)} | ${cell(r.note) || '-'} |`);
  });
  lines.push('');

  const open = openRequirements(coverage.requirements);
  lines.push('## Still required', '');
  if (open.length === 0) lines.push('Nothing: every requirement is covered.', '');
  else {
    for (const r of open) lines.push(`- ${r.status === 'missing' ? 'Missing' : 'Partial'}: ${inline(r.text)}${r.note ? ` (${inline(r.note)})` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeCoverageReport(
  ticket: { key: string; title: string | null; url: string | null },
  coverage: CoverageForReport,
  branches: readonly CoverageReportBranch[],
  meta: { reviewer: string | null; model: string | null },
): Promise<string> {
  const now = new Date();
  const relative = coverageReportPath(ticket.key, coverage.id, now);
  const absolute = path.join(config.DATA_DIR, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, renderCoverageReport(ticket, coverage, branches, meta, now), 'utf8');
  return relative;
}
