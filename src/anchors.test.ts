import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  anchorFindings, checkAnchor, createAnchorContext, MAX_REANCHOR, reanchorOutputSchema, renderReanchorFindings,
  resolvePath, type ReanchorOutput,
} from './anchors.js';
import { mergeChangedFiles, parseNameStatusZ, parseNumstatZ } from './changedFiles.js';
import { attributeLenses, normalizeHunk, normalizeKind } from './findingFields.js';
import { lensOutputSchema, renderChangedFiles, reviewOutputSchema } from './reviewRunner.js';
import type { ChangedFile, Finding, OnLog } from './types.js';

const noLog: OnLog = () => undefined;

// --- a throwaway repository: base commit, then a branch commit on top ------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-anchors-'));
const repo = path.join(root, 'repo');
const outside = path.join(root, 'outside.txt');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

fs.mkdirSync(repo);
git('init', '-q', '-b', 'main');
write('src/service.py', lines(10, 'service'));
write('src/caller.py', lines(30, 'caller'));
write('docs/guide.md', lines(5, 'guide'));
write('src/old_name.py', lines(40, 'moved'));
write('src/gone.py', lines(8, 'gone'));
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD').trim();

write('src/service.py', lines(12, 'service v2'));
write('src/new_file.py', lines(3, 'new'));
git('mv', 'src/old_name.py', 'src/new_name.py');
git('rm', '-q', 'src/gone.py');
git('add', '-A');
git('commit', '-q', '-m', 'branch');
fs.writeFileSync(outside, 'secret\n');
fs.symlinkSync(outside, path.join(repo, 'escape.txt'));

const changed: ChangedFile[] = mergeChangedFiles(
  git('diff', '--name-status', '-z', '-M', `${baseSha}..HEAD`),
  git('diff', '--numstat', '-z', '-M', `${baseSha}..HEAD`),
);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'major', category: 'correctness', file: 'src/service.py', line: 3, end_line: null,
    title: 'Something', problem: 'It breaks.', why: '', suggestion: '', snippet: null,
    kind: 'diff', cause_file: null, cause_line: null, hunk: null, lens: null,
    ...overrides,
  };
}

// --- changed-file list ------------------------------------------------------

test('the changed list resolves renames to the new path and keeps statuses and counts', () => {
  const byPath = new Map(changed.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), [
    'src/gone.py', 'src/new_file.py', 'src/new_name.py', 'src/service.py',
  ]);
  assert.equal(byPath.get('src/new_name.py')!.status, 'R');
  assert.equal(byPath.get('src/new_name.py')!.old_path, 'src/old_name.py');
  assert.equal(byPath.get('src/gone.py')!.status, 'D');
  assert.equal(byPath.get('src/new_file.py')!.status, 'A');
  assert.equal(byPath.get('src/new_file.py')!.additions, 3);
  assert.equal(byPath.get('src/service.py')!.status, 'M');
  assert.ok(changed.every((f) => !f.path.includes('=>')), 'no {a => b} form');
});

test('the -z parsers handle renames, binary counts, and odd file names', () => {
  const ns = parseNameStatusZ('M\0a b.txt\0R087\0old\tx.ts\0new.ts\0D\0gone\0');
  assert.deepEqual(ns, [
    { path: 'a b.txt', status: 'M', old_path: null },
    { path: 'new.ts', status: 'R', old_path: 'old\tx.ts' },
    { path: 'gone', status: 'D', old_path: null },
  ]);
  const counts = parseNumstatZ('1\t2\ta b.txt\0' + '3\t0\t\0old\tx.ts\0new.ts\0' + '-\t-\timg.png\0');
  assert.deepEqual(counts.get('a b.txt'), { additions: 1, deletions: 2, old_path: null });
  assert.deepEqual(counts.get('new.ts'), { additions: 3, deletions: 0, old_path: 'old\tx.ts' });
  assert.deepEqual(counts.get('img.png'), { additions: null, deletions: null, old_path: null });
});

test('the prompt lists renames under their new path', () => {
  const text = renderChangedFiles({
    dir: repo, headSha: 'h', baseSha, filesChanged: changed.length, additions: 1, deletions: 1,
    changedFiles: changed.map((f) => f.path), changedFileList: changed,
  });
  assert.match(text, /- `src\/new_name\.py` \(renamed from `src\/old_name\.py`\)/);
  assert.match(text, /- `src\/gone\.py` \(deleted\)/);
  assert.match(text, /- `src\/new_file\.py` \(added\)/);
  assert.doesNotMatch(text, /=>/);
});

// --- schema parsing ---------------------------------------------------------

test('lens output: kind defaults to diff, aliases map, unknown kinds fall back, cause and hunk parse', () => {
  const parsed = lensOutputSchema.parse({
    findings: [
      { severity: 'major', title: 't', problem: 'p', file: 'a.py', line: 1 },
      {
        severity: 'major', title: 't', problem: 'p', file: 'b.py', line: '7', kind: 'Regression',
        cause_file: ' src/x.py ', cause_line: '12', hunk: 'diff hunk @@ -1,4 +1,6 @@ def f():',
      },
      { severity: 'minor', title: 't', problem: 'p', kind: 'dependent-site' },
      { severity: 'minor', title: 't', problem: 'p', kind: 'something else', hunk: 'not a hunk' },
    ],
  });
  const [a, b, c, d] = parsed.findings;
  assert.equal(a!.kind, 'diff');
  assert.equal(a!.cause_file, null);
  assert.equal(a!.hunk, null);
  assert.equal(b!.kind, 'regression');
  assert.equal(b!.cause_file, 'src/x.py');
  assert.equal(b!.cause_line, 12);
  assert.equal(b!.line, 7);
  assert.equal(b!.hunk, '@@ -1,4 +1,6 @@');
  assert.equal(c!.kind, 'regression');
  assert.equal(d!.kind, 'diff');
  assert.equal(d!.hunk, null);
});

test('synthesis output keeps a known lens and drops an unknown one; old shapes still parse', () => {
  const base = { summary: 's', requirements: [], verdict: 'approve', can_merge: true };
  const parsed = reviewOutputSchema.parse({
    ...base,
    findings: [
      { severity: 'nit', title: 't', problem: 'p', lens: 'Regressions', kind: 'stale_doc' },
      { severity: 'nit', title: 't', problem: 'p', lens: 'made-up' },
    ],
  });
  assert.equal(parsed.findings[0]!.lens, 'regressions');
  assert.equal(parsed.findings[0]!.kind, 'stale_doc');
  assert.equal(parsed.findings[1]!.lens, null);
  // An answer written for the old prompt (no new fields at all).
  const old = reviewOutputSchema.parse({ ...base, findings: [{ severity: 'nit', title: 't', problem: 'p', file: 'x', line: 2 }] });
  assert.equal(old.findings[0]!.kind, 'diff');
  assert.equal(old.findings[0]!.lens, null);
});

test('kind and hunk normalisers', () => {
  assert.equal(normalizeKind(undefined), 'diff');
  assert.equal(normalizeKind('stale docs'), 'stale_doc');
  assert.equal(normalizeKind('CONSUMER'), 'consumer');
  assert.equal(normalizeHunk('@@ -3 +3,2 @@'), '@@ -3 +3,2 @@');
  assert.equal(normalizeHunk(42), null);
});

test('re-anchor answer: an absent kind is kept as null so the current kind survives', () => {
  const parsed = reanchorOutputSchema.parse({ anchors: [{ id: '2', file: 'a.py', line: 3 }] });
  assert.equal(parsed.anchors[0]!.id, 2);
  assert.equal(parsed.anchors[0]!.kind, null);
});

// --- validation at HEAD ---------------------------------------------------------

const ctx = () => createAnchorContext(repo, changed);

test('a changed line is ok; line and end_line are checked against the file length', () => {
  assert.equal(checkAnchor(ctx(), finding({ line: 12 })).finding.anchor_status, 'ok');
  assert.equal(checkAnchor(ctx(), finding({ line: 13 })).finding.anchor_status, 'line_out_of_range');
  assert.equal(checkAnchor(ctx(), finding({ line: 0 })).finding.anchor_status, 'line_out_of_range');
  assert.equal(checkAnchor(ctx(), finding({ line: 10, end_line: 14 })).finding.anchor_status, 'line_out_of_range');
  assert.equal(checkAnchor(ctx(), finding({ line: null })).finding.anchor_status, 'ok');
});

test('a missing path, a deleted file, a traversal, and a symlink out of the checkout are missing_path', () => {
  assert.equal(checkAnchor(ctx(), finding({ file: 'src/nope.py' })).finding.anchor_status, 'missing_path');
  assert.equal(checkAnchor(ctx(), finding({ file: 'src/gone.py', line: 2 })).finding.anchor_status, 'missing_path');
  assert.equal(checkAnchor(ctx(), finding({ file: '../outside.txt', line: 1 })).finding.anchor_status, 'missing_path');
  assert.equal(checkAnchor(ctx(), finding({ file: outside, line: 1 })).finding.anchor_status, 'missing_path');
  assert.equal(checkAnchor(ctx(), finding({ file: 'escape.txt', line: 1 })).finding.anchor_status, 'missing_path');
  assert.equal(checkAnchor(ctx(), finding({ file: '.git/HEAD', line: 1 })).finding.anchor_status, 'missing_path');
});

test('no file means unverified', () => {
  assert.equal(checkAnchor(ctx(), finding({ file: null, line: null })).finding.anchor_status, 'unverified');
});

test('an untouched file is off_diff for a diff finding, ok for a regression with a changed cause', () => {
  assert.equal(checkAnchor(ctx(), finding({ file: 'src/caller.py', line: 20 })).finding.anchor_status, 'off_diff');
  const regression = finding({ file: 'src/caller.py', line: 20, kind: 'regression', cause_file: 'src/service.py', cause_line: 4 });
  const ok = checkAnchor(ctx(), regression);
  assert.equal(ok.finding.anchor_status, 'ok');
  assert.equal(ok.causeValid, true);
  // The cause must be a changed file, and its line must exist.
  const badCause = checkAnchor(ctx(), { ...regression, cause_file: 'docs/guide.md', cause_line: 1 });
  assert.equal(badCause.finding.anchor_status, 'off_diff');
  const outOfRange = checkAnchor(ctx(), { ...regression, cause_line: 99 });
  assert.equal(outOfRange.finding.anchor_status, 'off_diff');
  const noCause = checkAnchor(ctx(), { ...regression, cause_file: null, cause_line: null });
  assert.equal(noCause.finding.anchor_status, 'off_diff');
  // A deleted file is a valid cause: its lines refer to the base.
  const deleted = checkAnchor(ctx(), { ...regression, kind: 'consumer', cause_file: 'src/gone.py', cause_line: 5 });
  assert.equal(deleted.finding.anchor_status, 'ok');
});

test('paths are normalised: ./, absolute inside the checkout, a/ b/ prefixes, :line suffix, old rename path', () => {
  const c = ctx();
  assert.deepEqual(resolvePath(c, './src/service.py'), { file: 'src/service.py', line: null, exists: true });
  assert.deepEqual(resolvePath(c, path.join(repo, 'src/caller.py')), { file: 'src/caller.py', line: null, exists: true });
  assert.deepEqual(resolvePath(c, 'b/src/service.py'), { file: 'src/service.py', line: null, exists: true });
  assert.deepEqual(resolvePath(c, 'src/caller.py:17'), { file: 'src/caller.py', line: 17, exists: true });
  assert.deepEqual(resolvePath(c, 'src/old_name.py'), { file: 'src/new_name.py', line: null, exists: true });

  const checked = checkAnchor(c, finding({ file: 'a/src/new_file.py:2', line: null })).finding;
  assert.equal(checked.file, 'src/new_file.py');
  assert.equal(checked.line, 2);
  assert.equal(checked.anchor_status, 'ok');
});

// --- the re-anchor pass -----------------------------------------------------------

test('one re-anchor pass for every bad finding; improvements applied, the rest kept with their status', async () => {
  const findings = [
    finding({ title: 'fine', line: 5 }),
    finding({ title: 'wrong line', line: 99 }),
    finding({ title: 'dependent site', file: 'src/caller.py', line: 20 }),
    finding({ title: 'hopeless', file: 'src/nope.py', line: 1 }),
    finding({ title: 'no location', file: null, line: null }),
  ];
  const calls: string[] = [];
  const answer: ReanchorOutput = reanchorOutputSchema.parse({
    anchors: [
      { id: 2, file: 'src/service.py', line: 11, hunk: '@@ -1,10 +1,12 @@' },
      { id: 3, file: 'src/caller.py', line: 20, kind: 'regression', cause_file: 'src/service.py', cause_line: 2 },
      // Not better: still missing. The original stays.
      { id: 4, file: 'src/also-nope.py', line: 1 },
      // Not one of the sent ids: ignored.
      { id: 1, file: 'src/caller.py', line: 1 },
    ],
  });
  const result = await anchorFindings(ctx(), findings, async (block) => { calls.push(block); return answer; }, noLog);

  assert.equal(calls.length, 1, 'exactly one pass');
  assert.match(calls[0]!, /Finding 2: \[major\] wrong line/);
  assert.match(calls[0]!, /Finding 3: \[major\] dependent site/);
  assert.match(calls[0]!, /Finding 4: \[major\] hopeless/);
  assert.doesNotMatch(calls[0]!, /Finding 1:|Finding 5:/);
  assert.equal(result.sent, 3);
  assert.equal(result.fixed, 2);
  assert.equal(result.stillInvalid, 1);

  const [fine, wrongLine, dependent, hopeless, none] = result.findings;
  assert.equal(fine!.anchor_status, 'ok');
  assert.equal(fine!.file, 'src/service.py');
  assert.equal(wrongLine!.anchor_status, 'ok');
  assert.equal(wrongLine!.line, 11);
  assert.equal(wrongLine!.hunk, '@@ -1,10 +1,12 @@');
  assert.equal(dependent!.anchor_status, 'ok');
  assert.equal(dependent!.kind, 'regression');
  assert.equal(dependent!.cause_file, 'src/service.py');
  assert.equal(hopeless!.anchor_status, 'missing_path');
  assert.equal(hopeless!.file, 'src/nope.py');
  assert.equal(hopeless!.title, 'hopeless');
  assert.equal(none!.anchor_status, 'unverified');
});

test('no pass when every anchor is fine', async () => {
  let called = false;
  const result = await anchorFindings(ctx(), [finding()], async () => { called = true; return { anchors: [] }; }, noLog);
  assert.equal(called, false);
  assert.equal(result.sent, 0);
  assert.equal(result.findings[0]!.anchor_status, 'ok');
});

test('a failed pass keeps every finding with its first status', async () => {
  const logs: string[] = [];
  const result = await anchorFindings(
    ctx(),
    [finding({ line: 99 }), finding()],
    async () => { throw new Error('model said no'); },
    (_level, message) => logs.push(message),
  );
  assert.deepEqual(result.findings.map((f) => f.anchor_status), ['line_out_of_range', 'ok']);
  assert.ok(logs.some((l) => /re-anchor pass failed/.test(l)));
});

test('the pass is capped', async () => {
  const many = Array.from({ length: MAX_REANCHOR + 5 }, (_, i) => finding({ title: `f${i}`, file: 'src/nope.py' }));
  let sentIds = 0;
  const result = await anchorFindings(ctx(), many, async (block) => {
    sentIds = (block.match(/^## Finding /gm) ?? []).length;
    return { anchors: [] };
  }, noLog);
  assert.equal(sentIds, MAX_REANCHOR);
  assert.equal(result.findings.length, MAX_REANCHOR + 5);
  assert.equal(result.stillInvalid, MAX_REANCHOR + 5);
});

test('the findings block names the anchor problem', () => {
  const block = renderReanchorFindings([{ id: 7, finding: { ...finding({ file: 'x.py', line: 4 }), anchor_status: 'missing_path' } }]);
  assert.match(block, /## Finding 7: \[major\] Something/);
  assert.match(block, /current anchor: x\.py:4/);
  assert.match(block, /the path does not exist at HEAD/);
});

// --- lens attribution -------------------------------------------------------------

test('attributeLenses infers the lens from an exact anchor match and carries kind and cause', () => {
  const lensFinding = finding({ file: 'src/caller.py', line: 20, kind: 'regression', cause_file: 'src/service.py', cause_line: 3 });
  const lenses = [
    { lens: 'regressions' as const, output: { findings: [lensFinding], observations: [] } },
    { lens: 'correctness' as const, output: { findings: [finding({ line: 5 })], observations: [] } },
    { lens: 'security' as const, output: null },
  ];
  const [dropped, kept, own, unmatched] = attributeLenses([
    // Synthesis dropped the kind and the cause but kept the regressions anchor.
    finding({ file: './src/caller.py', line: 20 }),
    // Synthesis named the lens itself.
    finding({ line: 5, lens: 'correctness' }),
    // Synthesis named a lens that has no candidate here: the name is kept.
    finding({ line: 9, lens: 'tests' }),
    finding({ line: 8 }),
  ], lenses);
  assert.equal(dropped!.lens, 'regressions');
  assert.equal(dropped!.kind, 'regression');
  assert.equal(dropped!.cause_file, 'src/service.py');
  assert.equal(dropped!.cause_line, 3);
  assert.equal(kept!.lens, 'correctness');
  assert.equal(kept!.kind, 'diff');
  assert.equal(own!.lens, 'tests');
  assert.equal(unmatched!.lens, null);
});

test('attributeLenses leaves the lens unset when two lenses share an anchor', () => {
  const at = finding({ line: 5 });
  const [f] = attributeLenses([finding({ line: 5 })], [
    { lens: 'correctness', output: { findings: [at], observations: [] } },
    { lens: 'tests', output: { findings: [at], observations: [] } },
  ]);
  assert.equal(f!.lens, null);
});
