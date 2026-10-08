import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTargets } from '../resolver.js';

/** Same limit as the `input` of POST /api/reviews: a pasted PR URL is often long. */
const inputSchema = z.string().trim().min(1).max(512);

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // A wildcard, not `:key`: the input may be any review input (a PR or issue
  // URL, `org/repo#12`), so it can contain slashes, encoded (`%2F`, as the UI
  // and the MCP server send it) or not, and the router caps a named parameter
  // at 100 characters. The wildcard arrives decoded.
  app.get('/api/tickets/*', async (req, reply) => {
    const parsed = inputSchema.safeParse((req.params as Record<string, unknown>)['*']);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid ticket key' });

    try {
      const { ticket, targets } = await resolveTargets(parsed.data);
      return { ticket, targets };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
}
