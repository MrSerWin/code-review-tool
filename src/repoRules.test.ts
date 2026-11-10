import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadRepoRules, readRepoChecksFile, renderRepoRules } from './repoRules.js';
import { buildLensPrompt, buildReanchorPrompt, buildSynthesisPrompt, type PromptVars } from './reviewRunner.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-rules-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('loadRepoRules: _all.md then <repo>.md; a missing file adds nothing', () => {
  assert.deepEqual(loadRepoRules('svc', dir), { text: '', files: [] });
  fs.writeFileSync(path.join(dir, 'svc.md'), '- Rule for svc.\n');
  assert.deepEqual(loadRepoRules('svc', dir), { text: '- Rule for svc.', files: ['svc.md'] });
  fs.writeFileSync(path.join(dir, '_all.md'), '- Rule for all.\n');
  assert.deepEqual(loadRepoRules('svc', dir), { text: '- Rule for all.\n\n- Rule for svc.', files: ['_all.md', 'svc.md'] });
  assert.deepEqual(loadRepoRules('other', dir).files, ['_all.md']);
  // Read on every call: an edit applies without a restart.
  fs.writeFileSync(path.join(dir, 'svc.md'), '- Edited.\n');
  assert.match(loadRepoRules('svc', dir).text, /Edited/);
  // A name that is not a plain file name never reaches the filesystem.
  assert.deepEqual(loadRepoRules('../svc', dir).files, ['_all.md']);
  fs.rmSync(path.join(dir, '_all.md'));
});

test('loadRepoRules refuses an oversized file; readRepoChecksFile parses JSON or says why not', () => {
  fs.writeFileSync(path.join(dir, 'huge.md'), 'x'.repeat(70 * 1024));
  assert.throws(() => loadRepoRules('huge', dir), /larger than/);
  assert.equal(readRepoChecksFile('svc', dir), null);
  fs.writeFileSync(path.join(dir, 'svc.json'), '{"checks": {"diff-size": true}}');
  assert.deepEqual(readRepoChecksFile('svc', dir), { checks: { 'diff-size': true } });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.throws(() => readRepoChecksFile('bad', dir), /bad\.json is not valid JSON/);
});

test('renderRepoRules: the binding section, or nothing', () => {
  assert.equal(renderRepoRules('svc', { text: '  ' }), '');
  const text = renderRepoRules('svc', { text: '- No em dashes.' });
  assert.match(text, /^# Repository rules \(binding\)/);
  assert.match(text, /take\s+precedence/);
  assert.match(text, /names the rule in `why`/);
  assert.match(text, /- No em dashes\.$/);
});

const vars: PromptVars = {
  ticket: null,
  review: {
    id: 1, repo: 'svc', branch: 'feat/x', reviewer: 'claude', model: 'm',
    ticket_key: 'ABC-1', ticket_title: 'Title', ticket_url: null, ticket_body: 'Do the thing.',
  },
  checkout: { dir: '/tmp/x', headSha: 'h', baseSha: 'b', filesChanged: 0, additions: 0, deletions: 0, changedFiles: [] },
  previousFindings: [],
  repoRules: renderRepoRules('svc', { text: '- RULE-MARKER' }),
};

test('the rules section reaches lens and synthesis prompts right after the ticket, never the re-anchor prompt', async () => {
  const lens = await buildLensPrompt('correctness', vars);
  const synthesis = await buildSynthesisPrompt(vars, '## Lens: correctness\n\n{}', '# Tool checks (deterministic, already verified)\n\nTOOL-MARKER');
  for (const prompt of [lens, synthesis]) {
    const ticket = prompt.indexOf('Do the thing.');
    const rules = prompt.indexOf('# Repository rules (binding)');
    const previous = prompt.indexOf('# Findings from the previous review');
    assert.ok(ticket > 0 && rules > ticket && previous > rules, 'rules sit between the ticket and the previous findings');
    assert.match(prompt, /RULE-MARKER/);
    assert.match(prompt, /binding summary of these\s+files and takes precedence/);
  }
  assert.match(lens, /customer docs; the rules name which docs those are/);
  assert.match(lens, /N\+1 queries and queries inside loops/);
  assert.match(synthesis, /TOOL-MARKER/);
  assert.match(synthesis, /\(customer docs\) is `major` when it is left stale/);
  assert.ok(synthesis.indexOf('TOOL-MARKER') < synthesis.indexOf('# How to work, in this order'));

  const reanchor = await buildReanchorPrompt(vars, '## Finding 1');
  assert.doesNotMatch(reanchor, /RULE-MARKER|Repository rules/);

  const bare = await buildLensPrompt('security', { ...vars, repoRules: '' });
  assert.doesNotMatch(bare, /Repository rules \(binding\)\n/);
  const bareSynthesis = await buildSynthesisPrompt({ ...vars, repoRules: '' }, '');
  assert.doesNotMatch(bareSynthesis, /Tool checks \(deterministic/);
});
