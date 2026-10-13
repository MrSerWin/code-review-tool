import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getReview } from '../db.js';
import {
  assertPristine, fetchCheckout, ghApi, lsRemoteHeads, sanitizeBranchForPath,
} from '../gitSandbox.js';
import { branchUrl } from '../githubLinks.js';
import { ticketKeyFromBranch } from '../groupKey.js';
import { branchRefs, parseLocalInput, resolveLocalBranch } from '../localRepos.js';
import { logger } from '../logger.js';
import { sanitizeLogMessage } from '../logSanitize.js';
import { remoteBranches } from '../remoteBranches.js';
import { resolveTargets } from '../resolver.js';
import { buildSanitizedEnv, REVIEWER_MARKER_ENV } from '../reviewers/shared.js';
import type {
  DumpMode, LogLevel, PreviewRole, PreviewRow, PreviewStatus, ResolvedTarget,
} from '../types.js';
import { resolveDumpSource } from './database.js';
import { publishPreview } from './events.js';
import { allocatePorts } from './ports.js';
import { findRecipe, loadRecipes, primaryPort, type Recipe } from './recipes.js';
import {
  coversAllRoles, followUpTicketKey, missingBranchMessage, missingOverrideBranches, normalizeOverrides,
  planRoles, previewLookupKey, ticketKeyFromBranches, trackerKeyOf, type MissingBranch, type RoleOverride,
  type RoleOverrideInput, type RoleTarget,
} from './roles.js';
import { runStep } from './steps.js';
import {
  addPreviewLog, countLive, createPreview, deletePreviewRow, expiredPreviews, getPreview,
  livePreviews, parsePorts, updatePreview,
} from './store.js';

/**
 * Preview checkouts share the review checkout root, so their directory ids are
 * offset far past any plausible review id: a collision would let a preview
 * delete a checkout a running review is reading.
 */
const PREVIEW_CHECKOUT_ID_BASE = 1_000_000_000;

const TEARDOWN_STEP_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 3_000;
const REAPER_INTERVAL_MS = 30_000;

interface RunContext {
  previewId: number;
  recipe: Recipe;
  previewDir: string;
  env: NodeJS.ProcessEnv;
  /** Checkouts this preview created and may delete. */
  ownedCheckouts: string[];
  /** Review checkouts reused as-is; they must be pristine afterwards. */
  borrowedCheckouts: string[];
  tornDown: boolean;
}

const pending: number[] = [];
const running = new Map<number, { controller: AbortController; context?: RunContext }>();
/** Previews whose exit was asked for, and the status they should end in. */
const stopRequested = new Map<number, PreviewStatus>();
let workers = 0;
let reaper: NodeJS.Timeout | null = null;

export function previewsEnabled(): boolean {
  return config.previewEnabled;
}

export interface CreatePreviewRequest {
  reviewId?: number;
  ticket?: string;
  recipe?: string;
  /**
   * Branches picked by hand per role; an empty branch runs that role's base
   * branch. A local role (`local: true` or `local:<repo>#<branch>`) is copied
   * from the configured local clone.
   */
  roles?: RoleOverrideInput[];
  dumpMode?: 'auto' | 'dump-dir' | 'pg_dump' | 'none' | 'clean';
}

/** Creates the row and queues it. Everything after this point is automatic. */
export async function requestPreview(request: CreatePreviewRequest): Promise<PreviewRow> {
  if (!config.previewEnabled) {
    throw new Error('Previews are disabled. Set PREVIEW_ENABLED=1 and configure a recipe.');
  }

  const recipe = pickRecipe(request.recipe);
  const review = request.reviewId !== undefined ? getReview(request.reviewId) : undefined;
  if (request.reviewId !== undefined && !review) throw new Error(`Review ${request.reviewId} not found`);
  // A local review's branch is copied from the clone again, so it must still be there.
  if (review?.source === 'local') await resolveLocalBranch(review.repo, review.branch);

  // Hand-picked branches are checked before anything is queued: a typo must
  // not quietly turn into a preview of the base branch.
  const overrides = await checkOverrides(recipe, request.roles);

  const { roles, ticketKey } = await resolveRoles(recipe, {
    review,
    ticket: request.ticket,
    overrides,
  });

  const row = createPreview({
    review_id: review?.id ?? null,
    recipe: recipe.name,
    ticket_key: ticketKey,
    roles_json: JSON.stringify(roles),
    ports_json: '{}',
    credentials_hint: recipe.credentialsHint ?? null,
    status: 'queued',
  });

  dumpModeOverrides.set(row.id, request.dumpMode);
  log(row.id, 'info', `Queued preview of recipe "${recipe.name}".`);
  pending.push(row.id);
  publishStatus(row.id, 'queued');
  spawnWorkers();
  return getPreview(row.id) ?? row;
}

const dumpModeOverrides = new Map<number, CreatePreviewRequest['dumpMode']>();

function pickRecipe(name: string | undefined): Recipe {
  if (name) return findRecipe(name);
  const { recipes, errors } = loadRecipes();
  if (recipes.length === 1) return recipes[0] as Recipe;
  if (recipes.length === 0) {
    const detail = errors.length ? ` Invalid recipe(s): ${errors.map((e) => e.error).join('; ')}` : '';
    throw new Error(`No preview recipe is configured in ${config.previewRecipesDir}.${detail}`);
  }
  throw new Error(`Several recipes are configured; name one of: ${recipes.map((r) => r.name).join(', ')}`);
}

// --- role resolution ---

async function remoteHeads(repos: string[], fresh: boolean): Promise<Record<string, string[]>> {
  const heads: Record<string, string[]> = {};
  await Promise.all(
    repos.map(async (repo) => {
      try {
        heads[repo] = (await remoteBranches(repo, { fresh })).branches;
      } catch (err) {
        throw new Error(`Could not list the branches of ${repo} to check the chosen branch: ${(err as Error).message}`);
      }
    }),
  );
  return heads;
}

/**
 * Every hand-picked role must belong to the recipe, and every hand-picked
 * branch must exist on its repository's remote. The listing is cached; a miss
 * is checked once more uncached, so a branch pushed a moment ago is found.
 * Local roles are checked against their clone instead.
 */
async function checkOverrides(recipe: Recipe, input: RoleOverrideInput[] | undefined): Promise<RoleOverride[]> {
  const overrides = normalizeOverrides(input, recipe.repos, recipe.name);
  await checkLocalOverrides(overrides);
  const named = overrides.filter((o) => o.source !== 'local' && (o.branch !== null || o.base !== undefined));
  if (named.length === 0) return overrides;
  const repos = [...new Set(named.map((o) => o.repo))];
  let heads = await remoteHeads(repos, false);
  let missing = missingOverrideBranches(overrides, heads);
  if (missing.length > 0) {
    heads = { ...heads, ...(await remoteHeads([...new Set(missing.map((m) => m.repo))], true)) };
    missing = missingOverrideBranches(overrides, heads);
  }
  if (missing.length > 0) throw new Error(missingBranchMessage(missing));
  return overrides;
}

/**
 * Resolves every local role against its clone, in place: the branch (the
 * checked-out one when none was named) and its tip. A named base must exist in
 * the clone, as a local branch or as origin's. Every miss is reported at once.
 * Exported for tests; `paths` stands in for the configured clones.
 */
export async function checkLocalOverrides(overrides: RoleOverride[], paths?: Map<string, string>): Promise<void> {
  const missing: MissingBranch[] = [];
  for (const o of overrides) {
    if (o.source !== 'local') continue;
    let resolved;
    try {
      resolved = await resolveLocalBranch(o.repo, o.branch, paths);
    } catch (err) {
      if (o.branch === null || !/not found in the local clone/.test((err as Error).message)) throw err;
      missing.push({ role: o.role, repo: o.repo, branch: o.branch, kind: 'branch', local: true });
      continue;
    }
    o.branch = resolved.branch;
    o.sha = resolved.sha;
    if (o.base !== undefined) {
      const refs = await branchRefs(resolved.repoPath, o.base);
      if (!refs.localHead && !refs.originRef) {
        missing.push({ role: o.role, repo: o.repo, branch: o.base, kind: 'base', local: true });
      }
    }
  }
  if (missing.length > 0) throw new Error(missingBranchMessage(missing));
}

const defaultBranchCache = new Map<string, string>();

async function defaultBranch(repo: string): Promise<string> {
  const cached = defaultBranchCache.get(repo);
  if (cached) return cached;
  const info = await ghApi<{ default_branch?: string }>(`repos/${config.githubOrg}/${repo}`);
  const branch = info.default_branch;
  if (!branch) throw new Error(`Could not determine the default branch of ${repo}`);
  defaultBranchCache.set(repo, branch);
  return branch;
}

interface ResolveRolesInput {
  review?: {
    id: number; repo: string; branch: string; base_branch: string; ticket_key: string | null;
    source?: 'github' | 'local';
  } | undefined;
  /** What the user typed: a ticket key, a PR URL, or repo#branch. */
  ticket?: string | null | undefined;
  overrides?: RoleOverride[] | undefined;
}

export interface ResolvedRoles {
  roles: PreviewRole[];
  /** The tracker ticket when one was found, else what the preview was started from. */
  ticketKey: string | null;
}

/** The branches behind one input, and the tracker key found on the way; null when nothing resolved. */
async function targetsFor(key: string): Promise<{ targets: RoleTarget[]; trackerKey: string | null } | null> {
  try {
    const { ticket, targets } = await resolveTargets(key);
    return { targets, trackerKey: trackerKeyOf(ticket, config.githubOrg) };
  } catch (err) {
    // A local branch that is not in the clone is a typo, not a ticket without
    // branches: previewing the base branch instead would hide it.
    if (parseLocalInput(key)) throw err;
    logger.warn(`preview: no branches resolved for ${key}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Branches come from the whole ticket, not just the input: a PR names one
 * branch of one repository, so when its branch carries a tracker key the
 * ticket is resolved as well and its other repositories join the preview. The
 * PR's own branch still wins for its repository.
 *
 * A role whose repository has no branch anywhere in the ticket runs its base
 * branch, recorded as `usedBase` so the UI can say so instead of silently
 * previewing something the ticket never touched.
 */
export async function resolveRoles(recipe: Recipe, input: ResolveRolesInput): Promise<ResolvedRoles> {
  const org = config.githubOrg;
  const lookup = previewLookupKey({ ticket: input.ticket, review: input.review }, org);
  const fallbackKey = input.ticket?.trim() || input.review?.ticket_key || null;
  const overrides = input.overrides ?? [];
  // Every role picked by hand: the ticket (if any) only labels the preview, so
  // it is not resolved. Without one, the branch names may still carry a key.
  const handPicked = overrides.length > 0 && coversAllRoles(overrides, recipe.repos);
  const branchKey = overrides.length > 0 ? ticketKeyFromBranches(overrides.map((o) => o.branch)) : null;

  let explicitTargets: RoleTarget[] = [];
  let ticketTargets: RoleTarget[] = [];
  let trackerKey: string | null = null;
  if (lookup && !handPicked) {
    const first = await targetsFor(lookup);
    if (first) {
      explicitTargets = first.targets;
      // A local input (`local:<repo>#<branch>`) has no ticket of its own; the
      // key its branch name carries brings in the ticket's other repositories.
      const localBranch = parseLocalInput(lookup) ? first.targets[0]?.branch : undefined;
      trackerKey = first.trackerKey ?? (localBranch ? ticketKeyFromBranch(localBranch) : null);
      const followUp = followUpTicketKey(lookup, first.trackerKey);
      if (followUp) ticketTargets = (await targetsFor(followUp))?.targets ?? [];
    }
  }

  const defaultBranches: Record<string, string> = {};
  for (const repo of Object.values(recipe.repos)) defaultBranches[repo] = await defaultBranch(repo);

  const roles = planRoles({
    recipeRepos: recipe.repos,
    defaultBranches,
    overrides,
    review: input.review,
    explicitTargets,
    ticketTargets,
  });
  const label = handPicked ? lookup ?? fallbackKey : trackerKey ?? fallbackKey;
  return { roles, ticketKey: label ?? branchKey };
}

// --- worker pool ---

function spawnWorkers(): void {
  while (workers < config.previewMaxConcurrent && pending.length > 0) {
    workers += 1;
    void worker();
  }
}

async function worker(): Promise<void> {
  try {
    while (pending.length > 0) {
      const previewId = pending.shift();
      if (previewId === undefined) break;
      const controller = new AbortController();
      running.set(previewId, { controller });
      try {
        await startPreview(previewId, controller);
      } catch (err) {
        logger.error(`preview ${previewId} failed: ${(err as Error).message}`);
      } finally {
        running.delete(previewId);
        stopRequested.delete(previewId);
        dumpModeOverrides.delete(previewId);
      }
    }
  } finally {
    workers -= 1;
  }
}

/** Position in the queue, 1-based; 0 when it is not waiting. */
export function queuePosition(previewId: number): number {
  const index = pending.indexOf(previewId);
  return index < 0 ? 0 : index + 1;
}

// --- lifecycle ---

async function startPreview(previewId: number, controller: AbortController): Promise<void> {
  const row = getPreview(previewId);
  if (!row) return;
  if (stopRequested.has(previewId)) {
    finish(previewId, stopRequested.get(previewId) ?? 'stopped');
    return;
  }

  const recipe = findRecipe(row.recipe);
  const previewDir = path.join(config.dataDir, 'previews', String(previewId));
  fs.mkdirSync(previewDir, { recursive: true });

  const context: RunContext = {
    previewId,
    recipe,
    previewDir,
    env: {},
    ownedCheckouts: [],
    borrowedCheckouts: [],
    tornDown: false,
  };
  const entry = running.get(previewId);
  if (entry) entry.context = context;

  const deadline = Date.now() + recipe.readyTimeoutSec * 1000;
  const readyTimer = setTimeout(() => controller.abort(), recipe.readyTimeoutSec * 1000);
  readyTimer.unref();

  try {
    setStatus(previewId, 'preparing');
    const roles: PreviewRole[] = JSON.parse(row.roles_json) as PreviewRole[];

    // 1. checkouts
    const checkouts = await prepareCheckouts(context, row, roles);

    // 2. ports, held until the row records them
    const reservation = await allocatePorts(recipe.ports.map((p) => p.id));
    try {
      updatePreview(previewId, { ports_json: JSON.stringify(reservation.ports) });
      log(previewId, 'info', `Ports: ${Object.entries(reservation.ports).map(([id, p]) => `${id}=${p}`).join(', ')}`);
    } finally {
      // Recorded in the database now, so the sockets can be handed to the stack.
      reservation.release();
    }

    // 3. environment for every step
    const dbName = recipe.database?.name ?? `preview_${previewId}`;
    context.env = buildStepEnv({
      previewId,
      previewDir,
      recipe,
      roles,
      checkouts,
      ports: reservation.ports,
      ticketKey: row.ticket_key,
      dbName,
    });

    // 4. database source: pg_dump -> dump dir -> clean, never a human
    const dump = await resolveDumpSource(recipe, {
      previewDir,
      env: { ...context.env, ...recipe.env },
      onLog: (level, message) => log(previewId, level, message),
      modeOverride: dumpModeOverrides.get(previewId),
      signal: controller.signal,
    });
    context.env.DUMP_FILE = dump.file;
    context.env.DUMP_MODE = dump.mode;
    persistContext(context);
    updatePreview(previewId, {
      db_name: dbName,
      dump_mode: dump.mode as DumpMode,
      dump_source: dump.source,
    });

    throwIfAborted(controller.signal);

    // 5. prepare -> up -> health
    await runPhase(context, 'prepare', recipe.steps.prepare, controller.signal, deadline);
    setStatus(previewId, 'starting');
    await runPhase(context, 'up', recipe.steps.up, controller.signal, deadline);
    await waitForHealth(context, controller.signal, deadline);

    // 6. ready
    const primary = primaryPort(recipe);
    const url = `http://127.0.0.1:${reservation.ports[primary.id]}`;
    const readyAt = new Date();
    const expiresAt = new Date(readyAt.getTime() + config.previewTtlMinutes * 60_000);
    updatePreview(previewId, {
      status: 'ready',
      url,
      error: null,
      ready_at: readyAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    log(previewId, 'info', `Preview is ready at ${url} (expires ${expiresAt.toISOString()}).`);
    publishPreview(previewId, { type: 'ready', previewId, status: 'ready', url });
    publishStatus(previewId, 'ready');
  } catch (err) {
    const requested = stopRequested.get(previewId);
    const message = requested
      ? `Stopped before it was ready (${requested}).`
      : (err as Error).message;
    log(previewId, requested ? 'warn' : 'error', requested ? message : `Failed: ${message}`);
    // Teardown is unconditional: `up` may have started containers even when a
    // later step threw, and `prepare` may have half-created resources.
    await teardown(context, requested ?? 'failed');
    finish(previewId, requested ?? 'failed', requested ? null : message);
  } finally {
    clearTimeout(readyTimer);
  }
}

async function prepareCheckouts(
  context: RunContext,
  row: PreviewRow,
  roles: PreviewRole[],
): Promise<Record<string, string>> {
  const checkouts: Record<string, string> = {};
  for (const role of roles) {
    const reused = row.review_id !== null ? reviewCheckoutDir(row.review_id, role) : null;
    if (reused) {
      log(context.previewId, 'info', `Reusing the review checkout of ${role.repo} (${role.branch}).`);
      context.borrowedCheckouts.push(reused.dir);
      checkouts[role.role] = reused.dir;
      if (reused.sha) role.sha = reused.sha;
      updatePreview(context.previewId, { roles_json: JSON.stringify(roles) });
      continue;
    }
    // Persisted as soon as it is decided: the row is what the API and the UI
    // read, and a later step may fail before the loop ends.
    if (role.source !== 'local' && await fallBackIfBranchGone(context, role)) {
      updatePreview(context.previewId, { roles_json: JSON.stringify(roles) });
    }
    log(
      context.previewId,
      'info',
      role.source === 'local'
        ? `Copying ${role.repo} (${role.branch}) from the local clone in the git sandbox.`
        : `Fetching ${role.repo} (${role.branch}) in the git sandbox.`,
    );
    const result = await fetchCheckout(
      checkoutTarget(role),
      PREVIEW_CHECKOUT_ID_BASE + context.previewId,
      (level, message) => log(context.previewId, level, message),
    );
    context.ownedCheckouts.push(result.dir);
    checkouts[role.role] = result.dir;
    if (role.source === 'local' && role.sha && role.sha !== result.headSha) {
      log(
        context.previewId,
        'info',
        `${role.branch} moved since the preview was requested (${role.sha.slice(0, 7)} -> ${result.headSha.slice(0, 7)}); `
          + 'running the new tip.',
      );
    }
    role.sha = result.headSha;
    updatePreview(context.previewId, { roles_json: JSON.stringify(roles) });
  }
  return checkouts;
}

/**
 * What the sandbox checks out for a role. A local role is copied from the
 * clone's `refs/heads/<branch>` (committed state only, never a working tree);
 * every other role is fetched from GitHub.
 */
export function checkoutTarget(role: PreviewRole): ResolvedTarget {
  const target: ResolvedTarget = { repo: role.repo, branch: role.branch, baseBranch: role.base, prNumber: null };
  if (role.source === 'local') {
    target.source = 'local';
    target.includeWorkingTree = false;
  }
  return target;
}

/**
 * A branch that was merged and deleted on the remote must not sink a preview:
 * the role falls back to its base branch, the same state a repo reaches when
 * the ticket never touched it. Only a missing base branch is fatal.
 *
 * This is deliberately preview-only. `fetchCheckout` is shared with reviews and
 * is left untouched, so a review of a vanished branch still fails loudly:
 * reviewing the base branch instead would report on code the branch never had.
 *
 * Returns true when the role was rewritten.
 */
async function fallBackIfBranchGone(context: RunContext, role: PreviewRole): Promise<boolean> {
  let heads: string[];
  try {
    heads = await lsRemoteHeads(role.repo);
  } catch (err) {
    // A listing failure is not proof the branch is gone; let the fetch decide.
    log(
      context.previewId,
      'warn',
      `Could not list the branches of ${role.repo} (${(err as Error).message}); trying ${role.branch} anyway.`,
    );
    return false;
  }
  if (heads.includes(role.branch)) return false;
  if (role.branch === role.base) {
    throw new Error(`The base branch ${role.base} no longer exists on the remote of ${role.repo}.`);
  }
  if (!heads.includes(role.base)) {
    throw new Error(
      `Branch ${role.branch} no longer exists on the remote of ${role.repo}, `
        + `and neither does its base branch ${role.base}.`,
    );
  }
  log(
    context.previewId,
    'warn',
    `Branch ${role.branch} no longer exists on the remote of ${role.repo}; `
      + `using the base branch ${role.base} instead.`,
  );
  role.branch = role.base;
  role.usedBase = true;
  return true;
}

/**
 * The checkout a review left behind, when it is still on disk and matches the
 * role. A local review that included uncommitted changes is not reused: its
 * checkout holds a snapshot commit, and a preview runs committed state only.
 */
function reviewCheckoutDir(reviewId: number, role: PreviewRole): { dir: string; sha: string | null } | null {
  const review = getReview(reviewId);
  if (!review || review.repo !== role.repo || review.branch !== role.branch) return null;
  if ((review.source === 'local') !== (role.source === 'local') || review.working_tree) return null;
  let dir: string;
  try {
    dir = path.join(config.dataDir, 'checkouts', role.repo, sanitizeBranchForPath(role.branch), String(reviewId));
  } catch {
    return null;
  }
  return fs.existsSync(path.join(dir, '.git')) ? { dir, sha: review.head_sha } : null;
}

interface StepEnvInput {
  previewId: number;
  previewDir: string;
  recipe: Recipe;
  roles: PreviewRole[];
  checkouts: Record<string, string>;
  ports: Record<string, number>;
  ticketKey: string | null;
  dbName: string;
}

/**
 * The base every preview step starts from: the reviewer's allowlist with every
 * tracker and GitHub token removed, but without the reviewer marker. A step is
 * not a reviewer, and the marker would make an MCP server it starts refuse
 * every review.
 */
export function previewBaseEnv(): NodeJS.ProcessEnv {
  return buildSanitizedEnv();
}

/** Everything variable reaches a step through the environment, never through the command string. */
export function buildStepEnv(input: StepEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = previewBaseEnv();
  env.PREVIEW_ID = `preview-${input.previewId}`;
  env.PREVIEW_DIR = input.previewDir;
  env.RECIPE_DIR = input.recipe.dir;
  env.TICKET_KEY = input.ticketKey ?? '';

  for (const role of input.roles) {
    const key = role.role.toUpperCase();
    env[`CHECKOUT_${key}`] = input.checkouts[role.role] ?? '';
    env[`BRANCH_${key}`] = role.branch;
    env[`BASE_${key}`] = role.base;
    env[`USED_BASE_${key}`] = role.usedBase ? '1' : '';
  }
  for (const [id, port] of Object.entries(input.ports)) env[`PORT_${id.toUpperCase()}`] = String(port);

  const database = input.recipe.database;
  env.DB_NAME = input.dbName;
  env.DB_USER = database?.user ?? 'postgres';
  env.DB_HOST = database?.host ?? '127.0.0.1';
  // A logical port named `db` wins: that is the one actually published on the host.
  env.DB_PORT = String(input.ports.db ?? input.ports.postgres ?? database?.port ?? 5432);
  env.DUMP_FILE = '';
  env.DUMP_MODE = 'clean';
  return env;
}

interface PersistedContext {
  env: NodeJS.ProcessEnv;
  ownedCheckouts: string[];
  borrowedCheckouts: string[];
}

const CONTEXT_FILE = 'preview-context.json';

/**
 * What a later process needs to tear this preview down: engine-generated
 * variables and the checkouts involved. Recipe secrets are never written here;
 * they are read back from the recipe.
 */
function persistContext(context: RunContext): void {
  const payload: PersistedContext = {
    env: context.env,
    ownedCheckouts: context.ownedCheckouts,
    borrowedCheckouts: context.borrowedCheckouts,
  };
  try {
    fs.writeFileSync(path.join(context.previewDir, CONTEXT_FILE), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`preview ${context.previewId}: could not persist the teardown context: ${(err as Error).message}`);
  }
}

function stepTimeoutMs(recipe: Recipe, deadline: number): number {
  const perStep = (recipe.stepTimeoutSec ?? recipe.readyTimeoutSec) * 1000;
  const remaining = Math.max(1_000, deadline - Date.now());
  return Math.min(perStep, remaining);
}

async function runPhase(
  context: RunContext,
  phase: string,
  commands: string[],
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  if (commands.length === 0) return;
  log(context.previewId, 'info', `--- ${phase} (${commands.length} step${commands.length > 1 ? 's' : ''}) ---`);
  for (const [index, command] of commands.entries()) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) throw new Error(`Timed out before ${phase} step ${index + 1}`);
    log(context.previewId, 'info', `$ ${command}`);
    await runStep(command, {
      cwd: context.previewDir,
      env: { ...context.env, ...context.recipe.env },
      timeoutMs: stepTimeoutMs(context.recipe, deadline),
      onLine: (level, line) => log(context.previewId, level, line),
      signal,
    });
  }
}

async function waitForHealth(context: RunContext, signal: AbortSignal, deadline: number): Promise<void> {
  const commands = context.recipe.steps.health;
  if (commands.length === 0) {
    log(context.previewId, 'info', 'No health check configured; assuming the stack is up.');
    return;
  }
  log(context.previewId, 'info', '--- health ---');
  let attempt = 0;
  let lastFailure = '';
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    attempt += 1;
    // Output is only mirrored on the first attempt and then every fifth, so a
    // slow start does not bury the log under identical failures.
    const quiet = attempt !== 1 && attempt % 5 !== 0;
    let ok = true;
    for (const command of commands) {
      const result = await runStep(command, {
        cwd: context.previewDir,
        env: { ...context.env, ...context.recipe.env },
        timeoutMs: Math.min(60_000, Math.max(1_000, deadline - Date.now())),
        onLine: (level, line) => log(context.previewId, level, line),
        signal,
        allowFailure: true,
        quiet,
      });
      if (result.code !== 0) {
        ok = false;
        lastFailure = `exit ${result.code}${result.tail ? `: ${result.tail.split('\n').slice(-2).join(' ')}` : ''}`;
        break;
      }
    }
    if (ok) {
      log(context.previewId, 'info', `Health check passed on attempt ${attempt}.`);
      return;
    }
    if (attempt === 1 || attempt % 5 === 0) {
      log(context.previewId, 'info', `Health check attempt ${attempt} not ready yet (${lastFailure}).`);
    }
    await sleep(HEALTH_POLL_MS, signal);
  }
  throw new Error(
    `The stack did not become healthy within ${context.recipe.readyTimeoutSec}s (last: ${lastFailure || 'no output'}).`,
  );
}

// --- teardown ---

/**
 * Runs `down`, then proves the reviewed checkout was not touched. Idempotent
 * and failure-tolerant: every command runs even if an earlier one failed, so a
 * half-created stack still gets cleaned up.
 */
async function teardown(context: RunContext, reason: PreviewStatus): Promise<void> {
  if (context.tornDown) return;
  context.tornDown = true;
  const { previewId, recipe } = context;

  log(previewId, 'info', `--- down (${reason}) ---`);
  for (const command of recipe.steps.down) {
    try {
      log(previewId, 'info', `$ ${command}`);
      const result = await runStep(command, {
        cwd: context.previewDir,
        env: { ...context.env, ...recipe.env },
        timeoutMs: TEARDOWN_STEP_TIMEOUT_MS,
        onLine: (level, line) => log(previewId, level, line),
        allowFailure: true,
      });
      if (result.code !== 0) log(previewId, 'warn', `Teardown step exited with ${result.code}; continuing.`);
    } catch (err) {
      log(previewId, 'warn', `Teardown step could not run: ${(err as Error).message}; continuing.`);
    }
  }

  for (const dir of context.borrowedCheckouts) {
    try {
      await assertPristine(dir);
      log(previewId, 'info', `Reviewed checkout is unchanged: ${path.basename(path.dirname(dir))}`);
    } catch (err) {
      log(previewId, 'error', (err as Error).message);
    }
  }

  // A dump taken for this preview can be hundreds of megabytes; it is worthless
  // once the stack is gone.
  fs.rmSync(path.join(context.previewDir, 'live.dump'), { force: true });

  for (const dir of context.ownedCheckouts) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`preview ${previewId}: could not remove ${dir}: ${(err as Error).message}`);
    }
  }
}

// --- stop, delete, reaper, recovery ---

export async function stopPreview(previewId: number, finalStatus: PreviewStatus = 'stopped'): Promise<void> {
  const row = getPreview(previewId);
  if (!row) throw new Error(`Preview ${previewId} not found`);
  if (['stopped', 'failed', 'expired'].includes(row.status)) return;

  stopRequested.set(previewId, finalStatus);

  const queuedAt = pending.indexOf(previewId);
  if (queuedAt >= 0) {
    pending.splice(queuedAt, 1);
    log(previewId, 'warn', 'Stopped before it started.');
    finish(previewId, finalStatus);
    stopRequested.delete(previewId);
    return;
  }

  const active = running.get(previewId);
  if (active) {
    setStatus(previewId, 'stopping');
    active.controller.abort();
    return; // the worker's catch runs teardown and writes the final status
  }

  // Ready (or orphaned) preview: nothing owns it, tear it down here.
  setStatus(previewId, 'stopping');
  const context = rebuildContext(row);
  await teardown(context, finalStatus);
  finish(previewId, finalStatus);
  stopRequested.delete(previewId);
}

export async function deletePreview(previewId: number): Promise<void> {
  const row = getPreview(previewId);
  if (!row) throw new Error(`Preview ${previewId} not found`);
  if (!['stopped', 'failed', 'expired'].includes(row.status)) await stopPreview(previewId, 'stopped');
  // A worker asked to stop finishes its teardown asynchronously; deleting the
  // row and its directory underneath it would strand containers.
  await waitUntilIdle(previewId);
  const previewDir = path.join(config.dataDir, 'previews', String(previewId));
  fs.rmSync(previewDir, { recursive: true, force: true });
  deletePreviewRow(previewId);
}

async function waitUntilIdle(previewId: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (running.has(previewId) && Date.now() < deadline) await sleep(200);
}

/**
 * Rebuilds just enough context to run `down` for a preview this process is not
 * running: the recipe by name, the environment from the scratch directory.
 */
function rebuildContext(row: PreviewRow): RunContext {
  const previewDir = path.join(config.dataDir, 'previews', String(row.id));
  const recipe = findRecipe(row.recipe);
  let persisted: PersistedContext | null = null;
  try {
    persisted = JSON.parse(fs.readFileSync(path.join(previewDir, CONTEXT_FILE), 'utf8')) as PersistedContext;
  } catch {
    persisted = null;
  }
  // A preview that died before its context was written still has to be torn
  // down: the id and the directory are enough for a compose project.
  const env: NodeJS.ProcessEnv = persisted?.env ?? {
    ...previewBaseEnv(),
    PREVIEW_ID: `preview-${row.id}`,
    PREVIEW_DIR: previewDir,
    RECIPE_DIR: recipe.dir,
  };
  // Contexts written before steps had their own base carry the reviewer marker.
  delete env[REVIEWER_MARKER_ENV];
  fs.mkdirSync(previewDir, { recursive: true });
  return {
    previewId: row.id,
    recipe,
    previewDir,
    env,
    ownedCheckouts: persisted?.ownedCheckouts ?? [],
    borrowedCheckouts: persisted?.borrowedCheckouts ?? [],
    tornDown: false,
  };
}

function safeRoles(json: string): PreviewRole[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as PreviewRole[]) : [];
  } catch {
    return [];
  }
}

/** Previews a crash left behind own containers nobody will ever stop. */
export async function recoverOrphanPreviews(): Promise<void> {
  if (!config.previewEnabled) return;
  const orphans = livePreviews();
  for (const row of orphans) {
    log(row.id, 'warn', 'Interrupted by a restart; tearing the preview down.');
    try {
      const context = rebuildContext(row);
      await teardown(context, 'stopped');
    } catch (err) {
      log(row.id, 'error', `Teardown after restart failed: ${(err as Error).message}`);
    }
    finish(row.id, 'stopped', 'interrupted by restart');
  }
}

export function startReaper(): void {
  if (!config.previewEnabled || reaper) return;
  reaper = setInterval(() => {
    void reap();
  }, REAPER_INTERVAL_MS);
  reaper.unref();
}

export function stopReaper(): void {
  if (reaper) clearInterval(reaper);
  reaper = null;
}

/** Stops every preview whose TTL has run out. Exported so tests can drive it. */
export async function reap(now: Date = new Date()): Promise<number> {
  const due = expiredPreviews(now.toISOString());
  for (const row of due) {
    log(row.id, 'warn', 'Time to live expired; stopping the preview.');
    try {
      await stopPreview(row.id, 'expired');
    } catch (err) {
      logger.warn(`preview ${row.id}: could not expire: ${(err as Error).message}`);
    }
  }
  return due.length;
}

export function previewsSummary(): {
  enabled: boolean; recipes: string[]; running: number; queued: number;
} {
  if (!config.previewEnabled) return { enabled: false, recipes: [], running: 0, queued: 0 };
  const { recipes } = loadRecipes();
  const queued = pending.length;
  return {
    enabled: true,
    recipes: recipes.map((r) => r.name),
    // Previews that actually hold resources; queued ones are counted apart.
    running: Math.max(0, countLive() - queued),
    queued,
  };
}

/** A preview row plus the parts the UI cannot derive from the row alone. */
export function decoratePreview(row: PreviewRow): Record<string, unknown> {
  return {
    ...row,
    // The org lives only in the server config, so the GitHub link is built here.
    roles: safeRoles(row.roles_json).map((role) => ({
      ...role,
      source: role.source ?? 'github',
      // A local branch may not exist on GitHub, so it gets no link.
      url: role.source === 'local' ? null : branchUrl(config.githubOrg, role.repo, role.usedBase ? role.base : role.branch),
    })),
    ports: parsePorts(row.ports_json),
    queuePosition: queuePosition(row.id),
  };
}

// --- helpers ---

function finish(previewId: number, status: PreviewStatus, error: string | null = null): void {
  updatePreview(previewId, { status, error, stopped_at: new Date().toISOString() });
  publishStatus(previewId, status);
}

function setStatus(previewId: number, status: PreviewStatus): void {
  updatePreview(previewId, { status });
  publishStatus(previewId, status);
}

function publishStatus(previewId: number, status: PreviewStatus): void {
  publishPreview(previewId, { type: 'status', previewId, status });
}

function log(previewId: number, level: LogLevel, rawMessage: string): void {
  const ts = new Date().toISOString();
  const message = sanitizeLogMessage(rawMessage);
  try {
    addPreviewLog(previewId, level, message);
  } catch {
    // Logging must never break the lifecycle.
  }
  publishPreview(previewId, { type: 'log', previewId, ts, level, message });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Preview stopped');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
