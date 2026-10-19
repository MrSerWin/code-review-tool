import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { coveragePending, recomputeCoverage } from '../coverage.js';
import { db } from '../db.js';
import { rowLinks } from '../githubLinks.js';
import { resolveTargets } from '../resolver.js';
import { REVIEWER_NAMES } from '../reviewers/index.js';
import {
  applyGroupBases, defaultDetectDeps, detectGroupParents, GroupError, joinGroup, orderBatch, orderedMembers, setChainOrder,
  setParentByHand, ticketGroupView, type DetectDeps, type TicketGroupView,
} from '../ticketGroups.js';
import {
  getTicketGroup, getTicketRun, latestCoverage, latestDoneCoverage, latestTicketRun, createTicketRun, getCoverage, parseCoverageRequirements,
  parseIds, syncMembersFromReviews,
} from '../ticketStore.js';
import type { ResolvedTarget, ReviewRow, TicketCoverageRow, TicketInfo, TicketRunRow } from '../types.js';
import { startRun } from './reviews.js';

export interface TicketRouteDeps {
  resolve: typeof resolveTargets;
  detect: DetectDeps;
  startRun: (
    target: ResolvedTarget, ticket: TicketInfo | null, reviewer: string | undefined, model: string | undefined,
    opts?: { dependsOn?: number | null },
  ) => ReviewRow;
  recompute: typeof recomputeCoverage;
  pending: (key: string) => boolean;
}

const defaultDeps: TicketRouteDeps = {
  resolve: resolveTargets,
  detect: defaultDetectDeps,
  startRun,
  recompute: recomputeCoverage,
  pending: coveragePending,
};

const keyParams = z.object({ key: z.string().trim().min(1).max(200) });

const branchRef = z.string().min(3).max(300).regex(/^[^#]+#.+$/, 'expected "repo#branch"');

const reviewBody = z.object({
  reviewer: z.enum(REVIEWER_NAMES).optional(),
  model: z.string().min(1).max(64).optional(),
  // Added to the ticket text: approved decisions, or this ticket's scope in words.
  requirementsText: z.string().min(1).max(20_000).optional(),
  // Only these branches of the group, as "repo#branch"; all by default.
  branches: z.array(branchRef).min(1).max(40).optional(),
  // Ask the tracker for the ticket's branches again (default true).
  refresh: z.boolean().optional(),
});

const coverageBody = z.object({
  reviewer: z.enum(REVIEWER_NAMES).optional(),
  model: z.string().min(1).max(64).optional(),
});

const parentBody = z.object({
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(255),
  // null or empty: the repository's default branch.
  parent: z.string().max(255).nullable(),
});

const orderBody = z.object({
  repo: z.string().min(1).max(200),
  branches: z.array(z.string().min(1).max(255)).min(1).max(40),
  root: z.string().min(1).max(255).optional(),
});

const detectBody = z.object({ reset: z.boolean().optional() });

const reportQuery = z.object({ id: z.coerce.number().int().positive().optional() });
const groupQuery = z.object({ run: z.coerce.number().int().positive().optional() });

/** A coverage row as the API returns it, requirements parsed. */
export function coveragePayload(row: TicketCoverageRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    ticket_key: row.ticket_key,
    status: row.status,
    verdict: row.verdict,
    summary: row.summary,
    requirements: parseCoverageRequirements(row),
    review_ids: parseIds(row.review_ids),
    reviewer: row.reviewer,
    model: row.model,
    report_path: row.report_path,
    error: row.error,
    trigger: row.trigger,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

export function runPayload(run: TicketRunRow | undefined | null) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    review_ids: parseIds(run.review_ids),
    coverage_id: run.coverage_id,
    created_at: run.created_at,
    finished_at: run.finished_at,
  };
}

function withLinks(view: TicketGroupView) {
  return {
    ...view,
    chains: view.chains.map((c) => ({
      ...c,
      branches: c.branches.map((b) => ({
        ...b,
        links: rowLinks(config.GITHUB_ORG, { repo: b.repo, branch: b.branch, pr_number: b.prNumber }),
      })),
    })),
  };
}

/** Everything a ticket page and `get_ticket` show. */
export function ticketPayload(key: string, pending: (key: string) => boolean = coveragePending, runId?: number) {
  const view = ticketGroupView(key);
  if (!view) return null;
  const done = latestDoneCoverage(key);
  const latest = latestCoverage(key);
  return {
    group: withLinks(view),
    coverage: coveragePayload(done),
    // A newer pass that is still running or failed, next to the last finished one.
    latest_coverage: latest && latest.id !== done?.id
      ? { id: latest.id, status: latest.status, error: latest.error, created_at: latest.created_at }
      : null,
    coverage_pending: pending(key) || latest?.status === 'running',
    run: runPayload(runId ? ownRun(key, runId) : latestTicketRun(key)),
  };
}

function ownRun(key: string, id: number): TicketRunRow | undefined {
  const run = getTicketRun(id);
  return run?.ticket_key === key ? run : undefined;
}

/** The ticket as the reviews of its group stored it, for a group the tracker cannot answer for. */
function storedTicket(key: string): TicketInfo | null {
  const row = db
    .prepare<[string], Pick<ReviewRow, 'ticket_title' | 'ticket_url' | 'ticket_body'>>(
      `SELECT ticket_title, ticket_url, ticket_body FROM reviews
        WHERE group_key = ? AND TRIM(COALESCE(ticket_body, '')) <> '' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(key);
  const group = getTicketGroup(key);
  if (!row && !group) return null;
  return {
    provider: 'stored', key, title: row?.ticket_title ?? group?.title ?? '', url: row?.ticket_url ?? group?.ticket_url ?? '',
    body: row?.ticket_body ?? '', state: '', branchName: null, comments: [], attachmentUrls: [],
  };
}

function withAddedRequirements(ticket: TicketInfo, text: string | undefined): TicketInfo {
  if (!text?.trim()) return ticket;
  const body = [ticket.body?.trim() || '(the ticket has no description)', '', '## Added requirements and decisions', '', text.trim()].join('\n');
  return { ...ticket, body };
}

function sendGroupError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof GroupError) return reply.code(err.status).send({ error: err.message });
  return reply.code(400).send({ error: (err as Error).message });
}

export async function ticketGroupRoutes(app: FastifyInstance, opts: { deps?: Partial<TicketRouteDeps> } = {}): Promise<void> {
  const deps: TicketRouteDeps = { ...defaultDeps, ...(opts.deps ?? {}) };

  app.get('/api/ticket-groups/:key', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const query = groupQuery.safeParse(req.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: 'Invalid ticket key' });
    const payload = ticketPayload(parsed.data.key, deps.pending, query.data.run);
    if (!payload) return reply.code(404).send({ error: `No ticket group ${parsed.data.key}` });
    return payload;
  });

  app.get('/api/ticket-groups/:key/coverage/report', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const query = reportQuery.safeParse(req.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: 'Invalid request' });
    const row = query.data.id ? getCoverage(query.data.id) : latestDoneCoverage(parsed.data.key);
    if (!row || row.ticket_key !== parsed.data.key || !row.report_path) {
      return reply.code(404).send({ error: 'No coverage report for this ticket' });
    }
    const abs = path.resolve(config.DATA_DIR, row.report_path);
    if (!abs.startsWith(path.resolve(config.DATA_DIR) + path.sep)) return reply.code(404).send({ error: 'No report' });
    try {
      return reply.type('text/markdown; charset=utf-8').send(await fs.readFile(abs, 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'Coverage report file is missing' });
    }
  });

  app.post('/api/tickets/:key/review', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const body = reviewBody.safeParse(req.body ?? {});
    if (!parsed.success || !body.success) return reply.code(400).send({ error: 'Invalid request body' });
    const key = parsed.data.key;
    const { reviewer, model, requirementsText, branches, refresh = true } = body.data;

    let ticket: TicketInfo | null = null;
    let targets: ResolvedTarget[] = [];
    let resolveError: string | null = null;
    if (refresh) {
      try {
        const resolved = await deps.resolve(key);
        ticket = resolved.ticket;
        targets = resolved.targets;
        if (ticket?.key && ticket.key !== key) {
          return reply.code(400).send({ error: `${key} resolves to ticket ${ticket.key}; use that key` });
        }
      } catch (err) {
        resolveError = (err as Error).message;
      }
    }
    syncMembersFromReviews(key);
    if (!ticket) ticket = storedTicket(key);
    if (!ticket) {
      return reply.code(404).send({ error: resolveError ?? `No ticket group ${key}: review one of its branches first` });
    }

    try {
      await joinGroup(key, ticket, targets, deps.detect, { detect: 'all', requirementsText: requirementsText ?? null });
    } catch (err) {
      return sendGroupError(reply, err);
    }

    let members = orderedMembers(key);
    if (branches) {
      const wanted = new Set(branches);
      const unknown = branches.filter((b) => !members.some((m) => `${m.repo}#${m.branch}` === b));
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: `Not branches of ${key}: ${unknown.join(', ')}. Available: ${members.map((m) => `${m.repo}#${m.branch}`).join(', ') || 'none'}`,
        });
      }
      members = members.filter((m) => wanted.has(`${m.repo}#${m.branch}`));
    }
    if (members.length === 0) return reply.code(400).send({ error: `${key} has no branches to review` });

    const runTicket = withAddedRequirements(ticket, requirementsText);
    const queuedNames = new Set(members.map((m) => `${m.repo}#${m.branch}`));
    const allMembers = orderedMembers(key);
    const planned = members.map((m) => {
      const fromTarget = targets.find((t) => t.repo === m.repo && t.branch === m.branch);
      const base: ResolvedTarget = fromTarget ?? {
        repo: m.repo, branch: m.branch, baseBranch: m.parent_branch ?? m.default_branch ?? 'main',
        prNumber: m.pr_number ?? null, source: m.source,
      };
      return applyGroupBases(key, [{ ...base, source: m.source }])[0]!;
    });
    const notes: string[] = [];
    const reviews: ReviewRow[] = [];
    try {
      // Parents first across every chain; a child waits in the queue for its parent's review.
      for (const step of orderBatch(planned, () => key)) {
        const target = step.target;
        const parentIsMember = allMembers.some((p) => p.repo === target.repo && p.branch === target.baseBranch);
        if (parentIsMember) {
          const reviewed = db.prepare(`SELECT 1 FROM reviews WHERE repo = ? AND branch = ? AND status = 'done' LIMIT 1`)
            .get(target.repo, target.baseBranch);
          if (step.parentIndex !== null) {
            notes.push(`${target.repo}#${target.branch}: starts after the review of its parent ${target.baseBranch} in this batch ends.`);
          } else if (!reviewed) {
            notes.push(queuedNames.has(`${target.repo}#${target.baseBranch}`)
              ? `${target.repo}#${target.branch}: its parent ${target.baseBranch} has no finished review yet.`
              : `${target.repo}#${target.branch}: its parent ${target.baseBranch} has no finished review yet and is not in this batch.`);
          }
        }
        const dependsOn = step.parentIndex !== null ? reviews[step.parentIndex]!.id : null;
        reviews.push(deps.startRun(target, runTicket, reviewer, model, { dependsOn }));
      }
    } catch (err) {
      if (reviews.length === 0) return reply.code(400).send({ error: (err as Error).message });
      notes.push(`Stopped queueing after ${reviews.length} review(s): ${(err as Error).message}`);
    }
    const run = createTicketRun(key, reviews.map((r) => r.id));
    return reply.code(201).send({
      run: runPayload(run),
      reviews,
      notes,
      ...(resolveError ? { resolve_warning: `The tracker lookup failed, so the stored branches were used: ${resolveError}` } : {}),
      ...ticketPayload(key, deps.pending),
    });
  });

  app.post('/api/tickets/:key/coverage', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const body = coverageBody.safeParse(req.body ?? {});
    if (!parsed.success || !body.success) return reply.code(400).send({ error: 'Invalid request body' });
    const key = parsed.data.key;
    syncMembersFromReviews(key);
    if (!getTicketGroup(key)) return reply.code(404).send({ error: `No ticket group ${key}` });
    const { started } = deps.recompute(key, { trigger: 'manual', ...body.data });
    return reply.code(202).send({ started, coverage: coveragePayload(latestCoverage(key)) });
  });

  app.put('/api/tickets/:key/parent', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const body = parentBody.safeParse(req.body ?? {});
    if (!parsed.success || !body.success) return reply.code(400).send({ error: 'Invalid request body' });
    try {
      await setParentByHand(parsed.data.key, body.data.repo, body.data.branch, body.data.parent, deps.detect);
    } catch (err) {
      return sendGroupError(reply, err);
    }
    return ticketPayload(parsed.data.key, deps.pending);
  });

  app.put('/api/tickets/:key/order', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const body = orderBody.safeParse(req.body ?? {});
    if (!parsed.success || !body.success) return reply.code(400).send({ error: 'Invalid request body' });
    try {
      await setChainOrder(parsed.data.key, body.data.repo, body.data.branches, body.data.root ?? null, deps.detect);
    } catch (err) {
      return sendGroupError(reply, err);
    }
    return ticketPayload(parsed.data.key, deps.pending);
  });

  app.post('/api/tickets/:key/detect', async (req, reply) => {
    const parsed = keyParams.safeParse(req.params);
    const body = detectBody.safeParse(req.body ?? {});
    if (!parsed.success || !body.success) return reply.code(400).send({ error: 'Invalid request body' });
    syncMembersFromReviews(parsed.data.key);
    if (!getTicketGroup(parsed.data.key)) return reply.code(404).send({ error: `No ticket group ${parsed.data.key}` });
    const detected = await detectGroupParents(parsed.data.key, deps.detect, { includeUser: Boolean(body.data.reset) });
    return { detected, ...ticketPayload(parsed.data.key, deps.pending) };
  });
}
