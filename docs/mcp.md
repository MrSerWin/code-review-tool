# Use from other agents (MCP)

`dist/mcp.js` is a stdio [MCP](https://modelcontextprotocol.io) server, so a
coding agent (Claude Code, OpenAI Codex, Cursor, Grok, or any other MCP client)
can start reviews and follow them. It is a thin client of the HTTP API: the API
server must be running (`npm start`, or your service manager), and the MCP
process itself holds no token and reads no `.env`. It talks to
`CODE_REVIEW_API_URL`, default `http://127.0.0.1:5178`; when the API is down,
every tool returns an error saying so.

| tool | parameters | what it does |
|---|---|---|
| `list_reviewers` | | reviewer CLIs, whether each is installed, default model, model ids |
| `list_local_repos` | `repo?`, `maxBranches?` (default 30) | local clones: repo name, path, checked-out branch, default base, dirty state, branches with unpushed / ahead / behind |
| `detect_base` | `repo`, `branch` | the base a local branch would be diffed against (detected parent or default branch) |
| `start_review` | `input`, `reviewer?`, `model?`, `baseBranch?`, `includeWorkingTree?`, `requirementsText?`, `targets?` | start a review of any [input](usage.md#inputs); a ticket with several branches starts one review per branch, unless `targets` (`["repo#branch", …]`) narrows it; returns the review ids at once |
| `get_review` | `id`, `maxFindings?` (default 50) | status and, once done, verdict, `code_verdict`, `ticket_group` (the coverage seen from this branch), `can_merge`, requirements met/total (unmet ones with their checklist id), `proposed_requirements`, severity counts, findings (most severe first, capped; each with `kind`, `cause`, `anchor_status`, and `lens`, which is `tool` for a tool check) |
| `wait_for_review` | `id`, `timeoutSec?` (default 50, max 600), `pollSec?` (default 5), `maxFindings?` | poll until the review finishes or `timeoutSec` passes; returns `finished`, call again while it is `false` |
| `get_report` | `id`, `maxChars?` (default 40000) | the Markdown report of a finished review, truncated past `maxChars` |
| `list_reviews` | `q?`, `repo?`, `ticket?`, `group?`, `status?`, `limit?` (default 20) | recent runs, newest first; `status` is one status or `active` |
| `list_review_groups` | `q?`, `status?` (`active`, `failed`, `done`), `limit?` (default 10, max 50), `offset?` | the history grouped by ticket (see [Grouping](usage.md#the-web-ui)), with the latest run of each branch, paged |
| `cancel_review` | `id` | cancel a queued or running review |
| `start_ticket_review` | `ticket`, `reviewer?`, `model?`, `requirementsText?`, `branches?`, `refresh?` | review every branch of a ticket, parents first, each against its parent; returns the run id, the review ids, and notes |
| `wait_for_ticket_review` | `ticket`, `runId?`, `timeoutSec?` (default 50, max 600), `pollSec?`, `maxRequirements?` | poll until every run of the batch ended and its coverage was computed; returns `finished`, the chains with each branch's latest run and `code_verdict`, and the coverage |
| `get_ticket` | `ticket`, `maxRequirements?` | the chains, the latest run per branch, the coverage, `coverage_pending`, and the latest run |
| `get_ticket_coverage` | `ticket`, `recompute?`, `reviewer?`, `model?`, `maxRequirements?` | the coverage: verdict, and per requirement (by checklist id) its status and covering branches with evidence; `recompute: true` starts a pass |
| `get_ticket_requirements` | `ticket` | the stored checklist: items with ids (`R12`) and source, not verifiable notes, removed items |
| `set_ticket_requirements` | `ticket` + one of `add`, `user`, `items` (`[{id?, text}]`) | edit the checklist (append, replace user items, or set the whole list) |
| `derive_ticket_requirements` | `ticket`, `reviewer?`, `model?`, `timeoutSec?` | derive the checklist again and wait for it up to `timeoutSec` |
| `set_branch_parent` | `ticket`, `repo`, `branch` + `parent`, or `order` (+ `root?`) | set one branch's parent (null = default branch), or make the repository one chain in the given order |
| `rerun_review` | `id`, `reviewer?`, `model?` | run a review again, optionally with another reviewer or model |
| `list_recipes` | | preview recipes: name, roles (role -> repo), database, ready timeout; `enabled` is false when previews are off |
| `start_preview` | `recipe?`, `roles?` (`[{role, branch?, base?, local?}]`), `review_id?`, `ticket?`, `dump_mode?`, `reuse_live?` | start a [preview](previews.md#preview-environments-optional); a role runs a local branch with `branch: "local:<repo>#<branch>"` or `local: true`; `ticket` alone for a ticket group runs its preview plan (each repo's chain tip) and returns a live preview that already runs it (`reused: true`) unless `reuse_live: false`; returns the preview id at once |
| `get_ticket_preview_plan` | `ticket`, `recipe?` | what `start_preview` with only this ticket would run: per role the chain tip, its `source` and `chain`, or the base branch (`used_base`); `live_preview` that already runs it, `other_live`, `notes` |
| `get_preview` | `id`, `tail_logs?` | status, `web_url` and `links` (every exposed address, primary first) once ready, each role's branch, `source` (`github` / `local`) and commit, ports, data mode, expiry, error |
| `wait_for_preview` | `id`, `timeoutSec?` (default 50, max 600), `pollSec?` (default 5) | poll until the preview is ready or has ended; returns `finished`, call again while it is `false` |
| `stop_preview` | `id`, `timeoutSec?` (default 50, max 600) | stop a preview; waits up to `timeoutSec` for its teardown, which goes on in the server after that (`stopped=false`) |
| `list_previews` | `review_id?`, `ticket?`, `recipe?`, `status?` (one status or `live`), `limit?` (default 20) | recent previews, newest first |

A review takes minutes, so the usual flow is `start_review`, then
`wait_for_review` in a loop, then `get_review` or `get_report`. For a ticket
split into several branches: `start_ticket_review`, `wait_for_ticket_review` in
a loop, then `get_ticket`. Review results
carry each review's page URL in the web UI. A preview follows the same pattern:
`start_preview`, `wait_for_preview` until `finished`, open `web_url` (or an
entry of `links`, such as the backend or its admin), then
`stop_preview`. For a ticket group, `get_ticket_preview_plan` then
`start_preview` with only `ticket` previews the whole stack. `start_preview`,
`stop_preview` and the review mutations are refused inside a reviewer.

Build first (`npm run build`), then register the server. Use an absolute path to
`node` if the agent is a GUI app that does not see your shell's `PATH` (nvm).

**Claude Code**

```bash
claude mcp add --scope user code-review -- node <path-to-repo>/dist/mcp.js
```

**OpenAI Codex** — `~/.codex/config.toml` (or `codex mcp add code-review -- node <path-to-repo>/dist/mcp.js`,
then add the timeouts):

```toml
[mcp_servers.code-review]
command = "node"
args = ["<path-to-repo>/dist/mcp.js"]
startup_timeout_sec = 20
# wait_for_review blocks for up to its timeoutSec (default 50 s).
tool_timeout_sec = 120
```

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "code-review": {
      "command": "node",
      "args": ["<path-to-repo>/dist/mcp.js"]
    }
  }
}
```

**Grok CLI**

```bash
grok mcp add code-review -- node <path-to-repo>/dist/mcp.js
```

Grok also picks up servers registered for Claude Code and Cursor.

When the API is unreachable (nothing listens at the address), the error
suggests `launchctl kickstart -k gui/$UID/com.code-review-tool.server`; that only
applies if you run the server as a launchd agent with that label. Otherwise
start it however you normally do. A request the server accepted but did not
answer in time (a slow ticket lookup, say), or whose connection dropped, is
reported as still working, without that hint: check `get_preview`,
`list_previews` or `list_reviews` instead of retrying. Never restart the server
while previews or reviews are live; a restart tears down every live preview and
fails every running review.

**Reviews cannot use it.** The reviewer CLIs are the same agents, so every
review run keeps MCP servers out: Claude Code runs with `--strict-mcp-config`
(and no `--mcp-config`), Codex with `--ignore-user-config`, Cursor Agent without
`--approve-mcps` in a checkout no server was ever approved for, and Grok with its
MCP dispatcher tools (`search_tool`, `use_tool`) disallowed, every MCP tool
denied (`--deny 'mcp__*'`), and its Claude, Cursor, and managed MCP imports
switched off. As a second line of defence each reviewer process gets
`CODE_REVIEW_TOOL_REVIEWER=1`, and the MCP server refuses `start_review`,
`rerun_review`, `cancel_review`, `start_ticket_review`, `set_branch_parent`,
`get_ticket_coverage` with `recompute`, `start_preview`, and `stop_preview`
when it sees it; the read-only tools stay available.
