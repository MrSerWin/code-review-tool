import type { ModelDiscovery, ModelInfo, ModelSource, ReviewerDefinition } from './types.js';

/** How long one discovery is trusted before the source is asked again. */
export const DISCOVERY_TTL_MS = 10 * 60_000;

const cache = new Map<ReviewerDefinition, ModelDiscovery>();
const inflight = new Map<ReviewerDefinition, Promise<ModelDiscovery>>();

/** A discovery that found models. */
export function found(models: ModelInfo[], source: ModelSource): ModelDiscovery {
  return { models, source, fetchedAt: Date.now(), hint: null };
}

/** A discovery that found nothing, with what to do about it. */
export function nothingFound(hint: string): ModelDiscovery {
  return { models: [], source: null, fetchedAt: Date.now(), hint };
}

/**
 * The reviewer's models, remembered per process for `DISCOVERY_TTL_MS`.
 * `refresh` asks the source again now. Concurrent callers share one discovery.
 */
export async function discoverModels(
  reviewer: ReviewerDefinition,
  opts: { refresh?: boolean } = {},
): Promise<ModelDiscovery> {
  const hit = cache.get(reviewer);
  if (!opts.refresh && hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit;
  const running = inflight.get(reviewer);
  if (running) return running;

  const pending = (async () => {
    let result: ModelDiscovery;
    try {
      result = await reviewer.discoverModels();
    } catch (err) {
      result = nothingFound(
        `${reviewer.label} model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cache.set(reviewer, result);
    return result;
  })();
  inflight.set(reviewer, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(reviewer);
  }
}

/** Only for tests: forget every discovery. */
export function clearDiscoveryCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The default among the discovered models: the configured one when it is
 * listed (or when the CLI takes unlisted ids), else the first listed one. A
 * configured id the list lacks is reported through `warn` and ignored, since
 * the CLI would refuse it.
 */
export function pickDefaultModel(
  models: ModelInfo[],
  configured: string | undefined,
  opts: { label: string; envName: string; acceptsUnlisted?: boolean },
  warn: (message: string) => void = () => {},
): string | null {
  const first = models[0]?.id ?? null;
  const wanted = configured?.trim();
  if (!wanted) return first;
  if (opts.acceptsUnlisted || models.some((m) => m.id === wanted)) return wanted;
  if (first) {
    warn(
      `${opts.envName}=${wanted} is not in the ${opts.label} model list (${models.map((m) => m.id).join(', ')}); ` +
        `using ${first} instead.`,
    );
  }
  return first;
}
