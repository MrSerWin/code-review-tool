import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { listReviewersWithModels } from '../reviewers/index.js';

/** `?refresh=1` (or `true`, `yes`) asks every reviewer for its models again. */
export function isRefreshRequested(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

export async function reviewerRoutes(app: FastifyInstance): Promise<void> {
  // The full reviewer list, models included. Discovered lists are cached per
  // process for ten minutes; `?refresh=1` discovers every list again now.
  app.get('/api/reviewers', async (req) => ({
    reviewers: await listReviewersWithModels({
      refresh: isRefreshRequested((req.query as { refresh?: unknown } | undefined)?.refresh),
    }),
    defaultReviewer: config.defaultReviewer,
  }));
}
