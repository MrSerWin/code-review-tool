import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DumpMode, LogLevel } from '../types.js';
import { stripGlob, type Recipe } from './recipes.js';

export interface DumpResolution {
  mode: DumpMode;
  /** Absolute path to the dump, or an empty string for a clean install. */
  file: string;
  /** Human-readable origin, never a credential. */
  source: string;
}

export interface ResolveDumpOptions {
  previewDir: string;
  env: NodeJS.ProcessEnv;
  onLog(level: LogLevel, message: string): void;
  /** Overrides the recipe's `database.source.mode` for this run. */
  modeOverride?: 'auto' | 'dump-dir' | 'pg_dump' | 'none' | 'clean';
  signal?: AbortSignal;
}

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PG_DUMP_TIMEOUT_SEC = 300;

/** `postgres://user:pw@host:5432/db` without the credential. */
export interface PgTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  /** The connection string with any password removed. */
  safeUrl: string;
}

export function parsePgUrl(raw: string): PgTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`database.source.pgDump.url is not a valid connection URL`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`database.source.pgDump.url must use the postgres:// scheme`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('database.source.pgDump.url must name a database');
  const host = url.hostname || '127.0.0.1';
  const port = url.port ? Number(url.port) : 5432;
  const user = decodeURIComponent(url.username) || 'postgres';
  return { host, port, user, database, safeUrl: `${host}:${port}/${database} as ${user}` };
}

/** A closed port must fail fast: an unreachable host may never hang a preview. */
export function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Newest readable file in `dumpDir`, which may end in a glob such as `*.dump`. */
export function newestDump(pattern: string): string | null {
  const dir = stripGlob(pattern);
  const base = path.basename(pattern);
  const matcher = base === pattern || !(base.includes('*') || base.includes('?'))
    ? null
    : new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest: { file: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (matcher && !matcher.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size === 0) continue;
    if (!newest || stat.mtimeMs > newest.mtime) newest = { file, mtime: stat.mtimeMs };
  }
  return newest?.file ?? null;
}

function runPgDump(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('pg_dump', args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let stderr = '';
    let timedOut = false;
    const kill = (): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', kill, { once: true });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr, timedOut });
    });
  });
}

async function tryPgDump(
  recipe: Recipe,
  options: ResolveDumpOptions,
): Promise<DumpResolution | null> {
  const pgDump = recipe.database?.source.pgDump;
  if (!pgDump) return null;

  let target: PgTarget;
  try {
    target = parsePgUrl(pgDump.url);
  } catch (err) {
    options.onLog('warn', `pg_dump source unusable: ${(err as Error).message}`);
    return null;
  }

  options.onLog('info', `Checking whether ${target.safeUrl} is reachable`);
  if (!(await probeTcp(target.host, target.port))) {
    options.onLog('warn', `Database host ${target.host}:${target.port} is not reachable; skipping pg_dump.`);
    return null;
  }

  const file = path.join(options.previewDir, 'live.dump');
  const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', file];
  for (const pattern of pgDump.excludeTableData ?? []) args.push(`--exclude-table-data=${pattern}`);
  args.push(pgDump.url);

  const timeoutMs = (pgDump.timeoutSec ?? DEFAULT_PG_DUMP_TIMEOUT_SEC) * 1000;
  options.onLog('info', `Dumping ${target.safeUrl} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  const result = await runPgDump(args, options.env, timeoutMs, options.signal);

  if (result.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.rmSync(file, { force: true });
    const why = result.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : result.code === 127
        ? 'pg_dump is not installed or not on PATH'
        : `exited with code ${result.code}: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`;
    options.onLog('warn', `pg_dump failed (${why}).`);
    return null;
  }

  const size = Math.round(fs.statSync(file).size / 1024);
  options.onLog('info', `pg_dump wrote ${size} KiB from ${target.safeUrl}`);
  return { mode: 'pg_dump', file, source: target.safeUrl };
}

function tryDumpDir(recipe: Recipe, options: ResolveDumpOptions): DumpResolution | null {
  const dumpDir = recipe.database?.source.dumpDir;
  if (!dumpDir) return null;
  const file = newestDump(dumpDir);
  if (!file) {
    options.onLog('warn', `No dump file found in ${dumpDir}.`);
    return null;
  }
  options.onLog('info', `Using the newest dump in ${stripGlob(dumpDir)}: ${path.basename(file)}`);
  return { mode: 'dump-dir', file, source: path.basename(file) };
}

/**
 * Decides where the preview's data comes from. In `auto` the order is
 * pg_dump (freshest) → newest file in dumpDir → clean install. A clean install
 * is always the last resort unless the recipe sets `onFailure: "fail"`; the
 * engine never stops to ask a human.
 */
export async function resolveDumpSource(
  recipe: Recipe,
  options: ResolveDumpOptions,
): Promise<DumpResolution> {
  const clean = (why: string): DumpResolution => {
    options.onLog('warn', `${why} Falling back to a clean install.`);
    return { mode: 'clean', file: '', source: 'clean install' };
  };

  const source = recipe.database?.source;
  if (!recipe.database || !source) {
    return { mode: 'clean', file: '', source: 'clean install' };
  }

  const requested = options.modeOverride === 'clean' ? 'none' : (options.modeOverride ?? source.mode);
  if (requested === 'none') {
    options.onLog('info', 'Database source is "none": starting from a clean install.');
    return { mode: 'clean', file: '', source: 'clean install' };
  }

  const attempts: (() => Promise<DumpResolution | null>)[] = [];
  if (requested === 'pg_dump' || requested === 'auto') attempts.push(() => tryPgDump(recipe, options));
  if (requested === 'dump-dir' || requested === 'auto') attempts.push(async () => tryDumpDir(recipe, options));

  for (const attempt of attempts) {
    const resolved = await attempt();
    if (resolved) return resolved;
  }

  const why = `No database dump could be obtained (requested mode "${requested}").`;
  if (source.onFailure === 'fail') throw new Error(`${why} The recipe sets onFailure: "fail".`);
  return clean(why);
}
