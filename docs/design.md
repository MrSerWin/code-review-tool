# Design

How the tool is put together, for anyone reading or extending the code. The
user-facing setup lives in [../README.md](../README.md).

## What it does

Input is a ticket key (`ABC-123`, optionally prefixed with its tracker as in
`jira:ABC-123`), a GitHub pull request URL, a tree URL, or `repo#branch` —
optionally with requirements pasted by hand instead of a ticket. The tool
resolves that into one or more `repo` + `branch` targets, fetches each one inside a Docker sandbox, runs a read-only Claude Code
review against the ticket requirements — five independent lens passes plus a
synthesis pass — stores the run in SQLite, and writes a Markdown report.

Two rules shape everything else:

- The reviewed code is never modified, and nothing is ever pushed or posted back
  to GitHub or any ticket tracker.
- Only `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` may
  be fetched. Anything else is rejected.

## Layout

```
package.json  tsconfig.json  .env.example  LICENSE  README.md
docker/Dockerfile.git  docker/entrypoint.sh
src/
  config.ts  types.ts  db.ts  logger.ts  events.ts
  prLinks.ts  resolver.ts  gitSandbox.ts  reviewRunner.ts  reportWriter.ts
  trackers/index.ts  trackers/types.ts  trackers/adf.ts  trackers/html.ts
  trackers/linear.ts  trackers/jira.ts  trackers/github.ts
  trackers/azure.ts  trackers/youtrack.ts
  queue.ts  cli.ts  server.ts
  preview/recipes.ts  preview/ports.ts  preview/database.ts
  preview/steps.ts  preview/engine.ts  preview/store.ts  preview/events.ts
  routes/reviews.ts  routes/tickets.ts  routes/repos.ts  routes/previews.ts
  prompts/common-preamble.md  prompts/lens-common.md
  prompts/lens-correctness.md  prompts/lens-security.md
  prompts/lens-tests.md  prompts/lens-contracts.md
  prompts/lens-regressions.md  prompts/synthesis.md
recipes.example/   # one documented, product-neutral preview recipe
recipes/           # gitignored: the real preview recipes
web/     # vite + react + ts, builds to web/dist
data/    # gitignored: review.db, checkouts/, reports/, previews/
```

Node 20, TypeScript, ESM. `tsx` for development, `tsc` for the build. Runtime
dependencies: `fastify`, `@fastify/static`, `better-sqlite3`, `zod`, `dotenv`.
The web app uses `react`, `react-dom`, and `vite`.

## Configuration (`src/config.ts`)

Environment is loaded from `.env` and validated with zod into a frozen `config`
object. Missing or malformed values throw at import time with the offending keys
listed, so the process never starts half-configured. The full variable table is
in the README.

The same module owns the allowlist:

- `ALLOWED_REPOS: readonly string[]` — parsed from the required `ALLOWED_REPOS`
  variable, comma-separated, trimmed, empty entries dropped. An empty result is
  a startup error.
- `assertAllowedRepo(name)` — throws unless the name is in the list.
- `assertAllowedRemote(url)` — throws unless the URL is
  `https://github.com/<GITHUB_ORG>/<allowed-repo>(.git)?`.
- `repoUrl(repo)` — builds the clone URL and re-checks it through
  `assertAllowedRemote` before returning it.

### Preview configuration

`PREVIEW_ENABLED` (default false) gates the whole feature. `PREVIEW_RECIPES_DIR`
(default `<repo>/recipes`), `PREVIEW_PORT_RANGE` (default `21000-21999`),
`PREVIEW_TTL_MINUTES` (default 120) and `PREVIEW_MAX_CONCURRENT` (default 3)
follow the same rule as everything else: the default lives in `src/config.ts`
and `.env.example` only lists it commented out.

## Isolation model

This is the part worth understanding before changing anything.

**Authenticated git never runs on the host.** `runInSandbox()` shells out to
`docker run --rm` with the sandbox image. The token is referenced by name in the
docker argv (`-e GH_TOKEN`) and supplied through the child process environment,
so it never appears in the host process list and is never written to disk on the
host. The only host path mounted is the checkout directory, at `/work`. The
container runs with `--user <host uid>:<host gid>` so the checkout stays readable
outside. Networking stays on the default bridge because fetching needs the
internet.

**The container re-checks the allowlist.** `docker/entrypoint.sh` fails fast if
`GH_TOKEN` or `GITHUB_ORG` is unset, and refuses to run if any argument
references a URL, an scp-style remote, or a `github.com` path outside
`github.com/$GITHUB_ORG`. It then writes an isolated `$HOME/.gitconfig` with a
throwaway identity, `safe.directory=*`, and a credential helper that echoes
`$GH_TOKEN`. This is defence in depth: the Node side already validates, and the
container validates again with no trust in its caller.

**The checkout is severed from its origin.** The clone deliberately avoids
`--filter`: a partial clone leaves blobs on a promisor remote, and the remote is
about to be removed, which would make `git log -p` and older blobs unreadable
offline. `--single-branch` keeps the download to the base branch plus the
reviewed branch. After fetching, `git rev-list --objects --all --missing=print`
must report zero missing objects — otherwise the reviewer would silently see a
truncated diff, and the run fails instead. Then `origin` is removed and
`.git/config` is rewritten by `scrubGitConfig()`, which drops whole
`[remote ...]` and `[credential ...]` sections plus any line carrying a token.
The scrub is section-aware on purpose: filtering line by line would orphan `url`
and `fetch` entries into the preceding section. A remaining remote is a hard
error.

**The reviewer is read-only and token-free.** `buildClaudeArgs()` allows only
`Read`, `Grep`, `Glob`, and read-only `Bash(git diff|log|show|status:*)`, and
explicitly disallows `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`,
`WebSearch`, and `Task`. `buildChildEnv()` builds the child environment from an
allowlist (`PATH`, `HOME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `USER`, `LOGNAME`,
`TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`) and deletes `GH_TOKEN`,
`GITHUB_TOKEN`, `REVIEW_GH_TOKEN`, and every tracker token (`LINEAR_API_KEY`,
`JIRA_API_TOKEN`, `AZURE_PAT`, `YOUTRACK_TOKEN`). `USER` is load-bearing
on macOS: without it the Claude CLI cannot read its credentials from the Keychain
and every review fails with "Not logged in". None of the passthrough variables
carry a secret. After the run, `assertPristine()` requires `git status
--porcelain` to be empty; a modified checkout invalidates the review.

**Names are inert.** Repo and branch names must match `[A-Za-z0-9._/-]+` and
must not contain `..`. Branch names are sanitised for filesystem paths by
replacing `/` with `__`. Everything is spawned with an argv array via
`execFile`, never through a shell string. GitHub API paths are checked against a
narrow character class and rejected if they contain `..` or a scheme.

**The server is local only.** Fastify binds to `127.0.0.1`. There is no auth
because there is no remote reachability.

## Trackers (`src/trackers/`)

A ticket source is a `TicketProvider`:

```ts
interface TicketProvider {
  readonly name: TrackerName;          // linear | jira | github | azure | youtrack
  readonly requiredEnv: readonly string[];
  isConfigured(): boolean;
  matches(input: string): boolean;
  getTicket(input: string): Promise<TicketInfo>;
}
```

Every provider returns the same `TicketInfo`, with `provider` naming who
produced it, so nothing downstream knows which tracker a review came from.

| provider | variables | reads |
|---|---|---|
| `linear` | `LINEAR_API_KEY` | one GraphQL POST to `api.linear.app`; description, state, `branchName`, attachments, comments |
| `jira` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | REST v3 `issue/{key}?fields=summary,description,status,comment` with HTTP Basic, plus the development panel |
| `github` | none beyond `GITHUB_ORG`, `REVIEW_GH_TOKEN` | `ghApi` inside the sandbox: `repos/{owner}/{repo}/issues/{n}` and its `/comments` |
| `azure` | `AZURE_ORG_URL`, `AZURE_PROJECT`, `AZURE_PAT` | `wit/workitems/{id}?$expand=all` with PAT Basic auth (empty user), plus `/comments` |
| `youtrack` | `YOUTRACK_BASE_URL`, `YOUTRACK_TOKEN` | `api/issues/{id}?fields=...` with a bearer token |

Jira descriptions and comments are Atlassian Document Format, not text, so
`trackers/adf.ts` flattens the tree to plain text with light Markdown:
paragraphs, headings, ordered and bullet lists with nesting, code blocks,
blockquotes, rules, tables, links, and text marks. An unknown node type is not
an error — it recurses into its `content`, so a node type Atlassian adds later
degrades to its text instead of disappearing. Jira's development information is
best effort: a token without that permission produces a warning in the log, not
a failed fetch. Azure DevOps fields are HTML, flattened by `trackers/html.ts`
(block tags become breaks, list items get a bullet, links keep their target,
entities are decoded, everything else is dropped).

`trackers/index.ts` is the registry. Only providers whose variables are all set
are active. For one input it picks, in order:

1. the provider named by an explicit prefix (`jira:ABC-123`); an unconfigured
   one is an error naming the variables to set;
2. the single active provider whose `matches()` returns true;
3. when several match a bare `ABC-123` — Linear, Jira, and YouTrack share that
   shape — the one named by `DEFAULT_TRACKER`.

If several match and `DEFAULT_TRACKER` names none of them, that is an error
listing the candidates and how to disambiguate. Guessing is never an option.
GitHub Issues need no variables beyond the ones the sandbox already requires,
so that provider is always active; every other tracker is opt-in. Configuring
none of them is not an error: the input then simply has to name a branch, with
the requirements pasted instead.

## Resolver (`src/resolver.ts`)

`resolveTargets(input, { requirementsText? })` returns `{ ticket, targets }`.

1. **Ticket key** - anything the registry claims. The ticket is fetched through
   its provider, then targets are collected from, in order:
   - pull request links, asking GitHub for each PR's head and base branch;
   - a remote branch scan: `git ls-remote --heads` on every allowlisted repo,
     keeping branches whose name matches the ticket key, plus an exact match on
     the ticket's `branchName`.

   Branch discovery is provider-agnostic: the key is just a string.
   `branchPattern(key)` handles `ABC-123` (project prefix, optional dash), a
   trailing number for GitHub issue and Azure work item keys, and otherwise
   matches the key literally. Targets are deduplicated by `repo` + `branch`.
   The base branch falls back to the repository's default branch, cached per
   process.
2. **`https://github.com/<org>/<repo>/pull/<n>`** - a single target from the PR's
   head and base.
3. **`https://github.com/<org>/<repo>/tree/<branch>`** or **`<repo>#<branch>`** -
   a single target; the ticket is looked up from the branch name if it contains a
   ticket-key token and some tracker claims it.

`requirementsText` replaces the tracker entirely: the ticket becomes a manual
`TicketInfo` (`provider: 'manual'`, empty `key`, title from the first line), no
lookup happens, and the input only has to name a branch. The empty key is what
stores `ticket_key` as `NULL`.

`src/prLinks.ts` is the provider-agnostic half of the old Linear module:
`parsePrUrls()` extracts `{ repo, prNumber }` from pull request URLs and
silently drops anything outside the organization or the allowlist, and
`collectPrUrls()` finds pull request links in the free text of trackers that
have no attachment list.

Anything else throws. If a ticket resolves to no branches, the error names what
was searched.

## Review runner (`src/reviewRunner.ts`)

One review is six `claude -p` processes, not one.

**Why.** A single pass produced zero findings on every real run. Three reasons:
the prompt banned nitpicking, so a reviewer noticing something non-blocking had
nowhere to put it; every finding fed the merge gate, so mentioning anything
blocked the merge; and one pass has whatever recall that one pass happens to
have, which varied run to run.

**Fan-out.** Five lenses run concurrently (`Promise.all`) against the same
checkout, each its own process with its own mandate:

| lens | mandate |
|---|---|
| `correctness` | logic errors, data integrity, migrations, transactions, error handling, data loss, edge cases |
| `security` | authz/authn, multi-tenant isolation, injection, secrets, information disclosure, unsafe defaults |
| `tests` | is the new behaviour actually covered, missing negative and edge cases, tests that assert nothing |
| `contracts` | API and response shape changes, backward compatibility, migrations versus consumers, stale documentation |
| `regressions` | what the rest of the repo depends on: call sites of changed or deleted symbols, shared-helper behaviour, migrations versus untouched readers, changed defaults and flags, tests encoding the old behaviour, widened or narrowed filters |

A lens returns only `{ findings, observations }`. Lenses do not evaluate ticket
requirements and do not emit a verdict: five passes deriving their own
requirement list produce five contradictory lists. A lens that fails twice is
recorded as failed and the review continues with the rest; if all five fail the
review fails. A cancel aborts the whole review instead of degrading it.

**Synthesis.** A sixth pass receives the ticket, the diff summary, and the five
lenses' raw JSON. Their claims are candidates, not facts: it must verify each
one against the code, drop what it cannot confirm, drop duplicates, assign the
final severities, derive the ticket requirement list with evidence, write the
summary and conclusion, and set `verdict` / `can_merge`. It returns the full
`ReviewOutput`. It is also told that a requirement marked `partial` or `missing`
must have either a matching finding or a sentence in the conclusion naming what
is missing — a "changes requested" with nothing to fix is a defect in the review
itself. Regression candidates are the one exception to "drop anything not about
the changed code": they point at untouched code on purpose, their `file` and
`line` are the dependent site rather than the changed line, and they are
verified there.

**Observations** are the second half of the fix: remarks a reviewer would leave
as a PR comment but would not block a merge on. They are stored and rendered but
never touch `verdict` or `can_merge`. Each lens is told that an empty findings
list is a legitimate answer, that inventing a defect is worse than reporting
none, and that anything it genuinely noticed but cannot call a defect belongs in
`observations`.

**Prompts.** The shared context — ticket, repo, branch, base sha, changed files,
previous findings, and the hard rules (never modify files, plain simple English,
every finding needs a file and a line, do not invent requirements, honour the
reviewed repository's own `CLAUDE.md` / `AGENTS.md`) — lives once in
`common-preamble.md`. `lens-common.md` adds the severity scale, the
finding-versus-observation contract, and the lens JSON shape. A lens prompt is
`common-preamble.md` + `lens-<name>.md` + `lens-common.md`; the synthesis prompt
is `common-preamble.md` + `synthesis.md`. `renderTemplate()` substitutes
`{{TICKET}}`, `{{REPO}}`, `{{BRANCH}}`, `{{BASE_SHA}}`, `{{CHANGED_FILES}}`,
`{{PREVIOUS_FINDINGS}}` and, for synthesis, `{{LENS_OUTPUTS}}`, and throws if any
placeholder is left unresolved.

**Per process.** Every process — lens and synthesis alike — gets the same
scrubbed environment from `buildChildEnv()` and the same read-only tool set from
`buildClaudeArgs()`. `stream-json` output is parsed line by line; assistant text
and tool names are forwarded to the log, prefixed with the lens name, and lens
start and completion are logged as `lens security: started` /
`lens security: 2 findings, 1 observation`. The final `type: "result"` message
carries the answer. The JSON payload is extracted from the last fenced `json`
block, falling back to the last balanced `{...}`, and validated with zod; on
failure the pass retries once with a corrective prompt, then throws.
`REVIEW_TIMEOUT_MS` bounds each process, and the process tree is killed on
timeout or cancel.

`normalize()` re-derives `can_merge` defensively (no blocker or major finding,
no `partial` or `missing` requirement) and downgrades an `approve` verdict that
contradicts it. Observations are deliberately absent from that computation.

## Database (`src/db.ts`, better-sqlite3, `data/review.db`)

Migrations run at startup from an in-code array, idempotent, with
`PRAGMA journal_mode = WAL`.

```sql
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT,                -- 'ABC-123' or NULL
  ticket_title TEXT,
  ticket_url TEXT,
  ticket_body TEXT,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_sha TEXT,
  base_sha TEXT,
  pr_number INTEGER,
  run_index INTEGER NOT NULL,     -- 1-based, per (repo, branch)
  status TEXT NOT NULL,           -- queued|fetching|reviewing|done|failed|cancelled
  verdict TEXT,                   -- approve|changes_requested|blocked
  can_merge INTEGER,              -- 0/1
  summary TEXT,
  requirements_met INTEGER,
  requirements_total INTEGER,
  blocking_count INTEGER,
  report_path TEXT,               -- relative to DATA_DIR
  model TEXT,
  error TEXT,
  files_changed INTEGER,
  additions INTEGER,
  deletions INTEGER,
  created_at TEXT NOT NULL,       -- ISO8601 UTC
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_reviews_ticket ON reviews(ticket_key);
CREATE INDEX idx_reviews_branch ON reviews(repo, branch);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,         -- blocker|major|minor|nit
  category TEXT,                  -- correctness|security|tenancy|tests|performance|style|docs
  file TEXT,
  line INTEGER,
  end_line INTEGER,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  why TEXT,
  suggestion TEXT,                -- advice only, never applied
  snippet TEXT,
  ord INTEGER NOT NULL
);
CREATE INDEX idx_findings_review ON findings(review_id);

CREATE TABLE requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL,           -- met|partial|missing|not_verifiable
  evidence TEXT,                  -- file:line or a short explanation
  ord INTEGER NOT NULL
);
CREATE INDEX idx_requirements_review ON requirements(review_id);

-- Non-blocking remarks. Never part of the merge gate.
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file TEXT,
  line INTEGER,
  note TEXT NOT NULL,
  rationale TEXT,
  ord INTEGER NOT NULL
);
CREATE INDEX idx_observations_review ON observations(review_id);

CREATE TABLE review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,            -- info|warn|error
  message TEXT NOT NULL
);
CREATE INDEX idx_logs_review ON review_logs(review_id);
```

## Types (`src/types.ts`)

`ReviewStatus`, `Verdict` (`approve|changes_requested|blocked`), `Severity`
(`blocker|major|minor|nit`), and `RequirementStatus`
(`met|partial|missing|not_verifiable`) mirror the columns above. `LENS_NAMES`
and `LensName` name the five lenses. `TicketInfo` carries `provider`: the
tracker that produced it, or `manual`. `TicketInfo`, `ResolvedTarget`, and
`CheckoutResult` are the values passed between the resolver, the sandbox, and
the runner. `LensOutput` is what one lens returns: `findings[]` and
`observations[]`. `ReviewOutput` is what the synthesis pass returns: `summary`,
`requirements[]`, `findings[]`, `observations[]`, `verdict`, `can_merge`,
`conclusion`. An `Observation` is `{ file, line, note, rationale }`.

## Queue and events

`src/queue.ts` runs reviews through an in-process worker pool of
`REVIEW_CONCURRENCY` (default 2) workers; the lens fan-out inside one review is
always 5 wide plus a synthesis pass, so the process ceiling is
`REVIEW_CONCURRENCY * 6`. On server
start any row still in `queued`, `fetching`, or `reviewing` is marked `failed`
with `error = 'interrupted by restart'`. `src/events.ts` is a process-level
`EventEmitter`; each SSE message is
`data: {"type":"log"|"status"|"done","reviewId":n,...}\n\n`, with a heartbeat
comment every 15 seconds.

## HTTP API

Fastify on `PORT`, serving `web/dist` statically at `/` with an SPA fallback, and
the API under `/api`. Handlers validate input with zod and return errors as
`{ error: string }` with a proper status code.

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, version, dockerImage, trackers, repos }` - tracker names only |
| GET | `/api/repos` | | `{ repos: string[] }` |
| GET | `/api/tickets/:key` | | `{ ticket, targets }` — preview before running |
| POST | `/api/reviews` | `{ input, targets?, model?, requirementsText? }` | `{ reviews }` — one row per target, status `queued` |
| GET | `/api/reviews` | `?ticket=&repo=&branch=&limit=&offset=` | `{ reviews, total }`, newest first |
| GET | `/api/reviews/:id` | | `{ review, requirements, findings, observations, logs }` |
| GET | `/api/reviews/:id/report` | | `text/markdown` raw report |
| POST | `/api/reviews/:id/rerun` | | `{ review }` — new row, same repo and branch, `run_index + 1` |
| POST | `/api/reviews/:id/cancel` | | `{ review }` |
| DELETE | `/api/reviews/:id` | | `{ ok: true }` — deletes the row and the report file |
| GET | `/api/reviews/:id/events` | | SSE stream |
| GET | `/api/recipes` | | `{ enabled, dir, recipes, errors }` — invalid recipes are reported, not thrown |
| GET | `/api/previews` | `?reviewId=&ticket=&recipe=&limit=&offset=` | `{ previews, total }`, newest first |
| GET | `/api/previews/:id` | | `{ preview, logs }` |
| POST | `/api/previews` | `{ reviewId?, ticket?, recipe?, roles?, dumpMode? }` | `{ preview }` — status `queued` |
| POST | `/api/previews/:id/stop` | | `{ preview }` — runs `down` |
| DELETE | `/api/previews/:id` | | `{ ok: true }` — stops it first, then deletes the row |
| GET | `/api/previews/:id/events` | | SSE stream |

## Report writer (`src/reportWriter.ts`)

`writeReport()` returns a path relative to `DATA_DIR`:
`reports/<ticket_key || repo>/<repo>__<sanitized-branch>/run-<runIndex>-<YYYYMMDD-HHmmss>.md`

The report opens with the verdict, then a meta table (ticket, repository, branch
with head and base shas, diff size, run number, timestamp, model), the summary,
a requirement table with status icons (met ✅, partial ⚠️, missing ❌,
not_verifiable ❓), findings grouped by severity with `file:line`, a
`## Suggestions (non-blocking)` section listing the observations as
`` - `file:line` — note `` with an indented rationale line (or `None.`), and a
conclusion naming exactly what is still required before merge.

## Web UI (`web/`)

Vite + React + TypeScript, dev server proxying `/api` to `PORT`. Plain CSS in
`web/src/styles.css` — no UI framework, no CDN. Dark-first, compact.

- **Home** — an input box and a Review button. The placeholder follows what
  `/api/health` reports: with no tracker configured it asks for a branch only.
  When the input looks like a ticket key it calls `GET /api/tickets/:key` first
  and shows the resolved ticket, a chip naming the tracker that answered, and
  the detected branches with checkboxes, then posts the chosen targets. A
  collapsible **Paste requirements instead** textarea sends `requirementsText`
  and skips the ticket lookup. Below is the history table of all runs.
- **Review detail** (`/review/:id`) — verdict banner, meta table, requirements
  table, findings grouped by severity, and a live log fed by SSE while the run is
  in progress. Actions: re-run, download report, copy report, delete.
- **Ticket view** (`/ticket/:key`) — all runs for one ticket across repositories,
  grouped by repo and branch, newest first.

Routing is a small hand-written history-based router; there is no react-router
dependency.

## Preview environments (`src/preview/`)

A preview is the reviewed branches running as a clickable stack. The engine is
product-agnostic: what to run lives in a **recipe** outside this repository
(`PREVIEW_RECIPES_DIR`, `recipes/` by default, gitignored). One documented,
product-neutral sample ships in `recipes.example/`. The whole feature is off
until `PREVIEW_ENABLED` is set.

| module | responsibility |
|---|---|
| `recipes.ts` | zod schema, loading, validation; errors name the field and the file |
| `ports.ts` | host port allocation, verified by binding, held until the row records it |
| `database.ts` | where the data comes from: `pg_dump` → newest file in `dumpDir` → clean |
| `steps.ts` | runs one recipe command, streams its output, enforces timeouts, kills the process group |
| `engine.ts` | lifecycle, worker pool, teardown, TTL reaper, orphan recovery |
| `store.ts` | `previews` and `preview_logs` rows |
| `events.ts` | preview SSE bus, mirroring `src/events.ts` |

**Lifecycle.** `queued → preparing → starting → ready`, then `stopping →
stopped`, or `failed` / `expired`. `preparing` resolves the roles (a repository
with no branch for the ticket runs its base branch, recorded as `usedBase`),
reuses the review's checkout when it is still on disk and otherwise fetches
through the same Docker sandbox as a review, allocates the ports, resolves the
database source, and runs `prepare`. `starting` runs `up` and then polls
`health` until it exits 0 or `readyTimeoutSec` runs out. Previews beyond
`PREVIEW_MAX_CONCURRENT` wait in the queue and report their position.

**Database source.** `mode: "auto"` tries `pg_dump` against the configured live
database first — after a five second TCP probe, so an unreachable host cannot
hang a preview — then the newest non-empty file in `dumpDir`, then a clean
install. The mode that actually happened is stored as `dump_mode` and handed to
the steps as `DUMP_MODE`. Only `onFailure: "fail"` turns a missing dump into an
error; nothing ever waits for a human.

**Steps.** Commands come from a trusted local file and run through `/bin/sh`
with `PREVIEW_DIR` as the working directory. No value is ever interpolated into
a command string: checkouts, branches, ports, database coordinates and the dump
are passed through the environment (`CHECKOUT_<ROLE>`, `BRANCH_<ROLE>`,
`BASE_<ROLE>`, `PORT_<ID>`, `DB_*`, `DUMP_FILE`, `DUMP_MODE`), on top of the
same scrubbed environment the reviewer gets. Each child gets its own process
group, so a timeout or a stop kills the whole tree.

**Teardown.** `down` runs on stop, on any failure, on timeout, on TTL expiry,
and at server start for previews a crash left behind — it is idempotent, every
command runs even if an earlier one failed, and it runs even when `prepare`
died halfway. The context needed to tear a preview down later (environment and
checkouts) is written to `<DATA_DIR>/previews/<id>/preview-context.json`. After
teardown a reused review checkout is verified pristine with `assertPristine`;
checkouts the preview fetched itself are removed.

## Non-goals

- No pushing, committing, or commenting on GitHub or any ticket tracker.
- No editing of reviewed repositories.
- No multi-user auth; the server is `127.0.0.1` only.
