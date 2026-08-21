# Design

How the tool is put together, for anyone reading or extending the code. The
user-facing setup lives in [../README.md](../README.md).

## What it does

Input is a Linear ticket key (`ABC-123`), a GitHub pull request URL, a tree URL,
or `repo#branch`. The tool resolves that into one or more `repo` + `branch`
targets, fetches each one inside a Docker sandbox, runs a read-only Claude Code
review against the ticket requirements — five independent lens passes plus a
synthesis pass — stores the run in SQLite, and writes a Markdown report.

Two rules shape everything else:

- The reviewed code is never modified, and nothing is ever pushed or posted back
  to GitHub or Linear.
- Only `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` may
  be fetched. Anything else is rejected.

## Layout

```
package.json  tsconfig.json  .env.example  LICENSE  README.md
docker/Dockerfile.git  docker/entrypoint.sh
src/
  config.ts  types.ts  db.ts  logger.ts  events.ts
  linear.ts  resolver.ts  gitSandbox.ts  reviewRunner.ts  reportWriter.ts
  queue.ts  cli.ts  server.ts
  routes/reviews.ts  routes/tickets.ts  routes/repos.ts
  prompts/common-preamble.md  prompts/lens-common.md
  prompts/lens-correctness.md  prompts/lens-security.md
  prompts/lens-tests.md  prompts/lens-contracts.md
  prompts/lens-regressions.md  prompts/synthesis.md
web/     # vite + react + ts, builds to web/dist
data/    # gitignored: review.db, checkouts/, reports/
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
`GITHUB_TOKEN`, `REVIEW_GH_TOKEN`, and `LINEAR_API_KEY`. `USER` is load-bearing
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

## Resolver (`src/resolver.ts`)

`resolveTargets(input)` returns `{ ticket, targets }`.

1. **Ticket key** (`ABC-123`, any team prefix matching `[A-Za-z]+-\d+`,
   case-insensitive) — the ticket is fetched from Linear, then targets are
   collected from, in order:
   - pull request attachment URLs, asking GitHub for each PR's head and base
     branch;
   - a remote branch scan: `git ls-remote --heads` on every allowlisted repo,
     keeping branches whose name contains the ticket key, plus an exact match on
     the ticket's `branchName`.

   Targets are deduplicated by `repo` + `branch`. The base branch falls back to
   the repository's default branch, cached per process.
2. **`https://github.com/<org>/<repo>/pull/<n>`** — a single target from the PR's
   head and base.
3. **`https://github.com/<org>/<repo>/tree/<branch>`** or **`<repo>#<branch>`** —
   a single target; the ticket is looked up from the branch name if it contains a
   ticket-key token.

Anything else throws. If a ticket resolves to no branches, the error names what
was searched.

## Linear (`src/linear.ts`)

One POST to `https://api.linear.app/graphql` with the raw API key in
`Authorization` (no `Bearer` prefix). `getTicket(key)` splits the key into a team
prefix and a number and queries
`issues(filter: { number: { eq: N }, team: { key: { eq: "ABC" } } }, first: 1)`,
selecting identifier, title, url, description, state, branch name, attachments,
and comments. `parsePrUrls(urls)` extracts `{ repo, prNumber }` from pull request
URLs and silently drops anything not in the allowlist.

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
and `LensName` name the five lenses. `TicketInfo`, `ResolvedTarget`, and
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
| GET | `/api/health` | | `{ ok, version, dockerImage, linear, repos }` |
| GET | `/api/repos` | | `{ repos: string[] }` |
| GET | `/api/tickets/:key` | | `{ ticket, targets }` — preview before running |
| POST | `/api/reviews` | `{ input, targets?, model? }` | `{ reviews }` — one row per target, status `queued` |
| GET | `/api/reviews` | `?ticket=&repo=&branch=&limit=&offset=` | `{ reviews, total }`, newest first |
| GET | `/api/reviews/:id` | | `{ review, requirements, findings, observations, logs }` |
| GET | `/api/reviews/:id/report` | | `text/markdown` raw report |
| POST | `/api/reviews/:id/rerun` | | `{ review }` — new row, same repo and branch, `run_index + 1` |
| POST | `/api/reviews/:id/cancel` | | `{ review }` |
| DELETE | `/api/reviews/:id` | | `{ ok: true }` — deletes the row and the report file |
| GET | `/api/reviews/:id/events` | | SSE stream |

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

- **Home** — an input box and a Review button. When the input looks like a ticket
  key it calls `GET /api/tickets/:key` first and shows the resolved ticket plus
  the detected branches with checkboxes, then posts the chosen targets. Below is
  the history table of all runs.
- **Review detail** (`/review/:id`) — verdict banner, meta table, requirements
  table, findings grouped by severity, and a live log fed by SSE while the run is
  in progress. Actions: re-run, download report, copy report, delete.
- **Ticket view** (`/ticket/:key`) — all runs for one ticket across repositories,
  grouped by repo and branch, newest first.

Routing is a small hand-written history-based router; there is no react-router
dependency.

## Non-goals

- No pushing, committing, or commenting on GitHub or Linear.
- No editing of reviewed repositories.
- No multi-user auth; the server is `127.0.0.1` only.
