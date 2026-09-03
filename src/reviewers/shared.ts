import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo } from './types.js';

/** Env vars that must never reach any review process. */
export const FORBIDDEN_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'REVIEW_GH_TOKEN',
  'LINEAR_API_KEY', 'JIRA_API_TOKEN', 'AZURE_PAT', 'YOUTRACK_TOKEN',
] as const;

// `USER` is required on macOS: the CLIs read credentials from the Keychain
// and cannot find them without it. None of the passthrough variables carry a
// repo or tracker secret.
export const PASSTHROUGH_ENV = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
] as const;

export function buildBaseChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of FORBIDDEN_ENV) delete env[key];
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
}

/** Timeout for the short helper calls that ask a CLI which models it has. */
export const MODEL_LIST_TIMEOUT_MS = 20_000;

/**
 * Run a short helper command and capture its output. Never rejects: a missing
 * binary, a crash, or a timeout all come back as an empty stdout, because the
 * only caller falls back to a static model list.
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
      done({ stdout, stderr, code: null });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => done({ stdout, stderr: `${stderr}${err.message}`, code: null }));
    child.on('close', (code) => done({ stdout, stderr, code }));
  });
}

// --- model list cache ----------------------------------------------------

const MODEL_CACHE_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

/** Remember one reviewer's model list for ten minutes. */
export async function cachedModels(
  key: string,
  load: () => Promise<ModelInfo[]>,
): Promise<ModelInfo[]> {
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) return hit.models;
  let models: ModelInfo[];
  try {
    models = await load();
  } catch {
    models = [];
  }
  modelCache.set(key, { at: Date.now(), models });
  return models;
}

/** Only for tests: drop every remembered model list. */
export function clearModelCache(): void {
  modelCache.clear();
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
