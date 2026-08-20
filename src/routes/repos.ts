import type { FastifyInstance } from 'fastify';
import { ALLOWED_REPOS } from '../config.js';

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async () => ({ repos: [...ALLOWED_REPOS] }));
}
