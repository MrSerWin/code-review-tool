import { config } from '../config.js';
import { logger } from '../logger.js';
import { collectPrUrls } from '../prLinks.js';
import type { TicketInfo } from '../types.js';
import { adfToText } from './adf.js';
import {
  assertConfigured, basicAuth, parseIssueKey, readJson, trimSlash, type TicketProvider,
} from './types.js';

interface JiraIssue {
  id?: string;
  key?: string;
  fields?: {
    summary?: string | null;
    description?: unknown;
    status?: { name?: string } | null;
    comment?: {
      comments?: { body?: unknown; author?: { displayName?: string } | null }[];
    } | null;
  };
}

/** The dev panel: branches and pull requests linked to the issue. */
interface JiraDevDetail {
  detail?: {
    branches?: { name?: string; url?: string }[];
    pullRequests?: { url?: string; name?: string }[];
    repositories?: { url?: string; name?: string }[];
  }[];
}

function baseUrl(): string {
  return trimSlash(config.JIRA_BASE_URL as string);
}

function authHeaders(): Record<string, string> {
  return { Authorization: basicAuth(config.JIRA_EMAIL as string, config.JIRA_API_TOKEN as string) };
}

/** `ABC-123`, or a browse//jira/software URL that ends in one. */
function parseKey(input: string): string | null {
  const raw = input.trim();
  const direct = parseIssueKey(raw);
  if (direct) return `${direct.project.toUpperCase()}-${direct.number}`;
  const url = /^https?:\/\/[^/]+\/(?:browse|jira\/software\/[^?]*?\/issues)\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(raw);
  return url ? (url[1] as string).toUpperCase() : null;
}

/**
 * Branch and pull request links from the development panel. Unreachable for
 * tokens without the permission, and absent when no repository is connected,
 * so a failure here is logged and never fails the ticket fetch.
 */
async function devInfoUrls(issueId: string): Promise<string[]> {
  const url =
    `${baseUrl()}/rest/dev-status/1.0/issue/detail` +
    `?issueId=${encodeURIComponent(issueId)}&applicationType=GitHub&dataType=pullrequest`;
  try {
    const data = await readJson<JiraDevDetail>(url, authHeaders(), 'Jira dev-status API');
    const urls: string[] = [];
    for (const detail of data.detail ?? []) {
      for (const pr of detail.pullRequests ?? []) if (pr.url) urls.push(pr.url);
    }
    return urls;
  } catch (error) {
    logger.warn(`Jira development information unavailable for issue ${issueId}:`, (error as Error).message);
    return [];
  }
}

export const jiraProvider: TicketProvider = {
  name: 'jira',
  requiredEnv: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],

  isConfigured: () =>
    Boolean(config.JIRA_BASE_URL && config.JIRA_EMAIL && config.JIRA_API_TOKEN),

  matches: (input) => parseKey(input) !== null,

  async getTicket(input) {
    assertConfigured(jiraProvider);
    const key = parseKey(input);
    if (!key) throw new Error(`Not a Jira issue key: ${JSON.stringify(input)}`);

    const url =
      `${baseUrl()}/rest/api/3/issue/${encodeURIComponent(key)}` +
      '?fields=summary,description,status,comment';
    const issue = await readJson<JiraIssue>(url, authHeaders(), 'Jira API');

    const body = adfToText(issue.fields?.description);
    const comments = (issue.fields?.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? 'unknown',
      body: adfToText(c.body),
    }));

    const linked = issue.id ? await devInfoUrls(issue.id) : [];

    return {
      provider: 'jira',
      key: issue.key ?? key,
      title: issue.fields?.summary ?? key,
      url: `${baseUrl()}/browse/${issue.key ?? key}`,
      body,
      state: issue.fields?.status?.name ?? 'unknown',
      branchName: null,
      comments,
      attachmentUrls: [...new Set([...linked, ...collectPrUrls(body, ...comments.map((c) => c.body))])],
    } satisfies TicketInfo;
  },
};
