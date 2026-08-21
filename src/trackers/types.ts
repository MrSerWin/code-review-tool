import type { TicketInfo } from '../types.js';

export const TRACKER_NAMES = ['linear', 'jira', 'github', 'azure', 'youtrack'] as const;
export type TrackerName = (typeof TRACKER_NAMES)[number];

export interface TicketProvider {
  readonly name: TrackerName;
  /** Environment variables this provider needs before it can be used. */
  readonly requiredEnv: readonly string[];
  /** True when every required variable is set. Only active providers are tried. */
  isConfigured(): boolean;
  /** Does this input look like one of my ticket references? */
  matches(input: string): boolean;
  getTicket(input: string): Promise<TicketInfo>;
}

export function missingEnvError(provider: TicketProvider): Error {
  return new Error(
    `The ${provider.name} tracker is not configured. Set ${provider.requiredEnv.join(', ')} in .env to use it.`,
  );
}

/** Throws with the exact variables to set when the provider is not configured. */
export function assertConfigured(provider: TicketProvider): void {
  if (!provider.isConfigured()) throw missingEnvError(provider);
}

/** `TEAM-123`, the shape Linear, Jira, and YouTrack all use. */
export function parseIssueKey(input: string): { project: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(input.trim());
  if (!match) return null;
  return { project: match[1] as string, number: Number(match[2]) };
}

/** A single line of title text taken from a longer body. */
export function firstLine(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export async function readJson<T>(
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (!response.ok) {
    throw new Error(`${label} error ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  return (await response.json()) as T;
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}

/** Trailing slashes make every joined path double-slashed; drop them once, here. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
