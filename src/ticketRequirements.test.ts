import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import type { ReviewerDefinition } from './reviewers/types.js';
import type { CheckoutResult, TicketInfo } from './types.js';

/**
 * The stored requirement checklist of a ticket: the store, the derivation pass
 * with a stand-in reviewer, synthesis and coverage by id, and the routes.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-ticket-reqs-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc,web';

const store = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const reqs = await import('./ticketRequirements.js');
const derivation = await import('./requirements.js');
const runner = await import('./reviewRunner.js');
const coverage = await import('./coverage.js');
const { ticketGroupRoutes } = await import('./routes/ticketGroups.js');
const { reviewRoutes } = await import('./routes/reviews.js');

const prompts = path.join(root, 'prompts');
fs.mkdirSync(prompts);

test.after(() => {
  for (const pgid of runner.liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in reviewer CLI: writes each prompt to its own file, answers by prompt kind. */
function reviewer(answers: Record<string, unknown>, opts: { delaySec?: number; fail?: boolean } = {}): ReviewerDefinition {
  const script = `
printf '%s' "$1" > "$PROMPT_DIR/$$.txt"
${opts.delaySec ? `sleep ${opts.delaySec}` : ''}
${opts.fail ? 'exit 3' : ''}
case "$1" in
  *"turn one ticket into a checklist"*) printf '%s\\n' "$DERIVE_JSON" ;;
  *"Your job: synthesis"*) printf '%s\\n' "$SYNTH_JSON" ;;
  *"judge whether one ticket is fully"*) printf '%s\\n' "$COVERAGE_JSON" ;;
  *) printf '%s\\n' '{"findings":[],"observations":[]}' ;;
esac
`;
  return {
    name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', bin: '/bin/sh',
    buildArgs: (prompt) => ['-c', script, 'sh', prompt],
    buildChildEnv: () => ({
      PATH: process.env.PATH, PROMPT_DIR: prompts,
      DERIVE_JSON: JSON.stringify(answers.derive ?? {}),
      SYNTH_JSON: JSON.stringify(answers.synthesis ?? {}),
      COVERAGE_JSON: JSON.stringify(answers.coverage ?? {}),
    }),
    parseStreamLine: (line) => ({ result: line }),
    listModels: async () => [],
    isAvailable: () => true,
    describeFailure: () => null,
  };
}

function sentPrompts(): string[] {
  return fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
}

function clearPrompts(): void {
  for (const f of fs.readdirSync(prompts)) fs.rmSync(path.join(prompts, f));
}

const ticket: TicketInfo = {
  provider: 'linear', key: 'REQ-1', title: 'Export risks', url: 'https://tracker.example/REQ-1',
  body: 'Users can export risks to Excel from the risk list.', state: 'Todo', branchName: null,
  comments: [{ author: 'Lead', body: 'Decision: CSV instead of Excel.' }], attachmentUrls: [],
};

test('pasted requirements split into items: list entries, or one per line', () => {
  assert.deepEqual(reqs.splitRequirementsText('- Export to CSV\n  with a header row\n* Audit the export\n\n1. Admins only'), [
    'Export to CSV with a header row', 'Audit the export', 'Admins only',
  ]);
  assert.deepEqual(reqs.splitRequirementsText('## Decisions\nCSV is enough.\nNo Excel.'), ['CSV is enough.', 'No Excel.']);
  assert.equal(reqs.normalizeRequirementText('  - Export   to CSV. '), reqs.normalizeRequirementText('export to csv'));
});

test('user items are deduplicated by normalised text; a removed one comes back with its id', () => {
  const first = reqs.addUserRequirements('DUP-1', ['Export to CSV', 'export  to csv.', 'Audit the export']);
  assert.deepEqual(first.added.map((r) => r.text), ['Export to CSV', 'Audit the export']);
  assert.equal(first.skipped, 1);
  assert.equal(reqs.addUserRequirements('DUP-1', ['- Export to CSV']).skipped, 1);
  const [csv, audit] = reqs.activeChecklist('DUP-1');
  reqs.setTicketRequirements('DUP-1', [{ id: audit!.id, text: audit!.text }]);
  assert.deepEqual(reqs.activeChecklist('DUP-1').map((r) => r.id), [audit!.id]);
  const back = reqs.addUserRequirements('DUP-1', ['Export to CSV']);
  assert.equal(back.added[0]!.id, csv!.id);
  assert.deepEqual(reqs.activeChecklist('DUP-1').map((r) => r.text), ['Audit the export', 'Export to CSV']);
});

test('a re-derivation replaces derived items, keeps user items and the ids of unchanged texts', () => {
  reqs.addUserRequirements('DER-1', ['Decision: CSV only']);
  const one = reqs.replaceDerivedRequirements('DER-1', ['Export risks', 'Add a button', 'decision: csv only'], ['Manual QA']);
  assert.deepEqual(one.map((r) => [r.text, r.source]), [
    ['Export risks', 'derived'], ['Add a button', 'derived'], ['Decision: CSV only', 'user'],
  ]);
  assert.deepEqual(reqs.requirementNotes('DER-1'), ['Manual QA']);
  assert.ok(ticketStore.getTicketGroup('DER-1')!.requirements_derived_at);
  const exportId = one[0]!.id;
  const two = reqs.replaceDerivedRequirements('DER-1', ['Export risks.', 'Write tests'], []);
  assert.equal(two[0]!.id, exportId);
  assert.deepEqual(two.map((r) => r.text), ['Export risks.', 'Write tests', 'Decision: CSV only']);
  const removed = reqs.listTicketRequirements('DER-1', { includeRemoved: true }).filter((r) => r.state === 'removed');
  assert.deepEqual(removed.map((r) => r.text), ['Add a button']);
});

test('setting the whole list: reorder, edit (a reworded derived item becomes a user item), add, remove', () => {
  const [a, b, c] = reqs.replaceDerivedRequirements('SET-1', ['A one', 'B two', 'C three'], []);
  const out = reqs.setTicketRequirements('SET-1', [{ id: c!.id, text: 'C three' }, { id: a!.id, text: 'A one, reworded' }, { text: 'D four' }]);
  assert.deepEqual(out.map((r) => [r.text, r.source, r.position]), [
    ['C three', 'derived', 0], ['A one, reworded', 'user', 1], ['D four', 'user', 2],
  ]);
  assert.equal(reqs.getTicketRequirement(b!.id)!.state, 'removed');
  assert.throws(() => reqs.setTicketRequirements('OTHER-1', [{ id: a!.id, text: 'x' }]), /not an item of OTHER-1/);
  assert.throws(() => reqs.setTicketRequirements('SET-1', [{ id: c!.id, text: 'x' }, { id: c!.id, text: 'y' }]), /listed twice/);
  // Replacing user items keeps the derived ones.
  const replaced = reqs.replaceUserRequirements('SET-1', ['E five']);
  assert.deepEqual(replaced.map((r) => r.text), ['C three', 'E five']);
});

test('the derivation pass: ticket comments and user items in the prompt, an empty workspace, one run for concurrent callers', async () => {
  clearPrompts();
  reqs.addUserRequirements('REQ-1', ['Decision: CSV instead of Excel']);
  const fake = reviewer({
    derive: {
      requirements: ['Export the risk list to CSV', 'Add an export button to the risk list', 'Decision: CSV instead of Excel'],
      not_verifiable_notes: ['Manual QA by the customer'],
    },
  }, { delaySec: 1 });
  const logs: string[] = [];
  const opts = { reviewerDefinition: fake, ticket, onLog: (_l: string, m: string) => logs.push(m) };
  const [x, y] = await Promise.all([
    derivation.ensureTicketRequirements('REQ-1', opts),
    derivation.ensureTicketRequirements('REQ-1', opts),
  ]);
  assert.deepEqual(x!.map((r) => r.id), y!.map((r) => r.id));
  assert.deepEqual(x!.map((r) => [r.text, r.source]), [
    ['Export the risk list to CSV', 'derived'],
    ['Add an export button to the risk list', 'derived'],
    ['Decision: CSV instead of Excel', 'user'],
  ]);
  const sent = sentPrompts();
  assert.equal(sent.length, 1, 'one derivation for both callers');
  assert.match(sent[0]!, /\*\*Lead\*\*: Decision: CSV instead of Excel\./);
  assert.match(sent[0]!, /# Items already on the checklist\n\nThese were added by hand[\s\S]*- Decision: CSV instead of Excel/);
  assert.ok(logs.some((m) => /waiting for the running derivation/.test(m)));
  assert.deepEqual(reqs.requirementNotes('REQ-1'), ['Manual QA by the customer']);
  // Derived once: the next call reads the stored list without a pass.
  await derivation.ensureTicketRequirements('REQ-1', opts);
  assert.equal(sentPrompts().length, 1);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR!, 'requirements', 'REQ-1')), [], 'workspace removed');
});

test('a failed derivation falls back (null) and is retried by the next review', async () => {
  const failing = reviewer({}, { fail: true });
  const logs: string[] = [];
  const out = await derivation.ensureTicketRequirements('FAIL-1', {
    reviewerDefinition: failing, ticket: { ...ticket, key: 'FAIL-1' }, onLog: (_l, m) => logs.push(m),
  });
  assert.equal(out, null);
  assert.ok(logs.some((m) => /could not derive the checklist of FAIL-1/.test(m)));
  assert.equal(ticketStore.getTicketGroup('FAIL-1')?.requirements_derived_at ?? null, null);
  assert.match(derivation.derivationError('FAIL-1')!.error, /exited with code 3/);
});

// --- synthesis and coverage by id ------------------------------------------------

const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const gitEnv = {
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'src/export.py'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(repo, 'src/export.py'), 'a\nb\nc\n');
git('commit', '-q', '-am', 'export');
const checkout: CheckoutResult = {
  dir: repo, headSha: git('rev-parse', 'HEAD').trim(), baseSha, filesChanged: 1, additions: 2, deletions: 0,
  changedFiles: ['src/export.py'],
  changedFileList: [{ path: 'src/export.py', status: 'M', old_path: null, additions: 2, deletions: 0 }],
};

test('synthesis with a stored checklist: statuses by id in the checklist order, proposals kept apart', async () => {
  clearPrompts();
  const checklist = reqs.activeChecklist('REQ-1').map((r) => ({ id: r.id, text: r.text }));
  const [csv, button, decision] = checklist;
  const fake = reviewer({
    synthesis: {
      summary: 'Adds the CSV export.',
      requirements: [
        { id: `R${button!.id}`, text: 'reworded by the model', status: 'missing', evidence: 'belongs to the web slice' },
        { id: csv!.id, status: 'met', evidence: 'src/export.py:2' },
        { id: 999, status: 'met', evidence: 'not on the list' },
      ],
      proposed_requirements: [
        { text: 'Audit every export', reason: 'Comment 1 mentions an audit trail' },
        'Export the risk list to CSV',
      ],
      findings: [], observations: [], verdict: 'approve', can_merge: true, conclusion: 'Fine.',
    },
  });
  const out = await runner.runReview(
    { id: 1, repo: 'svc', branch: 'feat/req-1', reviewer: 'claude', model: 'fake', ticket_key: 'REQ-1', ticket_title: 'Export', ticket_url: null, ticket_body: 'Export.' },
    checkout, ticket, () => {},
    {
      reviewerDefinition: fake, timeoutMs: 30_000, checklist,
      slice: { ticketKey: 'REQ-1', members: [{ repo: 'svc', branch: 'feat/req-1', parent: 'main', self: true }] },
    },
  );
  assert.deepEqual(out.requirements, [
    { requirement_id: csv!.id, text: csv!.text, status: 'met', evidence: 'src/export.py:2' },
    { requirement_id: button!.id, text: button!.text, status: 'missing', evidence: 'belongs to the web slice' },
    { requirement_id: decision!.id, text: decision!.text, status: 'missing', evidence: 'The review did not evaluate this item.' },
  ]);
  assert.deepEqual(out.proposed_requirements, [{ text: 'Audit every export', reason: 'Comment 1 mentions an audit trail' }]);
  assert.equal(out.verdict, 'approve');
  const synthesisPrompt = sentPrompts().find((p) => p.includes('Your job: synthesis'))!;
  assert.match(synthesisPrompt, new RegExp(`\`R${csv!.id}\` Export the risk list to CSV`));
  assert.match(synthesisPrompt, /Evaluate EXACTLY these items/);
  assert.doesNotMatch(synthesisPrompt, /Turn it into a numbered list/);

  // Stored per review by id; the text stays for reading old rows.
  const row = store.createReview({ repo: 'svc', branch: 'feat/req-1', base_branch: 'main', ticket_key: 'REQ-1', status: 'done' });
  store.replaceRequirements(row.id, out.requirements);
  assert.deepEqual(store.getRequirements(row.id).map((r) => r.requirement_id), [csv!.id, button!.id, decision!.id]);
});

test('synthesis without a checklist still derives, and keeps the comment rule', async () => {
  const step = runner.renderRequirementsStep(undefined);
  assert.match(step, /decision in the ticket comments, or an added\n {3}requirement, replaced the original text, the decision wins/);
  const prompt = await runner.buildSynthesisPrompt({
    ticket, previousFindings: [], checkout,
    review: { id: 2, repo: 'svc', branch: 'x', reviewer: 'claude', model: 'fake', ticket_key: 'REQ-1', ticket_title: null, ticket_url: null, ticket_body: null },
  }, '');
  assert.match(prompt, /Turn it into a numbered list/);
});

test('coverage with a stored checklist: one entry per id, in order, unknown ids dropped, missing ones filled', async () => {
  const checklist = reqs.activeChecklist('REQ-1').map((r) => ({ id: r.id, text: r.text }));
  const [csv, button, decision] = checklist;
  const branch = {
    member: { id: 1, ticket_key: 'REQ-1', repo: 'svc', branch: 'feat/req-1', source: 'github', parent_branch: 'main', parent_reason: 'default', default_branch: 'main', position: 0, pr_number: null, created_at: '', updated_at: '' },
    depth: 0,
    review: { id: 42 } as never,
    latest: null,
    files: [{ review_id: 42, path: 'src/export.py', status: 'M', old_path: null, additions: 2, deletions: 0, ord: 0 }],
    requirements: [{ id: 1, review_id: 42, text: csv!.text, status: 'met', evidence: 'src/export.py:2', ord: 0, requirement_id: csv!.id }],
  } as unknown as import('./coverage.js').CoverageBranchInput;
  const parsed = coverage.checklistCoverageOutputSchema.parse({
    summary: 's',
    requirements: [
      { id: `R${decision!.id}`, status: 'covered', branches: [{ repo: 'svc', branch: 'feat/req-1', evidence: ['src/export.py:2'] }] },
      { id: csv!.id, text: 'model wording', status: 'covered', branches: [{ repo: 'svc', branch: 'feat/req-1', evidence: [{ file: 'src/export.py', line: 2 }] }] },
      { id: 777, status: 'covered', branches: [] },
    ],
  });
  const logs: string[] = [];
  const out = coverage.normalizeCoverage(parsed as never, [branch], () => (file, line) => ({ file, line, anchor_status: 'ok' }), (_l, m) => logs.push(m), checklist);
  assert.deepEqual(out.map((r) => [r.requirement_id, r.text, r.status]), [
    [csv!.id, csv!.text, 'covered'],
    [button!.id, button!.text, 'missing'],
    [decision!.id, decision!.text, 'covered'],
  ]);
  assert.ok(logs.some((m) => /id 777/.test(m)));
  assert.ok(logs.some((m) => new RegExp(`requirement id ${button!.id}; marked missing`).test(m)));
  // The prompt lists the checklist with ids, and each branch's own status by id.
  const prompt = await coverage.buildCoveragePrompt({
    key: 'REQ-1', ticket: { key: 'REQ-1', title: null, url: null, text: 'Export.' }, branches: [branch], checklist,
  });
  assert.match(prompt, /Take the stored checklist/);
  assert.match(prompt, new RegExp(`\\[met\\] \`R${csv!.id}\` Export the risk list to CSV`));
  // A checklist answer without ids is refused (and retried by runPass).
  assert.equal(coverage.checklistCoverageOutputSchema.safeParse({ requirements: [{ text: 'x', status: 'covered' }] }).success, false);
  assert.equal(coverage.coverageOutputSchema.safeParse({ requirements: [{ id: null, status: 'covered' }] }).success, false);
});

// --- routes ---------------------------------------------------------------------------

test('routes: read, set, add, derive; pasted requirements deduplicated', async () => {
  const derived: { key: string; opts: unknown }[] = [];
  const app = Fastify({ logger: false });
  await app.register(ticketGroupRoutes, {
    deps: {
      derive: (key: string, opts: unknown) => {
        derived.push({ key, opts });
        const done = Promise.resolve().then(() => {
          reqs.replaceDerivedRequirements(key, ['Derived again'], ['QA']);
          return { items: reqs.activeChecklist(key), notes: ['QA'], reviewer: 'claude', model: 'fake' };
        });
        return { started: true, done };
      },
    },
  });
  await app.register(reviewRoutes);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/ticket-groups/NOPE-1/requirements' })).statusCode, 404);
    const got = await app.inject({ method: 'GET', url: '/api/ticket-groups/REQ-1/requirements' });
    assert.equal(got.statusCode, 200);
    const body = got.json();
    assert.equal(body.items.length, 3);
    assert.deepEqual(body.not_verifiable_notes, ['Manual QA by the customer']);
    assert.equal(body.deriving, false);

    const [first, second] = body.items as { id: number; text: string }[];
    const put = await app.inject({
      method: 'PUT', url: '/api/ticket-groups/REQ-1/requirements',
      payload: { items: [{ id: second!.id, text: second!.text }, { id: first!.id, text: first!.text }, { text: 'Audit every export' }] },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().items.map((r: { text: string }) => r.text), [second!.text, first!.text, 'Audit every export']);
    const add = await app.inject({ method: 'PUT', url: '/api/ticket-groups/REQ-1/requirements', payload: { add: ['audit every export.', 'Admins only'] } });
    assert.deepEqual(add.json().items.map((r: { text: string }) => r.text).slice(-2), ['Audit every export', 'Admins only']);
    const bad = await app.inject({ method: 'PUT', url: '/api/ticket-groups/REQ-1/requirements', payload: { items: [{ id: 999_999, text: 'x' }] } });
    assert.equal(bad.statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/ticket-groups/REQ-1/requirements', payload: { items: [{ text: '' }] } })).statusCode, 400);

    // Derive: the reviewer and model of the latest review by default.
    store.createReview({ repo: 'svc', branch: 'feat/req-1', base_branch: 'main', ticket_key: 'REQ-1', reviewer: 'claude', model: 'sonnet' });
    const derive = await app.inject({ method: 'POST', url: '/api/tickets/REQ-1/requirements/derive', payload: { wait: true } });
    assert.equal(derive.statusCode, 200, derive.body);
    assert.deepEqual(derived.at(-1)!.opts, { reviewer: 'claude', model: 'sonnet' });
    // Derived items are replaced, user items stay after them.
    assert.deepEqual(derive.json().items.map((r: { text: string; source: string }) => [r.text, r.source]), [
      ['Derived again', 'derived'], ['Audit every export', 'user'], ['Admins only', 'user'],
    ]);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tickets/NOPE-1/requirements/derive', payload: {} })).statusCode, 404);

    // Pasted requirements given twice, partly on the list already: only the new one is added.
    const before = reqs.activeChecklist('REQ-1').length;
    const pasted = reqs.splitRequirementsText('- Admins only\n- Rate limit the export');
    reqs.addUserRequirements('REQ-1', [...pasted, ...pasted]);
    assert.equal(reqs.activeChecklist('REQ-1').length, before + 1);
  } finally {
    await app.close();
  }
});

test('the review payload: statuses by id, the current checklist, and the proposals', async () => {
  const app = Fastify({ logger: false });
  await app.register(reviewRoutes);
  try {
    const item = reqs.activeChecklist('REQ-1')[0]!;
    const row = store.createReview({
      repo: 'svc', branch: 'feat/req-1', base_branch: 'main', ticket_key: 'REQ-1', status: 'done',
      proposed_requirements: JSON.stringify([{ text: 'Audit', reason: 'r' }]),
    });
    store.replaceRequirements(row.id, [{ requirement_id: item.id, text: item.text, status: 'met', evidence: 'a.py:1' }]);
    const res = (await app.inject({ method: 'GET', url: `/api/reviews/${row.id}` })).json();
    assert.equal(res.requirements[0].requirement_id, item.id);
    assert.deepEqual(res.proposed_requirements, [{ text: 'Audit', reason: 'r' }]);
    assert.equal(res.ticket_group.key, 'REQ-1');
    assert.ok(res.ticket_group.checklist.some((c: { id: number }) => c.id === item.id));
  } finally {
    await app.close();
  }
});
