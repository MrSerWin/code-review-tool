import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributionClass, attributionLinks, baseGroupTitle, baseLocation, coverageStatusClass, coverageStatusLabel, splitBaseRequirements,
  ticketCoverageClass,
} from './coverageView';
import type { Attribution, BaseEvidence, CoverageRequirement } from './types';

test('the attribution palette: green only for this branch, amber partial, red only nowhere, the rest neutral', () => {
  const all: Attribution[] = ['this_branch', 'other_branch', 'already_on_base', 'not_verifiable', 'nowhere', 'partial', 'pending'];
  assert.deepEqual(all.map(attributionClass), [
    'attr-here', 'attr-neutral', 'attr-neutral', 'attr-neutral', 'attr-nowhere', 'attr-partial', 'attr-neutral',
  ]);
  assert.deepEqual(
    attributionLinks({ state: 'other_branch', label: 'in a#b', note: '', branches: [{ repo: 'a', branch: 'b', review_id: 4 }, { repo: 'c', branch: 'd', review_id: null }] }),
    [{ label: 'a#b', to: '/review/4' }, { label: 'c#d', to: null }],
  );
});

test('the ticket coverage table uses the same palette; missing reads as nowhere', () => {
  assert.deepEqual(['covered', 'partial', 'missing', 'already_on_base'].map((s) => coverageStatusLabel(s as never)),
    ['covered', 'partial', 'nowhere', 'already on base']);
  assert.deepEqual(['covered', 'partial', 'missing', 'already_on_base'].map((s) => coverageStatusClass(s as never)),
    ['attr-here', 'attr-partial', 'attr-nowhere', 'attr-neutral']);
});

const site = (overrides: Partial<BaseEvidence> = {}): BaseEvidence => ({
  repo: 'svc', file: 'a.py', line: 3, quote: 'q', base_branch: 'main', base_sha: 'abc', verified: true, reason: null, ...overrides,
});
const req = (status: CoverageRequirement['status'], evidence?: BaseEvidence[]): CoverageRequirement => ({
  text: status, status, note: '', branches: [], ...(evidence ? { base_evidence: evidence } : {}),
});

test('requirements already on the base go to their own group, titled after the base', () => {
  const { open, onBase } = splitBaseRequirements([req('covered'), req('already_on_base', [site()]), req('missing')]);
  assert.deepEqual(open.map((r) => r.status), ['covered', 'missing']);
  assert.equal(onBase.length, 1);
  assert.equal(baseGroupTitle(onBase), 'Already on main before this ticket');
  assert.equal(baseGroupTitle([req('already_on_base', [site()]), req('already_on_base', [site({ base_branch: 'develop' })])]),
    'Already on the base before this ticket');
  assert.equal(baseLocation(site()), 'svc a.py:3');
});

test('the ticket badge on a slice page: red only with a real gap', () => {
  const badge = (state: 'covered' | 'needs_work' | 'pending', nowhere = 0) => ({ state, nowhere, partial: 1, already_on_base: 0, label: '' });
  assert.equal(ticketCoverageClass(badge('covered')), 'attr-here');
  assert.equal(ticketCoverageClass(badge('needs_work', 2)), 'attr-nowhere');
  assert.equal(ticketCoverageClass(badge('needs_work', 0)), 'attr-partial');
  assert.equal(ticketCoverageClass(badge('pending')), 'attr-neutral');
});
