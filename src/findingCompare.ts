import type { FindingRow, Severity } from './types.js';

/** Minimal shape needed to compare findings across runs. */
export interface ComparableFinding {
  severity: Severity;
  title: string;
  file: string | null;
  line: number | null;
  problem: string;
}

export interface FindingComparison {
  resolved: ComparableFinding[];
  new: ComparableFinding[];
  persistent: ComparableFinding[];
}

/** Stable identity for matching the same defect across runs. */
export function findingKey(finding: ComparableFinding): string {
  const file = (finding.file ?? '').toLowerCase();
  const title = finding.title.trim().toLowerCase();
  const line = finding.line ?? '';
  return `${finding.severity}|${file}|${line}|${title}`;
}

export function toComparable(finding: FindingRow): ComparableFinding {
  return {
    severity: finding.severity,
    title: finding.title,
    file: finding.file ?? null,
    line: finding.line ?? null,
    problem: finding.problem,
  };
}

/**
 * Compare the current run's findings to a previous run.
 * `resolved` = present before but not now; `new` = present now but not before.
 */
export function compareFindings(
  previous: ComparableFinding[],
  current: ComparableFinding[],
): FindingComparison {
  const prevKeys = new Set(previous.map(findingKey));
  const currKeys = new Set(current.map(findingKey));

  const resolved = previous.filter((f) => !currKeys.has(findingKey(f)));
  const newFindings = current.filter((f) => !prevKeys.has(findingKey(f)));
  const persistent = current.filter((f) => prevKeys.has(findingKey(f)));

  return { resolved, new: newFindings, persistent };
}
