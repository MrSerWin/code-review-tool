import { ALLOWED_REPOS, assertAllowedRepo, config } from './config.js';
import { ghApi, lsRemoteHeads } from './gitSandbox.js';
import { logger } from './logger.js';
import { parsePrUrls } from './prLinks.js';
import { activeTrackerNames, getTicket, looksLikeTicket } from './trackers/index.js';
import { firstLine } from './trackers/types.js';
import type { ResolvedTarget, TicketInfo } from './types.js';

const defaultBranchCache = new Map<string, string>();

async function defaultBranch(repo: string): Promise<string> {
  assertAllowedRepo(repo);
  const cached = defaultBranchCache.get(repo);
  if (cached) return cached;
  const info = await ghApi<{ default_branch?: string }>(`repos/${config.GITHUB_ORG}/${repo}`);
  const branch = info.default_branch ?? 'main';
  defaultBranchCache.set(repo, branch);
  return branch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How a ticket key shows up in a branch name. The key is just a string here:
 * branch discovery knows nothing about which tracker produced it.
 */
export function branchPattern(key: string): RegExp {
  const projectKey = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(key.trim());
  if (projectKey) {
    const project = escapeRegExp((projectKey[1] as string).toLowerCase());
    return new RegExp(`(^|[^a-z0-9])${project}-?${projectKey[2]}([^0-9]|$)`, 'i');
  }
  // Numeric keys (GitHub issues, Azure work items): match the number alone.
  const numeric = /(?:^|[/#])(\d+)$/.exec(key.trim());
  if (numeric) return new RegExp(`(^|[^0-9])${numeric[1]}([^0-9]|$)`);
  return new RegExp(escapeRegExp(key.trim()), 'i');
}

function pushTarget(targets: ResolvedTarget[], target: ResolvedTarget): void {
  if (targets.some((t) => t.repo === target.repo && t.branch === target.branch)) return;
  targets.push(target);
}

async function targetsFromTicket(ticket: TicketInfo): Promise<ResolvedTarget[]> {
  const targets: ResolvedTarget[] = [];

  for (const { repo, prNumber } of parsePrUrls(ticket.attachmentUrls)) {
    try {
      const pr = await ghApi<{ head?: { ref?: string }; base?: { ref?: string } }>(
        `repos/${config.GITHUB_ORG}/${repo}/pulls/${prNumber}`,
      );
      if (!pr.head?.ref) continue;
      pushTarget(targets, {
        repo,
        branch: pr.head.ref,
        baseBranch: pr.base?.ref ?? (await defaultBranch(repo)),
        prNumber,
      });
    } catch (error) {
      logger.warn(`Could not read PR ${repo}#${prNumber}:`, (error as Error).message);
    }
  }

  const pattern = branchPattern(ticket.key);
  for (const repo of ALLOWED_REPOS) {
    let heads: string[];
    try {
      heads = await lsRemoteHeads(repo);
    } catch (error) {
      logger.warn(`Could not list branches of ${repo}:`, (error as Error).message);
      continue;
    }
    for (const branch of heads) {
      if (!pattern.test(branch) && branch !== ticket.branchName) continue;
      pushTarget(targets, { repo, branch, baseBranch: await defaultBranch(repo), prNumber: null });
    }
  }

  return targets;
}

async function ticketFromBranchName(branch: string): Promise<TicketInfo | null> {
  const match = /([A-Za-z][A-Za-z0-9_]*)-(\d+)/.exec(branch);
  if (!match) return null;
  const key = `${match[1]}-${match[2]}`;
  try {
    if (!looksLikeTicket(key)) return null;
    return await getTicket(key);
  } catch (error) {
    logger.warn(`No ticket for branch ${branch}:`, (error as Error).message);
    return null;
  }
}

/** Requirements pasted by hand stand in for a ticket, without a key. */
function manualTicket(text: string): TicketInfo {
  const body = text.trim();
  return {
    provider: 'manual',
    key: '',
    title: firstLine(body) || 'Pasted requirements',
    url: '',
    body,
    state: 'manual',
    branchName: null,
    comments: [],
    attachmentUrls: [],
  };
}

export interface ResolveOptions {
  /** Requirements typed by the user; replaces the ticket lookup entirely. */
  requirementsText?: string;
}

export async function resolveTargets(
  input: string,
  options: ResolveOptions = {},
): Promise<{ ticket: TicketInfo | null; targets: ResolvedTarget[] }> {
  const raw = input.trim();
  if (!raw) throw new Error('Unsupported input: empty');

  const manual = options.requirementsText?.trim() ? manualTicket(options.requirementsText) : null;
  const org = config.GITHUB_ORG;

  // Pasted requirements replace the tracker, so the input only has to name a branch.
  if (!manual && looksLikeTicket(raw)) {
    const ticket = await getTicket(raw);
    const targets = await targetsFromTicket(ticket);
    if (targets.length === 0) {
      throw new Error(
        `No branches found for ${ticket.key}. Searched the ticket's PR attachments and the branches of: ${ALLOWED_REPOS.join(', ')}.`,
      );
    }
    return { ticket, targets };
  }

  const prMatch = new RegExp(`^https://github\\.com/${org}/([^/]+)/pull/(\\d+)(?:[/?#].*)?$`, 'i').exec(raw);
  if (prMatch) {
    const repo = prMatch[1] as string;
    const prNumber = Number(prMatch[2]);
    assertAllowedRepo(repo);
    const pr = await ghApi<{ head?: { ref?: string }; base?: { ref?: string } }>(
      `repos/${org}/${repo}/pulls/${prNumber}`,
    );
    if (!pr.head?.ref) throw new Error(`Pull request ${repo}#${prNumber} has no head branch`);
    const branch = pr.head.ref;
    return {
      ticket: manual ?? (await ticketFromBranchName(branch)),
      targets: [{ repo, branch, baseBranch: pr.base?.ref ?? (await defaultBranch(repo)), prNumber }],
    };
  }

  const treeMatch = new RegExp(`^https://github\\.com/${org}/([^/]+)/tree/(.+?)/?$`, 'i').exec(raw);
  const hashMatch = /^([A-Za-z0-9._-]+)#(.+)$/.exec(raw);
  const pair = treeMatch
    ? { repo: treeMatch[1] as string, branch: treeMatch[2] as string }
    : hashMatch
      ? { repo: hashMatch[1] as string, branch: hashMatch[2] as string }
      : null;

  if (pair) {
    assertAllowedRepo(pair.repo);
    return {
      ticket: manual ?? (await ticketFromBranchName(pair.branch)),
      targets: [
        { repo: pair.repo, branch: pair.branch, baseBranch: await defaultBranch(pair.repo), prNumber: null },
      ],
    };
  }

  const active = activeTrackerNames();
  if (manual) {
    throw new Error(
      `Unsupported input: ${JSON.stringify(raw)}. With pasted requirements the input must name a branch: ` +
        'a pull request URL, a tree URL, or repo#branch.',
    );
  }
  throw new Error(
    `Unsupported input: ${JSON.stringify(raw)}. Use a ticket key of a configured tracker ` +
      `(${active.join(', ')}), a pull request URL, a tree URL, or repo#branch. ` +
      'Requirements pasted by hand work without any tracker.',
  );
}
