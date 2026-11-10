import fs from 'node:fs';
import path from 'node:path';
import { GlobSet } from './glob.js';
import { lsTreeNames } from './git.js';
import { toolFinding, type CheckContext, type CheckResult, type ToolCheck, type TreeRef } from './types.js';

const ADDED = new Set(['A', 'R', 'C']);

/** `apps/x/migrations/0042_y.py` -> `apps/x/migrations#0042`; null without a numeric prefix. */
export function migrationSlot(file: string): { key: string; number: string } | null {
  const base = path.posix.basename(file);
  const number = /^(\d+)_/.exec(base)?.[1];
  if (!number) return null;
  return { key: `${path.posix.dirname(file)}#${number}`, number };
}

function addedMigrations(ctx: CheckContext, globs: GlobSet): string[] {
  return ctx.changedFiles.filter((f) => ADDED.has(f.status) && globs.matches(f.path)).map((f) => f.path);
}

/** The trees an added migration number is compared against, same repository only. */
export function comparisonTrees(ctx: CheckContext): TreeRef[] {
  const trees: TreeRef[] = [{ label: 'the base commit', dir: ctx.checkoutDir, ref: ctx.baseSha }];
  if (ctx.baseTip) trees.push(ctx.baseTip);
  if (ctx.defaultBranch) trees.push(ctx.defaultBranch);
  for (const s of ctx.siblings) if (s.repo === ctx.repo && s.tree) trees.push(s.tree);
  return trees;
}

export const migrationCollision: ToolCheck<{ globs: string[] }> = {
  id: 'migration-collision',
  async run(ctx, config): Promise<CheckResult> {
    const globs = new GlobSet(config.globs);
    const added = addedMigrations(ctx, globs);
    const result: CheckResult = { findings: [], observations: [], notes: [] };
    if (added.length === 0) return result;

    // slot -> other file -> where it was seen
    const taken = new Map<string, Map<string, Set<string>>>();
    for (const tree of comparisonTrees(ctx)) {
      const names = await lsTreeNames(tree);
      if (names === null) {
        result.notes!.push(`could not read ${tree.label}; it was not compared`);
        continue;
      }
      for (const name of names) {
        if (!globs.matches(name)) continue;
        const slot = migrationSlot(name);
        if (!slot) continue;
        const files = taken.get(slot.key) ?? new Map<string, Set<string>>();
        const where = files.get(name) ?? new Set<string>();
        where.add(tree.label);
        files.set(name, where);
        taken.set(slot.key, files);
      }
    }

    for (const file of added) {
      const slot = migrationSlot(file);
      if (!slot) continue;
      // The same file elsewhere is this migration (a child slice carries it), not a clash.
      const others = [...(taken.get(slot.key) ?? new Map<string, Set<string>>())].filter(([other]) => other !== file);
      if (others.length === 0) continue;
      const described = others.map(([other, where]) => `\`${other}\` (on ${[...where].join(', ')})`);
      result.findings.push(toolFinding({
        severity: 'major',
        category: 'correctness',
        file,
        line: 1,
        title: `Migration number ${slot.number} is already taken in ${path.posix.dirname(file)}`,
        problem: `\`${file}\` is new in this branch, and its number ${slot.number} is already used by ${described.join('; ')}.`,
        why: 'Two migrations with one number in one app give Django two leaf nodes; whichever merges second fails `migrate` until it is renumbered.',
        suggestion: 'Renumber this migration after the latest one on the target branch and update its `dependencies`, or coordinate the order with the other branch.',
      }));
    }
    return result;
  },
};

const RUN_PYTHON = /\bRunPython\b/;
const WRITES = /\.create\(|\bbulk_create\(|\b\w*(?:seed|sync)\w*\s*\(/i;
const GUARDED = /\bget_or_create\b|\bupdate_or_create\b|\.exists\(\)|ignore_conflicts\s*=\s*True|\bif\s+not\b[^\n]*\.filter\(/;

function firstLine(text: string, re: RegExp): number {
  const lines = text.split('\n');
  const index = lines.findIndex((l) => re.test(l));
  return index < 0 ? 1 : index + 1;
}

export const dataMigrationIdempotence: ToolCheck<{ globs: string[] }> = {
  id: 'data-migration-idempotence',
  async run(ctx, config): Promise<CheckResult> {
    const globs = new GlobSet(config.globs);
    const result: CheckResult = { findings: [], observations: [] };
    for (const file of ctx.changedFiles.filter((f) => f.status === 'A' && globs.matches(f.path)).map((f) => f.path)) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(ctx.checkoutDir, file), 'utf8');
      } catch {
        continue;
      }
      if (!RUN_PYTHON.test(text) || !WRITES.test(text) || GUARDED.test(text)) continue;
      result.observations.push({
        file,
        line: firstLine(text, WRITES),
        note: 'This data migration creates rows in `RunPython` without `get_or_create`, `update_or_create` or an existence check. Verify it is idempotent against a database that already holds this data.',
        rationale: 'Heuristic tool check: a seed that runs twice, or on a database seeded by hand or by another branch, can fail on a unique constraint or duplicate rows.',
      });
    }
    return result;
  },
};
