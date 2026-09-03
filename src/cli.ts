import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';
import { enqueueReview, recoverInterrupted } from './queue.js';
import {
  getReviewer, listReviewersWithModels, notInstalledMessage, REVIEWER_NAMES,
} from './reviewers/index.js';
import { resolveTargets } from './resolver.js';
import type { ResolvedTarget, TicketInfo } from './types.js';

const HELP = `code-review-tool — run a read-only code review from the terminal.

Usage:
  tsx src/cli.ts <input> [--reviewer <name>] [--model <name>] [--quiet] [--requirements <text>]
  tsx src/cli.ts --list-models [reviewer]
  tsx src/cli.ts --help

Input can be:
  ABC-123                                          a ticket key of a configured tracker
  jira:ABC-123                                     the same key, forced to one tracker
  https://github.com/<org>/<repo>/pull/12          a pull request URL
  https://github.com/<org>/<repo>/tree/<branch>    a branch URL
  my-service#feature/abc-123-example               repo#branch

Options:
  --reviewer <name>
                   one of: ${REVIEWER_NAMES.join(', ')} — Claude Code,
                   Cursor Agent, OpenAI Codex, and the Grok CLI;
                   default: ${config.defaultReviewer}
  --model <name>   model for the chosen reviewer (default depends on reviewer)
  --list-models [reviewer]
                   list the reviewers, whether their CLI is installed, and the
                   models each one offers, then exit
  --requirements <text>
                   review against these requirements instead of a ticket
  --quiet          only print the final result and report paths
  -h, --help       show this help

Output:
  Progress is streamed to stdout while each review runs. At the end the path of
  every written report is printed, relative to DATA_DIR (${config.DATA_DIR}).

Exit codes:
  0  every review finished and every review says the branch can be merged
     (all ticket requirements met, no blocker and no major finding)
  1  at least one review failed, was cancelled, or reported can_merge = false
  2  bad usage, or the input could not be resolved to any branch

The reviewed code is never modified.`;

interface Args {
  input: string;
  listModels?: string | null;
  reviewer?: string;
  model?: string;
  requirementsText?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = { input: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') return null;
    if (arg === '--quiet') { args.quiet = true; continue; }
    if (arg === '--list-models') {
      // The optional value is a reviewer name, never another option.
      const next = argv[i + 1];
      args.listModels = next && !next.startsWith('-') ? next : null;
      if (args.listModels) i += 1;
      continue;
    }
    if (arg === '--reviewer') { args.reviewer = argv[i + 1]; i += 1; continue; }
    if (arg === '--model') { args.model = argv[i + 1]; i += 1; continue; }
    if (arg === '--requirements') { args.requirementsText = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (args.input) throw new Error('Only one input is supported.');
    args.input = arg;
  }
  if (args.listModels !== undefined) return args;
  if (!args.input) return null;
  return args;
}

async function main(): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\n' + HELP);
    return 2;
  }
  if (!args) {
    console.log(HELP);
    return process.argv.length > 2 ? 0 : 2;
  }

  if (args.listModels !== undefined) return printModels(args.listModels);

  let reviewer;
  try {
    reviewer = getReviewer(args.reviewer);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (!reviewer.isAvailable()) {
    console.error(`${notInstalledMessage(reviewer)}. Install it, or pick another --reviewer.`);
    return 2;
  }

  recoverInterrupted();

  let resolved: { ticket: TicketInfo | null; targets: ResolvedTarget[] };
  try {
    resolved = await resolveTargets(args.input, { requirementsText: args.requirementsText });
  } catch (err) {
    console.error(`Could not resolve "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (resolved.targets.length === 0) {
    console.error(`No branches found for "${args.input}".`);
    return 2;
  }

  if (resolved.ticket) {
    const label = resolved.ticket.key || 'Pasted requirements';
    console.log(`Ticket (${resolved.ticket.provider}): ${label} — ${resolved.ticket.title}`);
  }
  console.log(`Branches to review (${resolved.targets.length}):`);
  for (const t of resolved.targets) console.log(`  - ${t.repo}#${t.branch} (base ${t.baseBranch})`);
  console.log('');

  const ids: number[] = [];
  for (const target of resolved.targets) {
    const review = db.createReview({
      ticket_key: resolved.ticket?.key || null,
      ticket_title: resolved.ticket?.title || null,
      ticket_url: resolved.ticket?.url || null,
      ticket_body: resolved.ticket?.body ?? null,
      repo: target.repo,
      branch: target.branch,
      base_branch: target.baseBranch,
      pr_number: target.prNumber,
      reviewer: reviewer.name,
      model: args.model ?? reviewer.defaultModel,
    });
    ids.push(review.id);
    enqueueReview(review.id);
  }

  const failed = await follow(ids, args.quiet);

  console.log('\n=== Results ===');
  let bad = 0;
  for (const id of ids) {
    const review = db.getReview(id);
    if (!review) { bad += 1; continue; }
    const label = `${review.repo}#${review.branch}`;
    if (review.status !== 'done') {
      bad += 1;
      console.log(`  ${label}: ${review.status.toUpperCase()} — ${review.error ?? 'no details'}`);
      continue;
    }
    if (!review.can_merge) bad += 1;
    const verdict = review.verdict ?? 'unknown';
    const met = `${review.requirements_met ?? 0}/${review.requirements_total ?? 0} requirements met`;
    console.log(`  ${label}: ${verdict} — ${met}, ${review.blocking_count ?? 0} blocking finding(s)`);
    if (review.report_path) {
      console.log(`      report: ${path.join(config.DATA_DIR, review.report_path)}`);
    }
  }
  return bad > 0 || failed ? 1 : 0;
}

/** Print every reviewer, whether its CLI is installed, and the models it offers. */
async function printModels(only: string | null): Promise<number> {
  if (only !== null) {
    try {
      getReviewer(only);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }
  const reviewers = await listReviewersWithModels();
  for (const r of reviewers) {
    if (only !== null && r.name !== only.toLowerCase()) continue;
    const state = r.available ? '' : ' — not installed';
    const isDefault = r.name === config.defaultReviewer ? ' (default reviewer)' : '';
    console.log(`${r.name} — ${r.label} [${r.bin}]${state}${isDefault}`);
    console.log(`  default model: ${r.defaultModel}`);
    if (r.models.length === 0) console.log('  models: (none reported)');
    else for (const m of r.models) console.log(`    ${m.id}${m.label && m.label !== m.id ? ` — ${m.label}` : ''}`);
    console.log('');
  }
  return 0;
}

/** Poll the log table until every review reaches a terminal status. */
async function follow(ids: number[], quiet: boolean): Promise<boolean> {
  const printed = new Map<number, number>(ids.map((id) => [id, 0]));
  const terminal = new Set(['done', 'failed', 'cancelled']);
  let sawFailure = false;

  for (;;) {
    let allDone = true;
    for (const id of ids) {
      if (!quiet) {
        const logs = db.getLogs(id);
        const already = printed.get(id) ?? 0;
        for (const entry of logs.slice(already)) {
          const prefix = ids.length > 1 ? `[#${id}] ` : '';
          const mark = entry.level === 'error' ? '!' : entry.level === 'warn' ? '~' : ' ';
          console.log(`${prefix}${mark} ${entry.message}`);
        }
        printed.set(id, logs.length);
      }
      const review = db.getReview(id);
      if (!review || !terminal.has(review.status)) allDone = false;
      else if (review.status !== 'done') sawFailure = true;
    }
    if (allDone) return sawFailure;
    await sleep(700);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
