/**
 * Ticket links on the client: which launcher inputs are a tracker's issue link,
 * the key they name, and which tracker a stored ticket URL belongs to.
 *
 * Mirrors `src/trackers/urls.ts`. The server is the authority (it also knows
 * the hosts of self-hosted trackers); here an unknown host is judged by its
 * path alone, which is enough to pick the launcher button and a label.
 */

export type TicketTracker = 'linear' | 'jira' | 'youtrack' | 'azure' | 'github';

export interface TicketLinkRef {
  tracker: TicketTracker;
  /** As the tracker reports it: `ABC-123`, `#123` (Azure DevOps), `my-org/my-service#12` (GitHub). */
  key: string;
  /** Told by the path alone, on a host that may be a self-hosted tracker or nothing at all. */
  guessed?: boolean;
}

export const TRACKER_LABEL: Record<TicketTracker, string> = {
  linear: 'Linear',
  jira: 'Jira',
  youtrack: 'YouTrack',
  azure: 'Azure DevOps',
  github: 'GitHub',
};

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

function issueKey(value: string | null | undefined): string | null {
  const match = ISSUE_KEY.exec((value ?? '').trim());
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

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

function after(segments: string[], marker: string): string | null {
  const index = segments.findIndex((s) => s.toLowerCase() === marker);
  return index >= 0 ? segments[index + 1] ?? null : null;
}

function queryParam(url: URL, name: string): string | null {
  for (const [key, value] of url.searchParams) if (key.toLowerCase() === name) return value;
  return null;
}

function azureId(url: URL, segments: string[]): string | null {
  const index = segments.findIndex((s) => s.toLowerCase() === '_workitems');
  const edit = index >= 0 && segments[index + 1]?.toLowerCase() === 'edit' ? segments[index + 2] : null;
  const id = /^\d+$/.test(edit ?? '') ? edit : queryParam(url, 'workitem');
  return id && /^\d+$/.test(id) ? `#${Number(id)}` : null;
}

/**
 * The ticket an issue link names, or null. Pull request links are not tickets
 * here: the launcher reviews a PR directly, as exactly one branch.
 */
export function ticketLinkRef(input: string): TicketLinkRef | null {
  const url = asUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'github.com') {
    const [owner, repo, kind, number] = segments;
    return owner && repo && kind === 'issues' && /^\d+$/.test(number ?? '')
      ? { tracker: 'github', key: `${owner}/${repo}#${number}` }
      : null;
  }
  if (host === 'linear.app') {
    const key = segments[1]?.toLowerCase() === 'issue' ? issueKey(segments[2]) : null;
    return key ? { tracker: 'linear', key } : null;
  }

  const jira = issueKey(after(segments, 'browse')) ?? issueKey(queryParam(url, 'selectedissue'));
  const youtrack = issueKey(after(segments, 'issue'));
  const azure = azureId(url, segments);

  // Known hosts first, so a path both trackers use is credited to the right one.
  if (host.endsWith('.atlassian.net')) {
    const key = jira ?? issueKey(after(segments, 'issues'));
    return key ? { tracker: 'jira', key } : null;
  }
  if (host.endsWith('.youtrack.cloud') || host.endsWith('.myjetbrains.com')) {
    return youtrack ? { tracker: 'youtrack', key: youtrack } : null;
  }
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return azure ? { tracker: 'azure', key: azure } : null;

  // A self-hosted tracker: only the server knows its host, the path tells which kind it is.
  if (jira) return { tracker: 'jira', key: jira, guessed: true };
  if (azure) return { tracker: 'azure', key: azure, guessed: true };
  if (youtrack) return { tracker: 'youtrack', key: youtrack, guessed: true };
  return null;
}

/** Which tracker a stored ticket URL points into; null when it cannot be told. */
export function trackerOfUrl(url: string | null | undefined): TicketTracker | null {
  if (!url) return null;
  const parsed = asUrl(url);
  if (parsed && parsed.hostname.toLowerCase().replace(/^www\./, '') === 'github.com') return 'github';
  return ticketLinkRef(url)?.tracker ?? null;
}

/** "Open in Linear", or "Open ticket" when the tracker cannot be told from the URL. */
export function openTicketLabel(url: string | null | undefined): string {
  const tracker = trackerOfUrl(url);
  return tracker ? `Open in ${TRACKER_LABEL[tracker]}` : 'Open ticket';
}

/** "Open ABC-123 in Linear", for tooltips and screen readers. */
export function openTicketTitle(url: string | null | undefined, key: string | null | undefined): string {
  const tracker = trackerOfUrl(url);
  const what = key?.trim() || 'the ticket';
  return tracker ? `Open ${what} in ${TRACKER_LABEL[tracker]}` : `Open ${what} in its tracker`;
}
