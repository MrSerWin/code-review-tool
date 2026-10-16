/**
 * Which branch each role of a preview runs. Pure and network-free: the engine
 * resolves tickets and default branches, this module only decides.
 */
import { assertSafeName } from '../gitNames.js';
import { ticketKeyFromBranch } from '../groupKey.js';
import { LOCAL_PREFIX, parseLocalInput } from '../localRepos.js';
import { parsePullRequestRef } from '../resolver.js';
import { TRACKER_NAMES } from '../trackers/types.js';
import type { PreviewRole, ResolvedTarget, TicketInfo } from '../types.js';

/** `linear:`, `jira:`, … in front of a ticket key. */
const TRACKER_PREFIX = new RegExp(`^(?:${TRACKER_NAMES.join('|')}):`, 'i');

/** A branch the resolver found, reduced to what a preview role needs. */
export type RoleTarget = Pick<ResolvedTarget, 'repo' | 'branch' | 'baseBranch' | 'source'>;

/**
 * The branches a preview can draw from: the ones the input itself named (a PR,
 * a tree URL) first, then the ticket's branches for every repo the input did
 * not cover. An explicitly named branch always wins for its repository.
 */
export function mergeTargets(explicit: RoleTarget[], ticket: RoleTarget[]): RoleTarget[] {
  const covered = new Set(explicit.map((t) => t.repo));
  return [...explicit, ...ticket.filter((t) => !covered.has(t.repo))];
}

/**
 * A branch picked by hand for one role, as the API receives it. A local role
 * (`local: true`, or a branch written `local:<repo>#<branch>` like a review
 * input) is copied from the configured local clone instead of GitHub.
 */
export interface RoleOverrideInput {
  role: string;
  /** Empty or absent: the role runs its base branch (local: the clone's checked-out branch). */
  branch?: string | undefined;
  base?: string | undefined;
  local?: boolean | undefined;
}

/**
 * A checked override: a recipe role, its repository, and the branch. A null
 * branch runs the base branch, or for a local role the clone's checked-out
 * branch until the engine resolves it.
 */
export interface RoleOverride {
  role: string;
  repo: string;
  branch: string | null;
  base?: string | undefined;
  /** Present only for local roles. */
  source?: 'local';
  /** Local roles, once resolved: the branch tip in the clone. */
  sha?: string;
}

/**
 * The branch of one hand-picked role and whether it is local. A `local:` branch
 * must name the role's own repository: `local:<repo>#<branch>`, or `local:<repo>`
 * for the clone's checked-out branch.
 */
export function parseRoleBranch(
  role: string,
  repo: string,
  rawBranch: string | undefined,
  localFlag: boolean | undefined,
): { branch: string | null; local: boolean } {
  const trimmed = rawBranch?.trim() ?? '';
  if (trimmed.toLowerCase().startsWith(LOCAL_PREFIX)) {
    const parsed = parseLocalInput(trimmed);
    if (!parsed) throw new Error(`Malformed local branch for role ${role}: ${JSON.stringify(trimmed)}`);
    if (parsed.repo !== repo) {
      throw new Error(
        `Role ${role} runs repo ${repo}, but its branch names local:${parsed.repo}; use local:${repo}#<branch>`,
      );
    }
    return { branch: parsed.branch, local: true };
  }
  const branch = trimmed || null;
  if (localFlag && branch !== null) assertSafeName('branch', branch);
  return { branch, local: Boolean(localFlag) };
}

/**
 * Checks hand-picked roles against the recipe: every role must be one of the
 * recipe's and appear once. Names are trimmed; an empty branch means "run the
 * base branch" (for a local role: the clone's checked-out branch). Throws with
 * a message fit for the user.
 */
export function normalizeOverrides(
  input: RoleOverrideInput[] | undefined,
  recipeRepos: Record<string, string>,
  recipeName?: string,
): RoleOverride[] {
  const valid = Object.keys(recipeRepos);
  const seen = new Set<string>();
  const out: RoleOverride[] = [];
  for (const item of input ?? []) {
    const role = item.role.trim();
    const repo = Object.hasOwn(recipeRepos, role) ? recipeRepos[role] : undefined;
    if (!repo) {
      const where = recipeName ? ` in recipe "${recipeName}"` : '';
      throw new Error(`Unknown role "${role}"${where}. Valid roles: ${valid.join(', ')}`);
    }
    if (seen.has(role)) throw new Error(`Role "${role}" is given more than once`);
    seen.add(role);
    const { branch, local } = parseRoleBranch(role, repo, item.branch, item.local);
    const base = item.base?.trim() || undefined;
    if (local && base !== undefined) assertSafeName('base branch', base);
    const override: RoleOverride = base ? { role, repo, branch, base } : { role, repo, branch };
    if (local) override.source = 'local';
    out.push(override);
  }
  return out;
}

export interface MissingBranch {
  role: string;
  repo: string;
  branch: string;
  kind: 'branch' | 'base';
  /** Missing from the local clone rather than from the remote. */
  local?: boolean;
}

/**
 * The hand-picked branches (and bases) that the remote does not have, given
 * repository -> its remote branch names. A repository missing from the map is
 * not checked here; the caller lists every repository it needs. Local roles
 * are checked against the clone instead and are skipped here.
 */
export function missingOverrideBranches(
  overrides: RoleOverride[],
  remote: Record<string, readonly string[]>,
): MissingBranch[] {
  const missing: MissingBranch[] = [];
  for (const o of overrides) {
    if (o.source === 'local') continue;
    const heads = remote[o.repo];
    if (!heads) continue;
    if (o.branch !== null && !heads.includes(o.branch)) {
      missing.push({ role: o.role, repo: o.repo, branch: o.branch, kind: 'branch' });
    }
    if (o.base !== undefined && !heads.includes(o.base)) {
      missing.push({ role: o.role, repo: o.repo, branch: o.base, kind: 'base' });
    }
  }
  return missing;
}

export function missingBranchMessage(missing: MissingBranch[]): string {
  return missing
    .map((m) => `${m.kind === 'base' ? 'Base branch' : 'Branch'} ${m.branch} not found in `
      + `${m.local ? 'the local clone of ' : ''}repo ${m.repo} (role ${m.role})`)
    .join('; ');
}

/**
 * A display ticket for a preview started from branches alone: the ticket key
 * the branch names carry, when the ones that carry a key all name the same.
 */
export function ticketKeyFromBranches(branches: (string | null)[]): string | null {
  const keys = new Set<string>();
  for (const branch of branches) {
    const key = branch ? ticketKeyFromBranch(branch) : null;
    if (key) keys.add(key);
  }
  return keys.size === 1 ? ([...keys][0] as string) : null;
}

/** True when the overrides decide every role, so no ticket lookup is needed. */
export function coversAllRoles(overrides: RoleOverride[], recipeRepos: Record<string, string>): boolean {
  const covered = new Set(overrides.map((o) => o.role));
  return Object.keys(recipeRepos).every((role) => covered.has(role));
}

export interface PlanRolesInput {
  /** role -> repository, as the recipe lists them. */
  recipeRepos: Record<string, string>;
  /** repository -> its default branch. */
  defaultBranches: Record<string, string>;
  /** Branches picked by hand, per role; they win over everything else. A null branch runs the base branch. */
  overrides?: Pick<RoleOverride, 'role' | 'branch' | 'base' | 'source' | 'sha'>[] | undefined;
  /** The reviewed branch, when the preview is started from a review. */
  review?: { repo: string; branch: string; base_branch: string; source?: 'github' | 'local' } | undefined;
  /** Branches the input named itself. */
  explicitTargets: RoleTarget[];
  /** Every branch of the ticket behind the input. */
  ticketTargets: RoleTarget[];
}

/**
 * One role per recipe repository. A repository with no branch anywhere in the
 * ticket runs its base branch, recorded as `usedBase` so the UI can say so; so
 * does a role whose hand-picked branch is empty or is its base branch.
 */
export function planRoles(input: PlanRolesInput): PreviewRole[] {
  const targets = mergeTargets(input.explicitTargets, input.ticketTargets);
  const roles: PreviewRole[] = [];
  for (const [role, repo] of Object.entries(input.recipeRepos)) {
    const base = input.defaultBranches[repo];
    if (!base) throw new Error(`The default branch of ${repo} is unknown`);
    const override = input.overrides?.find((o) => o.role === role);
    if (override) {
      const overrideBase = override.base ?? base;
      const branch = override.branch ?? overrideBase;
      const planned: PreviewRole = { role, repo, branch, base: overrideBase, usedBase: branch === overrideBase };
      roles.push(withLocal(planned, override.source === 'local', override.sha));
      continue;
    }
    if (input.review && input.review.repo === repo) {
      const planned: PreviewRole = {
        role, repo, branch: input.review.branch, base: input.review.base_branch, usedBase: false,
      };
      roles.push(withLocal(planned, input.review.source === 'local'));
      continue;
    }
    const target = targets.find((t) => t.repo === repo);
    if (target) {
      const planned: PreviewRole = { role, repo, branch: target.branch, base: target.baseBranch, usedBase: false };
      roles.push(withLocal(planned, target.source === 'local'));
      continue;
    }
    roles.push({ role, repo, branch: base, base, usedBase: true });
  }
  return roles;
}

/**
 * The planned roles that run the reviewed branch because no override picked
 * one: the precedence of `planRoles`, where a hand-picked role (even one naming
 * the same branch) wins over the review.
 */
export function rolesFromReview<R extends Pick<PreviewRole, 'role' | 'repo' | 'branch'>>(
  roles: R[],
  overrides: Pick<RoleOverride, 'role'>[],
  review: { repo: string; branch: string } | undefined,
): R[] {
  if (!review) return [];
  const picked = new Set(overrides.map((o) => o.role));
  return roles.filter((r) => !picked.has(r.role) && r.repo === review.repo && r.branch === review.branch);
}

/** Marks a role as copied from the local clone; GitHub roles carry no source field. */
function withLocal(role: PreviewRole, local: boolean, sha?: string): PreviewRole {
  if (!local) return role;
  return sha ? { ...role, source: 'local', sha } : { ...role, source: 'local' };
}

/** `org/repo#N` or a PR URL: a pull request standing in for a ticket. */
export function isPullRequestKey(key: string, org: string): boolean {
  return parsePullRequestRef(key, org) !== null;
}

/**
 * What a preview resolves its branches from: the ticket the user typed; else
 * the review's ticket key; else, when that key is only a pull request, the
 * ticket key its branch name carries, so the other repositories of the ticket
 * are found too.
 */
export function previewLookupKey(
  input: { ticket?: string | null; review?: { ticket_key: string | null; branch: string } | undefined },
  org: string,
): string | null {
  const typed = input.ticket?.trim();
  if (typed) return typed;
  if (!input.review) return null;
  const reviewKey = input.review.ticket_key?.trim() || null;
  if (reviewKey && !isPullRequestKey(reviewKey, org)) return reviewKey;
  return ticketKeyFromBranch(input.review.branch) ?? reviewKey;
}

/**
 * The tracker key of a resolved ticket, or null when there is none: pasted
 * requirements, or a pull request read as its own ticket.
 */
export function trackerKeyOf(ticket: Pick<TicketInfo, 'key' | 'provider'> | null, org: string): string | null {
  if (!ticket || ticket.provider === 'manual') return null;
  const key = ticket.key.trim();
  if (!key || isPullRequestKey(key, org) || /^https?:\/\//i.test(key)) return null;
  return key;
}

/**
 * The ticket worth a second lookup: the tracker key found behind the input (a
 * PR whose branch names ABC-123), when the input was not that ticket already.
 */
export function followUpTicketKey(lookup: string, trackerKey: string | null): string | null {
  if (!trackerKey) return null;
  // `jira:ABC-12` (or an issue link, canonicalized to that) already was ABC-12.
  const typed = lookup.trim().replace(TRACKER_PREFIX, '');
  if (trackerKey.toLowerCase() === typed.toLowerCase()) return null;
  return trackerKey;
}
