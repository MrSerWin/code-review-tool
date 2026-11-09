import { listCommits } from './git.js';
import { toolFinding, type CheckResult, type ToolCheck } from './types.js';

const AI_TRAILER = /^Co-Authored-By:.*(Claude|Anthropic)/im;
const AI_FOOTER = /Generated with \[?Claude/i;

export const commitIdentity: ToolCheck<{ allowedEmails: string[] }> = {
  id: 'commit-identity',
  async run(ctx, config): Promise<CheckResult> {
    const result: CheckResult = { findings: [], observations: [] };
    const allowed = new Set(config.allowedEmails.map((e) => e.trim().toLowerCase()));
    const synthetic = new Set(ctx.syntheticCommits);
    const commits = (await listCommits(ctx.checkoutDir, ctx.baseSha, ctx.headSha)).filter((c) => !synthetic.has(c.sha));
    const wrongAuthor = commits.filter((c) => !allowed.has(c.email.toLowerCase()));
    const attributed = commits.filter((c) => AI_TRAILER.test(c.message) || AI_FOOTER.test(c.message));
    const short = (list: typeof commits, withEmail: boolean) =>
      list.slice(0, 20).map((c) => (withEmail ? `${c.sha.slice(0, 9)} (${c.email || 'no email'})` : c.sha.slice(0, 9))).join(', ') +
      (list.length > 20 ? `, and ${list.length - 20} more` : '');
    if (wrongAuthor.length > 0) {
      result.findings.push(toolFinding({
        severity: 'minor',
        category: 'style',
        title: `${wrongAuthor.length} commit${wrongAuthor.length === 1 ? '' : 's'} by an author outside the allow list`,
        problem: `Commits ${short(wrongAuthor, true)} are authored by an address that is not allowed for this repository (${config.allowedEmails.join(', ')}).`,
        why: 'Repository rule: every commit uses the configured work identity.',
        suggestion: 'Rewrite the author of these commits (`git rebase --exec "git commit --amend --no-edit --reset-author"` with the right identity) before the PR.',
      }));
    }
    if (attributed.length > 0) {
      result.findings.push(toolFinding({
        severity: 'minor',
        category: 'style',
        title: `${attributed.length} commit message${attributed.length === 1 ? '' : 's'} with an AI attribution`,
        problem: `Commits ${short(attributed, false)} carry a Claude or Anthropic co-author trailer or a "Generated with Claude" line.`,
        why: 'Repository rule: commit messages carry no AI attribution.',
        suggestion: 'Reword these commits without the trailer before the PR.',
      }));
    }
    return result;
  },
};
