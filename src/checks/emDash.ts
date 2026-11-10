import { addedLines } from './git.js';
import { GlobSet, selectPaths } from './glob.js';
import { toolFinding, type CheckResult, type ToolCheck } from './types.js';

const EM_DASH = '\u2014';

export const emDash: ToolCheck<{ globs: string[]; excludeGlobs: string[] }> = {
  id: 'em-dash',
  async run(ctx, config): Promise<CheckResult> {
    const result: CheckResult = { findings: [], observations: [] };
    const candidates = ctx.changedFiles.filter((f) => f.status !== 'D').map((f) => f.path);
    const files = selectPaths(candidates, new GlobSet(config.globs), new GlobSet(config.excludeGlobs));
    if (files.length === 0) return result;
    const added = await addedLines(ctx.checkoutDir, ctx.baseSha, ctx.headSha, files);
    for (const file of files) {
      const hits = (added.get(file) ?? []).filter((l) => l.text.includes(EM_DASH));
      if (hits.length === 0) continue;
      const count = hits.reduce((n, l) => n + l.text.split(EM_DASH).length - 1, 0);
      const lines = hits.slice(0, 10).map((l) => l.line).join(', ');
      result.findings.push(toolFinding({
        severity: 'minor',
        category: 'style',
        file,
        line: hits[0]!.line,
        title: `Em dash in user-facing text (${count})`,
        problem: `The branch adds ${count} em dash${count === 1 ? '' : 'es'} to this user-facing file, on line${hits.length === 1 ? '' : 's'} ${lines}${hits.length > 10 ? ', ...' : ''}.`,
        why: 'Repository rule: no em dashes in new or edited user-facing copy.',
        suggestion: 'Use a comma, a colon, parentheses, or two sentences instead.',
        snippet: hits[0]!.text.trim().slice(0, 300),
      }));
    }
    return result;
  },
};
