import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePullRequestRef } from './resolver.js';

test('a pull request URL is certainly one pull request', () => {
  assert.deepEqual(
    parsePullRequestRef('https://github.com/my-org/my-service/pull/689', 'my-org'),
    { repo: 'my-service', number: 689, certain: true },
  );
  assert.deepEqual(
    parsePullRequestRef('https://github.com/My-Org/my-service/pull/12/files?w=1', 'my-org'),
    { repo: 'my-service', number: 12, certain: true },
  );
});

test('owner/repo#N may be a pull request or an issue', () => {
  assert.deepEqual(
    parsePullRequestRef('my-org/my-service#689', 'my-org'),
    { repo: 'my-service', number: 689, certain: false },
  );
  assert.deepEqual(
    parsePullRequestRef('github:my-org/my-service#7', 'my-org'),
    { repo: 'my-service', number: 7, certain: false },
  );
});

test('issues, other organizations and branches are not pull request references', () => {
  assert.equal(parsePullRequestRef('https://github.com/my-org/my-service/issues/689', 'my-org'), null);
  assert.equal(parsePullRequestRef('https://github.com/other-org/my-service/pull/689', 'my-org'), null);
  assert.equal(parsePullRequestRef('my-service#feat/abc-1', 'my-org'), null);
  assert.equal(parsePullRequestRef('ABC-123', 'my-org'), null);
  assert.equal(parsePullRequestRef('https://github.com/my-org/my-service/tree/main', 'my-org'), null);
});

test('pasted GitHub links are normalized to one spelling', async () => {
  const { normalizeInput } = await import('./resolver.js');
  assert.equal(
    normalizeInput('  http://github.com/my-org/my-service/pull/704 '),
    'https://github.com/my-org/my-service/pull/704',
  );
  assert.equal(
    normalizeInput('https://www.github.com/my-org/my-service/pull/7/files'),
    'https://github.com/my-org/my-service/pull/7/files',
  );
  assert.equal(
    normalizeInput('<https://github.com/my-org/my-service/tree/feat/x>'),
    'https://github.com/my-org/my-service/tree/feat/x',
  );
  assert.equal(normalizeInput('ABC-123'), 'ABC-123');
  assert.deepEqual(
    parsePullRequestRef(normalizeInput('http://github.com/my-org/my-service/pull/704'), 'my-org'),
    { repo: 'my-service', number: 704, certain: true },
  );
});
