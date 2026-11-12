import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BaseReader, checkQuote, cleanBasePath, collectBaseHints, renderBaseExcerpts, type BaseRoot, type GitRunner,
} from './baseEvidence.js';
import { git } from './testGit.js';
import type { RequirementRow } from './types.js';

/**
 * `already_on_base` sites checked at the base commit of a throwaway repository:
 * main has the code, the branch cut from it adds more, and main moves on after.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-base-'));
const repo = path.join(root, 'svc');
fs.mkdirSync(path.join(repo, 'apps/orders'), { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
const services = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
services[25] = 'def order_links(order):';
services[26] = '    return {"order_id": order.id, "url": order_url(order)}';
fs.writeFileSync(path.join(repo, 'apps/orders/services.py'), `${services.join('\n')}\n`);
fs.writeFileSync(path.join(repo, 'apps/orders/order_serializers.py'), 'class S:\n    is_paid = serializers.SerializerMethodField()\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'base');
const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
git(repo, 'checkout', '-q', '-b', 'feat/x');
fs.writeFileSync(path.join(repo, 'apps/orders/new.py'), 'def resolve():\n    pass\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'slice');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const hostGit: GitRunner = (dir, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

function baseRoot(checkout: string | null): BaseRoot {
  return {
    repo: 'svc', baseBranch: 'main', sha: baseSha, checkout,
    fetchTarget: { repo: 'svc', branch: 'main', baseBranch: 'main', prNumber: null }, reviewId: 7,
  };
}

function reader(checkout: string | null, fetchDir?: string) {
  const fetched: string[] = [];
  const pruned: string[] = [];
  const r = new BaseReader([baseRoot(checkout)], {
    run: hostGit,
    fetch: async (root) => {
      fetched.push(root.repo);
      if (!fetchDir) throw new Error('offline');
      return fetchDir;
    },
    prune: (dir) => pruned.push(dir),
  });
  return { r, fetched, pruned };
}

test('a site at the base verifies: file, line in range, quote on the line or within three lines', async () => {
  const { r, fetched } = reader(repo);
  const ok = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 26, quote: 'def order_links(order):' });
  assert.equal(ok.verified, true, ok.reason ?? '');
  assert.equal(ok.base_sha, baseSha);
  assert.equal(ok.base_branch, 'main');
  // Three lines away, extra whitespace in the quote, and a bare file name that is unique at the base.
  const near = await r.verify({ repo: 'svc', file: 'services.py', line: 24, quote: '"order_id":   order.id' });
  assert.equal(near.verified, true, near.reason ?? '');
  assert.equal(near.file, 'apps/orders/services.py');
  // `file:line` in one string, and no repository named while the group has one.
  const suffix = await r.verify({ repo: null, file: 'apps/orders/order_serializers.py:2', line: null, quote: 'is_paid = serializers' });
  assert.equal(suffix.verified, true, suffix.reason ?? '');
  assert.deepEqual(fetched, [], 'the review checkout is used, nothing is fetched');
});

test('a wrong line, a quote not there, a missing file, a file the branch added: not verified, with the reason', async () => {
  const { r } = reader(repo);
  const far = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 10, quote: 'def order_links' });
  assert.equal(far.verified, false);
  assert.match(far.reason!, /not within 3 lines of line 10/);
  const range = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 400, quote: 'def order_links' });
  assert.match(range.reason!, /line 400 is out of range \(the file has 30 lines\)/);
  const quote = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 26, quote: 'def order_notification_extra' });
  assert.match(quote.reason!, /quote is not within/);
  const missing = await r.verify({ repo: 'svc', file: 'apps/orders/nope.py', line: 1, quote: 'anything here' });
  assert.match(missing.reason!, /does not exist at main@/);
  // On the branch, not on the base.
  const added = await r.verify({ repo: 'svc', file: 'apps/orders/new.py', line: 1, quote: 'def resolve' });
  assert.equal(added.verified, false);
  assert.match(added.reason!, /does not exist at main@/);
  const noQuote = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 26, quote: '' });
  assert.match(noQuote.reason!, /no quote given/);
  const otherRepo = await r.verify({ repo: 'web', file: 'a.ts', line: 1, quote: 'whatever' });
  assert.match(otherRepo.reason!, /web is not a repository of this ticket/);
});

test('the review checkout is gone: the base branch is fetched once, read, and pruned on close', async () => {
  const { r, fetched, pruned } = reader(path.join(root, 'gone'), repo);
  const ok = await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 26, quote: 'order_links' });
  assert.equal(ok.verified, true, ok.reason ?? '');
  await r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 27, quote: 'order_url(order)' });
  assert.deepEqual(fetched, ['svc']);
  r.close();
  assert.deepEqual(pruned, [repo]);

  const offline = reader(null);
  const failed = await offline.r.verify({ repo: 'svc', file: 'apps/orders/services.py', line: 26, quote: 'order_links' });
  assert.equal(failed.verified, false);
  assert.match(failed.reason!, /could not be read \(offline\)/);
});

test('quote check and path cleaning', () => {
  const lines = ['a', 'b', 'the quote here', 'c'];
  assert.equal(checkQuote(lines, 3, 'quote here'), null);
  assert.equal(checkQuote(lines, 1, 'quote here'), null);
  assert.match(checkQuote(lines, null, 'quote here')!, /no line given/);
  assert.match(checkQuote(lines, 2, 'ab')!, /no quote given/);
  assert.deepEqual(cleanBasePath('./a/apps/x.py:12'), { file: 'apps/x.py', line: 12 });
  assert.deepEqual(cleanBasePath('`src/y.ts`'), { file: 'src/y.ts', line: null });
});

const reqRow = (requirement_id: number, status: RequirementRow['status'], evidence: string): RequirementRow => ({
  id: requirement_id, review_id: 1, text: `R${requirement_id}`, status, evidence, ord: 0, requirement_id,
});

test('hints: rows a slice review marked missing because they are already on main, with sites and identifiers', async () => {
  const hints = collectBaseHints([{
    repo: 'svc', branch: 'feat/x',
    requirements: [
      reqRow(1, 'met', 'already on main (apps/orders/services.py:26)'),
      reqRow(2, 'missing', 'order_links already on main (apps/orders/services.py:26); not part of this diff'),
      reqRow(3, 'missing', 'Backend work, belongs to the service slice.'),
      reqRow(4, 'missing', 'is_paid already on main before this branch; not part of this diff'),
      reqRow(5, 'partial', 'Already on main (services.py:27)'),
    ],
  }]);
  assert.deepEqual(hints.map((h) => h.requirement_id), [2, 4, 5]);
  assert.deepEqual(hints[0]!.locations, [{ file: 'apps/orders/services.py', line: 26 }]);
  assert.deepEqual(hints[1]!.locations, []);
  assert.deepEqual(hints[1]!.words, ['is_paid']);

  const { r } = reader(repo);
  const text = await renderBaseExcerpts(hints, r);
  assert.match(text, /### R2, per the review of `svc#feat\/x`/);
  assert.match(text, /`apps\/orders\/services.py` at main@[0-9a-f]{7}, lines 21-30:/);
  assert.match(text, /   26\| def order_links\(order\):/);
  // An identifier without a site is looked up with git grep at the base.
  assert.match(text, /`apps\/orders\/order_serializers.py` at main@[0-9a-f]{7}, lines 1-2:/);
  assert.equal(await renderBaseExcerpts([], r), 'No branch review said a requirement is already on the base.');
  assert.match(await renderBaseExcerpts(hints, null), /No base commit is known/);
});
