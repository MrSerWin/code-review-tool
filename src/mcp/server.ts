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
import type { ResolvedTarget, ReviewGroup, ReviewRow, TicketInfo } from '../types.js';
import { ApiClient, ApiError, ApiUnreachableError } from './client.js';
import {
  ALL_STATUSES, ACTIVE_STATUSES, compactGroup, compactLocalRepos, compactPreview, compactRecipes, compactReviewers,
  DEFAULT_MAX_BRANCHES, DEFAULT_MAX_FINDINGS, DEFAULT_REPORT_MAX, isPreviewSettled, isTerminalStatus,
  mutationRefusal, parseTargetSelector, PREVIEW_END_STATUSES, PREVIEW_LIVE_STATUSES, reviewDetail, reviewListRow, reviewRef,
  selectTargets, truncateReport, type PreviewPayload, type RecipePayload, type ReviewDetailPayload,
} from './format.js';

const version = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version ?? '0.0.0';

export const WAIT_DEFAULT_SEC = 50;
export const WAIT_MAX_SEC = 600;
export const POLL_DEFAULT_SEC = 5;

const INSTRUCTIONS = `code-review-tool runs read-only code reviews of git branches (GitHub or local clones) with a reviewer CLI (Claude Code, Codex, Cursor Agent, or Grok) and returns a verdict, a requirement checklist, and findings.
Typical flow: start_review -> wait_for_review (repeat while finished=false) -> get_review / get_report.
A review takes several minutes (often 5-20). Never start the same review twice to check on it: poll the id you got.
For a branch that is not pushed yet, use list_local_repos to find the repo name and branch, then start_review with "local:<repo>#<branch>".
Previews run a ticket's branches as a live app on a local port: list_recipes -> start_preview -> wait_for_preview (repeat while finished=false) -> open web_url -> stop_preview when done. A role can run a local (unpushed) branch: {role, branch: "local:<repo>#<branch>"} or {role, branch, local: true}.`;

const idSchema = z.number().int().positive().describe('Review id, as returned by start_review or list_reviews.');
const previewIdSchema = z.number().int().positive()
  .describe('Preview id, as returned by start_preview or list_previews.');

export const PREVIEW_WAIT_DEFAULT_SEC = 120;

const DUMP_MODES = ['auto', 'dump-dir', 'pg_dump', 'none', 'clean'] as const;

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
      '- "https://github.com/<org>/<repo>/pull/12" pull request URL (exactly that PR\'s branch), or a /tree/<branch> URL\n' +
      '- "<org>/<repo>#12" the same pull request; when 12 is an issue, the GitHub issue as a ticket\n' +
      '- "https://github.com/<org>/<repo>/issues/12" a GitHub issue as a ticket\n' +
      '- "my-service#feature/x" a pushed branch of an allowed repo\n' +
      '- "local:my-service#feature/x" a branch of the local clone, pushed or not (see list_local_repos); ' +
      '"local:my-service" = the checked-out branch\n' +
      'GitHub links may also use http://, www.github.com, or <...> around them. ' +
      'When a ticket resolves to several branches, all of them are reviewed unless "targets" narrows it. ' +
      'Returns {reviews:[{id, repo, branch, base, reviewer, model, status, url}]}.',
    inputSchema: {
      input: z.string().min(1).max(512)
        .describe('Ticket key, PR or issue URL, "org/repo#12", "repo#branch", or "local:repo#branch".'),
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
      'Recent reviews (single runs), newest first, as compact rows (id, status, ticket, repo, branch, base, ' +
      'reviewer, model, verdict, can_merge, blocking_count, url). Filter by free text q (matches ticket key/title, ' +
      'repo, branch, group key), repo, ticket, group, or status ("active" = queued, fetching, or reviewing). ' +
      'For an overview by ticket use list_review_groups; group=<key> from there lists every run of that group.',
    inputSchema: {
      q: z.string().min(1).max(200).optional()
        .describe('Free-text filter on ticket key/title, repo, branch, and group key.'),
      repo: z.string().min(1).max(200).optional(),
      ticket: z.string().min(1).max(64).optional()
        .describe('Exact ticket key. Misses runs started with pasted requirements; use group for those.'),
      group: z.string().min(1).max(600).optional()
        .describe('Exact group key from list_review_groups: every run of that ticket, including runs with ' +
          'pasted requirements whose branch name carries the key, or of that repo#branch.'),
      status: z.enum(['active', ...ALL_STATUSES]).optional()
        .describe('One status, or "active" for queued, fetching, and reviewing.'),
      limit: z.number().int().min(1).max(100).optional().describe('Rows to return (default 20).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ q, repo, ticket, group, status, limit }) => guarded(async () => {
    const want = limit ?? 20;
    // The API has no status filter, so a filtered listing scans a wider window.
    const { reviews, total } = await api.listReviews<{ reviews: ReviewRow[]; total: number }>({
      q, repo, ticket, group, limit: status ? 500 : want,
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

  server.registerTool('list_review_groups', {
    title: 'List review groups',
    description:
      'The review history grouped by ticket, most recently active group first. A group is a ticket key (from the ' +
      'tracker, or found in the branch name when requirements were pasted by hand, e.g. feat/abc-123-x -> ABC-123), ' +
      'or a single "repo#branch" when there is neither (is_ticket=false). Each group has its title, run count, ' +
      'number of active runs, and one entry per repo/branch with that branch\'s latest run (id, run, status, ' +
      'verdict, can_merge, url). Filter by free text q (ticket key/title, repo, branch) or status: "active" (a run ' +
      'is queued, fetching, or reviewing), "failed" (a branch\'s latest run failed), "done" (nothing running or ' +
      'failed, at least one verdict). Page with limit/offset. list_reviews with group=<key> lists every run of a group.',
    inputSchema: {
      q: z.string().min(1).max(200).optional().describe('Free-text filter on ticket key/title, repo, and branch.'),
      status: z.enum(['active', 'failed', 'done']).optional()
        .describe('"active", "failed", or "done", judged per group as described above.'),
      limit: z.number().int().min(1).max(50).optional().describe('Groups to return (default 10).'),
      offset: z.number().int().min(0).optional().describe('Groups to skip, for the next page (default 0).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ q, status, limit, offset }) => guarded(async () => {
    const want = limit ?? 10;
    const skip = offset ?? 0;
    const { groups, total } = await api.reviewGroups<{ groups: ReviewGroup[]; total: number }>({
      q, status, limit: want, offset: skip,
    });
    const nextOffset = skip + groups.length;
    return ok({
      total,
      offset: skip,
      shown: groups.length,
      ...(nextOffset < total ? { next_offset: nextOffset } : {}),
      groups: groups.map((g) => compactGroup(g, (id) => api.reviewUrl(id))),
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

  // --- previews ---------------------------------------------------------------

  server.registerTool('list_recipes', {
    title: 'List preview recipes',
    description:
      'The preview recipes configured on this code-review-tool: for each, its name, roles (role -> repo; use the ' +
      'role names in start_preview), the database it loads, and how long it may take to become ready. ' +
      '"enabled" is false when previews are switched off (PREVIEW_ENABLED).',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guarded(async () => ok(compactRecipes(await api.recipes<{
    enabled: boolean; recipes: RecipePayload[]; errors?: { error: string }[];
  }>()))));

  server.registerTool('start_preview', {
    title: 'Start a preview',
    description:
      'Start a live preview: the recipe\'s repos (e.g. backend + frontend) checked out at the chosen branches and ' +
      'run on free local ports with their own database. Returns at once with the preview id; it takes minutes ' +
      '(longer the first time dependencies change). Then call wait_for_preview(id) until finished=true and open ' +
      'web_url. Stop it with stop_preview when done; it also expires on its own.\n' +
      'Branches per role, in order of precedence:\n' +
      '- roles: [{role, branch}] picks a branch by hand; an empty branch runs the role\'s base branch.\n' +
      '- a local (unpushed) branch: {role, branch: "local:<repo>#<branch>"} or {role, branch: "<branch>", local: ' +
      'true}; it is copied (committed state only) from the configured clone, so a branch checked out in a git ' +
      'worktree of that clone works too. "local:<repo>" alone = the clone\'s checked-out branch. See ' +
      'list_local_repos for repo names and branches.\n' +
      '- review_id: the reviewed branch runs for its repo (a local review is copied from the clone again).\n' +
      '- ticket: "ABC-123", a PR URL, "repo#branch", or "local:<repo>#<branch>"; the ticket\'s branches run for ' +
      'the repos it touches.\n' +
      'A role with no branch from any of these runs its base branch (used_base=true in the result).',
    inputSchema: {
      recipe: z.string().min(1).max(128).optional()
        .describe('Recipe name (see list_recipes). Optional when only one recipe is configured.'),
      roles: z.array(z.object({
        role: z.string().min(1).max(64).describe('Role name from the recipe, e.g. "backend".'),
        branch: z.string().max(300).optional()
          .describe('Branch to run; "local:<repo>#<branch>" for a branch of the local clone. Empty: base branch.'),
        base: z.string().max(255).optional().describe('Base branch of this role. Default: the repo default.'),
        local: z.boolean().optional().describe('Copy the branch from the local clone instead of GitHub.'),
      })).max(20).optional()
        .describe('Branches picked by hand, one entry per role. Roles left out follow review_id / ticket.'),
      review_id: z.number().int().positive().optional()
        .describe('Preview the branch of this review (its repo), plus its ticket\'s branches for the other repos.'),
      ticket: z.string().min(1).max(256).optional()
        .describe('Ticket key, PR URL, "repo#branch", or "local:repo#branch" to resolve branches from.'),
      dump_mode: z.enum(DUMP_MODES).optional()
        .describe('Database contents: auto (default), pg_dump (fresh dump), dump-dir (stored dump), clean or none.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => guarded(async () => {
    const refused = refusal();
    if (refused) return fail(refused);
    if (!args.roles?.length && args.review_id === undefined && !args.ticket) {
      return fail('Give roles, review_id, or ticket: a preview needs at least one of them to pick branches.');
    }
    const body = {
      ...(args.recipe ? { recipe: args.recipe } : {}),
      ...(args.roles?.length ? { roles: args.roles } : {}),
      ...(args.review_id !== undefined ? { reviewId: args.review_id } : {}),
      ...(args.ticket ? { ticket: args.ticket } : {}),
      ...(args.dump_mode ? { dumpMode: args.dump_mode } : {}),
    };
    const { preview } = await api.createPreview<{ preview: PreviewPayload }>(body);
    return ok({
      preview: compactPreview(preview, { page: api.previewPage(preview.review_id) }),
      next: 'Call wait_for_preview with this id until finished=true, then open web_url.',
    });
  }));

  server.registerTool('get_preview', {
    title: 'Get a preview',
    description:
      'Status of one preview: queued | preparing | starting | ready | stopping | stopped | failed | expired, the ' +
      'branch, source (github or local) and commit each role runs, web_url once ready, ports, data mode, ' +
      'expiry, and "error" when it failed. "progress" is the latest log line while it works; tail_logs adds the ' +
      'last log lines.',
    inputSchema: {
      id: previewIdSchema,
      tail_logs: z.number().int().min(0).max(200).optional().describe('Log lines to include (default 0).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, tail_logs }) => guarded(async () => {
    const { preview, logs } = await api.preview<{ preview: PreviewPayload; logs: { message: string }[] }>(id);
    return ok({
      ...compactPreview(preview, { page: api.previewPage(preview.review_id), logs }),
      ...(tail_logs ? { logs: logs.slice(-tail_logs).map((l) => l.message) } : {}),
    });
  }));

  server.registerTool('wait_for_preview', {
    title: 'Wait for a preview',
    description:
      'Wait until a preview is ready or has ended (stopped, failed, expired), polling its status, for at most ' +
      `timeoutSec seconds (default ${PREVIEW_WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC}; keep it below your MCP tool ` +
      'timeout). Returns the same fields as get_preview plus "finished" and "waited_sec". If finished=false it is ' +
      'still starting: call wait_for_preview again with the same id. On failure the last log lines are included.',
    inputSchema: {
      id: previewIdSchema,
      timeoutSec: z.number().int().min(1).max(WAIT_MAX_SEC).optional()
        .describe(`Longest time to wait, in seconds (default ${PREVIEW_WAIT_DEFAULT_SEC}).`),
      pollSec: z.number().int().min(1).max(60).optional()
        .describe(`Seconds between status checks (default ${POLL_DEFAULT_SEC}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, timeoutSec, pollSec }, extra) => guarded(async () => {
    const timeoutMs = (timeoutSec ?? PREVIEW_WAIT_DEFAULT_SEC) * 1000;
    const pollMs = (pollSec ?? POLL_DEFAULT_SEC) * 1000;
    const started = Date.now();
    const deadline = started + timeoutMs;
    const progressToken = extra._meta?.progressToken;
    type Detail = { preview: PreviewPayload; logs: { message: string }[] };

    let payload = await api.preview<Detail>(id, extra.signal);
    while (!isPreviewSettled(payload.preview.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining), extra.signal);
      payload = await api.preview<Detail>(id, extra.signal);
      if (progressToken !== undefined) {
        const last = payload.logs.at(-1)?.message;
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: Math.round((Date.now() - started) / 1000),
            total: Math.round(timeoutMs / 1000),
            message: `preview ${id}: ${payload.preview.status}${last ? ` - ${last.slice(0, 120)}` : ''}`,
          },
        }).catch(() => { /* progress is best-effort */ });
      }
    }

    const { preview, logs } = payload;
    const finished = isPreviewSettled(preview.status);
    return ok({
      finished,
      waited_sec: Math.round((Date.now() - started) / 1000),
      ...compactPreview(preview, { page: api.previewPage(preview.review_id), logs }),
      ...(preview.status === 'failed' ? { logs: logs.slice(-20).map((l) => l.message) } : {}),
      ...(finished ? {} : { next: 'Still starting. Call wait_for_preview again with the same id.' }),
    });
  }));

  server.registerTool('stop_preview', {
    title: 'Stop a preview',
    description:
      'Stop a preview and tear it down: its processes and containers are stopped, its database and checkouts ' +
      'removed, its ports freed. Waits for the teardown (up to a few minutes). A preview that has already ' +
      'ended is left as it is.',
    inputSchema: { id: previewIdSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ id }) => guarded(async () => {
    const refused = refusal();
    if (refused) return fail(refused);
    const { preview } = await api.stopPreview<{ preview: PreviewPayload | null }>(id);
    if (!preview) return ok({ stopped: true, id });
    const ended = (PREVIEW_END_STATUSES as readonly string[]).includes(preview.status);
    return ok({
      stopped: ended,
      ...compactPreview(preview, { page: api.previewPage(preview.review_id) }),
      ...(ended ? {} : { next: 'Teardown is still running; check get_preview in a moment.' }),
    });
  }));

  server.registerTool('list_previews', {
    title: 'List previews',
    description:
      'Recent previews, newest first: id, status, recipe, ticket, review_id, web_url (while ready), and per role ' +
      'the branch, source (github or local) and commit. Filter by review_id, ticket, recipe, or status ("live" = ' +
      'queued, preparing, starting, ready, or stopping).',
    inputSchema: {
      review_id: z.number().int().positive().optional(),
      ticket: z.string().min(1).max(256).optional(),
      recipe: z.string().min(1).max(128).optional(),
      status: z.enum(['live', 'queued', 'preparing', 'starting', 'ready', 'stopping', 'stopped', 'failed', 'expired'])
        .optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Rows to return (default 20).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ review_id, ticket, recipe, status, limit }) => guarded(async () => {
    const want = limit ?? 20;
    // The API has no status filter, so a filtered listing scans a wider window.
    const { previews, total } = await api.listPreviews<{ previews: PreviewPayload[]; total: number }>({
      reviewId: review_id, ticket, recipe, limit: status ? 500 : want,
    });
    const matches = (s: string): boolean =>
      !status || (status === 'live' ? (PREVIEW_LIVE_STATUSES as readonly string[]).includes(s) : s === status);
    const matching = previews.filter((p) => matches(p.status));
    const rows = matching.slice(0, want);
    return ok({
      total: status ? matching.length : total,
      shown: rows.length,
      previews: rows.map((p) => compactPreview(p, { page: api.previewPage(p.review_id) })),
    });
  }));

  return server;
}
