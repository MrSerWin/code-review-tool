import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { found, nothingFound } from './discovery.js';
import type { ModelDiscovery, ModelInfo } from './types.js';

/** Env vars that must never reach any review process. */
export const FORBIDDEN_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'REVIEW_GH_TOKEN',
  'LINEAR_API_KEY', 'JIRA_API_TOKEN', 'AZURE_PAT', 'YOUTRACK_TOKEN',
  // Only used to list models; a Claude Code run that saw it would bill the API
  // key instead of the CLI's own login.
  'ANTHROPIC_API_KEY',
] as const;

// `USER` is required on macOS: the CLIs read credentials from the Keychain
// and cannot find them without it. None of the passthrough variables carry a
// repo or tracker secret.
export const PASSTHROUGH_ENV = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
] as const;

/**
 * Marks a process as a reviewer spawned by this tool. The code-review MCP server
 * (src/mcp.ts) refuses to start, re-run, or cancel reviews when it sees it, so a
 * review can never drive the tool that runs it. Not every CLI forwards its
 * environment to the MCP servers it starts, which is why each reviewer's argv
 * also keeps user MCP servers out of the run.
 */
export const REVIEWER_MARKER_ENV = 'CODE_REVIEW_TOOL_REVIEWER';

/**
 * The allowlisted environment with every forbidden token removed, and nothing
 * else: no reviewer marker. Preview steps start from this.
 */
export function buildSanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of FORBIDDEN_ENV) delete env[key];
  return env;
}

/** A reviewer process's environment: the sanitized base plus the reviewer marker. */
export function buildBaseChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = buildSanitizedEnv(extra);
  env[REVIEWER_MARKER_ENV] = '1';
  return env;
}

// --- binary lookup -------------------------------------------------------

const availabilityCache = new Map<string, boolean>();

/**
 * Whether `bin` can be executed: an existing path, or a name found in one of
 * the PATH directories. The PATH is walked by hand — no shell is involved, so
 * a binary name can never be interpreted as a command.
 */
export function isBinOnPath(bin: string): boolean {
  const cached = availabilityCache.get(bin);
  if (cached !== undefined) return cached;
  const found = lookupBin(bin);
  availabilityCache.set(bin, found);
  return found;
}

/** Only for tests: forget what `isBinOnPath` has already decided. */
export function clearAvailabilityCache(): void {
  availabilityCache.clear();
}

function lookupBin(bin: string): boolean {
  if (!bin.trim()) return false;
  if (bin.includes(path.sep) || bin.startsWith('.')) return isExecutableFile(path.resolve(bin));
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutableFile(path.join(dir, bin)));
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- helper CLI calls ----------------------------------------------------

export interface CliOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when the command was killed for running past the timeout. */
  timedOut?: boolean;
}

/** Timeout for the short helper calls that ask a CLI which models it has. */
export const MODEL_LIST_TIMEOUT_MS = 20_000;

/**
 * Run a short helper command and capture its output. Never rejects: a missing
 * binary, a crash, or a timeout come back as an empty stdout (`timedOut` set
 * for the timeout), and the caller turns that into a hint.
 */
export function runCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<CliOutput> {
  return new Promise<CliOutput>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const done = (out: CliOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => done({ stdout, stderr: `${stderr}${err.message}`, code: null }));
    child.on('close', (code) => done({ stdout, stderr, code }));
  });
}

// --- model lists ---------------------------------------------------------

/** A runner with the shape of `runCli`, so discovery can be tested without a CLI. */
export type CliRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CliOutput>;

/**
 * Ask a CLI's list command for its models. An empty list says why: the CLI is
 * missing, timed out, is not logged in, or answered nothing usable.
 */
export async function discoverFromCliCommand(opts: {
  label: string;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  parse: (stdout: string) => ModelInfo[];
  /** e.g. "run `grok login`" */
  login: string;
  run?: CliRunner;
  installed?: (bin: string) => boolean;
}): Promise<ModelDiscovery> {
  const command = `\`${[opts.bin, ...opts.args].join(' ')}\``;
  if (!(opts.installed ?? isBinOnPath)(opts.bin)) {
    return nothingFound(`${opts.label} is not installed: ${opts.bin} not found on PATH. Install it, then refresh models.`);
  }
  const out = await (opts.run ?? runCli)(opts.bin, opts.args, opts.env);
  const models = opts.parse(out.stdout);
  if (models.length > 0) return found(models, 'cli');
  if (out.timedOut) {
    return nothingFound(
      `${command} did not answer within ${Math.round(MODEL_LIST_TIMEOUT_MS / 1000)} s. ` +
        'Run it by hand to see what it waits for, then refresh models.',
    );
  }
  if (describeAuthFailure(`${out.stderr}\n${out.stdout}`, opts.bin)) {
    return nothingFound(`${opts.label} is not logged in: ${opts.login}, then refresh models.`);
  }
  return nothingFound(
    `${opts.label} listed no models (${command} exited with ${out.code ?? 'no code'}). ` +
      `If it is not logged in, ${opts.login}; then refresh models.`,
  );
}

/** Drop `id` duplicates, keeping the first (the CLIs list the default first). */
export function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: model.label.trim() || id });
  }
  return out;
}

// --- failure hints -------------------------------------------------------

const AUTH_PATTERNS = [
  /not logged in/i,
  /unauthorized/i,
  /\b401\b/,
  /authentication (?:failed|required)/i,
  /please (?:log ?in|sign in)/i,
  /invalid (?:api )?key/i,
];

/**
 * The shared half of `describeFailure`: an authentication problem, whatever
 * the CLI calls it, becomes "run this to log in".
 */
export function describeAuthFailure(stderrTail: string, loginCommand: string): string | null {
  if (!stderrTail.trim()) return null;
  if (!AUTH_PATTERNS.some((re) => re.test(stderrTail))) return null;
  return `The CLI is not authenticated. Run \`${loginCommand}\`.`;
}

/** First non-empty line of a stderr tail, for a one-line hint. */
export function firstLine(text: string, max = 300): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
