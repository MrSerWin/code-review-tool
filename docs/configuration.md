# Configuration

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


## Environment

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
| `REVIEW_MODEL` | no | first discovered Claude model | Default Claude model: a listed alias or any full model name |
| `ANTHROPIC_API_KEY` | no | unset | Only lists Claude models from the Anthropic Models API; never passed to a review |
| `CURSOR_BIN` | no | `cursor-agent` | Path to the Cursor Agent CLI |
| `CURSOR_REVIEW_MODEL` | no | first model of `cursor-agent --list-models` | Picks the Cursor default among the listed models; an unlisted id is ignored with a warning |
| `CURSOR_API_KEY` | no | — | Cursor API key handed to the Cursor CLI only (otherwise it uses its own login) |
| `CODEX_BIN` | no | `codex` | Path to the OpenAI Codex CLI |
| `CODEX_REVIEW_MODEL` | no | first model in the Codex model cache | Picks the Codex default among the models in `$CODEX_HOME/models_cache.json`; an unlisted id is ignored with a warning |
| `GROK_BIN` | no | `grok` | Path to the Grok CLI |
| `GROK_REVIEW_MODEL` | no | first model of `grok models` | Picks the Grok default among the listed models; an unlisted id is ignored with a warning |
| `REVIEW_TIMEOUT_MS` | no | `1800000` | Hard timeout for one review process (each lens and the synthesis pass) |
| `REVIEW_CONCURRENCY` | no | `2` | How many reviews run at once. Each review fans out to 5 lens processes plus a synthesis pass, so the process ceiling is this value * 6 |
| `COVERAGE_DEBOUNCE_MS` | no | `15000` | How long ticket coverage waits after a branch review of the group settles, so a batch is covered once |
| `DOCKER_BIN` | no | `docker` | Path to the Docker CLI |
| `GIT_IMAGE` | no | `code-review-tool-git:latest` | Sandbox image tag |
| `LOCAL_REPOS_DIR` | no | — | Directory holding local clones named like the `ALLOWED_REPOS` entries; enables [local reviews](usage.md#reviewing-a-local-unpushed-branch) |
| `LOCAL_REPOS` | no | — | Per-repo clone paths overriding `LOCAL_REPOS_DIR`: `name=/abs/path,other=/abs/path` |
| `RULES_DIR` | no | `<repo>/rules` | [Repository rules and tool checks](#repository-rules-and-tool-checks): `<repo>.md`, `_all.md`, `<repo>.json`; read on every review |

The tracker variables (`LINEAR_API_KEY`, `JIRA_*`, `AZURE_*`, `YOUTRACK_*`,
`DEFAULT_TRACKER`) are listed under [Ticket trackers](#ticket-trackers), the
`PREVIEW_*` variables under [Preview environments](previews.md#preview-environments-optional).
`REVIEW_GH_TOKEN`, `GITHUB_ORG`, and `ALLOWED_REPOS` have no defaults; the
server and the CLI refuse to start without them.

A few variables are read outside `src/config.ts`:

| var | read by | default | meaning |
|---|---|---|---|
| `LOG_LEVEL` | server, CLI | `info` | Log threshold: `debug`, `info`, `warn`, or `error` |
| `CODEX_HOME` | server, CLI | `~/.codex` | Where the Codex model list (`models_cache.json`) is read from; also passed to Codex review processes (and only to them), so a review uses the same Codex login and models |
| `CODE_REVIEW_API_URL` | MCP server | `http://127.0.0.1:5178` | Where the [MCP server](mcp.md#use-from-other-agents-mcp) finds the API. The MCP process does not load `.env`; set it in the agent's MCP server entry |
| `PORT` | web dev server | `5178` | `npm run dev` proxies `/api` to this port, read from the shell environment, not from `.env`: export it too when you change the API port |

`CODE_REVIEW_TOOL_REVIEWER` is set by the tool on every reviewer process it
starts (see [the recursion guard](mcp.md#use-from-other-agents-mcp)); never set it
yourself.

## Reviewers

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
reachable from a run (see [Use from other agents](mcp.md#use-from-other-agents-mcp)).

**Models.** No model id is built into the tool: every list is discovered at
runtime, and each reviewer's default is the first discovered model unless its
`*_REVIEW_MODEL` picks another listed one.

| reviewer | where the list comes from (`source`) | when it is empty |
|---|---|---|
| `claude` | the Anthropic Models API (`api`, paginated) when `ANTHROPIC_API_KEY` is set; else the model catalog Claude Code caches per account in `~/.claude/cache/model-catalog/` (`cli-cache`: aliases first, then the full ids, without models disabled for the plan or newer than the installed CLI); else the alias examples of `claude --help` (`cli-help`) | run `claude` once, or set `ANTHROPIC_API_KEY`; a full model name can still be typed, since `--model` documents it |
| `cursor` | `cursor-agent --list-models` (`cli`) | install it, `cursor-agent login` or `CURSOR_API_KEY` |
| `codex` | `$CODEX_HOME/models_cache.json` (`cli-cache`) | `codex login` or one `codex` run |
| `grok` | `grok models` (`cli`) | install it, `grok login` |

A reviewer with nothing discoverable reports an empty list with that hint,
never an invented id. Lists are cached for ten minutes per process; "Refresh
models" next to the model pickers (Home, the re-run control, the ticket page),
`GET /api/reviewers?refresh=1`, and the MCP tool `list_reviewers` with
`refresh: true` discover them again now. Every start (web, API, MCP, CLI,
re-run, coverage and requirement passes started by hand) checks the model
against the reviewer's list before anything is queued, re-reading the list once
on a miss; an unlisted model is refused with the available ids. Claude Code is
the exception: it also takes a full model name typed by hand. A model carried
over from an earlier run that is no longer listed gives way to the default.

From the terminal:

```bash
npm run review -- --list-models         # every reviewer, availability, models
npm run review -- --list-models codex   # just one of them
```

`GET /api/reviewers` returns the same thing to the UI: per reviewer `models`,
the resolved `defaultModel`, `source`, `fetchedAt`, and `noModelsHint`.
`GET /api/health` reports the reviewers without their model lists, so it stays
cheap.

## Repository rules and tool checks

Both are optional and configured per repository in `RULES_DIR` (default
`<repo>/rules`, gitignored; a documented sample is in
[rules.example/](../rules.example/README.md)). Files are read on every review, so
an edit applies to the next run without a restart; a missing file means no
rules or no checks.

**Rules.** `<repo>.md` (and `_all.md`, for every repository) is added to the
lens and synthesis prompts as a "Repository rules (binding)" section right
after the ticket. It is the binding summary of the repository's own
`CLAUDE.md` / `AGENTS.md` and wins where they differ; a finding that rests on
a rule cites it in `why`. Name the customer-facing docs in it: a behaviour
change that leaves a customer doc stale is `major`, a stale internal doc
`minor`.

**Tool checks.** `<repo>.json` enables deterministic checks, run on the host
checkout (read-only git, nothing is fetched or checked out) after the lenses
and before synthesis:

```json
{ "checks": { "migration-collision": true, "diff-size": { "maxFiles": 40 } } }
```

A check runs when its key is present and not `false`; `true` or `{}` takes the
defaults; unknown keys are rejected and an invalid file runs no checks. The
same file may set `contractGlobs` (top level, next to `checks`): the contract
files of the ticket coverage's [cross-repository contract](usage.md#tickets-split-into-several-branches) check.

| check | result | config keys (default) |
|---|---|---|
| `migration-collision` | `major` finding: a migration the branch adds whose number already exists in the same app directory on the base commit, the base tip, the default branch as last fetched in the local clone, or a sibling branch of the ticket group (its review checkout, else the local clone) | `globs` (`apps/*/migrations/[0-9][0-9][0-9][0-9]_*.py`) |
| `data-migration-idempotence` | observation: a new migration with `RunPython` that creates rows without `get_or_create`, `update_or_create` or an existence check | `globs` (as above) |
| `forbidden-paths` | `blocker` for env/venv paths, `major` for other patterns and for files above the size limit, among added or modified paths | `blockerPatterns` (`.venv/`, `venv/`, `.env`), `patterns` (`node_modules/`, `__pycache__/`, `*.pyc`, `.DS_Store`), `maxFileBytes` (5 MB) |
| `em-dash` | `minor` finding per file: an em dash in an added line of a user-facing file | `globs` (required), `excludeGlobs` (test files: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/tests/**`, `**/test_*.py`; an explicit list replaces it, `[]` checks tests too) |
| `commit-identity` | `minor` finding, no location: commits in base..HEAD whose author matches neither an allowed address nor an allowed domain (case-insensitive), or with a Claude/Anthropic co-author trailer or "Generated with Claude" | `allowedEmails`, `allowedDomains` (at least one entry in either) |
| `doc-update-heuristic` | observation: behaviour files changed and no customer doc did | `behaviourGlobs`, `docGlobs` (both required) |
| `diff-size` | observation: more changed files than the limit; consider a stack of smaller branches | `maxFiles` (40) |

Globs are gitignore-like: a pattern without `/` matches a file name at any
depth, a trailing `/` matches a path segment at any depth (a `.venv` symlink
included), `**` spans directories, and `[0-9]` and `{a,b}` work.

Tool results carry `lens: "tool"` and their check id in the title. Synthesis
sees them as a "Tool checks (deterministic, already verified)" section and is
told not to repeat them; the tool appends them to the final findings and
observations itself, so synthesis cannot drop them, and they count toward the
verdict and `can_merge` like any other finding. The web UI shows a `tool`
badge, the report lists them under "Tool checks", and `get_review` returns
`lens` on every finding. A check that fails is logged and skipped; it never
fails the review.

## Ticket trackers

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
