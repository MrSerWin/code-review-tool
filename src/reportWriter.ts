import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listReviewers } from './reviewers/index.js';
import type { CheckoutResult, ReviewOutput, ReviewRow, Severity, TicketInfo } from './types.js';

/** Minimal shape the report needs from a `reviews` row. */
export type ReportableReview = Pick<
  ReviewRow,
  | 'id' | 'repo' | 'branch' | 'base_branch' | 'run_index'
  | 'head_sha' | 'base_sha' | 'reviewer' | 'model' | 'ticket_key' | 'ticket_title' | 'ticket_url'
>;

const VERDICT_BANNER: Record<string, string> = {
  approve: 'APPROVED — safe to merge',
  changes_requested: 'CHANGES REQUESTED — do not merge yet',
  blocked: 'BLOCKED — do not merge',
};

const REQ_ICON: Record<string, string> = {
  met: '✅ Met',
  partial: '⚠️ Partial',
  missing: '❌ Missing',
  not_verifiable: '❓ Not verifiable',
};

const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];

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

export async function writeReport(
  review: ReportableReview,
  ticket: TicketInfo | null,
  checkout: CheckoutResult,
  output: ReviewOutput,
): Promise<string> {
  const now = new Date();
  const relative = reportRelativePath(review, now);
  const absolute = path.join(config.DATA_DIR, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, renderReport(review, ticket, checkout, output, now), 'utf8');
  return relative;
}

export function renderReport(
  review: ReportableReview,
  ticket: TicketInfo | null,
  checkout: CheckoutResult,
  output: ReviewOutput,
  now: Date = new Date(),
): string {
  const title = [review.ticket_key, review.repo, review.branch].filter(Boolean).join(' · ');
  const lines: string[] = [];

  lines.push(`# Code Review — ${title}`, '');
  lines.push(`**Verdict: ${VERDICT_BANNER[output.verdict] ?? output.verdict.toUpperCase()}**`, '');

  lines.push('| | |', '|---|---|');
  lines.push(`| Ticket | ${ticketCell(review, ticket)} |`);
  lines.push(`| Repository | ${review.repo} |`);
  lines.push(
    `| Branch | ${review.branch} (head ${shortSha(checkout.headSha ?? review.head_sha)}, ` +
      `base ${review.base_branch} ${shortSha(checkout.baseSha ?? review.base_sha)}) |`,
  );
  lines.push(
    `| Diff | ${checkout.filesChanged} files, +${checkout.additions} / -${checkout.deletions} |`,
  );
  lines.push(
    `| Run | #${review.run_index} · ${humanStamp(now)} UTC · ` +
      `${reviewerLabel(review.reviewer)} · model ${review.model ?? 'unknown'} |`,
  );
  lines.push('');

  lines.push('## Summary', '', output.summary.trim() || '(no summary)', '');

  lines.push('## Ticket requirements', '');
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

  lines.push('## Issues to fix', '');
  const findings = [...output.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  if (findings.length === 0) {
    lines.push('No issues found.', '');
  } else {
    findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`, '');
      lines.push(`- **File:** ${location(finding.file, finding.line, finding.end_line)}`);
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
