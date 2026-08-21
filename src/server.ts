import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ALLOWED_REPOS, config } from './config.js';
import { activeTrackerNames } from './trackers/index.js';
import { ensureImage } from './gitSandbox.js';
import { logger } from './logger.js';
import { recoverInterrupted } from './queue.js';
import { previewsSummary, recoverOrphanPreviews, startReaper } from './preview/engine.js';
import { previewRoutes } from './routes/previews.js';
import { repoRoutes } from './routes/repos.js';
import { reviewRoutes } from './routes/reviews.js';
import { ticketRoutes } from './routes/tickets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../web/dist');
const version = (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? '0.0.0';

export async function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  app.setErrorHandler((raw, _req, reply) => {
    const err = raw as { message?: string; statusCode?: number };
    logger.error(`request failed: ${err.message ?? 'unknown error'}`);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err.message || 'Internal error' });
  });

  app.get('/api/health', async () => ({
    ok: true,
    version,
    dockerImage: config.GIT_IMAGE,
    // Names only: which trackers are usable, never a credential.
    trackers: activeTrackerNames(),
    repos: ALLOWED_REPOS.length,
    previews: previewsSummary(),
  }));

  await app.register(repoRoutes);
  await app.register(ticketRoutes);
  await app.register(reviewRoutes);
  await app.register(previewRoutes);

  const hasWeb = existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: webDist });

  // SPA fallback: unknown GET paths outside /api serve index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (!hasWeb) {
      return reply.code(404).type('text/plain').send('web/dist is not built yet - run: npm run build');
    }
    return reply.sendFile('index.html');
  });

  return app;
}

async function main(): Promise<void> {
  recoverInterrupted();

  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: config.PORT });
  logger.info(`code-review-tool listening on http://127.0.0.1:${config.PORT}`);

  // The git image is only needed once a review runs; a failure here is not fatal.
  ensureImage().catch((err: unknown) => {
    logger.warn(`git sandbox image unavailable: ${(err as Error).message}`);
  });

  // Previews left running by a crash own containers nobody else will stop.
  recoverOrphanPreviews()
    .catch((err: unknown) => logger.warn(`preview recovery failed: ${(err as Error).message}`))
    .finally(() => startReaper());

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.error(`failed to start: ${(err as Error).message}`);
  process.exit(1);
});
