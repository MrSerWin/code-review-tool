import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, assertAllowedRemote, assertAllowedRepo, repoUrl } from './config.js';
import { logger } from './logger.js';
import type { CheckoutResult, OnLog, ResolvedTarget } from './types.js';

const NAME_SAFE = /^[A-Za-z0-9._/-]+$/;

/** Names reaching git/docker must be inert: no shell metacharacters, no path traversal. */
function assertSafeName(kind: string, value: string): void {
  if (!value || !NAME_SAFE.test(value) || value.includes('..')) {
    throw new Error(`Unsafe ${kind} name: ${JSON.stringify(value)}`);
  }
}

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
}

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
    throw new Error(`Sandbox command failed (${result.code}): git ${args.join(' ')}\n${result.stderr.trim()}`);
  }
  return result;
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

export async function fetchCheckout(
  target: ResolvedTarget,
  reviewId: number,
  onLog: OnLog = () => {},
): Promise<CheckoutResult> {
  assertAllowedRepo(target.repo);
  assertSafeName('branch', target.branch);
  assertSafeName('base branch', target.baseBranch);

  const url = repoUrl(target.repo);
  assertAllowedRemote(url);

  const relDir = path.join(target.repo, sanitizeBranchForPath(target.branch), String(reviewId));
  const hostDir = path.join(checkoutsRoot(), relDir);
  const containerDir = `/work/${relDir.split(path.sep).join('/')}`;

  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(hostDir), { recursive: true });

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
