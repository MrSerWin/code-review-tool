# code-review-tool

A local, read-only code-review tool. Give it a ticket key, a GitHub pull request
URL, `repo#branch`, or `local:repo#branch` for a branch that is not pushed yet.
It resolves the matching branches, fetches them into an isolated Docker sandbox,
reviews them against the ticket requirements with the agent CLI you pick
(Claude Code, Cursor Agent, OpenAI Codex, or the Grok CLI), stores the run in
SQLite, and writes a Markdown report.

Tickets can come from Linear, Jira, GitHub Issues, Azure DevOps, or YouTrack —
whichever you configure. With none configured you paste the requirements
instead, and everything else works the same.

The tool never modifies the reviewed code, never pushes, and never comments
back on any of them. Reports are local files; what you do with them is up to
you.

How it is built inside is described in [docs/design.md](docs/design.md).

## How a review works

1. **Resolve.** The input is turned into one or more `repo` + `branch` targets
   (see [Inputs](#inputs)). A ticket key is looked up in whichever tracker
   claims it; its pull-request links and any branch whose name contains the
   ticket key are collected. A pull request URL is exactly that pull request's
   branch.
2. **Fetch.** Each branch is cloned inside the Docker sandbox, together with its
   base branch. The checkout's remote and credentials are then stripped.
   A `local:` target is copied from your clone instead (read-only mount); its
   base is the branch's detected parent (see below) or the default branch.
3. **Review.** A reviewer CLI runs against the checkout with every write tool
   disabled. Choose **Claude Code** (`claude`), **Cursor Agent**
   (`cursor-agent`), **OpenAI Codex** (`codex`), or the **Grok CLI** (`grok`),
   and a model from that CLI's own list. Every review is five lens passes run in
   parallel — correctness, security, tests, contracts, regressions — plus a
   synthesis pass that verifies their candidate findings against the code.
   The reviewer restates the ticket as a requirement list, reads the diff and
   the surrounding code, honours the reviewed repository's own `CLAUDE.md` /
   `AGENTS.md` conventions, and returns a structured JSON verdict.
4. **Report.** The verdict, requirement checklist, findings, and non-blocking
   observations are stored in SQLite and rendered to a Markdown report.

## Prerequisites

- Docker, running. The git sandbox image is built from `docker/Dockerfile.git`.
- Node 20 or newer.
- At least one reviewer CLI, installed and authenticated:
  - **Claude Code** — the `claude` CLI, logged in.
  - **Cursor Agent** — the `cursor-agent` CLI, logged in via
    `cursor-agent login` or `CURSOR_API_KEY`.
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

`src/config.ts` validates the environment at startup and is the source of
truth for every default; `.env.example` lists each variable with its default.

| var | required | default | meaning |
|---|---|---|---|
| `REVIEW_GH_TOKEN` | yes | — | GitHub token with read access to the allowed repositories; only ever handed to the Docker sandbox |
| `GITHUB_ORG` | yes | — | GitHub organization or user that owns the repositories |
| `ALLOWED_REPOS` | yes | — | Comma-separated repository names, e.g. `my-service,my-frontend`; nothing else can be fetched |
| `PORT` | no | `5178` | API and UI port, bound to `127.0.0.1` |
| `DATA_DIR` | no | `<repo>/data` | Where the database, checkouts, reports, and preview scratch directories live |
| `DEFAULT_REVIEWER` | no | `claude` | Default reviewer: `claude`, `cursor`, `codex`, or `grok` |
| `CLAUDE_BIN` | no | `claude` | Path to the Claude Code CLI |
| `REVIEW_MODEL` | no | `opus` | Default model when the reviewer is Claude |
| `CURSOR_BIN` | no | `cursor-agent` | Path to the Cursor Agent CLI |
| `CURSOR_REVIEW_MODEL` | no | `auto` | Default model when the reviewer is Cursor |
| `CURSOR_API_KEY` | no | — | Cursor API key handed to the Cursor CLI only (otherwise it uses its own login) |
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

The tracker variables (`LINEAR_API_KEY`, `JIRA_*`, `AZURE_*`, `YOUTRACK_*`,
`DEFAULT_TRACKER`) are listed under [Ticket trackers](#ticket-trackers), the
`PREVIEW_*` variables under [Preview environments](#preview-environments-optional).
`REVIEW_GH_TOKEN`, `GITHUB_ORG`, and `ALLOWED_REPOS` have no defaults; the
server and the CLI refuse to start without them.

A few variables are read outside `src/config.ts`:

| var | read by | default | meaning |
|---|---|---|---|
| `LOG_LEVEL` | server, CLI | `info` | Log threshold: `debug`, `info`, `warn`, or `error` |
| `CODEX_HOME` | server, CLI | `~/.codex` | Where the Codex model list (`models_cache.json`) is read from; also passed to Codex review processes (and only to them), so a review uses the same Codex login and models |
| `CODE_REVIEW_API_URL` | MCP server | `http://127.0.0.1:5178` | Where the [MCP server](#use-from-other-agents-mcp) finds the API. The MCP process does not load `.env`; set it in the agent's MCP server entry |
| `PORT` | web dev server | `5178` | `npm run dev` proxies `/api` to this port, read from the shell environment, not from `.env`: export it too when you change the API port |

`CODE_REVIEW_TOOL_REVIEWER` is set by the tool on every reviewer process it
starts (see [the recursion guard](#use-from-other-agents-mcp)); never set it
yourself.

### Reviewers

Four agent CLIs can drive a review. They are interchangeable: the same prompts,
the same five lenses, the same JSON verdict.

| reviewer | CLI | what makes the run read-only |
|---|---|---|
| `claude` | `claude -p` | `--allowed-tools` limited to `Read`, `Grep`, `Glob` and `git diff` / `log` / `show` / `status`; `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task` explicitly disallowed; `--strict-mcp-config` with no `--mcp-config`, so no MCP server loads |
| `cursor` | `cursor-agent --print` | `--mode plan --sandbox enabled`; no `--approve-mcps`, and every review runs in a fresh checkout no MCP server was ever approved for, so none loads |
| `codex` | `codex exec` | `-s read-only` (the sandbox refuses every write and every network call), `--ephemeral` so the run leaves no session behind, and `--ignore-user-config` so no MCP server, plugin, or personal default from `~/.codex/config.toml` applies; login still works |
| `grok` | `grok -p` | `--permission-mode plan --disable-web-search --no-subagents`; `--disallowed-tools` removes every write, scheduler, sub-agent, image and video, workflow, ask-the-user, and MCP dispatcher (`search_tool`, `use_tool`) tool; `--deny 'mcp__*'`; and `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED`, `GROK_MANAGED_MCPS_ENABLED` are set to `false` |

On top of that, all four get a scrubbed environment and a checkout with no
remote, the checkout is verified unchanged after every run, and no MCP server is
reachable from a run (see [Use from other agents](#use-from-other-agents-mcp)).

**Models.** Each reviewer has its own model list and its own default
(`REVIEW_MODEL`, `CURSOR_REVIEW_MODEL`, `CODEX_REVIEW_MODEL`,
`GROK_REVIEW_MODEL`). The list is asked of the CLI where it can answer —
`cursor-agent --list-models`, `grok models`, and Codex's own
`$CODEX_HOME/models_cache.json` — and is a short static list for Claude Code
(`opus`, `sonnet`, `haiku`), which has no such command. When a CLI cannot
answer, a short built-in fallback list is shown. The lists are cached for ten
minutes per process, and the model field always stays free text: any id the
CLI accepts works, listed or not.

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
| Linear | `linear:` | `LINEAR_API_KEY` | `ABC-123`, `https://linear.app/<workspace>/issue/ABC-123[/<slug>]` |
| Jira Cloud | `jira:` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | `ABC-123`, `https://<site>.atlassian.net/browse/ABC-123`, a board link with `?selectedIssue=ABC-123` |
| GitHub Issues | `github:` | none beyond `GITHUB_ORG` and `REVIEW_GH_TOKEN` | `my-org/my-service#123`, an issue URL |
| Azure DevOps | `azure:` | `AZURE_ORG_URL`, `AZURE_PROJECT`, `AZURE_PAT` | `123`, `#123`, `https://dev.azure.com/<org>/<project>/_workitems/edit/123` (or `<org>.visualstudio.com`, or a board link with `?workitem=123`) |
| YouTrack | `youtrack:` | `YOUTRACK_BASE_URL`, `YOUTRACK_TOKEN` | `ABC-123`, `https://<host>/issue/ABC-123[/<slug>]` |

An issue link is read as the key it names, and its host says which tracker it
belongs to, so a link never needs a prefix or `DEFAULT_TRACKER`. A link only
counts on a host of its tracker: `linear.app`, `*.atlassian.net`,
`*.youtrack.cloud`, `*.myjetbrains.com`, `dev.azure.com`, `*.visualstudio.com`,
or the host of the configured `JIRA_BASE_URL`, `YOUTRACK_BASE_URL`, or
`AZURE_ORG_URL` (a self-hosted tracker). `http://`, `www.`, a trailing slash, a
query, a fragment, and `<…>` around it are all fine.

Linear, Jira, and YouTrack all read `ABC-123` the same way. If more than one of
them is configured, set `DEFAULT_TRACKER` to the one that should win, or say it
per input with a prefix: `jira:ABC-123`. Without either, an ambiguous key is an
error that names the trackers involved.

`GET /api/health` lists the active tracker names, never their values.

### Reviewing without a tracker

You do not need a tracker at all. In the UI, open **Paste requirements
instead**, type what the branch is supposed to do, and give a pull request URL,
a tree URL, `repo#branch`, or a local branch as the input. The first line
becomes the title, the text becomes the requirements, and the run is stored
with no ticket key. From the terminal it is `--requirements`:

```bash
npm run review -- 'my-service#feature/example' --requirements "Reject expired tokens on refresh."
```

A branch reviewed with neither a ticket nor pasted requirements is still
reviewed: the reviewer infers the requirements from the branch name, the commit
messages, and the diff, and says so in the summary.

### Reviewing a local (unpushed) branch

Review a branch before you push it. Point `LOCAL_REPOS_DIR` at the directory
holding your clones (each named exactly like its `ALLOWED_REPOS` entry), or name
single clones in `LOCAL_REPOS`:

```bash
echo 'LOCAL_REPOS_DIR=/home/me/code' >> .env
npm run review -- 'local:my-service#feature/abc-123-example'
npm run review -- local:my-service --working-tree             # checked-out branch + uncommitted changes
npm run review -- 'local:my-service#feat/b' --base feat/a     # diff against an explicit base
```

- `local:<repo>#<branch>` reviews a local branch, pushed or not;
  `local:<repo>` reviews the clone's checked-out branch.
- The base defaults to the branch's **detected parent**, so a stacked branch
  (`main` → `feat/a` → `feat/b`) is reviewed for its own changes only. The
  closest branch whose tip the reviewed branch contains wins (the default
  branch only when it is strictly closer; among equally close candidates the
  newest tip). If none does, a local branch the reviewed one forked from and
  which has moved on since is used; otherwise the repository's default branch
  (`origin/HEAD`, else `origin/main`/`master`, else `main`/`master`).
  Branches already merged into the default branch never count, and a branch
  the reflog shows was cut *from* the reviewed one is never taken for its
  parent. `--base <branch>` (UI: the **Base** field; MCP: `baseBranch`)
  overrides it; the chosen base must exist in the clone, locally or as
  `origin/<base>`, and cannot be the branch itself.
  `GET /api/local-repos/<repo>/parent?branch=<name>` shows what was detected.
- A default-branch base is fetched fresh from GitHub inside the sandbox, so the
  diff is measured against the base as it is now; if GitHub cannot be reached,
  the clone's own `origin/<base>` is used and the log says so. Any other base
  may be unpushed, so it is copied from the clone (its local branch, else its
  `origin/<base>`).
- `--working-tree` (UI: **Include uncommitted changes**; MCP:
  `includeWorkingTree`) adds staged, unstaged, and untracked (non-ignored)
  files as one synthetic "working tree snapshot" commit on top of the branch,
  so the reviewer sees them as part of the change. It only works for the
  checked-out branch. Untracked symlinks and files over 5 MB (50 MB in total)
  are skipped, with a warning in the log.
- A re-run reads the clone again, so commits made since are picked up. It keeps
  the stored base; the parent is not detected again.
- The report says `Source: local clone (unpushed)`, the base and how it was
  picked (`detected parent`, `chosen`, or `default`), and whether working-tree
  changes were included; `head` is the branch tip in the clone.
- In the UI, switch the launcher to **Local**: pick a repository and a branch
  (the current one first, unpushed and ahead/behind marked). The **Base**
  field is prefilled with the detected parent and can be changed.
  `GET /api/local-repos` returns the same data.
- A local review's **Preview** card copies the reviewed branch from the clone
  again; see [Local branches in a preview](#local-branches-in-a-preview).

## Usage

Development, with hot reload:

```bash
npm run dev   # API on 127.0.0.1:5178, web dev server on 127.0.0.1:5179
```

Built:

```bash
npm run build && npm start   # http://127.0.0.1:5178
```

### Inputs

Every entry point — the UI, the CLI, `POST /api/reviews`, and the MCP
`start_review` tool — accepts the same inputs:

| input | what is reviewed |
|---|---|
| `ABC-123`, or `jira:ABC-123` to pick the tracker, or the ticket's issue link ([which](#ticket-trackers)) | every branch of the ticket: the pull requests it links to (each against its PR base), plus every branch of an allowed repository whose name contains the key (any case, dash optional: `abc123`) or equals the ticket's branch name (against the default branch). One review per branch |
| `https://github.com/my-org/my-service/pull/12` (trailing `/files`, `?…`, `#…` allowed) | exactly that pull request's head branch, against the PR's base branch |
| `my-org/my-service#12` (optionally `github:my-org/my-service#12`) | that pull request's branch, as above; when number 12 is an issue rather than a PR, the issue is read as a GitHub Issues ticket and its branches are collected as for `ABC-123` |
| an issue URL, `https://github.com/my-org/my-service/issues/12` | the GitHub issue as a ticket, as for `ABC-123` |
| `https://github.com/my-org/my-service/tree/<branch>` | that branch, against the repository's default branch |
| `my-service#<branch>` | the same |
| `local:my-service#<branch>`, `local:my-service` | a branch of your local clone; see [above](#reviewing-a-local-unpushed-branch) |

Pasted links are normalized first: surrounding whitespace and `<…>` are
dropped, and `http://` or `www.github.com` become `https://github.com/`. The
organization must be `GITHUB_ORG` and the repository must be in
`ALLOWED_REPOS`; anything else is refused.

A pull request never fans out: before the ticket lookup runs, a PR reference is
resolved to that one branch. Its requirements come from, in order, the pasted
requirements; the tracker ticket whose key its branch name carries
(`feat/abc-123-x` → `ABC-123`, when a configured tracker claims it); or else the
pull request's own title and description. A tree URL or `repo#branch` takes the
pasted requirements or the ticket in its branch name, and otherwise runs with
the requirements inferred from the change.

### The web UI

- **Reviews** (`/`) — the launcher and the history. Pick **GitHub** or
  **Local**, a reviewer, and a model (all three remembered per browser). A ticket key
  or issue link is resolved first (a link is named under the field as you
  paste it, e.g. "Linear ticket ABC-123"): the ticket, the tracker that
  answered, and every branch it found are shown with checkboxes, and **Start
  review** starts one run per picked branch. Any other input starts right away.
- **History** — **By ticket** (default, 20 groups a page) shows one compact row
  per group: the key (linking to the ticket page, with ↗ to the tracker), the
  title, `N branches · M runs`, one outcome badge, and the last activity. The
  badge is "N active" while anything runs, else the worst latest verdict of its
  branches (blocked, then changes requested, then approved), else the latest
  status; its tooltip has the breakdown. A row expands to its branches, each
  with its GitHub links and latest outcome, and that branch's runs newest
  first (five, then "N older runs"). **All runs** is the flat list, 25 runs a
  page. The filter matches ticket key and title, repository, branch, and group
  key. The chosen view is remembered, and the list refreshes every 4 s while
  something on screen is running.
- **Links in run tables** — in every table of runs (All runs, an expanded
  group, the ticket page) the branch opens on GitHub in a new tab and
  **PR #n ↗** opens its pull request when the run knows one, while the row and
  the run number open the review page. A local run's branch link warns that it
  may not be pushed.
- **Review page** (`/review/<id>`) — the verdict banner, links to GitHub
  (**PR #n** when the run knows its pull request, **Branch**, and **Diff**:
  GitHub's compare view of `base...branch`; the head and base shas link to
  their commits), the requirement checklist, findings by severity,
  observations, what changed since the previous finished run of the branch
  (resolved, new, persistent findings), the live log, and the **Preview** card.
  A local run is marked "local run — GitHub may lag", since GitHub only shows
  what is pushed. **Open in Linear** (or Jira, YouTrack, Azure DevOps, GitHub)
  opens the ticket in its tracker, and the ticket key in the Run card has a ↗
  to it as well; neither shows for pasted requirements. Actions: **Cancel** while it runs; afterwards **Re-run**,
  **Download**, **Copy report**, and **Delete**.
- **Ticket page** (`/ticket/<key>`) — every run of one group across
  repositories, grouped by repository and branch, newest first.
- **Previews** (`/previews`) — only when previews are enabled; see
  [below](#preview-environments-optional).

**Grouping.** A run belongs to the group of its ticket key. A run with no
ticket key (pasted requirements, or none) joins the group of the first
ticket-like key in its branch name — `feat/abc-123-export` → `ABC-123` — so it
lands next to the runs of that ticket. Version and encoding markers and generic
words with a counter (`v2-1`, `utf-8`, `sha-256`, `node20-…`, `step-2`,
`release-4`, `fix-1`, …) and "projects" longer than 10 characters are not taken
for a key. A run with neither is its own `repo#branch` group. A pull request
reviewed as its own ticket groups under `my-org/my-service#12`.

**Re-running.** A re-run is a new run of the same repository, branch, base, and
ticket (or pasted requirements), with the next run number. The reviewer and
model default to the previous run's; pick another reviewer or model to override
them. A model id belongs to one CLI, so switching the reviewer without naming a
model uses that reviewer's default model. Every run of a branch hands the
blocker and major findings of the branch's previous finished run to the
reviewer, which reports whether each one is fixed.

### Command line

```bash
npm run review -- ABC-123
npm run review -- 'my-service#feature/abc-123-example'
npm run review -- https://github.com/my-org/my-service/pull/12 --reviewer codex
npm run review -- --help
```

Put `--` after `npm run review` so npm passes options through, and quote inputs
that contain `#`.

| option | meaning |
|---|---|
| `--reviewer <name>` | `claude`, `cursor`, `codex`, or `grok`; default `DEFAULT_REVIEWER` |
| `--model <name>` | model for the chosen reviewer; default that reviewer's default model |
| `--requirements <text>` | review against these requirements instead of a ticket |
| `--working-tree` | local inputs only: also review the clone's uncommitted and untracked changes (checked-out branch only) |
| `--base <branch>` | local inputs only: the branch to diff against; default the detected parent |
| `--list-models [reviewer]` | list the reviewers, whether each CLI is installed, and their models, then exit |
| `--quiet` | print only the final result and report paths |
| `-h`, `--help` | show the help |

The CLI streams progress, prints the report path of every run, and exits `0`
only when every review finished and says the branch can be merged; `1` when a
review failed, was cancelled, or reported `can_merge = false`; `2` on bad usage
or an input that resolved to no branch.

The CLI runs reviews in its own process against the same `DATA_DIR`; it does
not need the server, and both may run at once. Every queued or running review
belongs to the process that started it (recorded as `runner_pid` with that
process's start time), because each process keeps its queue in memory. When
the CLI starts, it fails only reviews whose owner is gone — and stops the
reviewer processes those left running; a running server's reviews, and rows
written before owners were recorded, are left alone. Ctrl+C (or SIGTERM) fails
the CLI's own reviews ("interrupted: the CLI was stopped") and stops their
reviewer processes: SIGTERM, then SIGKILL after 3 s. A second Ctrl+C skips the
wait.

## HTTP API

The UI is a client of this API, which listens on `127.0.0.1:PORT` without
authentication. Errors come back as `{ "error": "…" }` with a 4xx or 5xx status.

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, version, dockerImage, trackers, reviewers, defaultReviewer, repos, previews }`; tracker names and the repository count only, reviewers without model lists |
| GET | `/api/reviewers` | | `{ reviewers, defaultReviewer }`; each reviewer with `name`, `label`, `bin`, `available`, `defaultModel`, `models` |
| GET | `/api/repos` | | `{ repos }`: the allowed repository names |
| GET | `/api/repos/:repo/branches` | `?q=` | `{ repo, defaultBranch, branches, total, truncated }`: remote branches, default first, then alphabetical, at most 200; listed in the sandbox and cached for a minute |
| GET | `/api/local-repos` | | `{ repos, unavailable }`: configured local clones with their checked-out branch, default base, dirty state, and branches (unpushed, ahead, behind) |
| GET | `/api/local-repos/:repo/parent` | `?branch=` | `{ branch, base, reason, distance, defaultBase }`: the detected parent; `reason` is `ancestor`, `fork-point`, or `default` |
| GET | `/api/tickets/<input>` | | `{ ticket, targets }`: what any [input](#inputs) resolves to, without starting anything (URL-encode the input, slashes included; at most 512 characters, as for `POST /api/reviews`) |
| POST | `/api/reviews` | `{ input, targets?, reviewer?, model?, requirementsText?, includeWorkingTree?, baseBranch? }` | `201 { reviews }`: one queued run per target; `targets` narrows a ticket to some of its branches |
| GET | `/api/reviews` | `?q=&ticket=&repo=&branch=&group=&limit=&offset=` | `{ reviews, total }`, newest first; `limit` 1–500, default 50; each row has `links: { branch, pr }`, its GitHub URLs (`pr` null without a PR number) |
| GET | `/api/review-groups` | `?q=&status=active\|failed\|done&limit=&offset=` | `{ groups, total }`, most recently active group first; `limit` 1–100, default 20; each branch has `prNumber` (the newest any of its runs knew) and `links: { branch, pr }` |
| GET | `/api/reviews/:id` | | `{ review, requirements, findings, observations, logs, comparison, links }`; `links` holds the GitHub URLs (`repo`, `branch`, `pr`, `compare`, `head`, `base`) |
| GET | `/api/reviews/:id/report` | | the Markdown report (`text/markdown`) |
| GET | `/api/reviews/:id/events` | | server-sent events: `status`, `log`, and `done` messages |
| POST | `/api/reviews/:id/rerun` | `{ reviewer?, model? }` | `201 { review }`: a new run of the same branch |
| POST | `/api/reviews/:id/cancel` | | `{ review }`; `409` when it is not queued or running |
| DELETE | `/api/reviews/:id` | | `{ ok: true }`; cancels it if needed, deletes the row and the report file |
| GET | `/api/recipes` | | `{ enabled, dir, recipes, errors }`: loaded preview recipes, and every invalid one with the reason |
| GET | `/api/previews` | `?reviewId=&ticket=&recipe=&limit=&offset=` | `{ previews, total }`, newest first; `limit` 1–500, default 50 |
| GET | `/api/previews/:id` | | `{ preview, logs }` |
| POST | `/api/previews` | `{ reviewId?, ticket?, recipe?, roles?, dumpMode? }`; `roles: [{ role, branch?, base?, local? }]`, a local branch as `local: true` or `branch: "local:<repo>#<branch>"` | `201 { preview }`, queued; `400` when a role, branch or local branch does not exist; `409` when previews are disabled |
| POST | `/api/previews/:id/stop` | | `{ preview }` at once, `stopping` while `down` runs in the background (follow it with `GET /api/previews/:id`); a second stop joins the running one; an ended preview is returned as it is |
| DELETE | `/api/previews/:id` | | `{ ok: true }`: stops it first, then deletes the row and its scratch directory |
| GET | `/api/previews/:id/events` | | server-sent events: `status`, `log`, and `ready` messages |

`status` on `/api/review-groups` is judged per group: `active` when a run is
queued, fetching, or reviewing; `failed` when the latest run of one of its
branches failed; `done` when nothing is running or failed and at least one
branch has a verdict.

## Use from other agents (MCP)

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
| `start_review` | `input`, `reviewer?`, `model?`, `baseBranch?`, `includeWorkingTree?`, `requirementsText?`, `targets?` | start a review of any [input](#inputs); a ticket with several branches starts one review per branch, unless `targets` (`["repo#branch", …]`) narrows it; returns the review ids at once |
| `get_review` | `id`, `maxFindings?` (default 50) | status and, once done, verdict, `can_merge`, requirements met/total, severity counts, findings (most severe first, capped) |
| `wait_for_review` | `id`, `timeoutSec?` (default 50, max 600), `pollSec?` (default 5), `maxFindings?` | poll until the review finishes or `timeoutSec` passes; returns `finished`, call again while it is `false` |
| `get_report` | `id`, `maxChars?` (default 40000) | the Markdown report of a finished review, truncated past `maxChars` |
| `list_reviews` | `q?`, `repo?`, `ticket?`, `group?`, `status?`, `limit?` (default 20) | recent runs, newest first; `status` is one status or `active` |
| `list_review_groups` | `q?`, `status?` (`active`, `failed`, `done`), `limit?` (default 10, max 50), `offset?` | the history grouped by ticket (see [Grouping](#the-web-ui)), with the latest run of each branch, paged |
| `cancel_review` | `id` | cancel a queued or running review |
| `rerun_review` | `id`, `reviewer?`, `model?` | run a review again, optionally with another reviewer or model |
| `list_recipes` | | preview recipes: name, roles (role -> repo), database, ready timeout; `enabled` is false when previews are off |
| `start_preview` | `recipe?`, `roles?` (`[{role, branch?, base?, local?}]`), `review_id?`, `ticket?`, `dump_mode?` | start a [preview](#preview-environments-optional); a role runs a local branch with `branch: "local:<repo>#<branch>"` or `local: true`; returns the preview id at once |
| `get_preview` | `id`, `tail_logs?` | status, `web_url` and `links` (every exposed address, primary first) once ready, each role's branch, `source` (`github` / `local`) and commit, ports, data mode, expiry, error |
| `wait_for_preview` | `id`, `timeoutSec?` (default 50, max 600), `pollSec?` (default 5) | poll until the preview is ready or has ended; returns `finished`, call again while it is `false` |
| `stop_preview` | `id`, `timeoutSec?` (default 50, max 600) | stop a preview; waits up to `timeoutSec` for its teardown, which goes on in the server after that (`stopped=false`) |
| `list_previews` | `review_id?`, `ticket?`, `recipe?`, `status?` (one status or `live`), `limit?` (default 20) | recent previews, newest first |

A review takes minutes, so the usual flow is `start_review`, then
`wait_for_review` in a loop, then `get_review` or `get_report`. Review results
carry each review's page URL in the web UI. A preview follows the same pattern:
`start_preview`, `wait_for_preview` until `finished`, open `web_url` (or an
entry of `links`, such as the backend or its admin), then
`stop_preview`. `start_preview`, `stop_preview` and the review mutations are
refused inside a reviewer.

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
`rerun_review`, `cancel_review`, `start_preview`, and `stop_preview` when it
sees it; the read-only tools stay available.

## Preview environments (optional)

A preview runs branches as a real, clickable stack on local ports, started from
the UI and torn down on demand or when its time to live runs out. There is no
manual step between the click and a working URL. Previews involve no AI: no
reviewer CLI is started and nothing is reviewed; the engine fetches branches
through the same Docker sandbox as a review and runs your recipe's commands.

The tool itself knows nothing about any product: what to start lives in a
**recipe** — a directory with a `recipe.json` naming the repositories (one per
role, such as `backend` and `frontend`), the ports to allocate, where the
database comes from, and the shell commands for `prepare`, `up`, `health` and
`down`. `recipes.example/` holds one documented, product-neutral sample;
`recipes/` is gitignored so a real recipe never lands in the repository.

```bash
cp -r recipes.example/example-app recipes/example-app
$EDITOR recipes/example-app/recipe.json
echo 'PREVIEW_ENABLED=1' >> .env
```

Then `GET /api/recipes` lists what loaded, together with any recipe that failed
validation and why. See [recipes.example/README.md](recipes.example/README.md)
for every variable a step receives and for running an app's background
workers.

**Starting one.** From a review page's **Preview** card, or from the
**Previews** page with a ticket key, a PR URL, `repo#branch`, or
`local:repo#branch`. Once a preview leaves the queue it goes through:

1. **Checkouts.** Each role gets its branch (see below): the review's own
   checkout when it is still on disk (for a local role only when it holds the
   very commit the role runs), otherwise a fresh fetch in the sandbox (a local
   role is copied from the clone instead). A branch that has since
   been deleted on the remote (merged, say) falls back to its base branch,
   with a warning.
2. **Ports.** One free host port per recipe port, from `PREVIEW_PORT_RANGE`.
3. **Data.** The freshest source that works: a `pg_dump` of a live database
   (run with the host's `pg_dump`), otherwise the newest dump file in a
   directory, otherwise a clean install. An unreachable database never blocks
   a preview; the mode that actually happened is shown in the UI, and a
   **data:** choice per launch can force one.
4. **`prepare`**, then **`up`**, then **`health`**, polled every 3 s until every
   command exits 0.

All of that shares the recipe's `readyTimeoutSec`. Then the preview is
**ready**: the UI shows the primary port's link first, every other port link
(labels and paths from the recipe's `ports`, see
[recipes.example](recipes.example/README.md#ports-and-links)) and the recipe's
credentials hint, and its time to live starts. `down` runs on stop, on failure
or timeout, on expiry, and after a restart; it must succeed even when nothing
was started.

**Which branch each role runs.**

- Started from a review: the reviewed branch for its repository. The other
  roles take their branches from the review's ticket; when the review has no
  tracker ticket (only a pull request, or none), from the ticket key the
  reviewed branch's name carries.
- Started from an input: the input is resolved like a review input. A PR URL
  names one branch of one repository, so when its branch name carries a ticket
  key of a configured tracker, that ticket is resolved too and its branches in
  the other repositories join the preview. The PR's own branch still wins for
  its repository.
- A role whose repository has no branch in the ticket runs its base (default)
  branch, marked `usedBase` in the API and "base branch" in the UI, instead of
  silently previewing code the ticket never touched.

**Custom branches.** To combine branches yourself — say a backend branch from
one ticket with a frontend branch from another, or a backend branch with the
frontend's base branch — switch the Previews page to **Custom branches** (or use
**Custom…** on a review's Preview card, prefilled with the reviewed branch and
the branches the last preview ran) and pick a branch per role; branch names are
suggested from the remote (`GET /api/repos/<repo>/branches?q=`). Over the API
that is `POST /api/previews` with
`roles: [{ "role": "backend", "branch": "feat/abc-1" }]` (a role may also carry
a `base`). Every role must exist in the recipe and every branch on its
repository, or the request is refused before anything is queued. A role with
an empty branch runs its base branch. A role left out runs, when a ticket or
review is given too, the branch that resolves to, otherwise its base branch;
when every role is given, no ticket is looked up at all.

#### Local branches in a preview

A role can run a branch of a [local clone](#reviewing-a-local-unpushed-branch)
that was never pushed. The input follows the review convention:

- API and MCP: `{ "role": "backend", "branch": "local:my-service#feat/x" }`, or
  `{ "role": "backend", "branch": "feat/x", "local": true }`. The repo in
  `local:<repo>#…` must be the role's own. `local:<repo>` alone, or `local: true`
  with no branch, runs the clone's checked-out branch.
- UI: in **Custom branches** (or **Custom…** on a Preview card), tick **Local**
  on a role; its branch list then comes from the clone, unpushed branches
  marked.
- A ticket input `local:<repo>#<branch>` works too: that branch runs for its
  repo, and when its name carries a ticket key, the ticket's branches on GitHub
  join for the other repos.
- A local review's Preview card runs the reviewed commit from the review's
  checkout while that is on disk; otherwise the branch is copied from the clone
  again at its current tip, so it must still be there. Roles picked by hand
  never need the reviewed branch: **Custom…** works after it was pushed and
  pruned.

The branch is read through the main clone's refs, so a branch checked out in a
`git worktree` of that clone works as well. The sandbox copies the committed
tip (`refs/heads/<branch>`, read-only mount, as for a local review); uncommitted
changes in the clone or any worktree are never included, and a review checkout
that holds a working-tree snapshot, or an older commit than the branch tip
picked by hand, is not reused. A branch or base missing from
the clone is refused with a `400` before anything is queued. Each role records
`source` (`github` or `local`) and the commit it ran (`sha`); the UI tags local
roles **local** and shows no GitHub link for them.

| variable | default | meaning |
|---|---|---|
| `PREVIEW_ENABLED` | `0` | `1`, `true`, `yes`, or `on` turns the feature on |
| `PREVIEW_RECIPES_DIR` | `<repo>/recipes` | where recipes live, one `<name>/recipe.json` each |
| `PREVIEW_PORT_RANGE` | `21000-21999` | host ports the engine may allocate, inclusive, within 1024–65535 |
| `PREVIEW_TTL_MINUTES` | `120` | how long a preview stays up after it became ready; a reaper checks every 30 s and stops expired ones |
| `PREVIEW_MAX_CONCURRENT` | `3` | previews being started (checkouts through `health`) at once; the rest wait in the queue and show their position. A ready preview no longer counts |

**Restarts.** Neither reviews nor previews survive a restart of the server; the
queues live in memory. On SIGTERM or SIGINT the server fails its queued and
running reviews ("interrupted by shutdown") and stops their reviewer
processes — SIGTERM, then SIGKILL after 3 s — before it exits; a second signal
skips the wait. The reviewer CLIs run in their own process groups, so without
this they would keep running unobserved. When the server is killed outright
(SIGKILL, a crash), the next start does the same cleanup: it fails every review
whose owning process is gone ("interrupted by restart"), plus reviews written
before owners were recorded, and stops the reviewer processes recorded for
them that are still running — only when a process still leads its process
group, still runs the recorded reviewer binary, and started when the review
says it did, so a reused pid is never killed. A review owned by a running CLI
is left alone. Re-run what was interrupted. With previews enabled the start
also runs `down` for every preview that was queued, preparing, starting,
ready, or stopping, and marks it stopped ("interrupted by restart"), so a
restart takes down live previews, ready ones included. Stopping the server
without starting it again leaves preview stacks running until the next start.
Restart when nothing is running.

## Where things live

- `data/review.db` — run history, findings, requirements, observations, logs,
  and previews (SQLite).
- `data/reports/<ticket|repo>/<repo>__<branch>/run-N-<timestamp>.md` — reports.
- `data/checkouts/` — temporary checkouts, removed after a successful review
  (kept after a failure, for inspection).
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
  get a scrubbed environment built from an allowlist (`PATH`, `HOME`, `SHELL`,
  locale, `USER`, `TMPDIR`, XDG directories), with `GH_TOKEN`, `GITHUB_TOKEN`,
  `REVIEW_GH_TOKEN`, and every tracker token removed. After each run the
  checkout is verified to be unchanged; a modified checkout fails the review.
- **A local clone is only ever read.** For `local:` reviews the host runs only
  read-only git commands in your clone (`rev-parse`, `symbolic-ref`,
  `for-each-ref`, `merge-base`, `rev-list`, `log --walk-reflogs`, `status`,
  `diff`, `ls-files`), via `execFile` with
  `GIT_OPTIONAL_LOCKS=0` so not even the index is refreshed. The review
  checkout is made inside the Docker sandbox, where the clone is bind-mounted
  **read-only** at `/src` and copied with `git clone --no-local` (a real object
  copy: no hardlinks, no alternates). The base branch is fetched (from GitHub,
  or from the read-only mount) into that copy, never into your clone; the copy
  then loses its remotes like any other checkout. Nothing is fetched, checked
  out, committed, or configured in your clone. Only
  `<LOCAL_REPOS_DIR>/<allowed name>` (or an explicit `LOCAL_REPOS` entry for an
  allowed name) is ever read.
- **The allowlist bounds what can be fetched at all.** Only
  `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` is
  accepted, both in the Node process and again in the container entrypoint,
  which refuses any argument pointing at another host or organization.
- **Preview steps get no tokens either.** Recipe commands run with the same
  allowlisted, token-free environment as a reviewer (without the reviewer
  marker `CODE_REVIEW_TOOL_REVIEWER`: a step is not a reviewer), plus the
  variables the engine sets and the recipe's own `env` block.
- **The server is local.** It binds to `127.0.0.1` only and has no
  authentication, because it is not reachable from outside the machine.

## License

MIT. See [LICENSE](LICENSE).
