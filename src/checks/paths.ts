import fs from 'node:fs';
import path from 'node:path';
import { GlobSet } from './glob.js';
import { toolFinding, type CheckResult, type ToolCheck } from './types.js';

const WRITTEN = new Set(['A', 'M', 'R', 'C', 'T']);
const LISTED = 5;

function listed(paths: readonly string[]): string {
  const head = paths.slice(0, LISTED).map((p) => `\`${p}\``).join(', ');
  return paths.length > LISTED ? `${head} and ${paths.length - LISTED} more` : head;
}

export const forbiddenPaths: ToolCheck<{ blockerPatterns: string[]; patterns: string[]; maxFileBytes: number }> = {
  id: 'forbidden-paths',
  async run(ctx, config): Promise<CheckResult> {
    const result: CheckResult = { findings: [], observations: [] };
    const written = ctx.changedFiles.filter((f) => WRITTEN.has(f.status)).map((f) => f.path);
    const groups = new Map<string, { severity: 'blocker' | 'major'; paths: string[] }>();
    const blockers = new GlobSet(config.blockerPatterns);
    const others = new GlobSet(config.patterns);
    for (const file of written) {
      const blocker = blockers.firstMatch(file);
      const pattern = blocker ?? others.firstMatch(file);
      if (!pattern) continue;
      const group = groups.get(pattern) ?? { severity: blocker ? 'blocker' : 'major', paths: [] };
      group.paths.push(file);
      groups.set(pattern, group);
    }
    for (const [pattern, group] of groups) {
      result.findings.push(toolFinding({
        severity: group.severity,
        category: group.severity === 'blocker' ? 'security' : 'correctness',
        file: group.paths[0]!,
        line: null,
        title: `Committed path matches \`${pattern}\` (${group.paths.length} file${group.paths.length === 1 ? '' : 's'})`,
        problem: `The branch adds or changes ${listed(group.paths)}, which match the forbidden pattern \`${pattern}\`.`,
        why: group.severity === 'blocker'
          ? 'An environment file or virtualenv in the repository leaks local secrets or machine state, and a committed venv symlink can destroy a real venv on checkout.'
          : 'Generated or machine-local files do not belong in the repository.',
        suggestion: 'Remove these paths from the branch history and add them to .gitignore.',
      }));
    }

    const large: { file: string; bytes: number }[] = [];
    for (const file of written) {
      try {
        const stat = fs.lstatSync(path.join(ctx.checkoutDir, file));
        if (stat.isFile() && stat.size > config.maxFileBytes) large.push({ file, bytes: stat.size });
      } catch {
        // Not in the working tree (a submodule entry, say): nothing to measure.
      }
    }
    for (const { file, bytes } of large.slice(0, 20)) {
      result.findings.push(toolFinding({
        severity: 'major',
        category: 'correctness',
        file,
        line: null,
        title: `Large file committed (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
        problem: `\`${file}\` is ${bytes} bytes, above the ${config.maxFileBytes}-byte limit for this repository.`,
        why: 'Large binaries bloat every clone forever, even after they are deleted.',
        suggestion: 'Keep the file out of git (object storage, a release asset, or Git LFS) unless it truly belongs here.',
      }));
    }
    return result;
  },
};

export const docUpdateHeuristic: ToolCheck<{ behaviourGlobs: string[]; docGlobs: string[] }> = {
  id: 'doc-update-heuristic',
  async run(ctx, config): Promise<CheckResult> {
    const paths = ctx.changedFiles.map((f) => f.path);
    const behaviour = new GlobSet(config.behaviourGlobs);
    const docs = new GlobSet(config.docGlobs);
    const changed = paths.filter((p) => behaviour.matches(p));
    if (changed.length === 0 || paths.some((p) => docs.matches(p))) return { findings: [], observations: [] };
    return {
      findings: [],
      observations: [{
        file: null,
        line: null,
        note: `Behaviour files changed (${listed(changed)}), but no customer doc (${config.docGlobs.join(', ')}) changed. Check whether a customer doc must be updated in this branch.`,
        rationale: 'Heuristic tool check: many behaviour changes need no doc update, so this never blocks on its own.',
      }],
    };
  },
};

export const diffSize: ToolCheck<{ maxFiles: number }> = {
  id: 'diff-size',
  async run(ctx, config): Promise<CheckResult> {
    const count = ctx.changedFiles.length;
    if (count <= config.maxFiles) return { findings: [], observations: [] };
    return {
      findings: [],
      observations: [{
        file: null,
        line: null,
        note: `This branch changes ${count} files (limit ${config.maxFiles}). Consider splitting it into a stack of smaller branches.`,
        rationale: 'Tool check: a large diff is hard to review well; it does not block the merge.',
      }],
    };
  },
};
