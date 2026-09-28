import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALLOWED_REPOS } from '../config.js';
import { describeParent, listLocalRepos } from '../localRepos.js';

const parentParams = z.object({ repo: z.string().min(1).max(200) });
const parentQuery = z.object({ branch: z.string().min(1).max(255) });

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async () => ({ repos: [...ALLOWED_REPOS] }));

  // Local clones of the allowed repositories, read-only: branches, what is unpushed, dirty state.
  // Deliberately cheap: parent detection runs per branch, on demand, below.
  app.get('/api/local-repos', async () => listLocalRepos());

  // The branch a local branch was most likely cut from (stacked branches), read-only.
  app.get('/api/local-repos/:repo/parent', async (req, reply) => {
    const params = parentParams.safeParse(req.params);
    const query = parentQuery.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Expected /api/local-repos/<repo>/parent?branch=<name>' });
    try {
      return await describeParent(params.data.repo, query.data.branch);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
