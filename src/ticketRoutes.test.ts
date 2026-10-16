import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

// Nothing here should touch the database, but never risk the real DATA_DIR.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-tickets-'));
process.env.DATA_DIR = dataDir;
const { ticketRoutes } = await import('./routes/tickets.js');
const { config } = await import('./config.js');

const app = Fastify({ logger: false });
await app.register(ticketRoutes);

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The path the UI and the MCP server request: the input, URL-encoded. */
const ticketPath = (input: string): string => `/api/tickets/${encodeURIComponent(input)}`;

test('a long PR URL with slashes reaches the resolver intact', async () => {
  // Over the router's 100-character limit for a named parameter, and full of
  // slashes. The repository is not allowed, so the resolver refuses it before
  // any network call; that error proves the whole input arrived.
  const repo = `not-allowed-${'x'.repeat(150)}`;
  const input = `https://github.com/test-org/${repo}/pull/12`;
  const res = await app.inject({ method: 'GET', url: ticketPath(input) });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, new RegExp(repo));
});

test('an org/repo#N input reaches the resolver', async () => {
  const res = await app.inject({ method: 'GET', url: ticketPath('other-org/my-service#12') });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /configured organization/);
});

test('an unencoded slash is part of the input too', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/tickets/other-org/my-service%2312' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /configured organization/);
});

test('inputs over 512 characters and empty inputs are refused', async () => {
  const tooLong = await app.inject({ method: 'GET', url: ticketPath(`ABC-${'1'.repeat(520)}`) });
  assert.equal(tooLong.statusCode, 400);
  const empty = await app.inject({ method: 'GET', url: '/api/tickets/' });
  assert.equal(empty.statusCode, 400);
});

test('a tracker issue link resolves as its tracker, even when that tracker is not configured', async (t) => {
  // Configured, the link would be fetched; this test must stay offline.
  if (config.YOUTRACK_BASE_URL && config.YOUTRACK_TOKEN) return t.skip('YouTrack is configured in .env');
  const res = await app.inject({
    method: 'GET',
    url: ticketPath('https://acme.youtrack.cloud/issue/ABC-123/add-export'),
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /youtrack tracker is not configured.*YOUTRACK_BASE_URL/);
});

test('an issue-like link on an unrelated host is not a ticket', async () => {
  const res = await app.inject({ method: 'GET', url: ticketPath('https://example.com/issue/ABC-123') });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /^Unsupported input/);
});
