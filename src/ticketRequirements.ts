/**
 * The stored requirement checklist of a ticket (`ticket_requirements`).
 * Derived once from the ticket (see requirements.ts), then edited by hand;
 * every review and coverage pass of the ticket evaluates the same items by id.
 * Items are never deleted: a removed item keeps its id, so older per-review
 * statuses that point at it stay readable.
 */
import { db } from './db.js';
import { getTicketGroup, upsertTicketGroup } from './ticketStore.js';
import type { TicketRequirementRow, TicketRequirementSource } from './types.js';

const now = (): string => new Date().toISOString();

export const MAX_REQUIREMENT_TEXT = 2_000;
export const MAX_REQUIREMENTS = 200;

/** The comparison key of a requirement: case, spacing, list markers and end punctuation do not count. */
export function normalizeRequirementText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)]|\[[ x]\])\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:,!]+$/, '')
    .trim();
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REQUIREMENT_TEXT);
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)]|\[[ x]\])\s+/;

/**
 * Pasted requirements as checklist items. A text written as a list gives one
 * item per list entry (lines without a marker continue the entry above);
 * otherwise each non-empty line is one item. Headings are dropped.
 */
export function splitRequirementsText(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l));
  const listed = lines.some((l) => LIST_MARKER.test(l));
  const items: string[] = [];
  for (const line of lines) {
    if (!listed || LIST_MARKER.test(line) || items.length === 0) items.push(line.replace(LIST_MARKER, ''));
    else items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
  }
  return items.map(cleanText).filter(Boolean);
}

export function listTicketRequirements(key: string, opts: { includeRemoved?: boolean } = {}): TicketRequirementRow[] {
  return db
    .prepare<[string], TicketRequirementRow>(
      `SELECT * FROM ticket_requirements WHERE ticket_key = ? ${opts.includeRemoved ? '' : `AND state = 'active'`}
        ORDER BY state = 'removed', position, id`,
    )
    .all(key);
}

/** The active checklist, in order; empty when the ticket has none. */
export function activeChecklist(key: string): TicketRequirementRow[] {
  return listTicketRequirements(key);
}

export function getTicketRequirement(id: number): TicketRequirementRow | undefined {
  return db.prepare<[number], TicketRequirementRow>(`SELECT * FROM ticket_requirements WHERE id = ?`).get(id);
}

export function requirementNotes(key: string): string[] {
  const raw = getTicketGroup(key)?.requirements_notes;
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function insertItem(key: string, text: string, source: TicketRequirementSource, position: number, at: string): number {
  const info = db.prepare(
    `INSERT INTO ticket_requirements (ticket_key, position, text, source, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(key, position, text, source, at, at);
  return Number(info.lastInsertRowid);
}

function renumber(key: string, orderedIds: readonly number[], at: string): void {
  const update = db.prepare(`UPDATE ticket_requirements SET position = ?, updated_at = ? WHERE id = ? AND position <> ?`);
  orderedIds.forEach((id, index) => update.run(index, at, id, index));
}

function ensureGroup(key: string): void {
  if (!getTicketGroup(key)) upsertTicketGroup(key);
}

/**
 * Appends items added by hand, skipping any whose text an active item already
 * has. A removed item with the same text comes back (and keeps its id).
 */
export function addUserRequirements(key: string, texts: readonly string[]): { added: TicketRequirementRow[]; skipped: number } {
  const added: number[] = [];
  let skipped = 0;
  const run = db.transaction(() => {
    ensureGroup(key);
    const at = now();
    const all = listTicketRequirements(key, { includeRemoved: true });
    const active = new Set(all.filter((r) => r.state === 'active').map((r) => normalizeRequirementText(r.text)));
    let position = all.filter((r) => r.state === 'active').length;
    for (const raw of texts) {
      const text = cleanText(raw);
      const norm = normalizeRequirementText(text);
      if (!norm || active.has(norm)) {
        skipped += 1;
        continue;
      }
      active.add(norm);
      const removed = all.find((r) => r.state === 'removed' && normalizeRequirementText(r.text) === norm);
      if (removed) {
        db.prepare(`UPDATE ticket_requirements SET state = 'active', source = 'user', position = ?, updated_at = ? WHERE id = ?`)
          .run(position, at, removed.id);
        added.push(removed.id);
      } else {
        added.push(insertItem(key, text, 'user', position, at));
      }
      position += 1;
    }
  });
  run();
  return { added: added.map((id) => getTicketRequirement(id)!), skipped };
}

/**
 * The result of a derivation: derived items replace the active derived ones
 * (which are marked removed), user items stay. A derived text equal to an
 * earlier derived item reuses that item's id; one equal to a user item is
 * dropped. Derived items come first, in the derivation's order.
 */
export function replaceDerivedRequirements(
  key: string,
  texts: readonly string[],
  notes: readonly string[],
): TicketRequirementRow[] {
  const run = db.transaction(() => {
    ensureGroup(key);
    const at = now();
    const all = listTicketRequirements(key, { includeRemoved: true });
    const user = all.filter((r) => r.state === 'active' && r.source === 'user');
    const userTexts = new Set(user.map((r) => normalizeRequirementText(r.text)));
    const oldDerived = all.filter((r) => r.source === 'derived');
    const keep: number[] = [];
    const seen = new Set<string>();
    for (const raw of texts) {
      const text = cleanText(raw);
      const norm = normalizeRequirementText(text);
      if (!norm || seen.has(norm) || userTexts.has(norm)) continue;
      seen.add(norm);
      const reuse = oldDerived.find((r) => normalizeRequirementText(r.text) === norm && !keep.includes(r.id));
      if (reuse) {
        db.prepare(`UPDATE ticket_requirements SET state = 'active', text = ?, updated_at = ? WHERE id = ?`).run(text, at, reuse.id);
        keep.push(reuse.id);
      } else {
        keep.push(insertItem(key, text, 'derived', keep.length, at));
      }
      if (keep.length >= MAX_REQUIREMENTS) break;
    }
    const kept = new Set(keep);
    for (const r of oldDerived) {
      if (r.state === 'active' && !kept.has(r.id)) {
        db.prepare(`UPDATE ticket_requirements SET state = 'removed', updated_at = ? WHERE id = ?`).run(at, r.id);
      }
    }
    renumber(key, [...keep, ...user.map((r) => r.id)], at);
    db.prepare(`UPDATE ticket_groups SET requirements_derived_at = ?, requirements_notes = ?, updated_at = ? WHERE key = ?`)
      .run(at, JSON.stringify(notes.map(cleanText).filter(Boolean)), at, key);
  });
  run();
  return activeChecklist(key);
}

export class ChecklistError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ChecklistError';
  }
}

/**
 * Sets the whole active checklist, in this order. An entry with an id keeps
 * that item (an edited derived item becomes a user item, so a re-derivation
 * keeps it); an entry without one is a new user item. Active items left out
 * are removed (soft). Throws for an id of another ticket, a duplicate id, or
 * an empty text.
 */
export function setTicketRequirements(key: string, items: readonly { id?: number | null; text: string }[]): TicketRequirementRow[] {
  const run = db.transaction(() => {
    ensureGroup(key);
    const at = now();
    const all = new Map(listTicketRequirements(key, { includeRemoved: true }).map((r) => [r.id, r]));
    const order: number[] = [];
    const seenIds = new Set<number>();
    const seenTexts = new Set<string>();
    for (const item of items) {
      const text = cleanText(item.text);
      const norm = normalizeRequirementText(text);
      if (!norm) throw new ChecklistError('A requirement needs a text.');
      if (item.id !== undefined && item.id !== null) {
        const row = all.get(item.id);
        if (!row) throw new ChecklistError(`Requirement ${item.id} is not an item of ${key}.`, 404);
        if (seenIds.has(item.id)) throw new ChecklistError(`Requirement ${item.id} is listed twice.`);
        seenIds.add(item.id);
        seenTexts.add(norm);
        const edited = text !== row.text;
        db.prepare(
          `UPDATE ticket_requirements SET text = ?, state = 'active', source = ?, updated_at = ? WHERE id = ?`,
        ).run(text, edited ? 'user' : row.source, at, row.id);
        order.push(row.id);
      } else {
        if (seenTexts.has(norm)) continue;
        seenTexts.add(norm);
        order.push(insertItem(key, text, 'user', order.length, at));
      }
    }
    if (order.length > MAX_REQUIREMENTS) throw new ChecklistError(`At most ${MAX_REQUIREMENTS} requirements.`);
    const listed = new Set(order);
    for (const row of all.values()) {
      if (row.state === 'active' && !listed.has(row.id)) {
        db.prepare(`UPDATE ticket_requirements SET state = 'removed', updated_at = ? WHERE id = ?`).run(at, row.id);
      }
    }
    renumber(key, order, at);
  });
  run();
  return activeChecklist(key);
}

/** Replaces every active user item with these texts; derived items stay. */
export function replaceUserRequirements(key: string, texts: readonly string[]): TicketRequirementRow[] {
  const current = activeChecklist(key);
  const derived = current.filter((r) => r.source === 'derived').map((r) => ({ id: r.id, text: r.text }));
  return setTicketRequirements(key, [...derived, ...texts.map((text) => ({ text }))]);
}

/** The checklist as the API returns it. */
export function checklistPayload(key: string) {
  const group = getTicketGroup(key);
  const all = listTicketRequirements(key, { includeRemoved: true });
  return {
    key,
    derived_at: group?.requirements_derived_at ?? null,
    not_verifiable_notes: requirementNotes(key),
    items: all.filter((r) => r.state === 'active'),
    removed: all.filter((r) => r.state === 'removed'),
  };
}

export type ChecklistPayload = ReturnType<typeof checklistPayload>;
