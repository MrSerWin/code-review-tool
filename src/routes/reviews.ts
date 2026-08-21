import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  createReview,
  deleteReview,
  getFindings,
  getLogs,
  getObservations,
  getRequirements,
  getReview,
  listReviews,
  updateReview,
} from '../db.js';
import { subscribe } from '../events.js';
import { cancelReview, enqueueReview } from '../queue.js';
import { resolveTargets } from '../resolver.js';
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
  model: z.string().min(1).max(64).optional(),
});

const listQuery = z.object({
  ticket: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function startRun(
  target: ResolvedTarget,
  ticket: TicketInfo | null,
  model: string | undefined,
): ReviewRow {
  const review = createReview({
    ticket_key: ticket?.key ?? null,
    ticket_title: ticket?.title ?? null,
    ticket_url: ticket?.url ?? null,
    ticket_body: ticket?.body ?? null,
    repo: target.repo,
    branch: target.branch,
    base_branch: target.baseBranch,
    pr_number: target.prNumber ?? null,
    status: 'queued',
    model: model ?? config.REVIEW_MODEL,
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
    const { input, targets, model } = parsed.data;

    let ticket: TicketInfo | null = null;
    let chosen: ResolvedTarget[];
    try {
      const resolved = await resolveTargets(input);
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

    try {
      const reviews = chosen.map((t) => startRun(t, ticket, model));
      return reply.code(201).send({ reviews });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/reviews', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const { limit = 50, offset = 0, ...rest } = parsed.data;
    return listReviews({ ...rest, limit, offset });
  });

  app.get('/api/reviews/:id', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid review id' });
    const review = getReview(parsed.data.id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    return {
      review,
      requirements: getRequirements(review.id),
      findings: getFindings(review.id),
      observations: getObservations(review.id),
      logs: getLogs(review.id),
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

    const ticket: TicketInfo | null = prev.ticket_key
      ? ({
          key: prev.ticket_key,
          title: prev.ticket_title ?? '',
          url: prev.ticket_url ?? '',
          body: prev.ticket_body ?? '',
          state: '',
          branchName: prev.branch,
          comments: [],
          attachmentUrls: [],
        } satisfies TicketInfo)
      : null;

    const review = startRun(
      {
        repo: prev.repo,
        branch: prev.branch,
        baseBranch: prev.base_branch,
        prNumber: prev.pr_number ?? null,
      },
      ticket,
      prev.model ?? undefined,
    );
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
    if (abs) await fs.rm(abs, { force: true });
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
