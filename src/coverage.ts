/**
 * Ticket coverage: one reviewer pass per ticket group that reads every
 * branch's finished review (changed files, summary, requirement checklist)
 * and says, per requirement, whether the group covers it and which branch
 * does. Evidence locations are checked like finding anchors, against each
 * branch's own checkout when it is still on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createAnchorContext, checkAnchor } from './anchors.js';
import { config } from './config.js';
import {
  collectContractHunks, contractGlobsFor, contractIssuesSchema, normalizeContractIssues, renderContractHunks, sandboxDiff,
  type ContractHunks, type DiffRunner,
  type SiteTarget,
} from './contract.js';
import {
  attributeRow, attributionCounts, attributionSummary, branchCoverage, coverageVerdict, openRequirements, ticketCoverageBadge,
  type AttributableRow,
} from './coverageView.js';
import { db, getRequirements, getReviewFiles } from './db.js';
import { BaseReader, collectBaseHints, renderBaseExcerpts, type BaseRoot, type GitRunner } from './baseEvidence.js';
import { checkoutDir, fetchCheckout, pruneCheckout } from './gitSandbox.js';
import { logger } from './logger.js';
import { livePreviews } from './preview/store.js';
import {
  renderBranchCoverageSection, sanitizeSegment, updateReportCoverage, writeCoverageReport,
  type CoverageForReport, type CoverageReportBranch,
} from './reportWriter.js';
import { chooseModel, getReviewer } from './reviewers/index.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import { loadPromptFile, renderChecklist, renderTemplate, requirementLabel, runPass, type ChecklistItem } from './reviewRunner.js';
import { activeChecklist } from './ticketRequirements.js';
import { orderChains } from './ticketChains.js';
import { groupHeads } from './ticketGroups.js';
import {
  closeTicketRuns, createCoverage, finishCoverage, getCoverage, getTicketGroup, latestCoverage, latestDoneCoverage, listTicketBranches,
  parseCoverageRequirements, parseIds, setCoverageModel, syncMembersFromReviews,
} from './ticketStore.js';
import type {
  AnchorStatus, BaseEvidence, ContractIssue, CoverageBranch, CoverageEvidence, CoverageRequirement, CoverageStatus, OnLog, RequirementRow,
  ReviewFileRow, ReviewRow, TicketBranchRow, TicketCoverageRow,
} from './types.js';

// --- the answer ----------------------------------------------------------------

function coverageStatus(value: unknown): CoverageStatus {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'covered' || v === 'met' || v === 'done' || v === 'implemented') return 'covered';
  if (v === 'already_on_base' || v === 'on_base' || v === 'already_on_main' || v === 'already_on_master') return 'already_on_base';
  if (v === 'partial' || v === 'partially_covered' || v === 'partly') return 'partial';
  return 'missing';
}

const evidenceSchema = z.union([
  z.object({
    file: z.string().min(1),
    line: z.coerce.number().int().nullish().transform((v) => v ?? null),
  }),
  // `path/file.py:42` as one string.
  z.string().min(1).transform((raw) => {
    const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(raw.trim());
    return m ? { file: m[1]!, line: Number(m[2]) } : { file: raw.trim(), line: null };
  }),
]);

const coverageBranchSchema = z.object({
  repo: z.string().nullish().transform((v) => v?.trim() || null),
  branch: z.string().min(1),
  status: z.unknown().optional().transform((v): 'covered' | 'partial' => (coverageStatus(v) === 'covered' ? 'covered' : 'partial')),
  note: z.string().nullish().transform((v) => v ?? ''),
  evidence: z.array(evidenceSchema).nullish().transform((v) => v ?? []),
});

const baseClaimSchema = z.union([
  z.object({
    repo: z.string().nullish().transform((v) => v?.trim() || null),
    file: z.string().min(1),
    line: z.coerce.number().int().nullish().transform((v) => v ?? null),
    quote: z.string().nullish().transform((v) => v ?? ''),
  }),
  // `path/file.py:42` as one string: no quote, so it cannot verify.
  z.string().min(1).transform((raw) => ({ repo: null, file: raw.trim(), line: null, quote: '' })),
]);

const coverageRequirementSchema = z.object({
  id: z.union([z.number(), z.string().regex(/^\s*R?\d+\s*$/i)]).nullish()
    .transform((v) => (v === null || v === undefined ? null : Number(String(v).replace(/[^\d]/g, '')))),
  text: z.string().nullish().transform((v) => v?.trim() ?? ''),
  status: z.unknown().transform(coverageStatus),
  note: z.string().nullish().transform((v) => v ?? ''),
  branches: z.array(coverageBranchSchema).nullish().transform((v) => v ?? []),
  base_evidence: z.array(baseClaimSchema).nullish().transform((v) => (v ?? []).slice(0, 10)),
});

/** The answer when the pass derives its own list: every requirement has a text. */
export const coverageOutputSchema = z.object({
  summary: z.string().nullish().transform((v) => v ?? ''),
  requirements: z.array(coverageRequirementSchema.refine((r) => r.text.length > 0, 'text is required')).min(1),
  contract_issues: contractIssuesSchema,
});

/** The answer for a stored checklist: every entry names its id. */
export const checklistCoverageOutputSchema = z.object({
  summary: z.string().nullish().transform((v) => v ?? ''),
  requirements: z.array(coverageRequirementSchema.refine((r) => r.id !== null, 'id is required')),
  contract_issues: contractIssuesSchema,
});

export type CoverageOutput = z.infer<typeof coverageOutputSchema>;

/** A requirement of the answer, its base claims checked by the tool (`checkBaseClaims`). */
export type CheckedRequirement = CoverageOutput['requirements'][number] & { base_checked?: BaseEvidence[] };

// --- the inputs -------------------------------------------------------------------

/** One branch of the group as the coverage pass sees it. */
export interface CoverageBranchInput {
  member: TicketBranchRow;
  depth: number;
  /** The latest finished review of the branch; null when it has none. */
  review: ReviewRow | null;
  /** The latest run, finished or not, for "not reviewed yet" / "failed". */
  latest: ReviewRow | null;
  files: ReviewFileRow[];
  requirements: RequirementRow[];
  /** The diff of its contract files, for the cross-repository contract check; set by `attachContractHunks`. */
  contract?: ContractHunks | null;
}

export interface CoverageInputs {
  key: string;
  ticket: { key: string; title: string | null; url: string | null; text: string };
  branches: CoverageBranchInput[];
  /** The ticket's stored checklist; empty when it has none, and the pass derives its own list. */
  checklist: ChecklistItem[];
}

/** The group's branches in stack order, each with its latest finished review. */
export function collectCoverageInputs(key: string): CoverageInputs {
  syncMembersFromReviews(key);
  const group = getTicketGroup(key);
  const heads = groupHeads(key);
  const branches: CoverageBranchInput[] = [];
  for (const chain of orderChains(listTicketBranches(key))) {
    for (const node of chain.nodes) {
      const head = heads.get(`${node.item.repo}#${node.item.branch}`);
      const review = head?.latestDone ?? null;
      branches.push({
        member: node.item,
        depth: node.depth,
        review,
        latest: head?.latest ?? null,
        files: review ? getReviewFiles(review.id) : [],
        requirements: review ? getRequirements(review.id) : [],
      });
    }
  }
  const withTicket = db
    .prepare<[string], Pick<ReviewRow, 'ticket_key' | 'ticket_title' | 'ticket_url' | 'ticket_body'>>(
      `SELECT ticket_key, ticket_title, ticket_url, ticket_body FROM reviews
        WHERE group_key = ? AND TRIM(COALESCE(ticket_body, '')) <> '' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(key);
  const title = group?.title ?? withTicket?.ticket_title ?? null;
  const url = group?.ticket_url ?? withTicket?.ticket_url ?? null;
  const parts: string[] = [`**${key}${title ? ` - ${title}` : ''}**`];
  if (url) parts.push(`URL: ${url}`);
  parts.push('', withTicket?.ticket_body?.trim() || '(no ticket text is stored; derive the requirements from the branches below)');
  if (group?.requirements_text?.trim()) {
    parts.push('', '## Added requirements and decisions', '', group.requirements_text.trim());
  }
  const checklist = activeChecklist(key).map((r) => ({ id: r.id, text: r.text }));
  return { key, ticket: { key, title, url, text: parts.join('\n') }, branches, checklist };
}

const MAX_FILES_PER_BRANCH = 200;
const STATUS_WORD: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

export function renderCoverageBranches(branches: readonly CoverageBranchInput[]): string {
  if (branches.length === 0) return 'No branches are known for this ticket.';
  return branches.map((b, index) => {
    const head = `## ${index + 1}. \`${b.member.repo}#${b.member.branch}\``;
    const base = b.member.parent_branch
      ? `- Diffed against: \`${b.member.parent_branch}\`${b.member.parent_branch === b.member.default_branch ? ' (default branch)' : ''}`
      : '- Diffed against: unknown';
    if (!b.review) {
      const state = b.latest ? `its latest review is ${b.latest.status}` : 'it was never reviewed';
      return [head, base, `- NOT REVIEWED: ${state}. Treat it as implementing nothing.`].join('\n');
    }
    const r = b.review;
    const lines = [
      head,
      base,
      `- Review #${r.id}, run ${r.run_index}, head ${r.head_sha?.slice(0, 7) ?? 'unknown'}, code verdict ${r.code_verdict ?? r.verdict ?? 'unknown'}`,
      `- Diff: ${r.files_changed ?? b.files.length} files, +${r.additions ?? 0} / -${r.deletions ?? 0}`,
      `- Review summary: ${(r.summary ?? '').replace(/\s+/g, ' ').trim() || '(none)'}`,
      '- Requirement checklist of this branch\'s own review:',
      ...(b.requirements.length
        ? b.requirements.map((q) => `  - [${q.status}] ${q.requirement_id ? `\`${requirementLabel(q.requirement_id)}\` ` : ''}` +
            `${q.text.replace(/\s+/g, ' ')}${q.evidence ? ` (evidence: ${q.evidence.replace(/\s+/g, ' ')})` : ''}`)
        : ['  - (none recorded)']),
      `- Changed files (${b.files.length}):`,
      ...b.files.slice(0, MAX_FILES_PER_BRANCH).map((f) => {
        const word = STATUS_WORD[f.status];
        const from = f.old_path && f.old_path !== f.path ? ` from \`${f.old_path}\`` : '';
        return `  - \`${f.path}\`${word ? ` (${word}${from})` : ''}`;
      }),
    ];
    if (b.files.length > MAX_FILES_PER_BRANCH) lines.push(`  - ... and ${b.files.length - MAX_FILES_PER_BRANCH} more`);
    return lines.join('\n');
  }).join('\n\n');
}

const COVERAGE_DERIVE_STEP = [
  '1. **Derive the ticket requirements.** Read the ticket, including its comments',
  '   and any added requirements or decisions. Turn it into a numbered list of',
  '   concrete, checkable requirements. Split compound sentences. Include',
  '   acceptance criteria, explicit "must" statements, and clear implied work (a',
  '   behaviour change usually needs tests). Leave out work no repository can show',
  '   (manual QA, a deployment, a decision still to be made) and name it in the',
  '   summary instead. Where a decision in the ticket or its comments replaced the',
  '   original text, the decision wins. Set `id` to null on every entry.',
].join('\n');

/** Step 1 of the coverage prompt: derive the requirements, or take the stored checklist by id. */
export function renderCoverageRequirementsStep(checklist: readonly ChecklistItem[]): string {
  if (checklist.length === 0) return COVERAGE_DERIVE_STEP;
  return [
    '1. **Take the stored checklist.** The ticket\'s requirements are this agreed',
    '   checklist; it already folds in the decisions from the ticket comments.',
    '   Report on EXACTLY these items: one entry per id, every id once, with `id` set',
    '   to it (for example `"R12"`). Do not add, drop, merge, split, or reword items;',
    '   `text` may be left out. A branch checklist line that starts with the same id',
    '   is that branch\'s own status for the item.',
    '',
    renderChecklist(checklist),
  ].join('\n');
}

export async function buildCoveragePrompt(inputs: CoverageInputs, base = 'No base commit is known for this ticket.'): Promise<string> {
  return renderTemplate(await loadPromptFile('coverage.md'), {
    BASE: base,
    TICKET: inputs.ticket.text,
    BRANCHES: renderCoverageBranches(inputs.branches),
    REQUIREMENTS_STEP: renderCoverageRequirementsStep(inputs.checklist),
    CONTRACT: renderContractHunks(inputs.branches.map((b) => ({
      repo: b.member.repo, branch: b.member.branch, hunks: b.review ? b.contract ?? null : null,
    }))),
  });
}

/** Reads the contract hunks of every reviewed branch from its checkout, before the checkouts are pruned. */
export async function attachContractHunks(
  branches: CoverageBranchInput[],
  opts: { run?: DiffRunner; rulesDir?: string } = {},
): Promise<void> {
  for (const b of branches) {
    if (!b.review) continue;
    b.contract = await collectContractHunks(b.review, b.files, checkoutDir(b.member, b.review.id), {
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.rulesDir ? { globs: contractGlobsFor(b.member.repo, opts.rulesDir) } : {}),
    });
  }
}

/** Contract sites resolved to the group's reviewed branches, each checked in that branch. */
export function contractResolver(
  branches: readonly CoverageBranchInput[],
  checkerFor: (b: CoverageBranchInput) => EvidenceChecker,
): (repo: string | null, branch: string) => SiteTarget | undefined {
  const checkers = new Map<CoverageBranchInput, EvidenceChecker>();
  return (repo, branch) => {
    const member = findMember(branches, repo, branch);
    if (!member?.review) return undefined;
    let check = checkers.get(member);
    if (!check) {
      check = checkerFor(member);
      checkers.set(member, check);
    }
    return { repo: member.member.repo, branch: member.member.branch, check };
  };
}

// --- evidence anchors -------------------------------------------------------------

export type EvidenceChecker = (file: string, line: number | null) => CoverageEvidence;

function cleanPath(raw: string): string {
  let file = raw.trim().replace(/\\/g, '/');
  while (file.startsWith('./')) file = file.slice(2);
  return file.replace(/^[ab]\//, '');
}

/**
 * Checks a branch's evidence like a finding anchor: inside that branch's
 * checkout at HEAD and in its changed set. Without the checkout only the
 * changed set can be checked: a changed path is `unverified` (the line is not
 * checked), any other path `off_diff`.
 */
export function evidenceChecker(dir: string | null, files: readonly ReviewFileRow[]): EvidenceChecker {
  if (dir && fs.existsSync(path.join(dir, '.git'))) {
    const ctx = createAnchorContext(dir, files);
    return (file, line) => {
      const { finding } = checkAnchor(ctx, {
        file, line, end_line: null, kind: 'diff', cause_file: null, cause_line: null,
      });
      return { file: finding.file ?? file, line: finding.line, anchor_status: finding.anchor_status };
    };
  }
  const changed = new Set(files.map((f) => f.path));
  const renamed = new Map(files.filter((f) => f.old_path).map((f) => [f.old_path!, f.path]));
  return (raw, line) => {
    let file = cleanPath(raw);
    const suffix = /^(.*?):(\d+)$/.exec(file);
    if (suffix && line === null) {
      file = suffix[1]!;
      line = Number(suffix[2]);
    }
    file = renamed.get(file) ?? file;
    const status: AnchorStatus = changed.has(file) ? 'unverified' : 'off_diff';
    return { file, line, anchor_status: status };
  };
}

/**
 * The answer, held to the group: a branch must be a reviewed member (anything
 * else is dropped), a requirement no branch is left to cover is `missing`, and
 * a `missing` one lists no branch.
 */
export function normalizeCoverage(
  output: { requirements: CheckedRequirement[] },
  branches: readonly CoverageBranchInput[],
  checkerFor: (b: CoverageBranchInput) => EvidenceChecker,
  onLog: OnLog = () => {},
  checklist: readonly ChecklistItem[] = [],
): CoverageRequirement[] {
  if (checklist.length > 0) {
    // Statuses by id, in the checklist's order and wording; an item left out is missing.
    const byId = new Map<number, CheckedRequirement>();
    const known = new Set(checklist.map((c) => c.id));
    for (const r of output.requirements) {
      if (r.id === null || !known.has(r.id)) {
        onLog('warn', `coverage: dropped an entry for ${r.id === null ? 'no id' : `id ${r.id}`}, which is not on the checklist`);
        continue;
      }
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
    const ordered = checklist.map((c) => {
      const r = byId.get(c.id);
      if (!r) onLog('warn', `coverage: no entry for requirement id ${c.id}; marked missing`);
      return r
        ? { ...r, id: c.id, text: c.text }
        : {
            id: c.id, text: c.text, status: 'missing' as const, note: 'The coverage pass did not report on this item.', branches: [],
            base_evidence: [],
          };
    });
    return normalizeRequirements(ordered, branches, checkerFor, onLog)
      .map((r, i) => ({ requirement_id: checklist[i]!.id, ...r }));
  }
  return normalizeRequirements(output.requirements, branches, checkerFor, onLog);
}

function normalizeRequirements(
  requirements: readonly CheckedRequirement[],
  branches: readonly CoverageBranchInput[],
  checkerFor: (b: CoverageBranchInput) => EvidenceChecker,
  onLog: OnLog,
): CoverageRequirement[] {
  const checkers = new Map<CoverageBranchInput, EvidenceChecker>();
  const find = (repo: string | null, branch: string) => findMember(branches, repo, branch);
  return requirements.map((req): CoverageRequirement => {
    if (req.status === 'already_on_base') return baseRequirement(req);
    const out: CoverageBranch[] = [];
    if (req.status !== 'missing') {
      for (const b of req.branches) {
        const member = find(b.repo, b.branch);
        if (!member || !member.review) {
          onLog('warn', `coverage: dropped ${b.repo ?? '?'}#${b.branch} for "${req.text.slice(0, 60)}": ` +
            (member ? 'that branch has no finished review' : 'not a branch of this ticket'));
          continue;
        }
        if (out.some((o) => o.repo === member.member.repo && o.branch === member.member.branch)) continue;
        let check = checkers.get(member);
        if (!check) {
          check = checkerFor(member);
          checkers.set(member, check);
        }
        out.push({
          repo: member.member.repo,
          branch: member.member.branch,
          review_id: member.review.id,
          status: b.status,
          note: b.note,
          evidence: b.evidence.slice(0, 10).map((e) => check!(e.file, e.line)),
        });
      }
    }
    const status: CoverageStatus = out.length === 0 ? 'missing' : req.status;
    const note = status === 'missing' && req.status !== 'missing' && !req.note
      ? 'No reviewed branch of this ticket implements it.'
      : req.note;
    return { text: req.text, status, note, branches: status === 'missing' ? [] : out };
  });
}

/**
 * An `already_on_base` claim: it stands only with at least one site the tool
 * verified at the base commit; otherwise the requirement is `missing` and the
 * note says why the claim failed.
 */
function baseRequirement(req: CheckedRequirement): CoverageRequirement {
  const checked = req.base_checked ?? [];
  if (checked.some((e) => e.verified)) {
    return { text: req.text, status: 'already_on_base', note: req.note, branches: [], base_evidence: checked };
  }
  const reasons = [...new Set(checked.map((e) => `${e.file}${e.line ? `:${e.line}` : ''}: ${e.reason ?? 'not verified'}`))];
  const reason = reasons.length ? reasons.join('; ') : 'no base site was given';
  return {
    text: req.text,
    status: 'missing',
    note: `claimed already on base, not verified: ${reason}`,
    branches: [],
    ...(checked.length ? { base_evidence: checked } : {}),
  };
}

/** The tool's own sentence on the base check, appended to the pass summary. */
export function baseCheckLine(onBase: number, rejected: number): string {
  if (!onBase && !rejected) return '';
  const parts: string[] = [];
  if (onBase) parts.push(`${onBase} requirement(s) verified as already on the base before this ticket`);
  if (rejected) parts.push(`${rejected} "already on base" claim(s) not verified, kept as missing`);
  return `Tool check: ${parts.join('; ')}.`;
}

/** Verifies every base site of every `already_on_base` claim; other requirements pass through. */
export async function checkBaseClaims(
  requirements: CoverageOutput['requirements'],
  reader: BaseReader | null,
): Promise<CheckedRequirement[]> {
  const out: CheckedRequirement[] = [];
  for (const req of requirements) {
    if (req.status !== 'already_on_base') {
      out.push(req);
      continue;
    }
    const checked: BaseEvidence[] = [];
    for (const claim of req.base_evidence) {
      checked.push(reader
        ? await reader.verify(claim)
        : {
            repo: claim.repo ?? '', file: claim.file, line: claim.line, quote: claim.quote, base_branch: null, base_sha: null,
            verified: false, reason: 'no base commit is known for this ticket',
          });
    }
    out.push({ ...req, base_checked: checked });
  }
  return out;
}

/** Removes a base checkout fetched for the pass, and its `<repo>/<base>/` folder once empty. */
function pruneFetchedBase(dir: string): void {
  pruneCheckout(dir);
  try {
    fs.rmdirSync(path.dirname(dir));
  } catch {
    // Not empty: another checkout of that base is still there.
  }
}

/** The base commit of every chain root with a finished review: what "before this ticket" means per repository. */
export function baseRootsOf(branches: readonly CoverageBranchInput[]): BaseRoot[] {
  const roots: BaseRoot[] = [];
  for (const b of branches) {
    if (b.depth !== 0 || !b.review?.base_sha) continue;
    const baseBranch = b.review.base_branch || b.member.parent_branch || b.member.default_branch || 'main';
    roots.push({
      repo: b.member.repo,
      baseBranch,
      sha: b.review.base_sha,
      checkout: checkoutDir(b.member, b.review.id),
      fetchTarget: { repo: b.member.repo, branch: baseBranch, baseBranch, prNumber: null, source: b.review.source },
      reviewId: b.review.id,
    });
  }
  return roots;
}

/** The member a model-written `repo` and `branch` (or `repo#branch`) name; undefined when none or several match. */
function findMember(branches: readonly CoverageBranchInput[], repo: string | null, branch: string): CoverageBranchInput | undefined {
  let name = branch.trim();
  let r = repo;
  const hash = name.indexOf('#');
  if (!r && hash > 0) {
    r = name.slice(0, hash);
    name = name.slice(hash + 1);
  } else if (r && name.startsWith(`${r}#`)) {
    name = name.slice(r.length + 1);
  }
  const matches = branches.filter((b) => b.member.branch === name && (!r || b.member.repo === r));
  return matches.length === 1 ? matches[0] : undefined;
}

// --- the pass -----------------------------------------------------------------------

export interface CoverageRunOptions {
  trigger?: string;
  reviewer?: string;
  model?: string;
  /** For tests: the reviewer to run instead of looking one up. */
  reviewerDefinition?: ReviewerDefinition;
  timeoutMs?: number;
  /** For tests: how a checkout's contract diff is read (default: git in the sandbox). */
  contractDiff?: DiffRunner;
  /** For tests: how git reads a base commit (default: git in the sandbox). */
  baseGit?: GitRunner;
  /** For tests: how the base branch of a root whose checkout is gone is fetched (default: a sandbox checkout). */
  baseFetch?: (root: BaseRoot) => Promise<string>;
}

const ACTIVE_SQL = `status IN ('queued', 'fetching', 'reviewing')`;

export function groupHasActiveReviews(key: string): boolean {
  const row = db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM reviews WHERE group_key = ? AND ${ACTIVE_SQL}`)
    .get(key);
  return (row?.n ?? 0) > 0;
}

/**
 * Runs one coverage pass for a group and stores it. The coverage row is
 * written before the first await, so a caller sees it `running` at once.
 * Never throws for a failed pass: the row says `failed`.
 */
export async function runCoverage(key: string, opts: CoverageRunOptions = {}): Promise<TicketCoverageRow> {
  const inputs = collectCoverageInputs(key);
  const reviewed = inputs.branches.filter((b) => b.review);
  const lastReview = [...reviewed].sort((a, b) => b.review!.id - a.review!.id)[0]?.review ?? null;
  const reviewerName = opts.reviewer ?? lastReview?.reviewer ?? undefined;
  let reviewer: ReviewerDefinition;
  try {
    reviewer = opts.reviewerDefinition ?? getReviewer(reviewerName);
  } catch {
    reviewer = getReviewer(undefined);
  }
  const inheritedModel = lastReview?.reviewer === reviewer.name ? lastReview.model : null;
  // Provisional, so the row exists before the first await; checked against the reviewer's list below.
  let model = opts.model ?? inheritedModel ?? reviewer.defaultModel;
  const row = createCoverage(key, {
    reviewIds: reviewed.map((b) => b.review!.id),
    reviewer: reviewer.name,
    model,
    trigger: opts.trigger ?? 'manual',
  });
  const log: OnLog = (level, message) => logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
    `coverage #${row.id} ${key}: ${message}`,
  );

  const settle = (): void => {
    const settled = new Set(
      db.prepare<[string], { id: number }>(`SELECT id FROM reviews WHERE group_key = ? AND NOT ${ACTIVE_SQL}`).all(key)
        .map((r) => r.id),
    );
    closeTicketRuns(key, settled, row.id);
  };

  if (reviewed.length === 0) {
    finishCoverage(row.id, { status: 'failed', error: 'No branch of this ticket has a finished review yet.' });
    settle();
    return getCoverage(row.id)!;
  }

  const workDir = path.join(config.DATA_DIR, 'coverage', sanitizeSegment(key), String(row.id));
  let reader: BaseReader | null = null;
  try {
    if (!opts.reviewerDefinition) {
      const chosen = await chooseModel(reviewer, {
        requested: opts.model, inherited: inheritedModel, onFallback: (message) => log('warn', message),
      });
      if (chosen !== model) {
        model = chosen;
        setCoverageModel(row.id, model);
      }
    }
    fs.mkdirSync(workDir, { recursive: true });
    log('info', `started with ${reviewed.length} of ${inputs.branches.length} branch(es) reviewed, ${reviewer.label} (${model})`);
    await attachContractHunks(inputs.branches, opts.contractDiff ? { run: opts.contractDiff } : {});
    const withDiff = inputs.branches.filter((b) => b.contract?.diff).length;
    log('info', `contract check: ${withDiff} branch(es) with contract hunks`);
    const roots = baseRootsOf(inputs.branches);
    reader = roots.length
      ? new BaseReader(roots, {
          run: opts.baseGit ?? sandboxDiff,
          fetch: opts.baseFetch ?? (async (root) => (await fetchCheckout(root.fetchTarget, root.reviewId, log)).dir),
          prune: pruneFetchedBase,
          onLog: log,
        })
      : null;
    const hints = collectBaseHints(reviewed.map((b) => ({ repo: b.member.repo, branch: b.member.branch, requirements: b.requirements })));
    const base = await renderBaseExcerpts(hints, reader);
    log('info', `base check: ${roots.length} chain root(s) with a base commit, ${hints.length} hint(s) from the slice reviews`);
    const prompt = await buildCoveragePrompt(inputs, base);
    const passOpts = {
      dir: workDir,
      reviewer,
      model,
      timeoutMs: opts.timeoutMs ?? config.REVIEW_TIMEOUT_MS,
      signal: undefined,
    };
    const { data } = inputs.checklist.length > 0
      ? await runPass('coverage', prompt, checklistCoverageOutputSchema, log, passOpts)
      : await runPass('coverage', prompt, coverageOutputSchema, log, passOpts);
    const checkerFor = (b: CoverageBranchInput) => evidenceChecker(b.review ? checkoutDir(b.member, b.review.id) : null, b.files);
    const checked = await checkBaseClaims(data.requirements, reader);
    const requirements = normalizeCoverage({ requirements: checked }, inputs.branches, checkerFor, log, inputs.checklist);
    const onBase = requirements.filter((r) => r.status === 'already_on_base').length;
    const rejected = requirements.filter((r) => r.status === 'missing' && r.base_evidence?.length).length;
    if (onBase || rejected) log('info', `base check: ${onBase} already on base (verified), ${rejected} claim(s) not verified`);
    const contractIssues: ContractIssue[] = normalizeContractIssues(
      data.contract_issues,
      contractResolver(inputs.branches, checkerFor),
      (message) => log('warn', message),
    );
    const verdict = coverageVerdict(requirements);
    const open = openRequirements(requirements);
    const modelSummary = data.summary.trim() || (open.length === 0
      ? 'Every requirement is covered by some branch.'
      : `${open.length} requirement(s) are not fully covered.`);
    const summary = [modelSummary, baseCheckLine(onBase, rejected)].filter(Boolean).join(' ');
    const report: CoverageForReport = { id: row.id, verdict, summary, requirements, createdAt: row.created_at, contractIssues };
    const reportPath = await writeCoverageReport(
      { key, title: inputs.ticket.title, url: inputs.ticket.url },
      report,
      inputs.branches.map(reportBranch),
      { reviewer: reviewer.name, model },
    );
    finishCoverage(row.id, { status: 'done', verdict, summary, requirements, reportPath, contractIssues });
    log('info', `done: ${verdict}, ${requirements.length} requirement(s), ${open.length} open, ` +
      `${contractIssues.length} contract issue(s); report ${reportPath}`);
    for (const b of reviewed) {
      if (!b.review?.report_path) continue;
      await updateReportCoverage(b.review.report_path, renderBranchCoverageSection(key, report, b.member.repo, b.member.branch));
    }
    pruneGroupCheckouts(key, new Set(reviewed.map((b) => b.review!.id)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishCoverage(row.id, { status: 'failed', error: message });
    log('error', `failed: ${message.split('\n')[0]}`);
  } finally {
    reader?.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    settle();
  }
  return getCoverage(row.id)!;
}

function reportBranch(b: CoverageBranchInput): CoverageReportBranch {
  return {
    repo: b.member.repo,
    branch: b.member.branch,
    base: b.review?.base_branch ?? b.member.parent_branch,
    reviewId: b.review?.id ?? null,
    runIndex: b.review?.run_index ?? null,
    codeVerdict: b.review ? b.review.code_verdict ?? b.review.verdict : null,
    headSha: b.review?.head_sha ?? null,
    depth: b.depth,
    status: b.latest ? `not reviewed (latest run ${b.latest.status})` : 'not reviewed',
  };
}

/**
 * Checkouts of finished group reviews are kept for the coverage pass. Once it
 * has read them they go, and so do those of superseded runs; a checkout a
 * live preview borrows stays, and so does a failed run's (kept for inspection).
 */
export function pruneGroupCheckouts(key: string, used: ReadonlySet<number>): number {
  const borrowed = new Set(livePreviews().map((p) => p.review_id).filter((id): id is number => id !== null));
  const heads = new Set([...groupHeads(key).values()].map((h) => h.latestDone?.id).filter((id): id is number => id !== undefined));
  const rows = db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE group_key = ? AND status = 'done'`).all(key);
  let pruned = 0;
  for (const r of rows) {
    if (borrowed.has(r.id)) continue;
    if (!used.has(r.id) && heads.has(r.id)) continue;
    const dir = checkoutDir(r, r.id);
    if (!fs.existsSync(dir)) continue;
    try {
      pruneCheckout(dir);
      pruned += 1;
    } catch (err) {
      logger.warn(`coverage ${key}: could not remove ${dir}: ${(err as Error).message}`);
    }
  }
  return pruned;
}

// --- debounced scheduling -------------------------------------------------------------

export interface SchedulerDeps {
  run(key: string, trigger: string): Promise<unknown>;
  /** True while a review of the group is queued or running: the last one to settle schedules again. */
  isActive(key: string): boolean;
  delayMs: number;
}

/**
 * Coalesces the "a branch review settled" signals of a group into one
 * coverage pass: each signal restarts the group's timer; when it fires and no
 * review of the group is still active, one pass runs. A signal during a pass
 * runs one more pass after it.
 */
export function createCoverageScheduler(deps: SchedulerDeps) {
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<unknown>>();
  const again = new Map<string, string>();

  const start = (key: string, trigger: string): Promise<unknown> => {
    const promise = deps.run(key, trigger)
      .catch((err: unknown) => logger.error(`coverage ${key}: ${(err as Error).message}`))
      .finally(() => {
        running.delete(key);
        const next = again.get(key);
        if (next !== undefined) {
          again.delete(key);
          schedule(key, next);
        }
      });
    running.set(key, promise);
    return promise;
  };

  const fire = (key: string, trigger: string): void => {
    timers.delete(key);
    if (deps.isActive(key)) return;
    if (running.has(key)) {
      again.set(key, trigger);
      return;
    }
    void start(key, trigger);
  };

  function schedule(key: string, trigger = 'review settled'): void {
    const old = timers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => fire(key, trigger), deps.delayMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  /** Runs now, skipping the timer; joins a running pass (and queues one more) instead of starting a second. */
  function runNow(key: string, trigger = 'manual'): { started: boolean; done: Promise<unknown> } {
    const old = timers.get(key);
    if (old) {
      clearTimeout(old);
      timers.delete(key);
    }
    const current = running.get(key);
    if (current) {
      again.set(key, trigger);
      return { started: false, done: current };
    }
    return { started: true, done: start(key, trigger) };
  }

  function pending(key: string): boolean {
    return timers.has(key) || running.has(key);
  }

  function cancelAll(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { schedule, runNow, pending, cancelAll };
}

export type CoverageScheduler = ReturnType<typeof createCoverageScheduler>;

let scheduler: CoverageScheduler | null = null;

/**
 * Turns on automatic coverage (the server does; the CLI does not, since it
 * exits when its reviews end). Off, finished group reviews prune their
 * checkouts at once and nothing is scheduled.
 */
export function enableCoverageScheduling(delayMs = config.COVERAGE_DEBOUNCE_MS): CoverageScheduler {
  scheduler = createCoverageScheduler({
    run: (key, trigger) => runCoverage(key, { trigger }),
    isActive: groupHasActiveReviews,
    delayMs,
  });
  return scheduler;
}

export function coverageSchedulingEnabled(): boolean {
  return scheduler !== null;
}

/** A review of a ticket group reached done, failed, or cancelled. */
export function onGroupReviewSettled(key: string): void {
  scheduler?.schedule(key, 'review settled');
}

/** Whether a pass is waiting on its timer or running for the group. */
export function coveragePending(key: string): boolean {
  return scheduler?.pending(key) ?? false;
}

/** Starts a pass now (manual recompute). Without the scheduler it simply runs. */
export function recomputeCoverage(key: string, opts: CoverageRunOptions = {}): { started: boolean; done: Promise<unknown> } {
  if (scheduler && !opts.reviewer && !opts.model) return scheduler.runNow(key, opts.trigger ?? 'manual');
  return { started: true, done: runCoverage(key, { trigger: 'manual', ...opts }) };
}

/**
 * Whether a coverage speaks for this run of a branch: it read this run and the
 * latest finished run of every member, no member has a run in progress, and
 * no pass is waiting. Otherwise a slice page treats the coverage as pending.
 */
export function coverageIsFresh(
  key: string,
  coverage: Pick<TicketCoverageRow, 'review_ids' | 'status'> | null | undefined,
  reviewId: number,
  pending: boolean,
): boolean {
  if (!coverage || coverage.status !== 'done' || pending) return false;
  const used = new Set(parseIds(coverage.review_ids));
  if (!used.has(reviewId)) return false;
  const heads = groupHeads(key);
  for (const member of listTicketBranches(key)) {
    const head = heads.get(`${member.repo}#${member.branch}`);
    if (!head?.latestDone || !used.has(head.latestDone.id)) return false;
    if (ACTIVE_STATUSES.has(head.latest.status)) return false;
  }
  return true;
}

const ACTIVE_STATUSES = new Set(['queued', 'fetching', 'reviewing']);

/** A slice review's own checklist rows, each attributed against the ticket coverage (pending when it is not fresh). */
export function sliceAttribution(
  review: Pick<ReviewRow, 'repo' | 'branch'>,
  rows: readonly AttributableRow[],
  requirements: readonly CoverageRequirement[] | null,
  fresh: boolean,
) {
  const coverage = fresh ? requirements : null;
  const attributed = rows.map((r) => attributeRow(r, coverage, review.repo, review.branch));
  const counts = attributionCounts(attributed);
  return { rows: attributed, by_attribution: counts, summary: attributionSummary(counts, fresh && requirements !== null), fresh };
}

/**
 * A slice review's checklist read against the ticket's latest coverage: each
 * row attributed, the counts, the summary line, and the ticket coverage badge
 * for the slice page. Null for a review outside a ticket group.
 */
export function reviewAttribution(
  key: string,
  review: Pick<ReviewRow, 'id' | 'repo' | 'branch'>,
  pending: boolean,
  rows: readonly (AttributableRow & { id: number })[] = getRequirements(review.id),
) {
  const coverage = latestDoneCoverage(key) ?? null;
  const fresh = coverageIsFresh(key, coverage, review.id, pending || latestCoverage(key)?.status === 'running');
  const requirements = coverage ? parseCoverageRequirements(coverage) : null;
  const slice = sliceAttribution(review, rows, requirements, fresh);
  return {
    fresh,
    coverage_id: coverage?.id ?? null,
    by_attribution: slice.by_attribution,
    summary: slice.summary,
    rows: rows.map((r, i) => ({ id: r.id, ...slice.rows[i]! })),
    ticket_coverage: ticketCoverageBadge(coverage && requirements ? { verdict: coverage.verdict, requirements } : null, fresh),
  };
}

/** One branch's reading of the group's latest coverage, for its review page and report. */
export function coverageForReview(review: Pick<ReviewRow, 'id' | 'repo' | 'branch'>, coverage: TicketCoverageRow, requirements: CoverageRequirement[]) {
  const used = parseIds(coverage.review_ids);
  return {
    id: coverage.id,
    status: coverage.status,
    verdict: coverage.verdict,
    summary: coverage.summary,
    created_at: coverage.created_at,
    finished_at: coverage.finished_at,
    /** False when this run is not the one the coverage read (an older or a newer run of the branch). */
    includes_this_review: used.includes(review.id),
    requirements: branchCoverage(requirements, review.repo, review.branch),
  };
}

