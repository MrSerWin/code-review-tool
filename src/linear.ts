import { config, assertAllowedRepo } from './config.js';
import type { TicketInfo } from './types.js';

const LINEAR_API = 'https://api.linear.app/graphql';

const ISSUE_QUERY = `
query Issue($number: Float!, $team: String!) {
  issues(filter: { number: { eq: $number }, team: { key: { eq: $team } } }, first: 1) {
    nodes {
      identifier
      title
      url
      description
      state { name }
      branchName
      attachments { nodes { url title } }
      comments { nodes { body user { displayName } } }
    }
  }
}`;

interface LinearIssueNode {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  state: { name: string } | null;
  branchName: string | null;
  attachments: { nodes: { url: string; title: string | null }[] } | null;
  comments: { nodes: { body: string; user: { displayName: string } | null }[] } | null;
}

async function linearQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      // Linear personal API keys are sent raw, without a "Bearer" prefix.
      Authorization: config.LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }

  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (payload.errors?.length) {
    throw new Error(`Linear API error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (!payload.data) throw new Error('Linear API returned no data');
  return payload.data;
}

export function parseTicketKey(key: string): { team: string; number: number } | null {
  const match = /^([A-Za-z]+)-(\d+)$/.exec(key.trim());
  if (!match) return null;
  return { team: (match[1] as string).toUpperCase(), number: Number(match[2]) };
}

export async function getTicket(key: string): Promise<TicketInfo> {
  const parsed = parseTicketKey(key);
  if (!parsed) throw new Error(`Not a Linear ticket key: ${JSON.stringify(key)}`);

  const data = await linearQuery<{ issues: { nodes: LinearIssueNode[] } }>(ISSUE_QUERY, {
    number: parsed.number,
    team: parsed.team,
  });

  const node = data.issues.nodes[0];
  if (!node) throw new Error(`Linear ticket not found: ${parsed.team}-${parsed.number}`);

  return {
    key: node.identifier,
    title: node.title,
    url: node.url,
    body: node.description ?? '',
    state: node.state?.name ?? 'unknown',
    branchName: node.branchName ?? null,
    comments: (node.comments?.nodes ?? []).map((c) => ({
      author: c.user?.displayName ?? 'unknown',
      body: c.body,
    })),
    attachmentUrls: (node.attachments?.nodes ?? []).map((a) => a.url).filter(Boolean),
  };
}

export function parsePrUrls(urls: string[]): { repo: string; prNumber: number }[] {
  const org = config.GITHUB_ORG.toLowerCase();
  const out: { repo: string; prNumber: number }[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
    if (!match) continue;
    const [, urlOrg, repo, number] = match;
    if ((urlOrg as string).toLowerCase() !== org) continue;
    try {
      assertAllowedRepo(repo as string);
    } catch {
      continue;
    }
    const key = `${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: repo as string, prNumber: Number(number) });
  }

  return out;
}
