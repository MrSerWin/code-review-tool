import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { LENS_NAMES } from './types.js';
import type {
  CheckoutResult, LensName, LensOutput, OnLog, ReviewOutput, ReviewRow, TicketInfo,
} from './types.js';

export interface PreviousFinding {
  severity: string;
  title: string;
  file: string | null;
  line: number | null;
  problem: string;
}

/** Minimal shape the runner needs from a `reviews` row. */
export type RunnableReview = Pick<
  ReviewRow,
  'id' | 'repo' | 'branch' | 'model' | 'ticket_key' | 'ticket_title' | 'ticket_url' | 'ticket_body'
>;

export interface RunReviewOptions {
  previousFindings?: PreviousFinding[];
  signal?: AbortSignal;
  model?: string;
  timeoutMs?: number;
}

const requirementSchema = z.object({
  text: z.string().min(1),
  status: z.enum(['met', 'partial', 'missing', 'not_verifiable']),
  evidence: z.string().nullish().transform((v) => v ?? ''),
});

const findingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  category: z.string().nullish().transform((v) => v ?? 'correctness'),
  file: z.string().nullish().transform((v) => v ?? null),
  line: z.coerce.number().int().nullish().transform((v) => v ?? null),
  end_line: z.coerce.number().int().nullish().transform((v) => v ?? null),
  title: z.string().min(1),
  problem: z.string().min(1),
  why: z.string().nullish().transform((v) => v ?? ''),
  suggestion: z.string().nullish().transform((v) => v ?? ''),
  snippet: z.string().nullish().transform((v) => v ?? null),
});

const observationSchema = z.object({
  file: z.string().nullish().transform((v) => v ?? null),
  line: z.coerce.number().int().nullish().transform((v) => v ?? null),
  note: z.string().min(1),
  rationale: z.string().nullish().transform((v) => v ?? ''),
});

/** One lens returns candidates only: no requirements, no verdict. */
export const lensOutputSchema = z.object({
  findings: z.array(findingSchema).nullish().transform((v) => v ?? []),
  observations: z.array(observationSchema).nullish().transform((v) => v ?? []),
});

export const reviewOutputSchema = z.object({
  summary: z.string().min(1),
  requirements: z.array(requirementSchema),
  findings: z.array(findingSchema),
  observations: z.array(observationSchema).nullish().transform((v) => v ?? []),
  verdict: z.enum(['approve', 'changes_requested', 'blocked']),
  can_merge: z.coerce.boolean(),
  conclusion: z.string().nullish().transform((v) => v ?? ''),
});

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

/** Every prompt file, so a caller can check them all. */
export const PROMPT_FILES = [
  'common-preamble.md',
  'lens-common.md',
  ...LENS_NAMES.map((lens) => `lens-${lens}.md`),
  'synthesis.md',
] as const;

const cachedTemplates = new Map<string, string>();

export async function loadPromptFile(name: string): Promise<string> {
  const cached = cachedTemplates.get(name);
  if (cached !== undefined) return cached;
  const text = await readFile(path.join(PROMPT_DIR, name), 'utf8');
  cachedTemplates.set(name, text);
  return text;
}

export interface PromptVars {
  ticket: TicketInfo | null;
  review: RunnableReview;
  checkout: CheckoutResult;
  previousFindings: PreviousFinding[];
}

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

/**
 * Substitute `{{KEY}}` tokens. A leftover token means a prompt file and this
 * code disagree, which would ship a broken prompt to the model, so it throws.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  // Replace via a callback so `$&`-style sequences inside values stay literal.
  const out = template.replace(PLACEHOLDER, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match);
  const leftover = out.match(PLACEHOLDER);
  if (leftover) throw new Error(`Unresolved prompt placeholder(s): ${[...new Set(leftover)].join(', ')}`);
  return out;
}

/** The values every prompt file may reference. */
export function promptValues(vars: PromptVars, lensOutputs = ''): Record<string, string> {
  return {
    TICKET: renderTicket(vars.ticket, vars.review),
    REPO: vars.review.repo,
    BRANCH: vars.review.branch,
    BASE_SHA: vars.checkout.baseSha,
    CHANGED_FILES: renderChangedFiles(vars.checkout),
    PREVIOUS_FINDINGS: renderPreviousFindings(vars.previousFindings),
    LENS_OUTPUTS: lensOutputs,
  };
}

export async function buildLensPrompt(lens: LensName, vars: PromptVars): Promise<string> {
  const values = promptValues(vars);
  const [preamble, mandate, tail] = await Promise.all([
    loadPromptFile('common-preamble.md'),
    loadPromptFile(`lens-${lens}.md`),
    loadPromptFile('lens-common.md'),
  ]);
  return [preamble, mandate, tail].map((t) => renderTemplate(t, values)).join('\n\n');
}

export async function buildSynthesisPrompt(vars: PromptVars, lensOutputs: string): Promise<string> {
  const values = promptValues(vars, lensOutputs);
  const [preamble, synthesis] = await Promise.all([
    loadPromptFile('common-preamble.md'),
    loadPromptFile('synthesis.md'),
  ]);
  return [preamble, synthesis].map((t) => renderTemplate(t, values)).join('\n\n');
}

/** The lens answers, as the synthesis pass sees them. */
export function renderLensOutputs(results: LensResult[]): string {
  return results
    .map((r) => {
      const body = r.error
        ? `This lens failed and produced nothing: ${r.error}`
        : `\`\`\`json\n${JSON.stringify(r.output, null, 2)}\n\`\`\``;
      return `## Lens: ${r.lens}\n\n${body}`;
    })
    .join('\n\n');
}

function renderTicket(ticket: TicketInfo | null, review: RunnableReview): string {
  if (!ticket) {
    if (review.ticket_body) {
      return [
        `**${review.ticket_key ?? 'Ticket'}** — ${review.ticket_title ?? ''}`,
        review.ticket_url ?? '',
        '',
        review.ticket_body,
      ].join('\n');
    }
    return [
      'No ticket is linked to this branch.',
      '',
      'Derive the requirements from the branch name, the commit messages',
      '(`git log`), and the diff itself. State clearly in the summary that the',
      'requirements were inferred, not taken from a ticket.',
    ].join('\n');
  }
  const parts: string[] = [
    `**${ticket.key} — ${ticket.title}**`,
    `State: ${ticket.state}`,
    `URL: ${ticket.url}`,
    '',
    '## Description',
    '',
    ticket.body?.trim() ? ticket.body.trim() : '(the ticket has no description)',
  ];
  if (ticket.comments?.length) {
    parts.push('', '## Ticket comments', '');
    for (const c of ticket.comments) {
      const body = (c.body ?? '').trim();
      if (!body) continue;
      parts.push(`- **${c.author || 'unknown'}**: ${body}`);
    }
  }
  return parts.join('\n');
}

const MAX_LISTED_FILES = 300;

function renderChangedFiles(checkout: CheckoutResult): string {
  const files = checkout.changedFiles ?? [];
  const head = files.slice(0, MAX_LISTED_FILES).map((f) => `- \`${f}\``);
  if (files.length > MAX_LISTED_FILES) {
    head.push(`- … and ${files.length - MAX_LISTED_FILES} more files (use \`git diff --stat\`)`);
  }
  const stat = `${checkout.filesChanged} files changed, +${checkout.additions} / -${checkout.deletions}`;
  return head.length ? `${stat}\n\n${head.join('\n')}` : `${stat}\n\n(no files changed)`;
}

function renderPreviousFindings(findings: PreviousFinding[]): string {
  if (!findings.length) return 'None. This is the first review of this branch, or the previous run found nothing blocking.';
  return findings
    .map((f) => {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'no location';
      return `- [${f.severity.toUpperCase()}] ${f.title} (${where}) — ${f.problem}`;
    })
    .join('\n');
}

/** Env vars that must never reach the review process. */
const FORBIDDEN_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'REVIEW_GH_TOKEN',
  'LINEAR_API_KEY', 'JIRA_API_TOKEN', 'AZURE_PAT', 'YOUTRACK_TOKEN',
];
// `USER` is required: the Claude CLI reads its credentials from the macOS
// Keychain and cannot find them without it. The rest keep the CLI's own
// runtime sane. None of these carry a secret.
const PASSTHROUGH_ENV = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
];

export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of FORBIDDEN_ENV) delete env[key];
  return env;
}

export function buildClaudeArgs(prompt: string, model: string, dir: string): string[] {
  return [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowed-tools', 'Read', 'Grep', 'Glob',
    'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
    '--disallowed-tools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
    'WebFetch', 'WebSearch', 'Task',
    '--add-dir', dir,
  ];
}

export interface LensResult {
  lens: LensName;
  output: LensOutput | null;
  error: string | null;
}

interface PassOptions {
  dir: string;
  model: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

/** Run one `claude -p` pass and parse its JSON block, retrying once. */
async function runPass<T>(
  label: string,
  basePrompt: string,
  schema: z.ZodType<T>,
  onLog: OnLog,
  opts: PassOptions,
): Promise<T> {
  let lastRaw = '';
  let lastError = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1 ? basePrompt : correctivePrompt(basePrompt, lastError);
    if (attempt === 2) onLog('warn', `${label}: output was not valid JSON. Retrying once.`);

    const raw = await spawnClaude(prompt, opts.model, opts.dir, opts.timeoutMs, onLog, opts.signal);
    lastRaw = raw;

    const json = extractJson(raw);
    if (json === null) {
      lastError = 'no JSON object found in the answer';
      continue;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      lastError = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      continue;
    }
    return parsed.data;
  }

  throw new Error(
    `${label}: the model did not return a valid JSON block (${lastError}).\n` +
      `--- raw answer (truncated) ---\n${lastRaw.slice(0, 4000)}`,
  );
}

function countLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The lenses run as independent processes against the same checkout. One
 * lens failing degrades the review instead of losing the others; the
 * synthesis pass is told which lens produced nothing.
 */
async function runLenses(
  vars: PromptVars,
  onLog: OnLog,
  opts: PassOptions,
): Promise<LensResult[]> {
  return Promise.all(
    LENS_NAMES.map(async (lens): Promise<LensResult> => {
      const lensLog: OnLog = (level, message) => onLog(level, `[${lens}] ${message}`);
      onLog('info', `lens ${lens}: started`);
      try {
        const prompt = await buildLensPrompt(lens, vars);
        const output = await runPass(`lens ${lens}`, prompt, lensOutputSchema, lensLog, opts);
        onLog(
          'info',
          `lens ${lens}: ${countLabel(output.findings.length, 'finding')}, ` +
            `${countLabel(output.observations.length, 'observation')}`,
        );
        return { lens, output, error: null };
      } catch (err) {
        // A cancelled run must abort the whole review, not degrade it.
        if (opts.signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        onLog('warn', `lens ${lens}: failed — ${message.split('\n')[0]}`);
        return { lens, output: null, error: message.slice(0, 500) };
      }
    }),
  );
}

export async function runReview(
  review: RunnableReview,
  checkout: CheckoutResult,
  ticket: TicketInfo | null,
  onLog: OnLog,
  opts: RunReviewOptions = {},
): Promise<ReviewOutput> {
  const vars: PromptVars = {
    ticket,
    review,
    checkout,
    previousFindings: opts.previousFindings ?? [],
  };
  const passOpts: PassOptions = {
    dir: checkout.dir,
    model: opts.model ?? review.model ?? config.REVIEW_MODEL,
    timeoutMs: opts.timeoutMs ?? config.REVIEW_TIMEOUT_MS,
    signal: opts.signal,
  };

  onLog('info', `Running ${LENS_NAMES.length} review lenses in parallel: ${LENS_NAMES.join(', ')}.`);
  const lensResults = await runLenses(vars, onLog, passOpts);
  if (lensResults.every((r) => r.output === null)) {
    throw new Error(
      `Every review lens failed. First error: ${lensResults[0]?.error ?? 'unknown'}`,
    );
  }

  const totalCandidates = lensResults.reduce((n, r) => n + (r.output?.findings.length ?? 0), 0);
  onLog('info', `synthesis: started with ${countLabel(totalCandidates, 'candidate finding')}.`);

  const prompt = await buildSynthesisPrompt(vars, renderLensOutputs(lensResults));
  const output = await runPass(
    'synthesis',
    prompt,
    reviewOutputSchema,
    (level, message) => onLog(level, `[synthesis] ${message}`),
    passOpts,
  );
  onLog(
    'info',
    `synthesis: ${countLabel(output.findings.length, 'finding')}, ` +
      `${countLabel(output.observations.length, 'observation')}, ` +
      `${countLabel(output.requirements.length, 'requirement')}`,
  );

  return normalize(output as ReviewOutput);
}

function correctivePrompt(basePrompt: string, problem: string): string {
  return [
    'Your previous answer could not be parsed. Problem: ' + problem + '.',
    'Do the work again and this time end your answer with exactly ONE ```json',
    'fenced block that matches the schema. No text after that block. No comments,',
    'no trailing commas inside the JSON.',
    '',
    basePrompt,
  ].join('\n');
}

function normalize(output: ReviewOutput): ReviewOutput {
  const hasBlocking = output.findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  // `not_verifiable` cannot be checked from this repository, so it does not
  // block a merge on its own. Only `partial` and `missing` do.
  const nothingOpen = output.requirements.every(
    (r) => r.status === 'met' || r.status === 'not_verifiable',
  );
  // The merge gate is a hard rule, not a model opinion. `observations` are
  // deliberately absent from it: they never block a merge.
  const canMerge = output.can_merge && !hasBlocking && nothingOpen;
  // Keep the verdict and the gate consistent: an "approve" banner must never
  // sit on top of can_merge = false.
  const verdict = !canMerge && output.verdict === 'approve' ? 'changes_requested' : output.verdict;
  return { ...output, can_merge: canMerge, verdict };
}

function spawnClaude(
  prompt: string,
  model: string,
  dir: string,
  timeoutMs: number,
  onLog: OnLog,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Review cancelled'));
      return;
    }
    const args = buildClaudeArgs(prompt, model, dir);
    const child = spawn(config.CLAUDE_BIN, args, {
      cwd: dir,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can kill the whole tree
    });

    let settled = false;
    let stdoutBuf = '';
    let stderrTail = '';
    let result: string | null = null;
    let resultIsError = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value ?? '');
    };

    const timer = setTimeout(() => {
      killTree();
      finish(new Error(`Review timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onAbort = () => {
      killTree();
      finish(new Error('Review cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line) continue;
        const handled = handleStreamLine(line, onLog);
        if (handled.result !== undefined) {
          result = handled.result;
          resultIsError = handled.isError === true;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on('error', (err) => finish(new Error(`Failed to start ${config.CLAUDE_BIN}: ${err.message}`)));

    child.on('close', (code) => {
      // Flush a trailing line without a newline.
      const tail = stdoutBuf.trim();
      if (tail) {
        const handled = handleStreamLine(tail, onLog);
        if (handled.result !== undefined) {
          result = handled.result;
          resultIsError = handled.isError === true;
        }
      }
      if (settled) return;
      if (result !== null && !resultIsError) {
        finish(null, result);
        return;
      }
      if (result !== null && resultIsError) {
        finish(new Error(`The review model reported an error: ${String(result).slice(0, 2000)}`));
        return;
      }
      finish(new Error(`claude exited with code ${code ?? 'null'}${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
    });
  });
}

interface StreamLineResult {
  result?: string;
  isError?: boolean;
}

const MAX_LOG_CHARS = 600;

/** Parse one stream-json line, forward progress, and surface the final result. */
export function handleStreamLine(line: string, onLog: OnLog): StreamLineResult {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof event !== 'object' || event === null) return {};
  const e = event as Record<string, any>;

  switch (e.type) {
    case 'system':
      if (e.subtype === 'init') onLog('info', `Reviewer started (model ${e.model ?? 'default'})`);
      return {};
    case 'assistant': {
      const content = e.message?.content;
      if (!Array.isArray(content)) return {};
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const text = block.text.trim();
          if (text) onLog('info', truncate(text, MAX_LOG_CHARS));
        } else if (block?.type === 'tool_use') {
          onLog('info', `tool: ${block.name}${describeToolInput(block.input)}`);
        }
      }
      return {};
    }
    case 'result': {
      if (typeof e.result === 'string') {
        return { result: e.result, isError: e.is_error === true || e.subtype !== 'success' };
      }
      return { result: '', isError: true };
    }
    default:
      return {};
  }
}

function describeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  const hint = i.file_path ?? i.path ?? i.pattern ?? i.command;
  return typeof hint === 'string' ? ` ${truncate(hint, 160)}` : '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Take the last ```json fenced block; fall back to the last balanced {...}.
 * Scanning backwards matters: the model often shows examples before its answer.
 */
export function extractJson(raw: string): unknown | null {
  const fenced = [...raw.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(fenced[i]![1]!);
    if (parsed !== null) return parsed;
  }
  const anyFence = [...raw.matchAll(/```\s*([\s\S]*?)```/g)];
  for (let i = anyFence.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(anyFence[i]![1]!);
    if (parsed !== null) return parsed;
  }
  return lastBalancedObject(raw);
}

function tryParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function lastBalancedObject(raw: string): unknown | null {
  for (let end = raw.lastIndexOf('}'); end >= 0; end = raw.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let inString = false;
    for (let i = end; i >= 0; i -= 1) {
      const ch = raw[i]!;
      if (inString) {
        // Walking backwards: a quote ends the string unless it is escaped.
        if (ch === '"' && !isEscaped(raw, i)) inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(raw.slice(i, end + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function isEscaped(raw: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && raw[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}
