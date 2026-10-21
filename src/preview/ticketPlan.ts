/**
 * The preview of a whole ticket: per recipe role, the tip of that repository's
 * chain in the ticket group (the last branch in stack order, which contains
 * every slice below it). The ticket page and the MCP `start_preview` share it.
 */
import { defaultBranch as remoteDefaultBranch } from '../resolver.js';
import { groupHeads } from '../ticketGroups.js';
import { orderChains } from '../ticketChains.js';
import { getTicketGroup, listTicketBranches, syncMembersFromReviews } from '../ticketStore.js';
import type { PreviewRow, ReviewSource, TicketBranchRow } from '../types.js';
import { findRecipe, loadRecipes, type Recipe } from './recipes.js';
import type { RoleOverrideInput } from './roles.js';
import { listPreviews } from './store.js';

/** One branch of a chain, with the source of its latest review. */
export interface PlanChainMember {
  branch: string;
  parent_branch: string | null;
  default_branch: string | null;
  position: number;
  /** The member row's source. */
  source: ReviewSource;
  /** The source of the branch's latest review, when it has one; it wins over `source`. */
  latestSource?: ReviewSource | null | undefined;
}

export interface TicketPlanRole {
  role: string;
  repo: string;
  /** What runs: the chain tip, or the base branch when the group has no branch in this repo. */
  branch: string;
  base: string;
  defaultBranch: string;
  usedBase: boolean;
  source: ReviewSource;
  /** The repo's branches in chain order; the last one is the tip. */
  chain: string[];
}

export interface PlanTicketRolesInput {
  recipeRepos: Record<string, string>;
  /** repo -> its members in chain order (parents first). */
  chains: Record<string, PlanChainMember[]>;
  /** repo -> default branch, for repositories whose members do not record one. */
  defaultBranches: Record<string, string>;
}

/**
 * The roles of a ticket preview. A role runs the last branch of its repo's
 * chain, from the local clone when that branch's latest review was local; its
 * base is the base the chain sits on. A repo without a branch in the group
 * runs its base branch (`usedBase`). Pure.
 */
export function planTicketRoles(input: PlanTicketRolesInput): { roles: TicketPlanRole[]; notes: string[] } {
  const roles: TicketPlanRole[] = [];
  const notes: string[] = [];
  for (const [role, repo] of Object.entries(input.recipeRepos)) {
    const members = input.chains[repo] ?? [];
    const def = members.find((m) => m.default_branch)?.default_branch ?? input.defaultBranches[repo];
    if (!def) throw new Error(`The default branch of ${repo} is unknown`);
    const tip = members.at(-1);
    if (!tip) {
      roles.push({ role, repo, branch: def, base: def, defaultBranch: def, usedBase: true, source: 'github', chain: [] });
      continue;
    }
    const names = new Set(members.map((m) => m.branch));
    const roots = members.filter((m) => !m.parent_branch || m.parent_branch === m.branch || !names.has(m.parent_branch));
    if (roots.length > 1 || hasFork(members, names)) {
      notes.push(`${repo}: the branches do not stack into one line; ${tip.branch}, the last in chain order, runs.`);
    }
    const root = rootOf(tip, members);
    const base = root.parent_branch && root.parent_branch !== root.branch ? root.parent_branch : def;
    roles.push({
      role, repo, branch: tip.branch, base, defaultBranch: def, usedBase: false,
      source: tip.latestSource ?? tip.source, chain: members.map((m) => m.branch),
    });
  }
  return { roles, notes };
}

function hasFork(members: PlanChainMember[], names: Set<string>): boolean {
  const kids = new Map<string, number>();
  for (const m of members) {
    if (m.parent_branch && m.parent_branch !== m.branch && names.has(m.parent_branch)) {
      kids.set(m.parent_branch, (kids.get(m.parent_branch) ?? 0) + 1);
    }
  }
  return [...kids.values()].some((n) => n > 1);
}

/** Walks up from `member` to the branch whose parent is outside the group. */
function rootOf(member: PlanChainMember, members: PlanChainMember[]): PlanChainMember {
  const byName = new Map(members.map((m) => [m.branch, m]));
  const seen = new Set<string>();
  let current = member;
  while (current.parent_branch && current.parent_branch !== current.branch && !seen.has(current.branch)) {
    seen.add(current.branch);
    const parent = byName.get(current.parent_branch);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * The `roles` of a `POST /api/previews` body that runs the plan exactly: every
 * role is sent, so nothing is resolved again. A base-branch role is sent
 * without a branch; a base other than the default branch is sent along.
 */
export function planRequestRoles(roles: TicketPlanRole[]): RoleOverrideInput[] {
  return roles.map((r) => {
    if (r.usedBase) return { role: r.role };
    const out: RoleOverrideInput = { role: r.role, branch: r.branch };
    if (r.base !== r.defaultBranch) out.base = r.base;
    if (r.source === 'local') out.local = true;
    return out;
  });
}

/** Statuses a preview can still be opened in; `stopping` is on its way out. */
const OPENABLE = new Set(['queued', 'preparing', 'starting', 'ready']);

type StoredRole = { role: string; repo: string; branch: string; base: string; usedBase?: boolean; source?: ReviewSource };

function storedRoles(row: Pick<PreviewRow, 'roles_json'>): StoredRole[] {
  try {
    const parsed = JSON.parse(row.roles_json) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredRole[]) : [];
  } catch {
    return [];
  }
}

/** Whether a preview runs exactly the planned roles: same branch (or base) and source for every role. */
export function runsPlan(row: Pick<PreviewRow, 'roles_json'>, roles: TicketPlanRole[]): boolean {
  const stored = storedRoles(row);
  if (stored.length !== roles.length) return false;
  return roles.every((p) => {
    const s = stored.find((x) => x.role === p.role);
    if (!s || s.repo !== p.repo) return false;
    if ((s.source ?? 'github') !== p.source) return false;
    if (p.usedBase) return Boolean(s.usedBase) && s.base === p.base;
    return !s.usedBase && s.branch === p.branch;
  });
}

/** The newest openable preview of the recipe that runs the plan, and the other openable ones. */
export function livePreviewsFor(
  rows: PreviewRow[],
  recipe: string,
  roles: TicketPlanRole[],
): { match: PreviewRow | null; others: PreviewRow[] } {
  const live = rows.filter((r) => OPENABLE.has(r.status)).sort((a, b) => b.id - a.id);
  const match = live.find((r) => r.recipe === recipe && runsPlan(r, roles)) ?? null;
  return { match, others: live.filter((r) => r !== match) };
}

export interface TicketPlanDeps {
  defaultBranch(repo: string): Promise<string>;
  /** The configured recipes; the recipes directory by default. */
  recipes?: () => Recipe[];
}

export const defaultTicketPlanDeps: TicketPlanDeps = { defaultBranch: remoteDefaultBranch };

export class PlanError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface TicketPreviewPlan {
  ticket: string;
  recipe: string;
  roles: TicketPlanRole[];
  /** The body that starts this plan with `POST /api/previews`. */
  request: { ticket: string; recipe: string; roles: RoleOverrideInput[] };
  livePreview: PreviewRow | null;
  otherLive: PreviewRow[];
  notes: string[];
}

function pickPlanRecipe(name: string | undefined, listed?: () => Recipe[]): Recipe {
  if (name) {
    if (listed) {
      const found = listed().find((r) => r.name === name);
      if (!found) throw new PlanError(`Unknown recipe ${JSON.stringify(name)}`);
      return found;
    }
    try {
      return findRecipe(name);
    } catch (err) {
      throw new PlanError((err as Error).message);
    }
  }
  const recipes = listed ? listed() : loadRecipes().recipes;
  if (recipes.length === 1) return recipes[0] as Recipe;
  if (recipes.length === 0) throw new PlanError('No preview recipe is configured', 409);
  throw new PlanError(`Several recipes are configured; name one of: ${recipes.map((r) => r.name).join(', ')}`);
}

/** Chains of the stored group, per repo, with each branch's latest review source. */
export function groupChains(key: string): Record<string, PlanChainMember[]> {
  const heads = groupHeads(key);
  const out: Record<string, PlanChainMember[]> = {};
  for (const chain of orderChains<TicketBranchRow>(listTicketBranches(key))) {
    out[chain.repo] = chain.nodes.map(({ item }) => ({
      branch: item.branch,
      parent_branch: item.parent_branch,
      default_branch: item.default_branch,
      position: item.position,
      source: item.source,
      latestSource: heads.get(`${item.repo}#${item.branch}`)?.latest.source ?? null,
    }));
  }
  return out;
}

/** The preview plan of a stored ticket group. Throws `PlanError` (404 without a group). */
export async function ticketPreviewPlan(
  key: string,
  recipeName?: string,
  deps: TicketPlanDeps = defaultTicketPlanDeps,
): Promise<TicketPreviewPlan> {
  syncMembersFromReviews(key);
  if (!getTicketGroup(key)) throw new PlanError(`No ticket group ${key}`, 404);
  const recipe = pickPlanRecipe(recipeName, deps.recipes);
  const chains = groupChains(key);
  const defaultBranches: Record<string, string> = {};
  for (const repo of new Set(Object.values(recipe.repos))) {
    if (chains[repo]?.some((m) => m.default_branch)) continue;
    try {
      defaultBranches[repo] = await deps.defaultBranch(repo);
    } catch (err) {
      throw new PlanError(`Could not read the default branch of ${repo}: ${(err as Error).message}`, 502);
    }
  }
  const { roles, notes } = planTicketRoles({ recipeRepos: recipe.repos, chains, defaultBranches });
  const { match, others } = livePreviewsFor(listPreviews({ ticket: key, limit: 100 }).previews, recipe.name, roles);
  return {
    ticket: key,
    recipe: recipe.name,
    roles,
    request: { ticket: key, recipe: recipe.name, roles: planRequestRoles(roles) },
    livePreview: match,
    otherLive: others,
    notes,
  };
}
