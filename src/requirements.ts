/**
 * The requirement derivation pass: one reviewer run per ticket that turns the
 * ticket text and its comments into the stored checklist
 * (ticketRequirements.ts). It runs in an empty directory, with no code, and
 * at most once at a time per ticket in this process: concurrent callers share
 * the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { sanitizeSegment } from './reportWriter.js';
import { chooseModel, getReviewer } from './reviewers/index.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import { loadPromptFile, renderTemplate, renderTicket, runPass } from './reviewRunner.js';
import { activeChecklist, replaceDerivedRequirements } from './ticketRequirements.js';
import { getTicketGroup } from './ticketStore.js';
import { activeProviders, getTicket, looksLikeTicket } from './trackers/index.js';
import type { OnLog, ReviewRow, TicketInfo, TicketRequirementRow } from './types.js';

const textList = z
  .array(z.union([z.string(), z.object({ text: z.string() }).transform((o) => o.text)]))
  .nullish()
  .transform((v) => (v ?? []).map((s) => s.trim()).filter(Boolean));

export const derivationOutputSchema = z.object({
  requirements: textList,
  not_verifiable_notes: textList,
  open_questions: textList,
});

export type DerivationOutput = z.infer<typeof derivationOutputSchema>;

export function renderUserItems(items: readonly Pick<TicketRequirementRow, 'text'>[]): string {
  if (items.length === 0) return 'None.';
  return items.map((r) => `- ${r.text.replace(/\s+/g, ' ')}`).join('\n');
}

export async function buildDerivationPrompt(ticketText: string, userItems: readonly Pick<TicketRequirementRow, 'text'>[]): Promise<string> {
  return renderTemplate(await loadPromptFile('requirements.md'), {
    TICKET: ticketText,
    USER_ITEMS: renderUserItems(userItems),
  });
}

/** The ticket as the reviews of a group stored it: body only, no comments. */
export function storedTicket(key: string): TicketInfo | null {
  const row = db
    .prepare<[string], Pick<ReviewRow, 'ticket_title' | 'ticket_url' | 'ticket_body'>>(
      `SELECT ticket_title, ticket_url, ticket_body FROM reviews
        WHERE group_key = ? AND TRIM(COALESCE(ticket_body, '')) <> '' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(key);
  const group = getTicketGroup(key);
  if (!row && !group) return null;
  return {
    provider: 'stored', key, title: row?.ticket_title ?? group?.title ?? '', url: row?.ticket_url ?? group?.ticket_url ?? '',
    body: row?.ticket_body ?? '', state: '', branchName: null, comments: [], attachmentUrls: [],
  };
}

/**
 * The ticket with its comments from the tracker; the stored text when no
 * tracker answers (no tracker configured, a key no tracker knows, an error).
 */
export async function ticketForDerivation(key: string, onLog: OnLog = () => {}): Promise<TicketInfo | null> {
  if (looksLikeTicket(key) && activeProviders().length > 0) {
    try {
      const ticket = await getTicket(key);
      if (ticket.key === key) return ticket;
    } catch (err) {
      onLog('warn', `the tracker did not answer for ${key} (${(err as Error).message.split('\n')[0]}); using the stored ticket text`);
    }
  }
  return storedTicket(key);
}

export interface DeriveOptions {
  reviewer?: string | null;
  model?: string | null;
  /** For tests: the reviewer to run instead of looking one up. */
  reviewerDefinition?: ReviewerDefinition;
  /** The ticket text to derive from; looked up (tracker, then stored text) when absent. */
  ticket?: TicketInfo | null;
  /** For tests: how the ticket is looked up when `ticket` is absent. */
  fetchTicket?: (key: string, onLog: OnLog) => Promise<TicketInfo | null>;
  timeoutMs?: number;
  onLog?: OnLog;
}

export interface DeriveResult {
  items: TicketRequirementRow[];
  notes: string[];
  openQuestions: string[];
  reviewer: string;
  model: string;
}

/**
 * The reviewer and model of a derivation. The model is the caller's (a branch
 * review's, carried over): used while the reviewer still offers it, else the
 * reviewer's default. Throws when the reviewer has no model at all.
 */
async function pickReviewer(opts: DeriveOptions, onLog: OnLog): Promise<{ reviewer: ReviewerDefinition; model: string }> {
  let reviewer: ReviewerDefinition;
  try {
    reviewer = opts.reviewerDefinition ?? getReviewer(opts.reviewer ?? undefined);
  } catch {
    reviewer = getReviewer(undefined);
  }
  const inherited = opts.model && (!opts.reviewer || opts.reviewer === reviewer.name) ? opts.model : null;
  if (opts.reviewerDefinition) return { reviewer, model: inherited ?? reviewer.defaultModel };
  const model = await chooseModel(reviewer, { inherited, onFallback: (message) => onLog('warn', message) });
  return { reviewer, model };
}

/** Derives the checklist now: derived items are replaced, user items stay. Throws when the pass fails. */
export async function deriveTicketRequirements(key: string, opts: DeriveOptions = {}): Promise<DeriveResult> {
  const onLog = opts.onLog ?? (() => {});
  const { reviewer, model } = await pickReviewer(opts, onLog);
  const ticket = opts.ticket !== undefined && opts.ticket !== null
    ? opts.ticket
    : await (opts.fetchTicket ?? ticketForDerivation)(key, onLog);
  const ticketText = ticket
    ? renderTicket(ticket, { ticket_key: key, ticket_title: ticket.title, ticket_url: ticket.url, ticket_body: ticket.body })
    : `**${key}**\n\n(no ticket text is stored)`;
  const userItems = activeChecklist(key).filter((r) => r.source === 'user');
  const prompt = await buildDerivationPrompt(ticketText, userItems);

  const workDir = path.join(config.DATA_DIR, 'requirements', sanitizeSegment(key), `${Date.now()}-${process.pid}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    onLog('info', `deriving the requirement checklist of ${key} with ${reviewer.label} (${model})`);
    const { data } = await runPass('requirements', prompt, derivationOutputSchema, onLog, {
      dir: workDir,
      reviewer,
      model,
      timeoutMs: opts.timeoutMs ?? config.REVIEW_TIMEOUT_MS,
      signal: undefined,
    });
    const items = replaceDerivedRequirements(key, data.requirements, data.not_verifiable_notes, data.open_questions);
    onLog('info', `checklist of ${key}: ${items.length} item(s), ${data.not_verifiable_notes.length} not verifiable note(s), ` +
      `${data.open_questions.length} open question(s)`);
    return { items, notes: data.not_verifiable_notes, openQuestions: data.open_questions, reviewer: reviewer.name, model };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const inFlight = new Map<string, Promise<DeriveResult>>();
const lastErrors = new Map<string, { error: string; at: string }>();

/** Derives now, joining a derivation of the same ticket that is already running. */
export function deriveOnce(key: string, opts: DeriveOptions = {}): { started: boolean; done: Promise<DeriveResult> } {
  const running = inFlight.get(key);
  if (running) return { started: false, done: running };
  const done = deriveTicketRequirements(key, opts)
    .then((result) => {
      lastErrors.delete(key);
      return result;
    }, (err: unknown) => {
      lastErrors.set(key, { error: (err as Error).message.split('\n')[0]!.slice(0, 500), at: new Date().toISOString() });
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return { started: true, done };
}

export function derivationRunning(key: string): boolean {
  return inFlight.has(key);
}

/** The error of the latest derivation of this ticket in this process, when it failed. */
export function derivationError(key: string): { error: string; at: string } | null {
  return lastErrors.get(key) ?? null;
}

/**
 * The ticket's active checklist, derived first when it never was. Returns
 * null when there is nothing to evaluate by id (the derivation failed, or the
 * list is empty): the caller then derives requirements in its own pass, as
 * for a branch without a ticket group.
 */
export async function ensureTicketRequirements(key: string, opts: DeriveOptions = {}): Promise<TicketRequirementRow[] | null> {
  const onLog = opts.onLog ?? (() => {});
  if (!getTicketGroup(key)?.requirements_derived_at) {
    const { started, done } = deriveOnce(key, opts);
    if (!started) onLog('info', `waiting for the running derivation of the ${key} checklist`);
    try {
      await done;
    } catch (err) {
      const message = (err as Error).message.split('\n')[0];
      onLog('warn', `could not derive the checklist of ${key}: ${message}. This review derives its own requirements.`);
      logger.warn(`requirements ${key}: derivation failed: ${message}`);
      return null;
    }
  }
  const items = activeChecklist(key);
  return items.length > 0 ? items : null;
}
