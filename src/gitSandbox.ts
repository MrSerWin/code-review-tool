import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, assertAllowedRemote, assertAllowedRepo, repoUrl } from './config.js';
import { logger } from './logger.js';
import type { BaseReason, CheckoutResult, OnLog, ResolvedTarget } from './types.js';
import { assertSafeName } from './gitNames.js';
import {
  branchRefs, branchTip, captureWorkingTree, currentBranch, detectBaseBranch, localRepoPath, planBaseSource,
} from './localRepos.js';

export function sanitizeBranchForPath(branch: string): string {
  assertSafeName('branch', branch);
  return branch.replace(/\//g, '__');
}

export interface SandboxOptions {
  /** Host directory mounted at /work. Defaults to <DATA_DIR>/checkouts. */
  mountDir?: string;
  /** Working directory inside the container. Defaults to /work. */
  workdir?: string;
  timeoutMs?: number;
  /** Return the failed result instead of throwing. */
  allowFailure?: boolean;
  /** An extra host directory mounted READ-ONLY into the container (local reviews). */
  readOnlyMount?: { host: string; container: string };
}

/** Where a local clone is visible inside the sandbox; always mounted read-only. */
const LOCAL_SRC = '/src';

const BASE_REASON_TEXT: Record<BaseReason, string> = {
  parent: 'detected parent',
  chosen: 'chosen',
  default: 'default branch',
};

export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
}

function checkoutsRoot(): string {
  return path.join(config.DATA_DIR, 'checkouts');
}

function execFileAsync(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number },
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code)
          : error
            ? 1
            : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
  });
}

let imageReady = false;

export async function ensureImage(): Promise<void> {
  if (imageReady) return;
  const inspect = await execFileAsync(config.DOCKER_BIN, ['image', 'inspect', config.GIT_IMAGE], {});
  if (inspect.code === 0) {
    imageReady = true;
    return;
  }
  logger.info(`Building sandbox image ${config.GIT_IMAGE}`);
  const build = await execFileAsync(
    config.DOCKER_BIN,
    ['build', '-f', config.dockerfile, '-t', config.GIT_IMAGE, config.projectRoot],
    { timeout: 10 * 60_000 },
  );
  if (build.code !== 0) {
    throw new Error(`Failed to build ${config.GIT_IMAGE}:\n${build.stderr || build.stdout}`);
  }
  imageReady = true;
}

/**
 * Runs git/gh inside the Docker sandbox. The token is referenced by name in the
 * docker argv (-e GH_TOKEN) and supplied through the child environment, so it
 * never appears in the host process list.
 */
export async function runInSandbox(args: string[], opts: SandboxOptions = {}): Promise<SandboxResult> {
  if (args.length === 0) throw new Error('runInSandbox requires at least one argument');
  await ensureImage();

  const mountDir = opts.mountDir ?? checkoutsRoot();
  fs.mkdirSync(mountDir, { recursive: true });

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;

  const dockerArgs = [
    'run', '--rm',
    '-e', 'GH_TOKEN',
    '-e', 'GITHUB_TOKEN',
    '-e', 'GITHUB_ORG',
    '-e', 'GIT_TERMINAL_PROMPT=0',
    '-v', `${mountDir}:/work`,
    ...(opts.readOnlyMount ? readOnlyMountArgs(opts.readOnlyMount) : []),
    '-w', opts.workdir ?? '/work',
    '--user', `${uid}:${gid}`,
    config.GIT_IMAGE,
    ...args,
  ];

  const result = await execFileAsync(config.DOCKER_BIN, dockerArgs, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: config.REVIEW_GH_TOKEN,
      GITHUB_TOKEN: config.REVIEW_GH_TOKEN,
      GITHUB_ORG: config.GITHUB_ORG,
    },
    timeout: opts.timeoutMs ?? 10 * 60_000,
  });

  if (result.code !== 0 && !opts.allowFailure) {
    throw new Error(`Sandbox command failed (${result.code}): ${args.join(' ')}\n${result.stderr.trim()}`);
  }
  return result;
}

function readOnlyMountArgs(mount: { host: string; container: string }): string[] {
  // --mount splits on "," and -v on ":"; either inside a path would change its meaning.
  if (/[,:]/.test(mount.host) || !path.isAbsolute(mount.host)) {
    throw new Error(`Refusing to mount ${JSON.stringify(mount.host)} into the sandbox`);
  }
  return ['--mount', `type=bind,src=${mount.host},dst=${mount.container},readonly`];
}

export async function lsRemoteHeads(repo: string): Promise<string[]> {
  assertAllowedRepo(repo);
  const url = repoUrl(repo);
  assertAllowedRemote(url);
  const result = await runInSandbox(['git', 'ls-remote', '--heads', url]);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t')[1] ?? '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .filter(Boolean);
}

const GH_PATH_SAFE = /^[A-Za-z0-9._~/?=&%-]+$/;

export async function ghApi<T>(apiPath: string): Promise<T> {
  const trimmed = apiPath.replace(/^\/+/, '');
  if (!GH_PATH_SAFE.test(trimmed) || trimmed.includes('..') || trimmed.includes('://')) {
    throw new Error(`Unsafe GitHub API path: ${JSON.stringify(apiPath)}`);
  }
  const result = await runInSandbox(['gh', 'api', '-H', 'Accept: application/vnd.github+json', trimmed]);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`GitHub API returned non-JSON for ${trimmed}: ${result.stdout.slice(0, 400)}`);
  }
}

interface CheckoutPaths {
  hostDir: string;
  containerDir: string;
  relDir: string;
}

function checkoutPaths(target: ResolvedTarget, reviewId: number): CheckoutPaths {
  const relDir = path.join(target.repo, sanitizeBranchForPath(target.branch), String(reviewId));
  const hostDir = path.join(checkoutsRoot(), relDir);
  const containerDir = `/work/${relDir.split(path.sep).join('/')}`;
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(hostDir), { recursive: true });
  return { hostDir, containerDir, relDir };
}

export async function fetchCheckout(
  target: ResolvedTarget,
  reviewId: number,
  onLog: OnLog = () => {},
): Promise<CheckoutResult> {
  assertAllowedRepo(target.repo);
  assertSafeName('branch', target.branch);
  assertSafeName('base branch', target.baseBranch);
  if (target.source === 'local') return fetchLocalCheckout(target, reviewId, onLog);

  const url = repoUrl(target.repo);
  assertAllowedRemote(url);

  const { hostDir, containerDir } = checkoutPaths(target, reviewId);
  const inRepo = (args: string[]) => runInSandbox(args, { workdir: containerDir });

  onLog('info', `Cloning ${target.repo} (${target.branch}) in the sandbox`);
  // No --filter: a partial clone keeps blobs on a promisor remote, and the remote is
  // removed below, which would make `git log -p` and older blobs unreadable offline.
  // --single-branch limits the download to the base branch plus the reviewed branch.
  await runInSandbox([
    'git', 'clone', '--no-checkout', '--single-branch', '--branch', target.baseBranch, url, containerDir,
  ]);

  onLog('info', `Fetching ${target.branch} and ${target.baseBranch}`);
  await inRepo([
    'git', 'fetch', 'origin',
    `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`,
    `+refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`,
  ]);
  await inRepo(['git', 'checkout', '-B', target.branch, '--no-track', `refs/remotes/origin/${target.branch}`]);

  const headSha = (await inRepo(['git', 'rev-parse', 'HEAD'])).stdout.trim();
  return finishCheckout(target, hostDir, containerDir, headSha, null, onLog);
}

/**
 * A branch of the user's local clone, which may never have been pushed.
 *
 * The clone is mounted read-only at /src and copied with `git clone --no-local`
 * (a real object copy: no hardlinks, no alternates), so the review can neither
 * change nor depend on the user's object store. When the base is the
 * repository's default branch it is fetched from GitHub inside the sandbox, so
 * the diff is measured against the base as it is now (the clone's own
 * `origin/<base>` is the fallback). Any other base — typically the parent of a
 * stacked branch, possibly unpushed — is copied from the clone itself.
 */
async function fetchLocalCheckout(
  target: ResolvedTarget,
  reviewId: number,
  onLog: OnLog,
): Promise<CheckoutResult> {
  const localPath = await localRepoPath(target.repo);
  const url = repoUrl(target.repo);
  assertAllowedRemote(url);

  if (target.includeWorkingTree) {
    const checkedOut = await currentBranch(localPath);
    if (checkedOut !== target.branch) {
      throw new Error(
        `Uncommitted changes were requested, but ${target.branch} is no longer the checked-out branch ` +
          `of the local clone (now ${checkedOut ?? 'detached HEAD'}).`,
      );
    }
  }
  const tip = await branchTip(localPath, target.branch);

  const { hostDir, containerDir, relDir } = checkoutPaths(target, reviewId);
  const mount = { host: localPath, container: LOCAL_SRC };
  const inRepo = (args: string[], extra: Partial<SandboxOptions> = {}) =>
    runInSandbox(args, { workdir: containerDir, ...extra });

  onLog('info', `Cloning ${target.repo} (${target.branch} @ ${tip.slice(0, 7)}) from the local clone (read-only mount)`);
  // A plain path, not file://: the sandbox entrypoint refuses every URL that is
  // not github.com/<org>. --no-local forces a real pack transfer.
  await runInSandbox(
    ['git', 'clone', '--no-local', '--no-checkout', '--single-branch', '--branch', target.branch, LOCAL_SRC, containerDir],
    { readOnlyMount: mount },
  );
  await inRepo(['git', 'checkout', '-B', target.branch, '--no-track', `refs/remotes/origin/${target.branch}`]);
  const headSha = (await inRepo(['git', 'rev-parse', 'HEAD'])).stdout.trim();
  if (headSha !== tip) {
    throw new Error(`${target.branch} moved while it was being copied (${tip.slice(0, 7)} → ${headSha.slice(0, 7)}); run it again.`);
  }

  // The base always lands at refs/remotes/origin/<base>, whatever its source, so
  // finishCheckout and everything downstream see the same layout.
  const baseDst = `refs/remotes/origin/${target.baseBranch}`;
  const defaultBase = await detectBaseBranch(localPath).catch(() => null);
  const source = planBaseSource(target.baseBranch, defaultBase, await branchRefs(localPath, target.baseBranch));
  const reason = target.baseReason ? ` (${BASE_REASON_TEXT[target.baseReason]})` : '';

  if (source !== 'github') {
    // Not the default branch: possibly unpushed, so it is taken from the clone as it is now.
    const src = source === 'local-head' ? `refs/heads/${target.baseBranch}` : `refs/remotes/origin/${target.baseBranch}`;
    await inRepo(['git', 'fetch', '--no-tags', LOCAL_SRC, `+${src}:${baseDst}`], { readOnlyMount: mount });
    const baseTip = (await inRepo(['git', 'rev-parse', baseDst])).stdout.trim();
    onLog(
      'info',
      `Base ${target.baseBranch}${reason} taken from the local clone ` +
        `(${source === 'local-head' ? 'local branch' : `origin/${target.baseBranch}`} @ ${baseTip.slice(0, 7)})`,
    );
    await inRepo(['git', 'remote', 'remove', 'origin']);
    await inRepo(['git', 'remote', 'add', 'origin', url]);
  } else {
    // Swap the local "origin" for GitHub, only to bring the base branch up to date.
    await inRepo(['git', 'remote', 'remove', 'origin']);
    await inRepo(['git', 'remote', 'add', 'origin', url]);
    const baseRef = `+refs/heads/${target.baseBranch}:${baseDst}`;
    const fromGithub = await inRepo(['git', 'fetch', '--no-tags', 'origin', baseRef], { allowFailure: true });
    if (fromGithub.code === 0) {
      onLog('info', `Base ${target.baseBranch}${reason} fetched from GitHub`);
    } else {
      onLog('warn', `Could not fetch ${target.baseBranch} from GitHub; using the local clone's origin/${target.baseBranch} (may be stale)`);
      const fallback = await inRepo(
        ['git', 'fetch', '--no-tags', LOCAL_SRC, `+refs/remotes/origin/${target.baseBranch}:${baseDst}`],
        { readOnlyMount: mount, allowFailure: true },
      );
      if (fallback.code !== 0) {
        await inRepo(
          ['git', 'fetch', '--no-tags', LOCAL_SRC, `+refs/heads/${target.baseBranch}:${baseDst}`],
          { readOnlyMount: mount },
        );
      }
    }
  }

  let snapshot: CheckoutResult['workingTreeSnapshot'] = null;
  if (target.includeWorkingTree) {
    snapshot = await applyWorkingTree(localPath, target, tip, hostDir, containerDir, relDir, onLog);
  }

  return finishCheckout(target, hostDir, containerDir, headSha, snapshot, onLog);
}

/**
 * Copies the clone's uncommitted changes into the checkout and commits them
 * there as one synthetic commit, so `git diff <base>..HEAD` includes them.
 */
async function applyWorkingTree(
  localPath: string,
  target: ResolvedTarget,
  tip: string,
  hostDir: string,
  containerDir: string,
  relDir: string,
  onLog: OnLog,
): Promise<CheckoutResult['workingTreeSnapshot']> {
  const inRepo = (args: string[]) => runInSandbox(args, { workdir: containerDir });
  const capture = await captureWorkingTree(localPath, hostDir);
  if (capture.head !== tip) {
    throw new Error(`The local clone's HEAD moved while its changes were being read; run it again.`);
  }
  for (const skipped of capture.skipped) onLog('warn', `Working tree: skipped ${skipped}`);

  if (capture.patch.length > 0) {
    // The patch lives next to the checkout, never inside it.
    const patchRel = `${relDir}.wt.patch`;
    const patchHost = path.join(checkoutsRoot(), patchRel);
    fs.writeFileSync(patchHost, capture.patch);
    try {
      await inRepo(['git', 'apply', '--binary', '--whitespace=nowarn', `/work/${patchRel.split(path.sep).join('/')}`]);
    } finally {
      fs.rmSync(patchHost, { force: true });
    }
  }

  await inRepo(['git', 'add', '-A']);
  const staged = await inRepo(['git', 'diff', '--cached', '--name-only']);
  const files = staged.stdout.split('\n').filter(Boolean).length;
  if (files === 0) {
    onLog('info', 'Working tree: no uncommitted changes to include');
    return null;
  }
  await inRepo([
    'git', 'commit', '--no-verify', '--quiet',
    '-m', 'Working tree snapshot (uncommitted changes)',
    '-m', `Uncommitted and untracked changes of the local clone on top of ${tip}.`,
  ]);
  const sha = (await inRepo(['git', 'rev-parse', 'HEAD'])).stdout.trim();
  onLog(
    'info',
    `Working tree: ${files} uncommitted file(s) (${capture.untracked.length} untracked) added as snapshot commit ${sha.slice(0, 7)}`,
  );
  return { sha, files };
}

/** Diff stats, the completeness check, and the remote/credential scrub shared by every checkout. */
async function finishCheckout(
  target: ResolvedTarget,
  hostDir: string,
  containerDir: string,
  headSha: string,
  snapshot: CheckoutResult['workingTreeSnapshot'],
  onLog: OnLog,
): Promise<CheckoutResult> {
  const inRepo = (args: string[]) => runInSandbox(args, { workdir: containerDir });
  const baseSha = (
    await inRepo(['git', 'merge-base', `refs/remotes/origin/${target.baseBranch}`, 'HEAD'])
  ).stdout.trim();

  const numstat = await inRepo(['git', 'diff', '--numstat', `${baseSha}..HEAD`]);
  let additions = 0;
  let deletions = 0;
  const changedFiles: string[] = [];
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, file] = line.split('\t');
    if (!file) continue;
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
    changedFiles.push(file);
  }

  // The review must run against a complete offline tree; a missing object here
  // would silently truncate the diff the reviewer sees.
  const missing = await inRepo(['git', 'rev-list', '--objects', '--all', '--missing=print']);
  const missingCount = missing.stdout.split('\n').filter((line) => line.startsWith('?')).length;
  if (missingCount > 0) {
    throw new Error(`Checkout is incomplete: ${missingCount} objects are missing from ${target.repo}`);
  }

  // The host-side working tree must keep no remote and no credential helper,
  // so nothing can push or fetch from it once the review starts.
  await inRepo(['git', 'remote', 'remove', 'origin']);
  const localConfig = path.join(hostDir, '.git', 'config');
  if (fs.existsSync(localConfig)) {
    fs.writeFileSync(localConfig, scrubGitConfig(fs.readFileSync(localConfig, 'utf8')), 'utf8');
  }
  const remainingRemotes = await inRepo(['git', 'remote']);
  if (remainingRemotes.stdout.trim()) {
    throw new Error(`Checkout still has a remote after scrubbing: ${remainingRemotes.stdout.trim()}`);
  }

  onLog('info', `Checked out ${headSha.slice(0, 7)} (base ${baseSha.slice(0, 7)}), ${changedFiles.length} files changed`);

  return {
    dir: hostDir,
    headSha,
    baseSha,
    filesChanged: changedFiles.length,
    additions,
    deletions,
    changedFiles,
    workingTreeSnapshot: snapshot,
  };
}

/**
 * Drops whole [remote ...] and [credential ...] sections plus any line carrying a
 * token. Section-aware on purpose: filtering line by line would orphan the `url =`
 * and `fetch =` entries into whichever section precedes them.
 */
export function scrubGitConfig(text: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      const name = (section[1] ?? '').trim().toLowerCase();
      dropping = name.startsWith('remote ') || name === 'remote' || name.startsWith('credential');
      if (dropping) continue;
      out.push(line);
      continue;
    }
    if (dropping) continue;
    if (/x-access-token|gh_token|helper\s*=/i.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

export async function assertPristine(dir: string): Promise<void> {
  const relative = path.relative(checkoutsRoot(), dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Checkout directory is outside the data dir: ${dir}`);
  }
  const containerDir = `/work/${relative.split(path.sep).join('/')}`;
  const status = await runInSandbox(['git', 'status', '--porcelain'], { workdir: containerDir });
  if (status.stdout.trim()) {
    throw new Error(`Reviewed checkout was modified; review is not trustworthy:\n${status.stdout.trim()}`);
  }
}

export function pruneCheckout(dir: string): void {
  const relative = path.relative(checkoutsRoot(), dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to delete a path outside the checkout root: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
