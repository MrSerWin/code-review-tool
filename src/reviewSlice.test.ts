import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLensPrompt, buildSynthesisPrompt, normalize, type PromptVars, type SliceInfo } from './reviewRunner.js';
import type { Finding, ReviewOutput } from './types.js';

/** A branch reviewed as one slice of a ticket: the verdict judges its code, not the ticket. */

function finding(severity: Finding['severity']): Finding {
  return {
    severity, category: 'correctness', file: 'a.py', line: 1, end_line: null, title: 't', problem: 'p', why: '',
    suggestion: '', snippet: null, kind: 'diff', cause_file: null, cause_line: null, hunk: null, lens: null,
  };
}

function output(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    summary: 's',
    requirements: [
      { text: 'Export endpoint', status: 'met', evidence: 'a.py:1' },
      { text: 'Export button', status: 'missing', evidence: 'belongs to the frontend slice' },
    ],
    findings: [],
    observations: [],
    verdict: 'changes_requested',
    can_merge: false,
    conclusion: '',
    ...overrides,
  };
}

test('a slice is not held back by requirements another slice covers', () => {
  const slice = normalize(output(), { slice: true });
  assert.equal(slice.verdict, 'approve');
  assert.equal(slice.can_merge, true);
  assert.equal(slice.code_verdict, 'approve');
  assert.equal(slice.code_can_merge, true);

  // Without a group the requirement checklist still gates the merge, as before; the code verdict does not.
  const lone = normalize(output());
  assert.equal(lone.verdict, 'changes_requested');
  assert.equal(lone.can_merge, false);
  assert.equal(lone.code_verdict, 'approve');
  assert.equal(lone.code_can_merge, true);
  const loneApprove = normalize(output({ verdict: 'approve', can_merge: true }));
  assert.equal(loneApprove.verdict, 'changes_requested');
});

test('the code verdict comes from the findings alone', () => {
  const major = normalize(output({ findings: [finding('major'), finding('nit')], verdict: 'approve', can_merge: true }), { slice: true });
  assert.equal(major.code_verdict, 'changes_requested');
  assert.equal(major.can_merge, false);
  const blocked = normalize(output({ findings: [finding('blocker')], verdict: 'blocked' }), { slice: true });
  assert.equal(blocked.code_verdict, 'blocked');
  // "blocked" for missing requirements alone is not a code verdict.
  const noBlocker = normalize(output({ findings: [finding('minor')], verdict: 'blocked' }), { slice: true });
  assert.equal(noBlocker.code_verdict, 'approve');
  assert.equal(noBlocker.verdict, 'approve');
});

const slice: SliceInfo = {
  ticketKey: 'ABC-1',
  members: [
    { repo: 'svc', branch: 'feat/abc-1-a', parent: 'main', self: false },
    { repo: 'svc', branch: 'feat/abc-1-b', parent: 'feat/abc-1-a', self: true },
    { repo: 'web', branch: 'feat/abc-1-ui', parent: 'main', self: false },
  ],
};

function vars(withSlice: boolean): PromptVars {
  return {
    ticket: null,
    review: {
      id: 1, repo: 'svc', branch: 'feat/abc-1-b', reviewer: 'claude', model: 'opus',
      ticket_key: 'ABC-1', ticket_title: 'Export', ticket_url: null, ticket_body: 'Export risks with a button.',
    },
    checkout: { dir: '/x', headSha: 'h', baseSha: 'b', filesChanged: 0, additions: 0, deletions: 0, changedFiles: [] },
    previousFindings: [],
    ...(withSlice ? { slice } : {}),
  };
}

test('prompts of a slice name the other slices; prompts of a lone branch are unchanged', async () => {
  const lens = await buildLensPrompt('correctness', vars(true));
  assert.match(lens, /## How this ticket is split/);
  assert.match(lens, /Ticket ABC-1 is implemented in 3 branches \(slices\)/);
  assert.match(lens, /- `svc#feat\/abc-1-b` \(diffed against `feat\/abc-1-a`\) <- this review/);
  assert.match(lens, /- `web#feat\/abc-1-ui` \(diffed against `main`\)\n/);
  assert.match(lens, /never report it as a finding/);
  const synthesis = await buildSynthesisPrompt(vars(true), '');
  assert.match(synthesis, /# This branch is one slice of the ticket/);
  assert.match(synthesis, /A ticket requirement this branch does not implement is NOT a finding/);

  const loneLens = await buildLensPrompt('correctness', vars(false));
  const loneSynthesis = await buildSynthesisPrompt(vars(false), '');
  for (const p of [loneLens, loneSynthesis]) {
    assert.doesNotMatch(p, /How this ticket is split|one slice of the ticket|\{\{/);
  }
});
