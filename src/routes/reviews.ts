import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  getReviewer,
  notInstalledMessage,
  resolveRerunChoice,
  REVIEWER_NAMES,
} from '../reviewers/index.js';
import {
  createReview,
  deleteReview,
  getFindings,
  getReviewFiles,
  getLogs,
  getObservations,
  getPreviousRun,
  getRequirements,
  getReview,
  listReviewGroups,
  listReviews,
  updateReview,
} from '../db.js';
import { compareFindings, toComparable } from '../findingCompare.js';
import { githubLinks, rowLinks } from '../githubLinks.js';
import { subscribe } from '../events.js';
import { cancelReview, enqueueReview } from '../queue.js';
import { rawOutputDir } from '../reportWriter.js';
import { resolveTargets } from '../resolver.js';
import { coverageForReview, coveragePending } from '../coverage.js';
import { fallbackGroupKey, groupKeyFor } from '../groupKey.js';
import { applyGroupBases, joinGroup } from '../ticketGroups.js';
import { getTicketBranch, latestDoneCoverage, parseCoverageRequirements, syncMembersFromReviews } from '../ticketStore.js';
import type { ResolvedTarget, ReviewRow, TicketInfo } from '../types.js';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);

const idParams = z.object({ id: z.coerce.number().int().positive() });

const targetSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
});

const createBody = z.object({
  input: z.string().min(1).max(512),
  targets: z.array(targetSchema).optional(),
  reviewer: z.enum(REVIEWER_NAMES).optional(),
  model: z.string().min(1).max(64).optional(),
  // Requirements pasted by hand, used instead of a ticket.
  requirementsText: z.string().min(1).max(20_000).optional(),
  // local:<repo>#<branch> only: review the clone's uncommitted changes too.
  includeWorkingTree: z.boolean().optional(),
  // local:<repo>#<branch> only: the branch to diff against; absent → the detected parent.
  baseBranch: z.string().min(1).max(255).optional(),
});

// Optional overrides for a re-run; an absent or empty body keeps the old run's choice.
const rerunBody = z.object({
  reviewer: z.enum(REVIEWER_NAMES).optional(),
  model: z.string().min(1).max(64).optional(),
});

const listQuery = z.object({
  ticket: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  // Exact group key, as returned by /api/review-groups.
  group: z.string().min(1).max(600).optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const groupsQuery = z.object({
  q: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'failed', 'done']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function startRun(
  target: ResolvedTarget,
  ticket: TicketInfo | null,
  reviewerName: string | undefined,
  model: string | undefined,
): ReviewRow {
  const reviewer = getReviewer(reviewerName);
  // A missing CLI is a configuration problem, not a failed review: refuse it
  // before a row is created and queued.
  if (!reviewer.isAvailable()) throw new Error(notInstalledMessage(reviewer));
  const review = createReview({
    // A manual ticket carries requirements but no key or URL.
    ticket_key: ticket?.key || null,
    ticket_title: ticket?.title || null,
    ticket_url: ticket?.url || null,
    ticket_body: ticket?.body ?? null,
    repo: target.repo,
    branch: target.branch,
    base_branch: target.baseBranch,
    pr_number: target.prNumber ?? null,
    source: target.source ?? 'github',
    working_tree: target.source === 'local' && target.includeWorkingTree ? 1 : 0,
    base_reason: target.baseReason ?? null,
    status: 'queued',
    reviewer: reviewer.name,
    model: model ?? reviewer.defaultModel,
  });
  enqueueReview(review.id);
  return review;
}

function reportAbsPath(row: ReviewRow): string | null {
  if (!row.report_path) return null;
  const abs = path.resolve(config.DATA_DIR, row.report_path);
  // Never let a stored path escape DATA_DIR.
  if (!abs.startsWith(path.resolve(config.DATA_DIR) + path.sep)) return null;
  return abs;
}

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/reviews', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' });
    const { input, targets, reviewer, model, requirementsText, includeWorkingTree, baseBranch } = parsed.data;

    let ticket: TicketInfo | null = null;
    let chosen: ResolvedTarget[];
    try {
      const resolved = await resolveTargets(input, { requirementsText, includeWorkingTree, baseBranch });
      ticket = resolved.ticket;
      chosen = targets && targets.length > 0
        ? resolved.targets.filter((t) =>
            targets.some((sel) => sel.repo === t.repo && sel.branch === t.branch))
        : resolved.targets;
      if (chosen.length === 0) chosen = (targets ?? []).map((t) => ({
        repo: t.repo,
        branch: t.branch,
        baseBranch: t.baseBranch,
        prNumber: t.prNumber ?? null,
      }));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    if (chosen.length === 0) return reply.code(400).send({ error: 'No targets to review' });

    // A branch of a ticket joins the ticket's group and is diffed against its parent there.
    try {
      chosen = await withGroupBases(chosen, ticket, Boolean(baseBranch?.trim()));
    } catch (err) {
      req.log?.warn?.(`ticket group: ${(err as Error).message}`);
    }

    try {
      const reviews = chosen.map((t) => startRun(t, ticket, reviewer, model));
      return reply.code(201).send({ reviews });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/reviews', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const { limit = 50, offset = 0, ...rest } = parsed.data;
    const { reviews, total } = listReviews({ ...rest, limit, offset });
    // GitHub pages of each row's branch and PR: the UI does not know the organization.
    return { reviews: reviews.map((r) => ({ ...r, links: rowLinks(config.GITHUB_ORG, r) })), total };
  });

  // The history grouped by ticket (see groupKey.ts), most recently active first.
  app.get('/api/review-groups', async (req, reply) => {
    const parsed = groupsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const { limit = 20, offset = 0, ...rest } = parsed.data;
    const { groups, total } = listReviewGroups({ ...rest, limit, offset });
    return {
      total,
      groups: groups.map((g) => ({
        ...g,
        branches: g.branches.map((b) => ({
          ...b,
          links: rowLinks(config.GITHUB_ORG, { repo: b.repo, branch: b.branch, pr_number: b.prNumber }),
        })),
      })),
    };
  });

  app.get('/api/reviews/:id', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });

    const findings = getFindings(review.id);
    const previous = getPreviousRun(review.repo, review.branch, review.run_index);
    const comparison = previous
      ? {
          previousRunId: previous.id,
          previousRunIndex: previous.run_index,
          ...compareFindings(
            getFindings(previous.id).map(toComparable),
            findings.map(toComparable),
          ),
        }
      : null;

    return {
      review,
      requirements: getRequirements(review.id),
      findings,
      observations: getObservations(review.id),
      changed_files: getReviewFiles(review.id),
      logs: getLogs(review.id),
      comparison,
      links: githubLinks(config.GITHUB_ORG, review),
      ticket_group: ticketGroupContext(review),
    };
  });

  app.get('/api/reviews/:id/report', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    const abs = reportAbsPath(review);
    if (!abs) return reply.code(404).send({ error: 'No report for this review' });
    try {
      const md = await fs.readFile(abs, 'utf8');
      return reply.type('text/markdown; charset=utf-8').send(md);
    } catch {
      return reply.code(404).send({ error: 'Report file is missing' });
    }
  });

  app.post('/api/reviews/:id/rerun', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const prev = getReview(parsed.data.id);
    if (!prev) return reply.code(404).send({ error: 'Review not found' });

    // Pasted requirements are stored without a key; they must survive a re-run too.
    const ticket: TicketInfo | null = prev.ticket_key || prev.ticket_body
      ? ({
          provider: prev.ticket_key ? 'stored' : 'manual',
          key: prev.ticket_key ?? '',
          title: prev.ticket_title ?? '',
          url: prev.ticket_url ?? '',
          body: prev.ticket_body ?? '',
          state: prev.ticket_key ? '' : 'manual',
          branchName: prev.ticket_key ? prev.branch : null,
          comments: [],
          attachmentUrls: [],
        } satisfies TicketInfo)
      : null;

    const body = rerunBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid request body' });

    let review: ReviewRow;
    try {
      const choice = resolveRerunChoice(prev, body.data);
      let target: ResolvedTarget = {
        repo: prev.repo,
        branch: prev.branch,
        baseBranch: prev.base_branch,
        prNumber: prev.pr_number ?? null,
        // A local re-run reads the clone again, so new commits are picked up.
        source: prev.source === 'local' ? 'local' : 'github',
        includeWorkingTree: prev.source === 'local' && prev.working_tree === 1,
        // The stored base is kept as-is (it may have been chosen by hand); never re-detected.
        ...(prev.base_reason ? { baseReason: prev.base_reason } : {}),
      };
      // A branch of a ticket group follows its parent there, which may have been changed since.
      // A base chosen by hand for the run itself is kept, unless the group's parent was set by hand later.
      if (prev.group_key && prev.group_key !== fallbackGroupKey(prev.repo, prev.branch)) {
        const member = getTicketBranch(prev.group_key, prev.repo, prev.branch);
        if (member && (prev.base_reason !== 'chosen' || member.parent_reason === 'user')) {
          [target] = applyGroupBases(prev.group_key, [target]) as [ResolvedTarget];
        }
      }
      review = startRun(target, ticket, choice.reviewer.name, choice.model);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return reply.code(201).send({ review });
  });

  app.post('/api/reviews/:id/cancel', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    if (!ACTIVE.has(review.status)) {
      return reply.code(409).send({ error: `Review is already ${review.status}` });
    }
    cancelReview(review.id);
    const after = getReview(review.id);
    if (after && ACTIVE.has(after.status)) {
      updateReview(review.id, { status: 'cancelled', finished_at: new Date().toISOString() });
    }
    return { review: getReview(review.id) };
  });

  app.delete('/api/reviews/:id', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    if (ACTIVE.has(review.status)) cancelReview(review.id);

    const abs = reportAbsPath(review);
    if (abs) {
      await fs.rm(abs, { force: true });
      await fs.rm(rawOutputDir(abs), { recursive: true, force: true });
    }
    deleteReview(review.id);
    return { ok: true };
  });

  app.get('/api/reviews/:id/events', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'status', reviewId: review.id, status: review.status })}\n\n`);

    const unsubscribe = subscribe(review.id, (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

  });
}

/**
 * The group key of a target, or null when it has none: the ticket key, else a
 * ticket-like key from the branch name (as the history groups it).
 */
function ticketGroupOf(target: ResolvedTarget, ticket: TicketInfo | null): string | null {
  const key = groupKeyFor({ ticket_key: ticket?.key || null, repo: target.repo, branch: target.branch });
  return key === fallbackGroupKey(target.repo, target.branch) ? null : key;
}

/**
 * Each target of a ticket joins its group (parents are detected for new
 * members) and gets the group's parent as its base, unless a base was chosen
 * explicitly.
 */
export async function withGroupBases(
  targets: ResolvedTarget[],
  ticket: TicketInfo | null,
  explicitBase: boolean,
): Promise<ResolvedTarget[]> {
  const out: ResolvedTarget[] = [];
  const byGroup = new Map<string, ResolvedTarget[]>();
  for (const t of targets) {
    const key = ticketGroupOf(t, ticket);
    if (!key) continue;
    const list = byGroup.get(key) ?? [];
    list.push(t);
    byGroup.set(key, list);
  }
  for (const [key, list] of byGroup) {
    await joinGroup(key, ticket?.key === key ? ticket : null, list, undefined, { detect: 'new' });
  }
  for (const t of targets) {
    const key = ticketGroupOf(t, ticket);
    out.push(key ? applyGroupBases(key, [t], { explicitBase: explicitBase || t.baseReason === 'chosen' })[0]! : t);
  }
  return out;
}

/** For a review of a ticket group: its place in the group and the group's latest coverage, seen from it. */
function ticketGroupContext(review: ReviewRow) {
  if (!review.group_key || review.group_key === fallbackGroupKey(review.repo, review.branch)) return null;
  const key = review.group_key;
  syncMembersFromReviews(key);
  const member = getTicketBranch(key, review.repo, review.branch);
  const coverage = latestDoneCoverage(key);
  return {
    key,
    parent: member?.parent_branch ?? null,
    parent_reason: member?.parent_reason ?? null,
    coverage: coverage ? coverageForReview(review, coverage, parseCoverageRequirements(coverage)) : null,
    coverage_pending: coveragePending(key),
  };
}
