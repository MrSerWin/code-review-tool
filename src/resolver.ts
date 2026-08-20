import { ALLOWED_REPOS, assertAllowedRepo, config } from './config.js';
import { getTicket, parsePrUrls, parseTicketKey } from './linear.js';
import { ghApi, lsRemoteHeads } from './gitSandbox.js';
import { logger } from './logger.js';
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

function ticketBranchPattern(key: string): RegExp {
  const parsed = parseTicketKey(key);
  if (!parsed) throw new Error(`Not a ticket key: ${key}`);
  const team = parsed.team.toLowerCase();
  return new RegExp(`(^|[^a-z0-9])${team}-?${parsed.number}([^0-9]|$)`, 'i');
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

  const pattern = ticketBranchPattern(ticket.key);
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
  const match = /([A-Za-z]+)-(\d+)/.exec(branch);
  if (!match) return null;
  try {
    return await getTicket(`${match[1]}-${match[2]}`);
  } catch (error) {
    logger.warn(`No Linear ticket for branch ${branch}:`, (error as Error).message);
    return null;
  }
}

export async function resolveTargets(
  input: string,
): Promise<{ ticket: TicketInfo | null; targets: ResolvedTarget[] }> {
  const raw = input.trim();
  if (!raw) throw new Error('Unsupported input: empty');

  const org = config.GITHUB_ORG;

  if (parseTicketKey(raw)) {
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
      ticket: await ticketFromBranchName(branch),
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
      ticket: await ticketFromBranchName(pair.branch),
      targets: [
        { repo: pair.repo, branch: pair.branch, baseBranch: await defaultBranch(pair.repo), prNumber: null },
      ],
    };
  }

  throw new Error(
    `Unsupported input: ${JSON.stringify(raw)}. Use a ticket key (ABC-123), a pull request URL, a tree URL, or repo#branch.`,
  );
}
