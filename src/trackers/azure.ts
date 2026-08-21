import { config } from '../config.js';
import { logger } from '../logger.js';
import { collectPrUrls } from '../prLinks.js';
import type { TicketInfo } from '../types.js';
import { htmlToText } from './html.js';
import { assertConfigured, basicAuth, readJson, trimSlash, type TicketProvider } from './types.js';

const API_VERSION = '7.0';

interface WorkItem {
  id?: number;
  fields?: Record<string, unknown>;
  relations?: { rel?: string; url?: string; attributes?: { name?: string } }[];
  _links?: { html?: { href?: string } };
}

interface WorkItemComments {
  comments?: { text?: string; createdBy?: { displayName?: string } }[];
}

function field(item: WorkItem, name: string): string {
  const value = item.fields?.[name];
  return typeof value === 'string' ? value : '';
}

function baseUrl(): string {
  return trimSlash(config.AZURE_ORG_URL as string);
}

function authHeaders(): Record<string, string> {
  // Azure DevOps personal access tokens authenticate as Basic with an empty user.
  return { Authorization: basicAuth('', config.AZURE_PAT as string) };
}

/** A bare work item id, `#123`, or a `_workitems/edit/123` URL. */
function parseId(input: string): number | null {
  const raw = input.trim();
  const bare = /^#?(\d+)$/.exec(raw);
  if (bare) return Number(bare[1]);
  const url = /^https?:\/\/[^\s]*\/_workitems\/edit\/(\d+)(?:[/?#].*)?$/i.exec(raw);
  return url ? Number(url[1]) : null;
}

async function comments(id: number): Promise<{ author: string; body: string }[]> {
  const url =
    `${baseUrl()}/${encodeURIComponent(config.AZURE_PROJECT as string)}` +
    `/_apis/wit/workItems/${id}/comments?api-version=7.0-preview.3`;
  try {
    const data = await readJson<WorkItemComments>(url, authHeaders(), 'Azure DevOps API');
    return (data.comments ?? [])
      .map((c) => ({ author: c.createdBy?.displayName ?? 'unknown', body: htmlToText(c.text) }))
      .filter((c) => c.body.length > 0);
  } catch (error) {
    logger.warn(`Could not read Azure DevOps comments of work item ${id}:`, (error as Error).message);
    return [];
  }
}

export const azureProvider: TicketProvider = {
  name: 'azure',
  requiredEnv: ['AZURE_ORG_URL', 'AZURE_PROJECT', 'AZURE_PAT'],

  isConfigured: () => Boolean(config.AZURE_ORG_URL && config.AZURE_PROJECT && config.AZURE_PAT),

  matches: (input) => parseId(input) !== null,

  async getTicket(input) {
    assertConfigured(azureProvider);
    const id = parseId(input);
    if (id === null) throw new Error(`Not an Azure DevOps work item id: ${JSON.stringify(input)}`);

    const url =
      `${baseUrl()}/${encodeURIComponent(config.AZURE_PROJECT as string)}` +
      `/_apis/wit/workitems/${id}?$expand=all&api-version=${API_VERSION}`;
    const item = await readJson<WorkItem>(url, authHeaders(), 'Azure DevOps API');

    // Description fields are HTML; repro steps carry the requirements on bugs.
    const parts = [
      htmlToText(field(item, 'System.Description')),
      htmlToText(field(item, 'Microsoft.VSTS.TCM.ReproSteps')),
      htmlToText(field(item, 'Microsoft.VSTS.Common.AcceptanceCriteria')),
    ].filter(Boolean);
    const body = parts.join('\n\n');
    const notes = await comments(id);
    const linked = (item.relations ?? []).map((r) => r.url ?? '').filter(Boolean);

    return {
      provider: 'azure',
      key: `#${id}`,
      title: field(item, 'System.Title') || `Work item ${id}`,
      url:
        item._links?.html?.href ??
        `${baseUrl()}/${config.AZURE_PROJECT as string}/_workitems/edit/${id}`,
      body,
      state: field(item, 'System.State') || 'unknown',
      branchName: null,
      comments: notes,
      attachmentUrls: collectPrUrls(body, ...notes.map((c) => c.body), ...linked),
    } satisfies TicketInfo;
  },
};
