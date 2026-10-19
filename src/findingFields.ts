import { z } from 'zod';
import { FINDING_KINDS, LENS_NAMES } from './types.js';
import type { Finding, FindingKind, LensName, LensOutput } from './types.js';

// --- parsing helpers shared by the lens, synthesis, and re-anchor schemas ---

const KIND_ALIASES: Record<string, FindingKind> = {
  dependent: 'regression',
  dependent_site: 'regression',
  regressions: 'regression',
  stale_docs: 'stale_doc',
  stale_documentation: 'stale_doc',
  docs: 'stale_doc',
  consumers: 'consumer',
};

/** A model's `kind`, leniently: unknown or missing values mean `diff`. */
export function normalizeKind(value: unknown): FindingKind {
  if (typeof value !== 'string') return 'diff';
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((FINDING_KINDS as readonly string[]).includes(key)) return key as FindingKind;
  return KIND_ALIASES[key] ?? 'diff';
}

const HUNK = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The `@@ -a,b +c,d @@` part of a hunk header, or null when there is none. */
export function normalizeHunk(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return HUNK.exec(value)?.[0] ?? null;
}

export function normalizeLens(value: unknown): LensName | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return (LENS_NAMES as readonly string[]).includes(key) ? (key as LensName) : null;
}

export const optionalPath = z.string().nullish().transform((v) => (v?.trim() ? v.trim() : null));
export const optionalLine = z.coerce.number().int().nullish().transform((v) => v ?? null);

/** The anchor fields every finding schema shares. */
export const anchorFields = {
  kind: z.unknown().optional().transform(normalizeKind),
  cause_file: optionalPath,
  cause_line: optionalLine,
  hunk: z.unknown().optional().transform(normalizeHunk),
};

// --- lens attribution --------------------------------------------------------

function samePlace(a: Pick<Finding, 'file' | 'line'>, b: Pick<Finding, 'file' | 'line'>): boolean {
  const norm = (p: string | null) => (p ?? '').trim().replace(/^\.\//, '');
  return !!a.file && norm(a.file) === norm(b.file) && a.line === b.line;
}

/**
 * Fills in `lens`, and carries a non-diff `kind` with its cause from the lens
 * candidate synthesis kept, when synthesis dropped them. A candidate counts as
 * kept when it sits at the same file and line. The lens synthesis names wins;
 * otherwise the lens is inferred only when every matching candidate comes
 * from one lens.
 */
export function attributeLenses(
  findings: Finding[],
  lenses: readonly { lens: LensName; output: LensOutput | null }[],
): Finding[] {
  return findings.map((f) => {
    const matches = lenses.flatMap((l) =>
      (l.output?.findings ?? []).filter((c) => samePlace(c, f)).map((c) => ({ lens: l.lens, c })));
    const own = f.lens ? matches.filter((m) => m.lens === f.lens) : matches;
    const lensNames = new Set(matches.map((m) => m.lens));
    const lens = f.lens ?? (lensNames.size === 1 ? [...lensNames][0]! : null);
    let out: Finding = { ...f, lens };
    if (out.kind === 'diff' && !out.cause_file) {
      const source = own.find((m) => m.c.kind !== 'diff');
      if (source) {
        out = { ...out, kind: source.c.kind, cause_file: source.c.cause_file, cause_line: source.c.cause_line };
      }
    }
    return out;
  });
}

