/**
 * Issue links of the ticket trackers, read back into the key they name.
 *
 * Pure: the hosts of self-hosted trackers are passed in, so tests need no
 * configuration. A URL is only mapped when its host plausibly belongs to the
 * tracker, so a random page with `/issue/ABC-1` in its path never becomes a
 * ticket. GitHub issue and pull request URLs are not handled here: the GitHub
 * tracker and the pull request path of the resolver read those themselves.
 */
import type { TrackerName } from './types.js';

/** The trackers whose issue links are read here. */
export type UrlTrackerName = Exclude<TrackerName, 'github'>;

export interface TicketUrlRef {
  tracker: UrlTrackerName;
  /** The key exactly as the tracker's own `getTicket` reports it: `ABC-123`, or `#123` for Azure DevOps. */
  key: string;
}

/** Base URLs of self-hosted (or custom-domain) trackers, as configured in `.env`. */
export interface TicketUrlHosts {
  jira?: string | undefined;
  youtrack?: string | undefined;
  azure?: string | undefined;
}

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

function issueKey(value: string | null | undefined): string | null {
  const match = ISSUE_KEY.exec((value ?? '').trim());
  return match ? `${(match[1] as string).toUpperCase()}-${match[2]}` : null;
}

/** `example.com` from a configured base URL, without `www.`; null when it is not a URL. */
function hostOf(base: string | undefined): string | null {
  if (!base?.trim()) return null;
  try {
    return new URL(base.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * The input as a URL: trimmed, `<…>` removed, and `https://` assumed when a
 * pasted link lost its scheme (`linear.app/…`). Null for anything that is not
 * a web link, such as a bare key or `repo#branch`.
 */
function asUrl(input: string): URL | null {
  let raw = input.trim().replace(/^<(.*)>$/, '$1').trim();
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(raw)) return null;
    raw = `https://${raw}`;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The segment right after `marker` in the path, if there is one. */
function after(segments: string[], marker: string): string | null {
  const index = segments.findIndex((s) => s.toLowerCase() === marker);
  return index >= 0 ? segments[index + 1] ?? null : null;
}

/** The value of a query parameter, matched without regard to case. */
function queryParam(url: URL, name: string): string | null {
  for (const [key, value] of url.searchParams) if (key.toLowerCase() === name) return value;
  return null;
}

/** `https://linear.app/<workspace>/issue/ABC-123[/<slug>]` */
function linearKey(segments: string[]): string | null {
  return segments[1]?.toLowerCase() === 'issue' ? issueKey(segments[2]) : null;
}

/**
 * `/browse/ABC-123`, a board or backlog with `?selectedIssue=ABC-123`, or
 * `/jira/software/…/issues/ABC-123`. Any context path in front is fine.
 */
function jiraKey(url: URL, segments: string[]): string | null {
  return issueKey(after(segments, 'browse'))
    ?? issueKey(queryParam(url, 'selectedissue'))
    ?? issueKey(after(segments, 'issues'));
}

/** `/issue/ABC-123[/<slug>]`, also under a `/youtrack` context path. */
function youtrackKey(segments: string[]): string | null {
  return issueKey(after(segments, 'issue'));
}

/** `/<project>/_workitems/edit/123`, or a board, backlog, or query with `?workitem=123`. */
function azureKey(url: URL, segments: string[]): string | null {
  const index = segments.findIndex((s) => s.toLowerCase() === '_workitems');
  const edit = index >= 0 && segments[index + 1]?.toLowerCase() === 'edit' ? segments[index + 2] : null;
  const id = /^\d+$/.test(edit ?? '') ? edit : queryParam(url, 'workitem');
  return id && /^\d+$/.test(id) ? `#${Number(id)}` : null;
}

/**
 * The tracker and key a pasted issue link names, or null when the input is not
 * a link to an issue of a tracker this tool can read.
 *
 * - Linear: `https://linear.app/<workspace>/issue/ABC-123[/<slug>]`
 * - Jira: `https://<site>.atlassian.net/browse/ABC-123`, `…?selectedIssue=ABC-123`
 *   board links, `…/issues/ABC-123`; also on the host of `hosts.jira`
 * - YouTrack: `https://<host>/issue/ABC-123[/<slug>]` on `*.youtrack.cloud`,
 *   `*.myjetbrains.com`, or the host of `hosts.youtrack`
 * - Azure DevOps: `https://dev.azure.com/<org>/<project>/_workitems/edit/123`,
 *   `https://<org>.visualstudio.com/<project>/_workitems/edit/123`, or a board
 *   link with `?workitem=123`; also on the host of `hosts.azure`
 *
 * `http://`, `www.`, a missing scheme, trailing slashes, a query, a fragment,
 * and surrounding `<…>` are all tolerated.
 */
export function ticketRefFromUrl(input: string, hosts: TicketUrlHosts = {}): TicketUrlRef | null {
  const url = asUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  const candidates: [UrlTrackerName, () => string | null][] = [];
  if (host === 'linear.app') candidates.push(['linear', () => linearKey(segments)]);
  if (host.endsWith('.atlassian.net') || host === hostOf(hosts.jira)) {
    candidates.push(['jira', () => jiraKey(url, segments)]);
  }
  if (host.endsWith('.youtrack.cloud') || host.endsWith('.myjetbrains.com') || host === hostOf(hosts.youtrack)) {
    candidates.push(['youtrack', () => youtrackKey(segments)]);
  }
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || host === hostOf(hosts.azure)) {
    candidates.push(['azure', () => azureKey(url, segments)]);
  }

  for (const [tracker, read] of candidates) {
    const key = read();
    if (key) return { tracker, key };
  }
  return null;
}

/** `linear:ABC-123` for an issue link, the explicit form the tracker registry resolves without guessing. */
export function ticketInputFromUrl(input: string, hosts: TicketUrlHosts = {}): string | null {
  const ref = ticketRefFromUrl(input, hosts);
  return ref ? `${ref.tracker}:${ref.key}` : null;
}
