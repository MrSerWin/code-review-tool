/**
 * The MCP tools of code-review-tool. Every tool is a thin call to the running
 * HTTP API (see `client.ts`); this process holds no secrets and never touches
 * the database, the checkouts, or a reviewer CLI itself.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Names only: this module imports nothing (no config, no secrets).
import { REVIEWER_NAMES } from '../reviewers/types.js';
import type { ResolvedTarget, ReviewRow, TicketInfo } from '../types.js';
import { ApiClient, ApiError, ApiUnreachableError } from './client.js';
import {
  ALL_STATUSES, ACTIVE_STATUSES, compactLocalRepos, compactReviewers, DEFAULT_MAX_BRANCHES,
  DEFAULT_MAX_FINDINGS, DEFAULT_REPORT_MAX, isTerminalStatus, mutationRefusal, parseTargetSelector,
  reviewDetail, reviewListRow, reviewRef, selectTargets, truncateReport,
  type ReviewDetailPayload,
} from './format.js';

const version = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version ?? '0.0.0';

export const WAIT_DEFAULT_SEC = 50;
export const WAIT_MAX_SEC = 600;
export const POLL_DEFAULT_SEC = 5;

const INSTRUCTIONS = `code-review-tool runs read-only code reviews of git branches (GitHub or local clones) with a reviewer CLI (Claude Code, Codex, Cursor Agent, or Grok) and returns a verdict, a requirement checklist, and findings.
Typical flow: start_review -> wait_for_review (repeat while finished=false) -> get_review / get_report.
A review takes several minutes (often 5-20). Never start the same review twice to check on it: poll the id you got.
For a branch that is not pushed yet, use list_local_repos to find the repo name and branch, then start_review with "local:<repo>#<branch>".`;

const idSchema = z.number().int().positive().describe('Review id, as returned by start_review or list_reviews.');

type ToolResult = CallToolResult;

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a tool body; every failure becomes an MCP error result, never a thrown protocol error. */
async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ApiUnreachableError) return fail(err.message);
    if (err instanceof ApiError) return fail(`code-review-tool API error (HTTP ${err.status}): ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CreateServerOptions {
  api: ApiClient;
  /** The environment the guard reads; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export function createMcpServer({ api, env = process.env }: CreateServerOptions): McpServer {
  const server = new McpServer({ name: 'code-review-tool', version }, { instructions: INSTRUCTIONS });
  const refusal = (): string | null => mutationRefusal(env);

  server.registerTool('list_reviewers', {
    title: 'List reviewers',
    description:
      'List the reviewer CLIs this code-review-tool can run (claude, codex, cursor, grok): whether each is ' +
      'installed ("available"), its default model, and the model ids it offers. Use a name and a model id from ' +
      'here for start_review / rerun_review. Omitting both uses the server default reviewer and its default model.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guarded(async () => ok(compactReviewers(await api.reviewers()))));

  server.registerTool('list_local_repos', {
    title: 'List local repositories',
    description:
      'List the local git clones code-review-tool can review without pushing: for each repo its name (use it in ' +
      '"local:<repo>#<branch>"), clone path, checked-out branch, default base branch, whether the working tree is ' +
      'dirty, and its branches (checked-out first, then most recent) with unpushed/ahead/behind. Match your current ' +
      'working directory against "path" to find the repo name. Empty when no local clones are configured.',
    inputSchema: {
      repo: z.string().min(1).max(200).optional().describe('Only this repository.'),
      maxBranches: z.number().int().min(1).max(500).optional()
        .describe(`Branches listed per repo (default ${DEFAULT_MAX_BRANCHES}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ repo, maxBranches }) => guarded(async () =>
    ok(compactLocalRepos(await api.localRepos(), { repo, maxBranches }))));

  server.registerTool('detect_base', {
    title: 'Detect base branch',
    description:
      'For a branch of a local clone, show the base branch a local review would diff against: the detected parent ' +
      'branch for stacked branches (main -> feat/a -> feat/b gives feat/a), else the default branch. Returns ' +
      '{branch, base, reason, distance (commits the base lacks), defaultBase}. Pass a different base to ' +
      'start_review as baseBranch to override it.',
    inputSchema: {
      repo: z.string().min(1).max(200).describe('Repository name, as listed by list_local_repos.'),
      branch: z.string().min(1).max(255).describe('Local branch name.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ repo, branch }) => guarded(async () => ok(await api.parent(repo, branch))));

  server.registerTool('start_review', {
    title: 'Start a code review',
    description:
      'Start a read-only code review. It runs in the background and takes several minutes (often 5-20); this ' +
      'tool returns immediately with the review ids. Then call wait_for_review(id) repeatedly until finished=true ' +
      '(or get_review(id) now and then). Do not call start_review again to check progress: every call starts new ' +
      'runs.\n' +
      'input forms:\n' +
      '- "ABC-123" ticket key of a configured tracker (or "jira:ABC-123", "linear:ABC-123" to pick the tracker); ' +
      'reviews every branch/PR linked to the ticket, one review per branch\n' +
      '- "https://github.com/<org>/<repo>/pull/12" pull request URL, or a /tree/<branch> URL\n' +
      '- "my-service#feature/x" a pushed branch of an allowed repo\n' +
      '- "local:my-service#feature/x" a branch of the local clone, pushed or not (see list_local_repos); ' +
      '"local:my-service" = the checked-out branch\n' +
      'When a ticket resolves to several branches, all of them are reviewed unless "targets" narrows it. ' +
      'Returns {reviews:[{id, repo, branch, base, reviewer, model, status, url}]}.',
    inputSchema: {
      input: z.string().min(1).max(512).describe('Ticket key, PR URL, "repo#branch", or "local:repo#branch".'),
      reviewer: z.enum(REVIEWER_NAMES).optional()
        .describe('Reviewer CLI (see list_reviewers). Default: the server default.'),
      model: z.string().min(1).max(64).optional()
        .describe("Model id for that reviewer (see list_reviewers). Default: the reviewer's default model."),
      baseBranch: z.string().min(1).max(255).optional()
        .describe('local: inputs only. Branch to diff against. Default: the detected parent (see detect_base).'),
      includeWorkingTree: z.boolean().optional()
        .describe('local: inputs only, checked-out branch only. Also review uncommitted and untracked changes.'),
      requirementsText: z.string().min(1).max(20_000).optional()
        .describe('What the change must do, when there is no ticket (or instead of it). First line = title.'),
      targets: z.array(z.string().min(3).max(300)).min(1).max(20).optional()
        .describe('Ticket inputs only: review just these of the ticket\'s branches, each as "repo#branch".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => guarded(async () => {
    const refused = refusal();
    if (refused) return fail(refused);

    let chosen: ResolvedTarget[] | undefined;
    if (args.targets) {
      const selectors = args.targets.map(parseTargetSelector);
      const resolved = await api.ticket<{ ticket: TicketInfo; targets: ResolvedTarget[] }>(args.input);
      const { chosen: picked, unmatched } = selectTargets(resolved.targets, selectors);
      if (unmatched.length > 0) {
        const available = resolved.targets.map((t) => `${t.repo}#${t.branch}`).join(', ') || 'none';
        return fail(
          `Not branches of ${args.input}: ${unmatched.map((s) => `${s.repo}#${s.branch}`).join(', ')}. ` +
          `Available: ${available}.`,
        );
      }
      chosen = picked;
    }

    const body = {
      input: args.input,
      ...(chosen ? { targets: chosen } : {}),
      ...(args.reviewer ? { reviewer: args.reviewer } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
      ...(args.includeWorkingTree ? { includeWorkingTree: true } : {}),
      ...(args.requirementsText ? { requirementsText: args.requirementsText } : {}),
    };
    const { reviews } = await api.createReviews<{ reviews: ReviewRow[] }>(body);
    return ok({
      reviews: reviews.map((r) => reviewRef(r, api.reviewUrl(r.id))),
      next: 'Reviews take several minutes. Call wait_for_review with each id until finished=true.',
    });
  }));

  server.registerTool('get_review', {
    title: 'Get a review',
    description:
      'Status and, once done, the outcome of one review: verdict (approve | changes_requested | blocked), ' +
      'can_merge, summary, requirements met/total with the unmet ones, blocking_count, counts per severity, and ' +
      `findings (most severe first, capped at maxFindings, default ${DEFAULT_MAX_FINDINGS}; findings_omitted says ` +
      'how many were cut). status is queued | fetching | reviewing | done | failed | cancelled; "error" explains ' +
      'a failure, "progress" is the latest log line while it runs. get_report returns the full Markdown report.',
    inputSchema: {
      id: idSchema,
      maxFindings: z.number().int().min(0).max(500).optional()
        .describe(`Findings to include (default ${DEFAULT_MAX_FINDINGS}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, maxFindings }) => guarded(async () => {
    const payload = await api.review<ReviewDetailPayload>(id);
    return ok(reviewDetail(payload, api.reviewUrl(id), { maxFindings }));
  }));

  server.registerTool('wait_for_review', {
    title: 'Wait for a review',
    description:
      'Wait for a review to finish, polling its status, for at most timeoutSec seconds (default ' +
      `${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC}; keep it below your MCP tool timeout). Returns the same fields as ` +
      'get_review plus "finished" and "waited_sec". If finished=false the review is still running: call ' +
      'wait_for_review again with the same id. Reviews usually take 5-20 minutes, so expect several calls.',
    inputSchema: {
      id: idSchema,
      timeoutSec: z.number().int().min(1).max(WAIT_MAX_SEC).optional()
        .describe(`Longest time to wait, in seconds (default ${WAIT_DEFAULT_SEC}).`),
      pollSec: z.number().int().min(1).max(60).optional()
        .describe(`Seconds between status checks (default ${POLL_DEFAULT_SEC}).`),
      maxFindings: z.number().int().min(0).max(500).optional()
        .describe(`Findings to include once done (default ${DEFAULT_MAX_FINDINGS}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, timeoutSec, pollSec, maxFindings }, extra) => guarded(async () => {
    const timeoutMs = (timeoutSec ?? WAIT_DEFAULT_SEC) * 1000;
    const pollMs = (pollSec ?? POLL_DEFAULT_SEC) * 1000;
    const started = Date.now();
    const deadline = started + timeoutMs;
    const progressToken = extra._meta?.progressToken;

    let payload = await api.review<ReviewDetailPayload>(id, extra.signal);
    while (!isTerminalStatus(payload.review.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining), extra.signal);
      payload = await api.review<ReviewDetailPayload>(id, extra.signal);
      if (progressToken !== undefined) {
        const last = payload.logs?.at(-1)?.message;
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: Math.round((Date.now() - started) / 1000),
            total: Math.round(timeoutMs / 1000),
            message: `review ${id}: ${payload.review.status}${last ? ` - ${last.slice(0, 120)}` : ''}`,
          },
        }).catch(() => { /* progress is best-effort */ });
      }
    }

    const finished = isTerminalStatus(payload.review.status);
    return ok({
      finished,
      waited_sec: Math.round((Date.now() - started) / 1000),
      ...reviewDetail(payload, api.reviewUrl(id), { maxFindings }),
      ...(finished ? {} : { next: 'Still running. Call wait_for_review again with the same id.' }),
    });
  }));

  server.registerTool('get_report', {
    title: 'Get the Markdown report',
    description:
      'The full Markdown report of a finished review (verdict, requirement checklist with evidence, every ' +
      'finding with why and suggestion, observations). Only exists once status is done. Long reports are cut at ' +
      `maxChars (default ${DEFAULT_REPORT_MAX}) with a note; get_review is the compact alternative.`,
    inputSchema: {
      id: idSchema,
      maxChars: z.number().int().min(1_000).max(500_000).optional()
        .describe(`Maximum characters returned (default ${DEFAULT_REPORT_MAX}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, maxChars }) => guarded(async () => {
    let markdown: string;
    try {
      markdown = await api.report(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && /no report/i.test(err.message)) {
        const { review } = await api.review<ReviewDetailPayload>(id);
        const hint = isTerminalStatus(review.status)
          ? `Review ${id} ended as ${review.status} without a report.`
          : `Review ${id} is still ${review.status}; the report exists once it is done. Use wait_for_review.`;
        return fail(hint);
      }
      throw err;
    }
    return { content: [{ type: 'text', text: truncateReport(markdown, maxChars ?? DEFAULT_REPORT_MAX, api.reviewUrl(id)) }] };
  }));

  server.registerTool('list_reviews', {
    title: 'List reviews',
    description:
      'Recent reviews, newest first, as compact rows (id, status, ticket, repo, branch, base, reviewer, model, ' +
      'verdict, can_merge, blocking_count, url). Filter by free text q (matches ticket key/title, repo, branch), ' +
      'repo, ticket, or status ("active" = queued, fetching, or reviewing).',
    inputSchema: {
      q: z.string().min(1).max(200).optional().describe('Free-text filter on ticket key/title, repo, and branch.'),
      repo: z.string().min(1).max(200).optional(),
      ticket: z.string().min(1).max(64).optional().describe('Exact ticket key.'),
      status: z.enum(['active', ...ALL_STATUSES]).optional()
        .describe('One status, or "active" for queued, fetching, and reviewing.'),
      limit: z.number().int().min(1).max(100).optional().describe('Rows to return (default 20).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ q, repo, ticket, status, limit }) => guarded(async () => {
    const want = limit ?? 20;
    // The API has no status filter, so a filtered listing scans a wider window.
    const { reviews, total } = await api.listReviews<{ reviews: ReviewRow[]; total: number }>({
      q, repo, ticket, limit: status ? 500 : want,
    });
    const matches = (s: string): boolean =>
      !status || (status === 'active' ? (ACTIVE_STATUSES as readonly string[]).includes(s) : s === status);
    const matching = reviews.filter((r) => matches(r.status));
    const rows = matching.slice(0, want);
    return ok({
      // With a status filter, `total` counts matches among the reviews scanned.
      total: status ? matching.length : total,
      shown: rows.length,
      ...(status && total > reviews.length
        ? { note: `status filter applied to the newest ${reviews.length} of ${total} reviews` }
        : {}),
      reviews: rows.map((r) => reviewListRow(r, api.reviewUrl(r.id))),
    });
  }));

  server.registerTool('cancel_review', {
    title: 'Cancel a review',
    description:
      'Cancel a queued or running review (status queued, fetching, or reviewing). The reviewer processes are ' +
      'killed and the status becomes cancelled. Fails if the review has already finished.',
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ id }) => guarded(async () => {
    const refused = refusal();
    if (refused) return fail(refused);
    const { review } = await api.cancel<{ review: ReviewRow }>(id);
    return ok({ cancelled: review.status === 'cancelled', review: reviewRef(review, api.reviewUrl(id)) });
  }));

  server.registerTool('rerun_review', {
    title: 'Re-run a review',
    description:
      'Start a new run of an existing review: same repo, branch, base, and ticket, optionally with another ' +
      'reviewer or model (a model id belongs to one reviewer; switching reviewer without a model uses that ' +
      "reviewer's default). Local reviews re-read the clone, so new commits are included. Returns the new " +
      'review; poll it with wait_for_review.',
    inputSchema: {
      id: idSchema,
      reviewer: z.enum(REVIEWER_NAMES).optional(),
      model: z.string().min(1).max(64).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ id, reviewer, model }) => guarded(async () => {
    const refused = refusal();
    if (refused) return fail(refused);
    const { review } = await api.rerun<{ review: ReviewRow }>(id, {
      ...(reviewer ? { reviewer } : {}),
      ...(model ? { model } : {}),
    });
    return ok({
      review: reviewRef(review, api.reviewUrl(review.id)),
      next: 'Call wait_for_review with the new id until finished=true.',
    });
  }));

  return server;
}
