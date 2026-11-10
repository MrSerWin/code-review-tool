import type { Finding, Observation, OnLog } from '../types.js';
import type { CheckId, ChecksConfig } from './config.js';
import { commitIdentity } from './commitIdentity.js';
import { emDash } from './emDash.js';
import { dataMigrationIdempotence, migrationCollision } from './migrations.js';
import { diffSize, docUpdateHeuristic, forbiddenPaths } from './paths.js';
import type { CheckContext, ToolCheck } from './types.js';

export type { CheckContext, SiblingBranch, TreeRef } from './types.js';
export { parseChecksConfig, type ChecksConfig } from './config.js';

/** Every check, in the order they run and are listed. */
const CHECKS: { [K in CheckId]: ToolCheck<NonNullable<ChecksConfig['checks'][K]>> } = {
  'migration-collision': migrationCollision,
  'data-migration-idempotence': dataMigrationIdempotence,
  'forbidden-paths': forbiddenPaths,
  'em-dash': emDash,
  'commit-identity': commitIdentity,
  'doc-update-heuristic': docUpdateHeuristic,
  'diff-size': diffSize,
};

export const CHECK_IDS = Object.keys(CHECKS) as CheckId[];

export interface ToolCheckRun {
  /** The checks that ran to the end. */
  ran: CheckId[];
  failed: { id: CheckId; error: string }[];
  /** `lens: 'tool'`; anchors are not validated yet. */
  findings: Finding[];
  observations: Observation[];
}

export function emptyToolCheckRun(): ToolCheckRun {
  return { ran: [], failed: [], findings: [], observations: [] };
}

/**
 * Runs every check the config enables. A check that throws is logged and
 * skipped: a tool check must never fail the review.
 */
export async function runToolChecks(ctx: CheckContext, config: ChecksConfig, onLog: OnLog): Promise<ToolCheckRun> {
  const out = emptyToolCheckRun();
  for (const id of CHECK_IDS) {
    const options = config.checks[id];
    if (!options) continue;
    try {
      const result = await (CHECKS[id] as ToolCheck<typeof options>).run(ctx, options);
      for (const note of result.notes ?? []) onLog('info', `tool check ${id}: ${note}`);
      out.findings.push(...result.findings.map((f): Finding => ({ ...f, title: `${id}: ${f.title}`, lens: 'tool' })));
      out.observations.push(...result.observations.map((o): Observation => ({ ...o, note: `${id}: ${o.note}`, lens: 'tool' })));
      out.ran.push(id);
      if (result.findings.length || result.observations.length) {
        onLog('info', `tool check ${id}: ${result.findings.length} finding(s), ${result.observations.length} observation(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.failed.push({ id, error: message.slice(0, 300) });
      onLog('warn', `tool check ${id}: failed, skipped: ${message.split('\n')[0]}`);
    }
  }
  return out;
}

function where(file: string | null, line: number | null): string {
  if (!file) return 'no location';
  return line ? `${file}:${line}` : file;
}

/** The `{{TOOL_CHECKS}}` section of the synthesis prompt; empty when no check ran. */
export function renderToolChecks(run: ToolCheckRun): string {
  if (run.ran.length === 0 && run.failed.length === 0) return '';
  const lines = [
    '# Tool checks (deterministic, already verified)',
    '',
    'The tool ran these checks on the checkout itself. Their results are facts, and the tool adds them to the',
    'final review on its own. Do NOT copy them into your `findings` or `observations`, and do not report the',
    'same problem again in other words. You may refer to them in the summary and the conclusion.',
    '',
    `Checks that ran: ${run.ran.join(', ') || 'none'}.`,
  ];
  if (run.failed.length) lines.push(`Checks that failed (no result): ${run.failed.map((f) => f.id).join(', ')}.`);
  lines.push('', '## Tool findings', '');
  if (run.findings.length === 0) lines.push('None.');
  for (const f of run.findings) {
    lines.push(`- [${f.severity.toUpperCase()}] ${f.title} (${where(f.file, f.line)}): ${f.problem.replace(/\s+/g, ' ')}`);
  }
  lines.push('', '## Tool observations', '');
  if (run.observations.length === 0) lines.push('None.');
  for (const o of run.observations) lines.push(`- (${where(o.file, o.line)}) ${o.note.replace(/\s+/g, ' ')}`);
  return lines.join('\n');
}
