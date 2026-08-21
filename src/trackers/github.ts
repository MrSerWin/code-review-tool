import { config } from '../config.js';
import { ghApi } from '../gitSandbox.js';
import { logger } from '../logger.js';
import { collectPrUrls } from '../prLinks.js';
import type { TicketInfo } from '../types.js';
import { type TicketProvider } from './types.js';

interface GhIssue {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  pull_request?: { html_url?: string } | null;
}

interface GhComment {
  body?: string | null;
  user?: { login?: string } | null;
}

interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** `owner/repo#123` or a GitHub issue or pull request URL. */
function parseRef(input: string): IssueRef | null {
  const raw = input.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(raw);
  if (url) return { owner: url[1] as string, repo: url[2] as string, number: Number(url[3]) };
  const short = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(raw);
  if (short) return { owner: short[1] as string, repo: short[2] as string, number: Number(short[3]) };
  return null;
}

export const githubProvider: TicketProvider = {
  name: 'github',
  // Both are already required for the sandbox, so this provider is always on.
  requiredEnv: ['GITHUB_ORG', 'REVIEW_GH_TOKEN'],

  isConfigured: () => Boolean(config.GITHUB_ORG && config.REVIEW_GH_TOKEN),

  matches: (input) => parseRef(input) !== null,

  async getTicket(input) {
    const ref = parseRef(input);
    if (!ref) throw new Error(`Not a GitHub issue reference: ${JSON.stringify(input)}`);
    if (ref.owner.toLowerCase() !== config.GITHUB_ORG.toLowerCase()) {
      throw new Error(
        `GitHub issues are only read from the configured organization ${JSON.stringify(config.GITHUB_ORG)}, not ${JSON.stringify(ref.owner)}.`,
      );
    }

    // Every GitHub call goes through the sandbox; the host process never holds the token.
    const base = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const issue = await ghApi<GhIssue>(base);

    let comments: { author: string; body: string }[] = [];
    try {
      const raw = await ghApi<GhComment[]>(`${base}/comments?per_page=100`);
      comments = raw
        .map((c) => ({ author: c.user?.login ?? 'unknown', body: (c.body ?? '').trim() }))
        .filter((c) => c.body.length > 0);
    } catch (error) {
      logger.warn(`Could not read comments of ${ref.repo}#${ref.number}:`, (error as Error).message);
    }

    // Body is already Markdown; nothing to flatten.
    const body = issue.body ?? '';
    const self = issue.pull_request?.html_url ? [issue.pull_request.html_url] : [];

    return {
      provider: 'github',
      key: `${ref.owner}/${ref.repo}#${ref.number}`,
      title: issue.title ?? `${ref.repo}#${ref.number}`,
      url: issue.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      body,
      state: issue.state ?? 'unknown',
      branchName: null,
      comments,
      attachmentUrls: [...new Set([...self, ...collectPrUrls(body, ...comments.map((c) => c.body))])],
    } satisfies TicketInfo;
  },
};
