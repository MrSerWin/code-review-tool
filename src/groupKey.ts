/**
 * The identity a review run is grouped under in the history: the ticket it was
 * run for, else a ticket-like key found in the branch name, else the branch
 * itself. Pure and dependency-free, so the database layer and the tests share
 * one definition.
 */

export interface GroupKeyInput {
  ticket_key: string | null | undefined;
  repo: string;
  branch: string;
}

/**
 * Words that look like a project key in a branch name but are not one: version
 * and encoding markers (v2-1, utf-8, iso-8601, sha-256, http2-...), and generic
 * words that carry a counter (step-2, phase-3, release-4, fix-1). Checked with
 * any trailing digits removed, so `utf8`, `md5`, `ipv6`, and `node20` count too.
 *
 * Known limitation: a real project whose key is one of these words (say a Jira
 * project "ES") is not recognised from a branch name. Runs started from its
 * tracker ticket still group correctly, because `ticket_key` always wins.
 */
const NOT_A_PROJECT = new Set([
  'V', 'UTF', 'ISO', 'SHA', 'MD', 'RFC', 'HTTP', 'TLS', 'SSL', 'ES', 'IPV', 'WIN', 'X', 'ARM',
  'NODE', 'PY', 'PYTHON', 'JAVA', 'PHP',
  'FIX', 'HOTFIX', 'BUGFIX', 'FEAT', 'FEATURE', 'RELEASE', 'CHORE', 'WIP', 'STEP', 'PART', 'PHASE',
  'STAGE', 'ROUND', 'TRY', 'TEST', 'TMP', 'DRAFT', 'VERSION', 'REV', 'PR', 'ISSUE',
]);

/** Jira caps project keys at 10 characters; nothing longer is taken for one. */
const MAX_PROJECT_LENGTH = 10;

/**
 * `<letters+digits>-<digits>` as a whole token: preceded by the start or a
 * non-alphanumeric character, followed by the end or a non-alphanumeric one.
 */
const TOKEN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-(\d+)(?![A-Za-z0-9])/g;

/**
 * The first ticket-like key in a branch name, upper-cased
 * (`feat/abc-123-foo` -> `ABC-123`), or null when there is none.
 */
export function ticketKeyFromBranch(branch: string): string | null {
  for (const match of branch.matchAll(TOKEN)) {
    const project = (match[1] as string).toUpperCase();
    if (project.length < 2 || project.length > MAX_PROJECT_LENGTH) continue;
    if (NOT_A_PROJECT.has(project.replace(/\d+$/, ''))) continue;
    return `${project}-${match[2]}`;
  }
  return null;
}

/** The key of a group that has neither a ticket nor a ticket-like branch name. */
export function fallbackGroupKey(repo: string, branch: string): string {
  return `${repo}#${branch}`;
}

/**
 * `ticket_key` when the run has one; else the key found in the branch name, so
 * runs with pasted requirements join their ticket's group; else `repo#branch`.
 */
export function groupKeyFor(row: GroupKeyInput): string {
  const ticket = row.ticket_key?.trim();
  if (ticket) return ticket;
  return ticketKeyFromBranch(row.branch) ?? fallbackGroupKey(row.repo, row.branch);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A ticket title as shown next to its key: a Markdown heading marker and a
 * leading copy of the key (`# ABC-123: Add export` -> `Add export`) are
 * dropped. Null when nothing is left.
 */
export function cleanGroupTitle(title: string | null | undefined, key: string): string | null {
  if (!title) return null;
  let text = title.trim().replace(/^#+\s*/, '');
  const leadingKey = new RegExp(`^\\[?${escapeRegExp(key)}\\]?(?![A-Za-z0-9])\\s*[:\\-–—]?\\s*`, 'i');
  text = text.replace(leadingKey, '').trim();
  return text || null;
}
