import { spawn } from 'node:child_process';
import type { LogLevel } from '../types.js';

export interface RunStepOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onLine(level: LogLevel, line: string): void;
  signal?: AbortSignal;
  /** Return the exit code instead of throwing on failure. */
  allowFailure?: boolean;
  /** Suppress per-line output; used by health polling to avoid log floods. */
  quiet?: boolean;
}

export interface StepResult {
  code: number;
  timedOut: boolean;
  /** Tail of the combined output, for the error message. */
  tail: string;
}

const TAIL_LINES = 20;
const KILL_GRACE_MS = 5_000;

/**
 * Runs one recipe command through `/bin/sh`. The command comes from a trusted
 * local recipe file and is executed verbatim: no value is ever interpolated
 * into it, everything variable is passed through `env`.
 *
 * The child gets its own process group so a timeout or a stop kills the whole
 * tree, not just the shell.
 */
export function runStep(command: string, options: RunStepOptions): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tail: string[] = [];
    let timedOut = false;
    let settled = false;

    const pushLine = (level: LogLevel, line: string): void => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      if (!options.quiet) options.onLine(level, line);
    };

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    attachLineReader(child.stdout, (line) => pushLine('info', line));
    attachLineReader(child.stderr, (line) => pushLine('warn', line));

    const finish = (result: StepResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      const exit = code ?? (signal ? 128 : 1);
      const result: StepResult = { code: exit, timedOut, tail: tail.join('\n') };
      if (exit !== 0 && !options.allowFailure) {
        const why = timedOut
          ? `timed out after ${Math.round(options.timeoutMs / 1000)}s`
          : `exited with code ${exit}`;
        finish(new Error(`Step ${why}: ${command}\n${result.tail}`));
        return;
      }
      finish(result);
    });
  });
}

function attachLineReader(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length) onLine(line.slice(0, 2000));
      index = buffer.indexOf('\n');
    }
    // A single unterminated line must not grow without bound.
    if (buffer.length > 8192) {
      onLine(buffer.slice(0, 2000));
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer.trim().length) onLine(buffer.trim().slice(0, 2000));
    buffer = '';
  });
}
