# code-review-tool

A local, read-only code-review tool. Give it a ticket key, a GitHub pull request
URL, `repo#branch`, or `local:repo#branch` for a branch that is not pushed yet. It resolves the matching branches, fetches them into an
isolated Docker sandbox, runs a Claude Code review against the ticket
requirements, stores the run in SQLite, and writes a Markdown report.

Tickets can come from Linear, Jira, GitHub Issues, Azure DevOps, or YouTrack —
whichever you configure. With none configured you paste the requirements
instead, and everything else works the same.

The tool never modifies the reviewed code, never pushes, and never comments
back on any of them. Reports are local files; what you do with them is up to
you.

## How a review works

1. **Resolve.** The input is turned into one or more `repo` + `branch` targets.
   A ticket key is looked up in whichever tracker claims it; its pull-request
   links and any branch whose name contains the ticket key are collected.
2. **Fetch.** Each branch is cloned inside the Docker sandbox, together with its
   base branch. The checkout's remote and credentials are then stripped.
   A `local:` target is copied from your clone instead (read-only mount); its
   base is the branch's detected parent (see below) or the default branch.
3. **Review.** A reviewer CLI runs against the checkout with edit tools
   disabled. Choose **Claude Code** (`claude`), **Cursor Agent**
   (`cursor-agent`), **OpenAI Codex** (`codex`), or the **Grok CLI** (`grok`),
   and a model from that CLI's own list. Each runs five parallel lens passes
   plus a synthesis pass.
   The reviewer restates the ticket as a requirement list, reads the diff and
   the surrounding code, honours the reviewed repository's own `CLAUDE.md` /
   `AGENTS.md` conventions, and returns a structured JSON verdict.
4. **Report.** The verdict, requirement checklist, and findings are stored in
   SQLite and rendered to a Markdown report.

## Prerequisites

- Docker, running. The git sandbox image is built from `docker/Dockerfile.git`.
- Node 20 or newer.
- At least one reviewer CLI, installed and authenticated:
  - **Claude Code** — the `claude` CLI, logged in.
  - **Cursor Agent** — the `cursor-agent` CLI (or `cursor agent`), logged in via
    `cursor agent login` or `CURSOR_API_KEY`.
  - **OpenAI Codex** — the `codex` CLI, logged in via `codex login`.
  - **Grok** — the `grok` CLI, logged in via `grok login`.

  A CLI that is not installed is shown as such and cannot be selected; the
  others keep working.
- Optionally, credentials for a ticket tracker (see below).
- A GitHub token with read access (`repo` scope) to the repositories you want to
  review. Use a dedicated read-only token, not your everyday personal one.

## Setup

```bash
cp .env.example .env   # then fill it in
npm run setup          # installs both workspaces and builds the sandbox image
```

### Environment

| var | required | default | meaning |
|---|---|---|---|
| `REVIEW_GH_TOKEN` | yes | — | GitHub token with read access to the allowed repositories |
| `GITHUB_ORG` | yes | — | GitHub organization or user that owns the repositories |
| `ALLOWED_REPOS` | yes | — | Comma-separated repository names, e.g. `my-service,my-frontend` |
| `PORT` | no | `5178` | API port, bound to `127.0.0.1` |
| `DATA_DIR` | no | `<repo>/data` | Where the database, checkouts, and reports live |
| `CLAUDE_BIN` | no | `claude` | Path to the Claude Code CLI |
| `REVIEW_MODEL` | no | `opus` | Default model when the reviewer is Claude |
| `DEFAULT_REVIEWER` | no | `claude` | Default reviewer: `claude`, `cursor`, `codex`, or `grok` |
| `CURSOR_BIN` | no | `cursor-agent` | Path to the Cursor Agent CLI |
| `CURSOR_REVIEW_MODEL` | no | `auto` | Default model when the reviewer is Cursor |
| `CURSOR_API_KEY` | no | — | Optional Cursor API key (otherwise uses CLI login) |
| `CODEX_BIN` | no | `codex` | Path to the OpenAI Codex CLI |
| `CODEX_REVIEW_MODEL` | no | `gpt-5.5` | Default model when the reviewer is Codex |
| `GROK_BIN` | no | `grok` | Path to the Grok CLI |
| `GROK_REVIEW_MODEL` | no | `grok-4.7` | Default model when the reviewer is Grok |
| `REVIEW_TIMEOUT_MS` | no | `1800000` | Hard timeout for one review process (each lens and the synthesis pass) |
| `REVIEW_CONCURRENCY` | no | `2` | How many reviews run at once. Each review fans out to 5 lens processes plus a synthesis pass, so the process ceiling is this value * 6 |
| `DOCKER_BIN` | no | `docker` | Path to the Docker CLI |
| `GIT_IMAGE` | no | `code-review-tool-git:latest` | Sandbox image tag |
| `LOCAL_REPOS_DIR` | no | — | Directory holding local clones named like the `ALLOWED_REPOS` entries; enables [local reviews](#reviewing-a-local-unpushed-branch) |
| `LOCAL_REPOS` | no | — | Per-repo clone paths overriding `LOCAL_REPOS_DIR`: `name=/abs/path,other=/abs/path` |

`GITHUB_ORG` and `ALLOWED_REPOS` have no defaults; the server refuses to start
without them.

### Reviewers

Four agent CLIs can drive a review. They are interchangeable: the same prompts,
the same five lenses, the same JSON verdict.

| reviewer | CLI | what makes the run read-only |
|---|---|---|
| `claude` | `claude` | `--allowed-tools` limited to `Read`/`Grep`/`Glob` and read-only `git` commands; `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task` explicitly disallowed; `--strict-mcp-config` loads no MCP server |
| `cursor` | `cursor-agent` | `--mode plan --sandbox enabled`; no `--approve-mcps`, so no MCP server loads |
| `codex` | `codex exec` | `-s read-only` (the sandbox refuses every write and every network call), plus `--ephemeral` so the run leaves no session behind, and `--ignore-user-config` so no MCP server, plugin, or personal default (reasoning effort, notify hook) from `~/.codex/config.toml` applies; login still works |
| `grok` | `grok` | `--permission-mode plan --disable-web-search --no-subagents`, plus `--disallowed-tools` removing every write, scheduler, sub-agent, image, workflow, ask-the-user, and MCP dispatcher (`search_tool`, `use_tool`) tool, and `--deny 'mcp__*'` |

On top of that, all four get a scrubbed environment and a checkout with no
remote, the checkout is verified unchanged after every run, and no MCP server is
reachable from a run (see [Use from other agents](#use-from-other-agents-mcp)).

**Models.** Each reviewer has its own model list and its own default
(`REVIEW_MODEL`, `CURSOR_REVIEW_MODEL`, `CODEX_REVIEW_MODEL`,
`GROK_REVIEW_MODEL`). The list is asked of the CLI where it can answer —
`cursor-agent --list-models`, `grok models`, and Codex's own
`~/.codex/models_cache.json` — and is a short static list for Claude Code,
which has no such command. The lists are cached for ten minutes per process,
and the model field always stays free text: any id the CLI accepts works, listed
or not.

From the terminal:

```bash
npm run review -- --list-models         # every reviewer, availability, models
npm run review -- --list-models codex   # just one of them
```

`GET /api/reviewers` returns the same thing to the UI. `GET /api/health` reports
the reviewers without their model lists, so it stays cheap.

### Ticket trackers

Every tracker is optional. A tracker is active only when all of its variables
are set, and a missing one is reported only when you actually use it.

| tracker | prefix | variables | recognises |
|---|---|---|---|
| Linear | `linear:` | `LINEAR_API_KEY` | `ABC-123` |
| Jira Cloud | `jira:` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | `ABC-123`, a `/browse/ABC-123` URL |
| GitHub Issues | `github:` | none beyond `GITHUB_ORG` and `REVIEW_GH_TOKEN` | `my-org/my-service#123`, an issue URL |
| Azure DevOps | `azure:` | `AZURE_ORG_URL`, `AZURE_PROJECT`, `AZURE_PAT` | `123`, `#123`, a `_workitems/edit/123` URL |
| YouTrack | `youtrack:` | `YOUTRACK_BASE_URL`, `YOUTRACK_TOKEN` | `ABC-123`, an `/issue/ABC-123` URL |

Linear, Jira, and YouTrack all read `ABC-123` the same way. If more than one of
them is configured, set `DEFAULT_TRACKER` to the one that should win, or say it
per input with a prefix: `jira:ABC-123`. Without either, an ambiguous key is an
error that names the trackers involved.

`GET /api/health` lists the active tracker names, never their values.

### Reviewing without a tracker

You do not need a tracker at all. In the UI, open **Paste requirements
instead**, type what the branch is supposed to do, and give a pull request URL,
a tree URL, or `repo#branch` as the input. The first line becomes the title, the
text becomes the requirements, and the run is stored with no ticket key. From
the terminal it is `--requirements`:

```bash
npm run review my-service#feature/example --requirements "Reject expired tokens on refresh."
```

### Reviewing a local (unpushed) branch

Review a branch before you push it. Point `LOCAL_REPOS_DIR` at the directory
holding your clones (each named exactly like its `ALLOWED_REPOS` entry), or name
single clones in `LOCAL_REPOS`:

```bash
echo 'LOCAL_REPOS_DIR=/home/me/code' >> .env
npm run review -- local:my-service#feature/abc-123-example
npm run review -- local:my-service --working-tree   # checked-out branch + uncommitted changes
npm run review -- local:my-service#feat/b --base feat/a   # diff against an explicit base
```

- `local:<repo>#<branch>` reviews a local branch, pushed or not;
  `local:<repo>` reviews the clone's checked-out branch.
- The base defaults to the branch's **detected parent**, so a stacked branch
  (`main` → `feat/a` → `feat/b`) is reviewed for its own changes only. The
  closest branch whose tip the reviewed branch contains wins (ties go to the
  non-default branch); if none does, a branch the reviewed one forked from
  and which has moved on since is used; otherwise the repository's default
  branch (`origin/HEAD`, else `origin/main`/`master`, else `main`/`master`).
  Branches already merged into the default branch never count, and a branch
  the reflog shows was cut *from* the reviewed one is never taken for its
  parent. `--base <branch>` (UI: the **Base** field) overrides it.
  `GET /api/local-repos/<repo>/parent?branch=<name>` shows what was detected.
- A default-branch base is fetched fresh from GitHub inside the sandbox, so the
  diff is measured against the base as it is now; if GitHub cannot be reached,
  the clone's own `origin/<base>` is used and the log says so. Any other base
  may be unpushed, so it is copied from the clone (its local branch, else its
  `origin/<base>`).
- A re-run keeps the stored base; it is not detected again.
- `--working-tree` (UI: **Include uncommitted changes**) adds staged,
  unstaged, and untracked (non-ignored) files as one synthetic
  "working tree snapshot" commit on top of the branch, so the reviewer sees
  them as part of the change. It only works for the checked-out branch.
  Untracked symlinks and files over 5 MB (50 MB in total) are skipped, with a
  warning in the log.
- A re-run reads the clone again, so commits made since are picked up.
- The report says `Source: local clone (unpushed)`, the base and how it was
  picked (`detected parent`, `chosen`, or `default`), and whether working-tree
  changes were included; `head` is the branch tip in the clone.
- In the UI, switch the launcher to **Local**: pick a repository and a branch
  (the current one first, unpushed and ahead/behind marked). The **Base**
  field is prefilled with the detected parent and can be changed.
  `GET /api/local-repos` returns the same data.
- Previews are not available for local reviews: a preview fetches from GitHub.

## Usage

Development, with hot reload:

```bash
npm run dev   # API on 127.0.0.1:5178, web dev server on 127.0.0.1:5179
```

Built:

```bash
npm run build && npm start   # http://127.0.0.1:5178
```

In the UI, type a ticket key (`ABC-123`), a pull request URL, or `repo#branch`.
A prefix picks the tracker explicitly (`jira:ABC-123`).
For a ticket key the tool first shows the ticket and every branch it found, so
you can pick which ones to review. Each run has its own page with the verdict,
the requirement checklist, findings grouped by severity, and a live log.

From the terminal:

```bash
npm run review ABC-123
npm run review my-service#feature/abc-123-example
npm run review https://github.com/my-org/my-service/pull/12
```

The CLI streams progress, prints the report path, and exits `0` only when every
review says the branch can be merged.

## Use from other agents (MCP)

`dist/mcp.js` is a stdio [MCP](https://modelcontextprotocol.io) server, so a
coding agent (Claude Code, OpenAI Codex, Cursor, Grok, or any other MCP client)
can start reviews and follow them. It is a thin client of the HTTP API: the API
server must be running (`npm start`, or your service manager), and the MCP
process itself holds no token and reads no `.env`. It talks to
`CODE_REVIEW_API_URL`, default `http://127.0.0.1:5178`; when the API is down,
every tool returns an error saying so.

| tool | what it does |
|---|---|
| `list_reviewers` | reviewer CLIs, whether each is installed, default model, model ids |
| `list_local_repos` | local clones: repo name, path, checked-out branch, dirty state, branches with unpushed / ahead / behind |
| `detect_base` | the base a local branch would be diffed against (detected parent or default branch) |
| `start_review` | start a review of a ticket key, PR URL, `repo#branch`, or `local:repo#branch`; a ticket with several branches starts one review per branch (narrow it with `targets`) |
| `get_review` | status and, once done, verdict, `can_merge`, requirements met/total, severity counts, findings (capped) |
| `wait_for_review` | poll until the review finishes or `timeoutSec` (default 50) passes; returns `finished`, call again while it is `false` |
| `get_report` | the Markdown report of a finished review (truncated past `maxChars`) |
| `list_reviews` | recent reviews, filterable by text, repo, ticket, group, or status |
| `list_review_groups` | the history grouped by ticket (a key from the tracker or from the branch name, else `repo#branch`), with the latest run of each branch; filterable by text or status (`active`, `failed`, `done`), paged |
| `cancel_review` | cancel a queued or running review |
| `rerun_review` | run a review again, optionally with another reviewer or model |

A review takes minutes, so the usual flow is `start_review`, then
`wait_for_review` in a loop, then `get_review` or `get_report`.

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

**Reviews cannot use it.** The reviewer CLIs are the same agents, so every
review run keeps MCP servers out: Claude Code runs with `--strict-mcp-config`
(and no `--mcp-config`), Codex with `--ignore-user-config`, Cursor Agent without
`--approve-mcps` in a checkout no server was ever approved for, and Grok with its
MCP dispatcher tools (`search_tool`, `use_tool`) disallowed and every MCP tool
denied (`--deny 'mcp__*'`). As a second line of defence each reviewer process
gets `CODE_REVIEW_TOOL_REVIEWER=1`, and the MCP server refuses `start_review`,
`rerun_review`, and `cancel_review` when it sees it.

## Preview environments (optional)

A preview runs the reviewed branches as a real, clickable stack, started from
the UI and torn down on demand or when its time to live runs out. There is no
manual step between the click and a working URL.

The tool itself knows nothing about any product: what to start lives in a
**recipe** — a directory with a `recipe.json` naming the repositories, the ports
to allocate, where the database comes from, and the shell commands for
`prepare`, `up`, `health` and `down`. `recipes.example/` holds one documented,
product-neutral sample; `recipes/` is gitignored so a real recipe never lands in
the repository.

```bash
cp -r recipes.example/example-app recipes/example-app
$EDITOR recipes/example-app/recipe.json
echo 'PREVIEW_ENABLED=1' >> .env
```

Then `GET /api/recipes` lists what loaded, together with any recipe that failed
validation and why. See [recipes.example/README.md](recipes.example/README.md)
for every variable a step receives.

Data comes from the freshest source that works: a `pg_dump` of a live database,
otherwise the newest dump file in a directory, otherwise a clean install. An
unreachable database never blocks a preview; the mode that actually happened is
shown in the UI.

| variable | default | meaning |
|---|---|---|
| `PREVIEW_ENABLED` | `0` | turns the feature on |
| `PREVIEW_RECIPES_DIR` | `<repo>/recipes` | where recipes live |
| `PREVIEW_PORT_RANGE` | `21000-21999` | host ports the engine may allocate |
| `PREVIEW_TTL_MINUTES` | `120` | how long a preview stays up |
| `PREVIEW_MAX_CONCURRENT` | `3` | previews running at once; the rest queue |

## Where things live

- `data/review.db` — run history, findings, requirements, logs (SQLite).
- `data/reports/<ticket|repo>/<repo>__<branch>/run-N-<timestamp>.md` — reports.
- `data/checkouts/` — temporary checkouts, removed after a successful review.
- `data/previews/<id>/` — scratch directory of one preview environment.

The whole `data/` directory is gitignored and local only.

## Isolation model

- **Authenticated git runs only in Docker.** Every git or GitHub API call that
  needs the token runs inside the sandbox image, never on the host. The
  container gets its own `HOME`, its own `.gitconfig`, and the token via
  `-e GH_TOKEN`. Your git identity, SSH keys, `~/.gitconfig`, and `~/.claude`
  are never mounted into it, and nothing is written to your host git config.
- **The checkout cannot push.** After the fetch, `origin` is removed and
  `.git/config` is rewritten without any remote or credential helper. The
  checkout the reviewer sees has no way back to GitHub.
- **The reviewer has no write tools and no tokens.** Claude runs with
  `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, and
  `Task` disabled. Cursor runs in `--mode plan` with `--sandbox enabled`, Codex
  in its `read-only` sandbox, and Grok in `--permission-mode plan` with every
  write tool removed (see [Reviewers](#reviewers)). All four
  get a scrubbed environment with `GH_TOKEN`, `GITHUB_TOKEN`, `REVIEW_GH_TOKEN`,
  and every tracker token removed. After each run the checkout is verified to be
  unchanged; a modified checkout fails the review.
- **A local clone is only ever read.** For `local:` reviews the host runs only
  read-only git commands in your clone (`rev-parse`, `symbolic-ref`,
  `for-each-ref`, `merge-base`, `rev-list`, `log --walk-reflogs`, `status`,
  `diff`, `ls-files`), via `execFile` with
  `GIT_OPTIONAL_LOCKS=0` so not even the index is refreshed. The review
  checkout is made inside the Docker sandbox, where the clone is bind-mounted
  **read-only** at `/src` and copied with `git clone --no-local` (a real object
  copy: no hardlinks, no alternates). The base branch is fetched (from GitHub,
  or from the read-only mount) into that copy, never into your clone; the copy then loses its remotes like
  any other checkout. Nothing is fetched, checked out, committed, or configured
  in your clone. Only `<LOCAL_REPOS_DIR>/<allowed name>` (or an explicit
  `LOCAL_REPOS` entry for an allowed name) is ever read.
- **The allowlist bounds what can be fetched at all.** Only
  `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` is
  accepted, both in the Node process and again in the container entrypoint,
  which refuses any argument pointing at another host or organization.
- **The server is local.** It binds to `127.0.0.1` only and has no
  authentication, because it is not reachable from outside the machine.

## License

MIT. See [LICENSE](LICENSE).
