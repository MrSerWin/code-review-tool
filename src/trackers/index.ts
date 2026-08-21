import { config } from '../config.js';
import type { TicketInfo } from '../types.js';
import { azureProvider } from './azure.js';
import { githubProvider } from './github.js';
import { jiraProvider } from './jira.js';
import { linearProvider } from './linear.js';
import { missingEnvError, TRACKER_NAMES, type TicketProvider, type TrackerName } from './types.js';
import { youtrackProvider } from './youtrack.js';

export type { TicketProvider, TrackerName } from './types.js';
export { TRACKER_NAMES } from './types.js';

const PROVIDERS: readonly TicketProvider[] = Object.freeze([
  linearProvider,
  jiraProvider,
  githubProvider,
  azureProvider,
  youtrackProvider,
]);

/** Only providers whose credentials are present take part in resolution. */
export function activeProviders(): TicketProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

export function activeTrackerNames(): TrackerName[] {
  return activeProviders().map((p) => p.name);
}

function isTrackerName(value: string): value is TrackerName {
  return (TRACKER_NAMES as readonly string[]).includes(value);
}

/** `jira:ABC-123` — an explicit provider, plus the reference to hand it. */
export function splitPrefix(input: string): { name: TrackerName | null; ref: string } {
  const match = /^([A-Za-z][A-Za-z0-9]*):(.+)$/.exec(input.trim());
  if (!match) return { name: null, ref: input.trim() };
  const name = (match[1] as string).toLowerCase();
  // A URL also looks like "scheme:rest"; only real provider names count.
  if (!isTrackerName(name)) return { name: null, ref: input.trim() };
  return { name, ref: (match[2] as string).trim() };
}

function defaultProvider(candidates: TicketProvider[]): TicketProvider | null {
  const preferred = config.DEFAULT_TRACKER?.toLowerCase();
  if (!preferred) return null;
  return candidates.find((p) => p.name === preferred) ?? null;
}

/**
 * The provider that should answer for this input, or null when none claims it.
 * Explicit prefix first, then the only active provider that matches, then
 * `DEFAULT_TRACKER` when several do. An ambiguity is an error, never a guess.
 */
export function selectProvider(input: string): { provider: TicketProvider; ref: string } | null {
  const { name, ref } = splitPrefix(input);

  if (name) {
    const provider = PROVIDERS.find((p) => p.name === name);
    if (!provider) throw new Error(`Unknown tracker prefix: ${JSON.stringify(name)}`);
    if (!provider.isConfigured()) throw missingEnvError(provider);
    return { provider, ref };
  }

  const candidates = activeProviders().filter((p) => p.matches(ref));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { provider: candidates[0] as TicketProvider, ref };

  const preferred = defaultProvider(candidates);
  if (preferred) return { provider: preferred, ref };

  const names = candidates.map((p) => p.name);
  throw new Error(
    `${JSON.stringify(ref)} matches more than one configured tracker: ${names.join(', ')}. ` +
      `Say which one with a prefix (${names[0]}:${ref}) or set DEFAULT_TRACKER to one of them.`,
  );
}

/** True when some configured tracker would try to resolve this input. */
export function looksLikeTicket(input: string): boolean {
  return selectProvider(input) !== null;
}

export async function getTicket(input: string): Promise<TicketInfo> {
  const selected = selectProvider(input);
  if (!selected) {
    throw new Error(
      `No configured tracker recognises ${JSON.stringify(input)}. ` +
        `Active trackers: ${activeTrackerNames().join(', ')}. ` +
        'Configure the tracker this key belongs to in .env, or paste the requirements instead.',
    );
  }
  return selected.provider.getTicket(selected.ref);
}
