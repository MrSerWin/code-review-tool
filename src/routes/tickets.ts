import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTargets } from '../resolver.js';

const paramsSchema = z.object({ key: z.string().min(1).max(64) });

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tickets/:key', async (req, reply) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid ticket key' });

    try {
      const { ticket, targets } = await resolveTargets(parsed.data.key);
      return { ticket, targets };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
}
