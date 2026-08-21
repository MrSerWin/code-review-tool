import { config } from '../config.js';
import { collectPrUrls } from '../prLinks.js';
import type { TicketInfo } from '../types.js';
import {
  assertConfigured, parseIssueKey, readJson, trimSlash, type TicketProvider,
} from './types.js';

const FIELDS =
  'idReadable,summary,description,' +
  'customFields(name,value(name,text)),' +
  'comments(text,author(fullName,login))';

interface YouTrackIssue {
  idReadable?: string;
  summary?: string | null;
  description?: string | null;
  customFields?: { name?: string; value?: unknown }[];
  comments?: { text?: string | null; author?: { fullName?: string; login?: string } | null }[];
}

function baseUrl(): string {
  return trimSlash(config.YOUTRACK_BASE_URL as string);
}

/** `ABC-123`, or an issue URL ending in one. */
function parseId(input: string): string | null {
  const raw = input.trim();
  const direct = parseIssueKey(raw);
  if (direct) return `${direct.project.toUpperCase()}-${direct.number}`;
  const url = /^https?:\/\/[^\s]*\/(?:issue|youtrack\/issue)\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$/i.exec(raw);
  return url ? (url[1] as string).toUpperCase() : null;
}

/** The State field, whatever shape the custom field value happens to have. */
function stateOf(issue: YouTrackIssue): string {
  for (const custom of issue.customFields ?? []) {
    if (custom.name !== 'State' && custom.name !== 'Stage') continue;
    const value = custom.value;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const named = value as { name?: string; text?: string };
      if (named.name) return named.name;
      if (named.text) return named.text;
    }
  }
  return 'unknown';
}

export const youtrackProvider: TicketProvider = {
  name: 'youtrack',
  requiredEnv: ['YOUTRACK_BASE_URL', 'YOUTRACK_TOKEN'],

  isConfigured: () => Boolean(config.YOUTRACK_BASE_URL && config.YOUTRACK_TOKEN),

  matches: (input) => parseId(input) !== null,

  async getTicket(input) {
    assertConfigured(youtrackProvider);
    const id = parseId(input);
    if (!id) throw new Error(`Not a YouTrack issue id: ${JSON.stringify(input)}`);

    const url = `${baseUrl()}/api/issues/${encodeURIComponent(id)}?fields=${FIELDS}`;
    const issue = await readJson<YouTrackIssue>(
      url,
      { Authorization: `Bearer ${config.YOUTRACK_TOKEN as string}` },
      'YouTrack API',
    );

    const body = (issue.description ?? '').trim();
    const comments = (issue.comments ?? [])
      .map((c) => ({
        author: c.author?.fullName ?? c.author?.login ?? 'unknown',
        body: (c.text ?? '').trim(),
      }))
      .filter((c) => c.body.length > 0);

    const key = issue.idReadable ?? id;
    return {
      provider: 'youtrack',
      key,
      title: issue.summary ?? key,
      url: `${baseUrl()}/issue/${key}`,
      body,
      state: stateOf(issue),
      branchName: null,
      comments,
      attachmentUrls: collectPrUrls(body, ...comments.map((c) => c.body)),
    } satisfies TicketInfo;
  },
};
