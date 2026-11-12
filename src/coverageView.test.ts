import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeRow, attributionCounts, attributionSummary, branchCoverage, coverageVerdict, openRequirements, PENDING_LABEL,
  ticketCoverageBadge, whereLabel, type AttributableRow,
} from './coverageView.js';
import type { CoverageRequirement } from './types.js';

/**
 * Where a slice's checklist rows live once the ticket coverage is known, and
 * the verdict math with `already_on_base`.
 */
const HERE = { repo: 'web', branch: 'feat/x-ui' };
const OTHER = { repo: 'svc', branch: 'feat/x-api' };

const req = (id: number, status: CoverageRequirement['status'], branches: CoverageRequirement['branches'] = [], note = ''): CoverageRequirement => ({
  requirement_id: id, text: `R${id} text`, status, note, branches,
});
const share = (b: { repo: string; branch: string }, reviewId: number, status: 'covered' | 'partial' = 'covered') => ({
  ...b, review_id: reviewId, status, note: '', evidence: [],
});
const row = (id: number, status: AttributableRow['status'], evidence: string | null = null): AttributableRow => ({
  requirement_id: id, text: `R${id} text`, status, evidence,
});

const coverage: CoverageRequirement[] = [
  req(1, 'covered', [share(HERE, 20)]),
  req(2, 'covered', [share(OTHER, 10)]),
  req(3, 'already_on_base'),
  req(4, 'missing', [], 'No branch adds the frontend test.'),
  req(5, 'partial', [share(OTHER, 10, 'partial')], 'can_resolve is not exposed yet.'),
  req(6, 'missing'),
  req(7, 'covered', [share(HERE, 20, 'partial'), share(OTHER, 10)]),
];

test('attribution with a fresh coverage: this branch, another slice (with its review), base, nowhere, partial, not verifiable', () => {
  const rows = [
    row(1, 'met'), row(2, 'missing'), row(3, 'missing'), row(4, 'missing'), row(5, 'missing'), row(6, 'not_verifiable', 'Runs the suite'),
    row(7, 'partial'),
  ];
  const out = rows.map((r) => attributeRow(r, coverage, HERE.repo, HERE.branch));
  assert.deepEqual(out.map((a) => a.state), [
    'this_branch', 'other_branch', 'already_on_base', 'nowhere', 'partial', 'not_verifiable', 'this_branch',
  ]);
  assert.equal(out[0]!.label, 'in this branch');
  assert.equal(out[1]!.label, 'in svc#feat/x-api');
  assert.deepEqual(out[1]!.branches, [{ repo: 'svc', branch: 'feat/x-api', review_id: 10 }]);
  assert.equal(out[2]!.label, 'already on base');
  assert.equal(out[3]!.label, 'nowhere');
  assert.equal(out[3]!.note, 'No branch adds the frontend test.');
  assert.equal(out[4]!.note, 'can_resolve is not exposed yet.');
  assert.equal(out[5]!.label, 'not verifiable');

  const counts = attributionCounts(out);
  assert.deepEqual(counts, {
    this_branch: 2, other_branch: 1, already_on_base: 1, not_verifiable: 1, nowhere: 1, partial: 1, pending: 0,
  });
  assert.equal(attributionSummary(counts, true),
    '2 in this slice, 1 in other slices, 1 already on base, 1 nowhere, 1 partial, 1 not verifiable');
});

test('attribution while the coverage is pending or stale: what is not here stays neutral, never nowhere', () => {
  const rows = [row(1, 'met'), row(2, 'missing'), row(5, 'partial', 'half'), row(6, 'not_verifiable')];
  const out = rows.map((r) => attributeRow(r, null, HERE.repo, HERE.branch));
  assert.deepEqual(out.map((a) => a.state), ['this_branch', 'pending', 'partial', 'not_verifiable']);
  assert.equal(out[1]!.label, PENDING_LABEL);
  assert.equal(out[2]!.note, 'half');
  const counts = attributionCounts(out);
  assert.equal(attributionSummary(counts, false), '1 in this slice, 1 partial, 1 not verifiable, 1 not in this slice (coverage pending)');
});

test('a row the coverage does not list is matched by text, else falls back to its own status', () => {
  const byText = attributeRow({ requirement_id: null, text: 'r2 TEXT.', status: 'missing', evidence: null }, coverage, HERE.repo, HERE.branch);
  assert.equal(byText.state, 'other_branch');
  const unknown = attributeRow(row(99, 'missing'), coverage, HERE.repo, HERE.branch);
  assert.equal(unknown.state, 'pending');
  assert.equal(unknown.label, 'not in this slice (not in the coverage)');
});

test('verdict: already_on_base counts as satisfied; only missing or partial is needs_work', () => {
  assert.equal(coverageVerdict([{ status: 'covered' }, { status: 'already_on_base' }]), 'covered');
  assert.equal(coverageVerdict([{ status: 'already_on_base' }]), 'covered');
  assert.equal(coverageVerdict([{ status: 'covered' }, { status: 'partial' }]), 'needs_work');
  assert.equal(coverageVerdict([{ status: 'already_on_base' }, { status: 'missing' }]), 'needs_work');
  assert.equal(coverageVerdict([]), 'needs_work');
  assert.deepEqual(openRequirements(coverage).map((r) => r.requirement_id), [4, 6, 5]);
});

test('a branch reading of the coverage names the base', () => {
  const lines = branchCoverage(coverage, HERE.repo, HERE.branch);
  assert.deepEqual(lines.map((l) => l.where), ['here', 'elsewhere', 'base', 'nowhere', 'elsewhere', 'nowhere', 'here']);
  assert.equal(whereLabel(lines[2]!), 'already on base');
  assert.equal(whereLabel(lines[6]!), 'partly in this branch and svc#feat/x-api');
});

test('the ticket coverage badge of a slice page: covered, needs_work with counts, pending', () => {
  assert.equal(ticketCoverageBadge({ verdict: 'needs_work', requirements: coverage }, true).label,
    'ticket coverage: needs_work (2 nowhere, 1 partial)');
  assert.equal(ticketCoverageBadge({ verdict: 'covered', requirements: [req(1, 'covered'), req(3, 'already_on_base')] }, true).state,
    'covered');
  const pending = ticketCoverageBadge({ verdict: 'needs_work', requirements: coverage }, false);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.label, 'ticket coverage: pending');
  assert.equal(ticketCoverageBadge(null, true).state, 'pending');
});
