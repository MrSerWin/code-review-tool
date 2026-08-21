import { assertAllowedRepo, config } from './config.js';

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_URL_ANYWHERE = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/gi;

/**
 * GitHub pull request links, whatever tracker they came from. Anything outside
 * the configured organization or the repository allowlist is dropped silently:
 * a ticket may legitimately link elsewhere, and that is not an error.
 */
export function parsePrUrls(urls: string[]): { repo: string; prNumber: number }[] {
  const org = config.GITHUB_ORG.toLowerCase();
  const out: { repo: string; prNumber: number }[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const match = PR_URL.exec(url.trim());
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

/** Pull request links mentioned in free text, for trackers without attachments. */
export function collectPrUrls(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.match(PR_URL_ANYWHERE) ?? []) found.add(match);
  }
  return [...found];
}
