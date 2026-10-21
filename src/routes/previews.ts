import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  beginStop, decoratePreview, deletePreview, previewsEnabled, requestPreview,
} from '../preview/engine.js';
import { subscribePreview } from '../preview/events.js';
import { loadRecipes, primaryPort } from '../preview/recipes.js';
import { getPreview, getPreviewLogs, listPreviews } from '../preview/store.js';
import {
  defaultTicketPlanDeps, PlanError, ticketPreviewPlan, type TicketPlanDeps,
} from '../preview/ticketPlan.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

const createBody = z
  .object({
    reviewId: z.coerce.number().int().positive().optional(),
    // A ticket key, an issue or PR link, repo#branch, or local:repo#branch; links run long.
    ticket: z.string().min(1).max(512).optional(),
    recipe: z.string().min(1).max(128).optional(),
    roles: z
      .array(
        z.object({
          role: z.string().min(1).max(64),
          // Empty or absent: the role runs its base branch (local: the clone's checked-out branch).
          // "local:<repo>#<branch>" is the same as local: true with that branch.
          branch: z.string().max(300).optional(),
          base: z.string().max(255).optional(),
          // Copy the branch from the configured local clone (it may be unpushed) instead of GitHub.
          local: z.boolean().optional(),
        }),
      )
      .max(20)
      .optional(),
    dumpMode: z.enum(['auto', 'dump-dir', 'pg_dump', 'none', 'clean']).optional(),
  })
  .default({});

const listQuery = z.object({
  reviewId: z.coerce.number().int().positive().optional(),
  ticket: z.string().optional(),
  recipe: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const planParams = z.object({ key: z.string().trim().min(1).max(200) });
const planQuery = z.object({ recipe: z.string().min(1).max(128).optional() });

export async function previewRoutes(
  app: FastifyInstance,
  opts: { planDeps?: TicketPlanDeps } = {},
): Promise<void> {
  const planDeps = opts.planDeps ?? defaultTicketPlanDeps;

  // What "Preview ticket" runs: per role the tip of its repo's chain, plus a live preview that already runs it.
  app.get('/api/ticket-groups/:key/preview-plan', async (req, reply) => {
    if (!previewsEnabled()) return reply.code(409).send({ error: 'Previews are disabled (PREVIEW_ENABLED)' });
    const params = planParams.safeParse(req.params);
    const query = planQuery.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      const plan = await ticketPreviewPlan(params.data.key, query.data.recipe, planDeps);
      const { recipes } = loadRecipes();
      return {
        ticket: plan.ticket,
        recipe: plan.recipe,
        roles: plan.roles,
        request: plan.request,
        live_preview: plan.livePreview ? decoratePreview(plan.livePreview, recipes) : null,
        other_live: plan.otherLive.map((row) => decoratePreview(row, recipes)),
        notes: plan.notes,
      };
    } catch (err) {
      const status = err instanceof PlanError ? err.status : 400;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.get('/api/recipes', async () => {
    const { recipes, errors } = loadRecipes();
    return {
      enabled: previewsEnabled(),
      dir: config.previewRecipesDir,
      recipes: recipes.map((recipe) => ({
        name: recipe.name,
        description: recipe.description ?? null,
        roles: Object.entries(recipe.repos).map(([role, repo]) => ({ role, repo })),
        ports: recipe.ports.map((port) => ({
          ...port,
          label: port.label ?? port.id,
          link: port.link !== false,
          primary: port.id === primaryPort(recipe).id,
        })),
        database: recipe.database
          ? {
              engine: recipe.database.engine,
              version: recipe.database.version ?? null,
              mode: recipe.database.source.mode,
              onFailure: recipe.database.source.onFailure,
              hasDumpDir: Boolean(recipe.database.source.dumpDir),
              hasPgDump: Boolean(recipe.database.source.pgDump),
            }
          : null,
        readyTimeoutSec: recipe.readyTimeoutSec,
        credentialsHint: recipe.credentialsHint ?? null,
      })),
      // A broken recipe is reported, not thrown: the server still starts.
      errors,
    };
  });

  app.get('/api/previews', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const { limit = 50, offset = 0, ...rest } = parsed.data;
    const { previews, total } = listPreviews({ ...rest, limit, offset });
    const { recipes } = loadRecipes();
    return { previews: previews.map((row) => decoratePreview(row, recipes)), total };
  });

  app.get('/api/previews/:id', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid preview id' });
    const preview = getPreview(parsed.data.id);
    if (!preview) return reply.code(404).send({ error: 'Preview not found' });
    return { preview: decoratePreview(preview), logs: getPreviewLogs(preview.id) };
  });

  app.post('/api/previews', async (req, reply) => {
    if (!previewsEnabled()) return reply.code(409).send({ error: 'Previews are disabled (PREVIEW_ENABLED)' });
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' });
    try {
      const preview = await requestPreview(parsed.data);
      return reply.code(201).send({ preview: decoratePreview(preview) });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/previews/:id/stop', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid preview id' });
    const preview = getPreview(parsed.data.id);
    if (!preview) return reply.code(404).send({ error: 'Preview not found' });
    try {
      // Answers once the row says `stopping`; `down` goes on in the background
      // (it can take minutes) and GET /api/previews/:id shows when it ended. A
      // client left waiting would time out and take a busy server for a dead one.
      beginStop(preview.id, 'stopped');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const after = getPreview(preview.id);
    return { preview: after ? decoratePreview(after) : null };
  });

  app.delete('/api/previews/:id', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid preview id' });
    const preview = getPreview(parsed.data.id);
    if (!preview) return reply.code(404).send({ error: 'Preview not found' });
    try {
      await deletePreview(preview.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  app.get('/api/previews/:id/events', async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid preview id' });
    const preview = getPreview(parsed.data.id);
    if (!preview) return reply.code(404).send({ error: 'Preview not found' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'status', previewId: preview.id, status: preview.status })}\n\n`);

    const unsubscribe = subscribePreview(preview.id, (payload) => {
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
