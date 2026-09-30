import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ApiClient, ApiError, ApiUnreachableError, apiBaseUrl, DEFAULT_API_URL,
} from './mcp/client.js';
import {
  compactFindings, compactLocalRepos, findingLocation, isTerminalStatus, mutationRefusal,
  parseTargetSelector, reviewDetail, selectTargets, severityCounts, truncate, truncateReport,
} from './mcp/format.js';
import type { FindingRow, ReviewRow } from './types.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC_DIR, '..');

// --- fixtures ---------------------------------------------------------------

function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 1, ticket_key: 'ABC-123', ticket_title: 'Example ticket', ticket_url: null, ticket_body: null,
    repo: 'my-service', branch: 'feature/abc-123-example', base_branch: 'main', head_sha: null, base_sha: null,
    pr_number: null, source: 'github', working_tree: 0, base_reason: null, run_index: 1, status: 'queued',
    verdict: null, can_merge: null, summary: null, requirements_met: null, requirements_total: null,
    blocking_count: null, report_path: null, reviewer: 'claude', model: 'opus', error: null,
    files_changed: null, additions: null, deletions: null, created_at: '2026-01-01T00:00:00.000Z',
    started_at: null, finished_at: null,
    ...overrides,
  };
}

function finding(i: number, severity: FindingRow['severity'], overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: i, review_id: 1, severity, category: 'correctness', file: `src/f${i}.ts`, line: i, end_line: null,
    title: `Finding ${i}`, problem: `Problem ${i}`, why: null, suggestion: null, snippet: null, ord: i,
    ...overrides,
  };
}

function doneRow(id: number): ReviewRow {
  return reviewRow({
    id, status: 'done', verdict: 'changes_requested', can_merge: 0, summary: 'One blocker.',
    requirements_met: 1, requirements_total: 2, blocking_count: 1, report_path: 'reports/x/run-1.md',
    files_changed: 3, additions: 10, deletions: 2, finished_at: '2026-01-01T00:10:00.000Z',
  });
}

// --- format helpers -----------------------------------------------------------

test('truncate keeps short text and marks a cut', () => {
  assert.equal(truncate(null, 5), null);
  assert.equal(truncate('  short  ', 10), 'short');
  const cut = truncate('abcdefghij', 5)!;
  assert.equal(cut.length, 5);
  assert.ok(cut.endsWith('…'));
});

test('terminal statuses are done, failed, and cancelled only', () => {
  for (const s of ['done', 'failed', 'cancelled']) assert.equal(isTerminalStatus(s), true, s);
  for (const s of ['queued', 'fetching', 'reviewing', 'bogus']) assert.equal(isTerminalStatus(s), false, s);
});

test('findings are sorted most severe first and capped', () => {
  const rows = [
    finding(1, 'nit'), finding(2, 'major'), finding(3, 'blocker'), finding(4, 'minor'), finding(5, 'major'),
  ];
  const { findings, omitted } = compactFindings(rows, 3);
  assert.deepEqual(findings.map((f) => f.severity), ['blocker', 'major', 'major']);
  // Stable within a severity: the original order is kept.
  assert.deepEqual(findings.map((f) => f.title), ['Finding 3', 'Finding 2', 'Finding 5']);
  assert.equal(omitted, 2);
  assert.deepEqual(severityCounts(rows), { blocker: 1, major: 2, minor: 1, nit: 1 });
});

test('finding text is truncated and locations are compact', () => {
  const long = finding(1, 'major', { problem: 'x'.repeat(1000), end_line: 9 });
  const [f] = compactFindings([long], 50, 100).findings;
  assert.equal(f!.problem!.length, 100);
  assert.equal(f!.location, 'src/f1.ts:1-9');
  assert.equal(findingLocation({ file: 'a.ts', line: null, end_line: null }), 'a.ts');
  assert.equal(findingLocation({ file: null, line: 3, end_line: null }), null);
  assert.equal(findingLocation({ file: 'a.ts', line: 3, end_line: 3 }), 'a.ts:3');
});

test('a running review has no outcome yet but shows its latest log line', () => {
  const detail = reviewDetail({
    review: reviewRow({ status: 'reviewing' }),
    findings: [finding(1, 'blocker')],
    logs: [
      { id: 1, review_id: 1, ts: '', level: 'info', message: 'fetching' },
      { id: 2, review_id: 1, ts: '', level: 'info', message: 'lens security: done' },
    ],
  }, 'http://x/review/1');
  assert.equal(detail.terminal, false);
  assert.equal(detail.verdict, null);
  assert.equal(detail.can_merge, null);
  assert.deepEqual(detail.findings, []);
  assert.equal(detail.progress, 'lens security: done');
});

test('a finished review carries its outcome, unmet requirements, and capped findings', () => {
  const findings = Array.from({ length: 60 }, (_, i) => finding(i + 1, i === 0 ? 'blocker' : 'minor'));
  const detail = reviewDetail({
    review: doneRow(7),
    findings,
    requirements: [
      { id: 1, review_id: 7, text: 'Reject expired tokens', status: 'met', evidence: null, ord: 0 },
      { id: 2, review_id: 7, text: 'Log the rejection', status: 'missing', evidence: null, ord: 1 },
    ],
  }, 'http://x/review/7');
  assert.equal(detail.terminal, true);
  assert.equal(detail.verdict, 'changes_requested');
  assert.equal(detail.can_merge, false);
  assert.deepEqual(detail.requirements, {
    met: 1, total: 2, unmet: [{ status: 'missing', text: 'Log the rejection' }],
  });
  assert.equal(detail.findings.length, 50);
  assert.equal(detail.findings_omitted, 10);
  assert.equal(detail.severity_counts?.blocker, 1);
  assert.equal(detail.url, 'http://x/review/7');
  assert.equal(detail.progress, null);
});

test('a long report is cut with a note pointing at the full one', () => {
  assert.equal(truncateReport('short', 100, 'u'), 'short');
  const cut = truncateReport('y'.repeat(5000), 1000, 'http://x/review/1');
  assert.ok(cut.startsWith('y'.repeat(1000)));
  assert.match(cut, /truncated: showing the first 1000 of 5000 characters/);
  assert.match(cut, /http:\/\/x\/review\/1/);
});

test('local repos are trimmed to the branches an agent needs', () => {
  const branches = Array.from({ length: 40 }, (_, i) => ({
    name: `b${i}`, upstream: null, ahead: 0, behind: 0, unpushed: true,
    lastCommit: { sha: 'abc', subject: 's'.repeat(200), date: '2026-01-01' },
  }));
  const out = compactLocalRepos({
    repos: [
      { repo: 'my-service', path: '/code/my-service', currentBranch: 'b0', baseBranch: 'main', dirty: true, branches },
      { repo: 'my-frontend', path: '/code/my-frontend', currentBranch: 'main', baseBranch: 'main', dirty: false, branches: [] },
    ],
    unavailable: [],
  }, { repo: 'my-service', maxBranches: 5 });
  assert.equal(out.repos.length, 1);
  assert.equal(out.repos[0]!.branches.length, 5);
  assert.equal(out.repos[0]!.branches_omitted, 35);
  assert.equal(out.repos[0]!.branches[0]!.last_commit!.subject!.length, 80);
});

test('targets parse from "repo#branch" and select resolved branches', () => {
  assert.deepEqual(parseTargetSelector('my-service#feature/x#y'), { repo: 'my-service', branch: 'feature/x#y' });
  assert.throws(() => parseTargetSelector('no-branch'), /repo#branch/);
  assert.throws(() => parseTargetSelector('#branch'), /repo#branch/);
  const resolved = [
    { repo: 'my-service', branch: 'a', baseBranch: 'main' },
    { repo: 'my-frontend', branch: 'b', baseBranch: 'main' },
  ];
  const { chosen, unmatched } = selectTargets(resolved, [
    { repo: 'my-frontend', branch: 'b' }, { repo: 'other', branch: 'z' },
  ]);
  assert.deepEqual(chosen, [resolved[1]]);
  assert.deepEqual(unmatched, [{ repo: 'other', branch: 'z' }]);
});

// --- recursion guard ----------------------------------------------------------

test('starting, re-running, and cancelling are refused inside a reviewer', () => {
  assert.equal(mutationRefusal({}), null);
  assert.equal(mutationRefusal({ CODE_REVIEW_TOOL_REVIEWER: '' }), null);
  assert.equal(mutationRefusal({ CODE_REVIEW_TOOL_REVIEWER: '0' }), null);
  assert.match(mutationRefusal({ CODE_REVIEW_TOOL_REVIEWER: '1' }) ?? '', /Refused/);
  assert.match(mutationRefusal({ CODE_REVIEW_TOOL_REVIEWER: 'yes' }) ?? '', /reviewer/);
});

/** Relative runtime imports of one source file (type-only imports are erased). */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gms;
  for (const match of text.matchAll(re)) {
    out.push(path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts')));
  }
  return out;
}

test('the MCP server never loads configuration or secrets', () => {
  const seen = new Set<string>();
  const queue = [path.join(SRC_DIR, 'mcp.ts')];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file));
  }
  const reached = [...seen].map((f) => path.relative(SRC_DIR, f));
  for (const forbidden of ['config.ts', 'db.ts', 'queue.ts', 'reviewRunner.ts', 'reviewers/index.ts']) {
    assert.ok(!reached.includes(forbidden), `mcp.ts must not import ${forbidden} (reached: ${reached.join(', ')})`);
  }
});

// --- HTTP client --------------------------------------------------------------

async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test('the API URL comes from CODE_REVIEW_API_URL, without a trailing slash', () => {
  assert.equal(apiBaseUrl({}), DEFAULT_API_URL);
  assert.equal(apiBaseUrl({ CODE_REVIEW_API_URL: 'http://127.0.0.1:9999/ ' }), 'http://127.0.0.1:9999');
});

test('an unreachable API is reported as such, with the restart hint', async () => {
  const url = await closedPortUrl();
  const api = new ApiClient(url);
  await assert.rejects(api.reviewers(), (err: unknown) => {
    assert.ok(err instanceof ApiUnreachableError);
    assert.match(err.message, new RegExp(`not reachable at ${url.replace(/[.]/g, '\\.')}`));
    assert.match(err.message, /launchctl kickstart/);
    return true;
  });
});

test('an API error carries the status and the error field', async () => {
  const fake = async (): Promise<Response> =>
    new Response(JSON.stringify({ error: 'Review not found' }), { status: 404 });
  const api = new ApiClient('http://stub', fake);
  await assert.rejects(api.review(99), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'Review not found');
    return true;
  });
});

// --- protocol: the real stdio server against a stub API -------------------------

interface Stub {
  url: string;
  posts: unknown[];
  close: () => Promise<void>;
}

/** A fake API: two-branch ticket, reviews that finish after a few status polls. */
async function startStub(pollsUntilDone = 2): Promise<Stub> {
  const posts: unknown[] = [];
  const polls = new Map<number, number>();
  const targets = [
    { repo: 'my-service', branch: 'feature/abc-123-a', baseBranch: 'main', prNumber: null },
    { repo: 'my-frontend', branch: 'feature/abc-123-b', baseBranch: 'main', prNumber: 7 },
  ];
  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && url.pathname === '/api/reviewers') {
        return send(res, 200, {
          defaultReviewer: 'claude',
          reviewers: [{
            name: 'claude', label: 'Claude Code', defaultModel: 'opus', bin: 'claude', available: true,
            models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
          }],
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/tickets/ABC-123') {
        return send(res, 200, { ticket: { key: 'ABC-123', title: 'Example' }, targets });
      }
      if (req.method === 'POST' && url.pathname === '/api/reviews') {
        const body = JSON.parse(raw) as { targets?: typeof targets; reviewer?: string; model?: string };
        posts.push(body);
        const chosen = body.targets ?? targets;
        return send(res, 201, {
          reviews: chosen.map((t, i) => reviewRow({
            id: 10 + i, repo: t.repo, branch: t.branch, base_branch: t.baseBranch,
            reviewer: body.reviewer ?? 'claude', model: body.model ?? 'opus',
          })),
        });
      }
      const match = /^\/api\/reviews\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && match) {
        const id = Number(match[1]);
        const n = (polls.get(id) ?? 0) + 1;
        polls.set(id, n);
        const done = n > pollsUntilDone;
        return send(res, 200, {
          review: done ? doneRow(id) : reviewRow({ id, status: 'reviewing' }),
          requirements: [],
          findings: done ? [finding(1, 'minor'), finding(2, 'blocker'), finding(3, 'nit')] : [],
          logs: [{ id: n, review_id: id, ts: '', level: 'info', message: `poll ${n}` }],
        });
      }
      return send(res, 404, { error: 'Not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(SRC_DIR, 'mcp.ts')],
    cwd: ROOT,
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function json(result: unknown): any {
  const r = result as CallToolResult;
  const first = r.content[0];
  assert.ok(first && first.type === 'text', 'expected a text result');
  return JSON.parse(first.text);
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  return first && first.type === 'text' ? first.text : '';
}

test('stdio MCP server: list, start, get, and wait against a stub API', { timeout: 60_000 }, async () => {
  const stub = await startStub(2);
  const client = await connect({ CODE_REVIEW_API_URL: stub.url });
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'cancel_review', 'detect_base', 'get_report', 'get_review', 'list_local_repos', 'list_reviewers',
      'list_reviews', 'rerun_review', 'start_review', 'wait_for_review',
    ]);
    assert.match(tools.find((t) => t.name === 'wait_for_review')!.description ?? '', /call wait_for_review again/i);

    const reviewers = json(await client.callTool({ name: 'list_reviewers', arguments: {} }));
    assert.equal(reviewers.default_reviewer, 'claude');
    assert.deepEqual(reviewers.reviewers[0].models, ['opus', 'sonnet']);

    // A ticket with two branches and no filter: both are started.
    const started = json(await client.callTool({ name: 'start_review', arguments: { input: 'ABC-123' } }));
    assert.deepEqual(started.reviews.map((r: { id: number }) => r.id), [10, 11]);
    assert.equal(started.reviews[0].url, `${stub.url}/review/10`);
    assert.deepEqual(stub.posts[0], { input: 'ABC-123' });

    // A filter picks one resolved branch and sends it with its base.
    const one = json(await client.callTool({
      name: 'start_review',
      arguments: { input: 'ABC-123', targets: ['my-frontend#feature/abc-123-b'], reviewer: 'claude', model: 'sonnet' },
    }));
    assert.equal(one.reviews.length, 1);
    assert.equal(one.reviews[0].repo, 'my-frontend');
    assert.equal(one.reviews[0].model, 'sonnet');
    assert.deepEqual((stub.posts[1] as { targets: unknown[] }).targets, [
      { repo: 'my-frontend', branch: 'feature/abc-123-b', baseBranch: 'main', prNumber: 7 },
    ]);

    const missing = await client.callTool({
      name: 'start_review', arguments: { input: 'ABC-123', targets: ['other#nope'] },
    });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /Available: my-service#feature\/abc-123-a, my-frontend#feature\/abc-123-b/);

    // First status read: still running.
    const running = json(await client.callTool({ name: 'get_review', arguments: { id: 10 } }));
    assert.equal(running.status, 'reviewing');
    assert.equal(running.verdict, null);

    // The stub finishes after two polls; wait_for_review reports progress on the way.
    const progress: string[] = [];
    const waited = json(await client.callTool(
      { name: 'wait_for_review', arguments: { id: 10, timeoutSec: 30, pollSec: 1 } },
      undefined,
      { onprogress: (p) => { progress.push(p.message ?? ''); } },
    ));
    assert.equal(waited.finished, true);
    assert.equal(waited.status, 'done');
    assert.equal(waited.can_merge, false);
    assert.deepEqual(waited.findings.map((f: { severity: string }) => f.severity), ['blocker', 'minor', 'nit']);
    assert.ok(progress.length >= 1, 'expected at least one progress notification');

    // A wait that times out says so and tells the agent to call again.
    const slow = json(await client.callTool({ name: 'wait_for_review', arguments: { id: 11, timeoutSec: 1, pollSec: 1 } }));
    assert.equal(slow.finished, false);
    assert.match(slow.next, /again/);

    const invalid = await client.callTool({ name: 'get_review', arguments: { id: -1 } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await stub.close();
  }
});

test('stdio MCP server: guard inside a reviewer, and an unreachable API', { timeout: 60_000 }, async () => {
  const url = await closedPortUrl();
  const client = await connect({ CODE_REVIEW_API_URL: url, CODE_REVIEW_TOOL_REVIEWER: '1' });
  try {
    for (const [name, args] of [
      ['start_review', { input: 'ABC-123' }],
      ['rerun_review', { id: 1 }],
      ['cancel_review', { id: 1 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(text(result), /Refused/, name);
    }
    // Read-only tools stay available; here the API is down, which they report cleanly.
    const down = await client.callTool({ name: 'list_reviewers', arguments: {} });
    assert.equal(down.isError, true);
    assert.match(text(down), /not reachable at http:\/\/127\.0\.0\.1:\d+\. Is the server running\?/);
  } finally {
    await client.close();
  }
});
