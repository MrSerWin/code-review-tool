#!/usr/bin/env node
/**
 * stdio MCP server: lets other coding agents (Claude Code, Codex, Cursor, Grok)
 * start code reviews and follow them.
 *
 * It is a thin HTTP client of the running API (`CODE_REVIEW_API_URL`, default
 * http://127.0.0.1:5178). It must never import `config.ts` or anything that
 * needs REVIEW_GH_TOKEN / GITHUB_ORG: the MCP process holds zero secrets.
 *
 * stdout carries the MCP protocol only. Diagnostics go to stderr.
 *
 * Recursion guard: the reviewer CLIs spawned by the review runner get
 * CODE_REVIEW_TOOL_REVIEWER=1, and this server refuses start/rerun/cancel when
 * it sees it. Some CLIs do not forward their environment to MCP subprocesses,
 * so the reviewer argv also disables user MCP servers (see src/reviewers/*.ts);
 * this check is the second line of defence.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient, apiBaseUrl } from './mcp/client.js';
import { REVIEWER_ENV_FLAG } from './mcp/format.js';
import { createMcpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const api = new ApiClient(apiBaseUrl());
  const server = createMcpServer({ api });
  await server.connect(new StdioServerTransport());
  const guard = process.env[REVIEWER_ENV_FLAG] ? ' (inside a reviewer: start/rerun/cancel refused)' : '';
  process.stderr.write(`code-review-tool MCP server ready; API ${api.baseUrl}${guard}\n`);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`code-review-tool MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
