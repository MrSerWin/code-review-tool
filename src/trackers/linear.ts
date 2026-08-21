import { config } from '../config.js';
import type { TicketInfo } from '../types.js';
import { assertConfigured, parseIssueKey, type TicketProvider } from './types.js';

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
      Authorization: config.LINEAR_API_KEY as string,
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
  const parsed = parseIssueKey(key);
  if (!parsed || !/^[A-Za-z]+$/.test(parsed.project)) return null;
  return { team: parsed.project.toUpperCase(), number: parsed.number };
}

export const linearProvider: TicketProvider = {
  name: 'linear',
  requiredEnv: ['LINEAR_API_KEY'],

  isConfigured: () => Boolean(config.LINEAR_API_KEY),

  matches: (input) => parseTicketKey(input) !== null,

  async getTicket(input) {
    assertConfigured(linearProvider);
    const parsed = parseTicketKey(input);
    if (!parsed) throw new Error(`Not a Linear ticket key: ${JSON.stringify(input)}`);

    const data = await linearQuery<{ issues: { nodes: LinearIssueNode[] } }>(ISSUE_QUERY, {
      number: parsed.number,
      team: parsed.team,
    });

    const node = data.issues.nodes[0];
    if (!node) throw new Error(`Linear ticket not found: ${parsed.team}-${parsed.number}`);

    return {
      provider: 'linear',
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
    } satisfies TicketInfo;
  },
};
