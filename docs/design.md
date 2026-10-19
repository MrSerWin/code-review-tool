# Design

How the tool is put together, for anyone reading or extending the code. The
user-facing setup — environment variables, accepted inputs, the CLI, the HTTP
API, the MCP tools, and previews — lives in [../README.md](../README.md); this
document links there instead of repeating it.

## What it does

Input is a ticket key (`ABC-123`, optionally prefixed with its tracker as in
`jira:ABC-123`) or the ticket's issue link, a GitHub pull request, a tree URL, `repo#branch`, or
`local:repo#branch` for a branch of a local clone — optionally with
requirements pasted by hand instead of a ticket (every form:
[README › Inputs](../README.md#inputs)). The tool resolves that into one or
more `repo` + `branch` targets, fetches each one inside a Docker sandbox, runs
a read-only review with one of four agent CLIs (Claude Code, Cursor Agent,
OpenAI Codex, Grok) against the ticket requirements — five independent lens
passes plus a synthesis pass — stores the run in SQLite, and writes a Markdown
report.

Two rules shape everything else:

- The reviewed code is never modified, and nothing is ever pushed or posted back
  to GitHub or any ticket tracker.
- Only `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` may
  be fetched, and only `<LOCAL_REPOS_DIR>/<repo>` (or a `LOCAL_REPOS` entry) for
  such a repo may be read locally. Anything else is rejected.

## Layout

```
package.json  tsconfig.json  .env.example  LICENSE  README.md
docker/Dockerfile.git  docker/entrypoint.sh
docs/design.md
src/
  config.ts  types.ts  db.ts  logger.ts  events.ts  logSanitize.ts  gitNames.ts
  resolver.ts  prLinks.ts  localRepos.ts  gitSandbox.ts  remoteBranches.ts
  reviewRunner.ts  reportWriter.ts  findingCompare.ts  groupKey.ts  githubLinks.ts
  ticketChains.ts  ticketStore.ts  ticketGroups.ts  coverage.ts  coverageView.ts
  queue.ts  processOwnership.ts  cli.ts  server.ts
  reviewers/types.ts  reviewers/index.ts  reviewers/shared.ts
  reviewers/claude.ts  reviewers/cursor.ts  reviewers/codex.ts  reviewers/grok.ts
  reviewers/anthropicStream.ts  reviewers/codexStream.ts
  trackers/index.ts  trackers/types.ts  trackers/adf.ts  trackers/html.ts
  trackers/linear.ts  trackers/jira.ts  trackers/github.ts
  trackers/azure.ts  trackers/youtrack.ts  trackers/urls.ts
  routes/reviews.ts  routes/tickets.ts  routes/ticketGroups.ts  routes/repos.ts  routes/previews.ts
  preview/recipes.ts  preview/roles.ts  preview/ports.ts  preview/database.ts
  preview/steps.ts  preview/engine.ts  preview/store.ts  preview/events.ts
  mcp.ts  mcp/client.ts  mcp/server.ts  mcp/format.ts
  prompts/common-preamble.md  prompts/lens-common.md
  prompts/lens-correctness.md  prompts/lens-security.md
  prompts/lens-tests.md  prompts/lens-contracts.md
  prompts/lens-regressions.md  prompts/synthesis.md  prompts/reanchor.md  prompts/coverage.md
  *.test.ts  testEnv.ts   # node:test suites (npm test)
recipes.example/   # one documented, product-neutral preview recipe
recipes/           # gitignored: the real preview recipes
web/     # vite + react + ts, builds to web/dist
data/    # gitignored: review.db, checkouts/, reports/, previews/
```

Node 20, TypeScript, ESM. `tsx` for development, `tsc` for the build
(`npm run build` also copies `src/prompts` to `dist/prompts` and builds the
web app). Runtime dependencies: `fastify`, `@fastify/static`,
`better-sqlite3`, `zod`, `dotenv`, and `@modelcontextprotocol/sdk` for the MCP
server. The web app uses `react`,
`react-dom`, and `vite`.

## Configuration (`src/config.ts`)

Environment is loaded from `<repo>/.env` and validated with zod into a frozen
`config` object. Missing or malformed values throw at import time with the
offending keys listed, so the process never starts half-configured. Only
`REVIEW_GH_TOKEN`, `GITHUB_ORG`, and `ALLOWED_REPOS` are required; every default
lives in the schema, and `.env.example` only lists them commented out. The full
variable table, including the few variables read elsewhere (`LOG_LEVEL`,
`CODEX_HOME`, `CODE_REVIEW_API_URL`), is in
[README › Environment](../README.md#environment).

The same module owns the allowlist:

- `ALLOWED_REPOS: readonly string[]` — parsed from the required `ALLOWED_REPOS`
  variable, comma-separated, trimmed, empty entries dropped. An empty result is
  a startup error.
- `assertAllowedRepo(name)` — throws unless the name is in the list.
- `assertAllowedRemote(url)` — throws unless the URL is
  `https://github.com/<GITHUB_ORG>/<allowed-repo>(.git)?`.
- `repoUrl(repo)` — builds the clone URL and re-checks it through
  `assertAllowedRemote` before returning it.

`config.ts` imports only the reviewer names (`reviewers/types.ts`), never the
reviewer registry, because the registry imports `config.ts`.

### Preview configuration

`PREVIEW_ENABLED` (`1`/`true`/`yes`/`on`, default off) gates the whole feature.
`PREVIEW_RECIPES_DIR` (default `<repo>/recipes`), `PREVIEW_PORT_RANGE` (default
`21000-21999`, validated as an ascending range inside 1024–65535),
`PREVIEW_TTL_MINUTES` (default 120, counted from the moment a preview is ready)
and `PREVIEW_MAX_CONCURRENT` (default 3, the number of previews being started
at once — a ready preview no longer holds a slot) follow the same rule as
everything else.

## Isolation model

This is the part worth understanding before changing anything. The
user-facing summary is in [README › Isolation model](../README.md#isolation-model).

**Authenticated git never runs on the host.** `runInSandbox()` shells out to
`docker run --rm` with the sandbox image. The token is referenced by name in the
docker argv (`-e GH_TOKEN`) and supplied through the child process environment,
so it never appears in the host process list and is never written to disk on the
host. The only host path mounted read-write is the checkout root, at `/work`; a
local clone is added as a read-only bind mount at `/src` when one is needed. The
container runs with `--user <host uid>:<host gid>` so the checkout stays readable
outside. Networking stays on the default bridge because fetching needs the
internet.

**The container re-checks the allowlist.** `docker/entrypoint.sh` fails fast if
`GH_TOKEN` or `GITHUB_ORG` is unset, and refuses to run if any argument
references a URL, an scp-style remote, or a `github.com` path outside
`github.com/$GITHUB_ORG`. It then writes an isolated `$HOME/.gitconfig` with a
throwaway identity, `safe.directory=*`, and a credential helper that echoes
`$GH_TOKEN`. This is defence in depth: the Node side already validates, and the
container validates again with no trust in its caller. A local clone is
therefore cloned from the plain path `/src`, never from a `file://` URL.

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

**A local clone is only read.** `src/localRepos.ts` runs a fixed set of
read-only git commands in the clone through `execFile` with
`GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`. The review checkout is made
in the sandbox with `git clone --no-local` from the read-only mount (a real
object copy), and the base branch is fetched into that copy — from GitHub when
it is the default branch, from the mount otherwise. Uncommitted changes, when
asked for, are captured on the host (`git diff HEAD --binary` plus the
untracked, non-ignored files, with size caps) and committed as one snapshot
commit inside the checkout, never in the clone.

**The reviewer is read-only and token-free.** Each reviewer definition in
`src/reviewers/` builds its own argv (`buildArgs()`) and child environment
(`buildChildEnv()`); the exact read-only and MCP-disabling flags per CLI are in
[README › Reviewers](../README.md#reviewers). Every child environment starts
from `buildBaseChildEnv()` in `reviewers/shared.ts`: `buildSanitizedEnv()`,
an allowlist (`PATH`, `HOME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `USER`,
`LOGNAME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`) from which
`GH_TOKEN`, `GITHUB_TOKEN`, `REVIEW_GH_TOKEN`, and every tracker token
(`LINEAR_API_KEY`, `JIRA_API_TOKEN`, `AZURE_PAT`, `YOUTRACK_TOKEN`) are
deleted, plus `CODE_REVIEW_TOOL_REVIEWER=1`. Cursor adds `CURSOR_API_KEY` when
it is configured; Codex adds `CODEX_HOME` when it is set, so the review runs
against the same Codex home the model list is read from; Grok adds
`GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED`, and
`GROK_MANAGED_MCPS_ENABLED`, all `false`. Preview steps start from
`buildSanitizedEnv()` alone: the same allowlist and stripping, without the
reviewer marker. `USER` is load-bearing on macOS:
without it the CLIs cannot read their credentials from the Keychain and every
review fails with "Not logged in". None of the passthrough variables carry a
secret. After the run, `assertPristine()` requires `git status --porcelain` to
be empty; a modified checkout invalidates the review.

**Names are inert.** Branch names must match `[A-Za-z0-9._/-]+`, must not
contain `..`, and must not start with `-` (`gitNames.ts`); repository names must
be on the allowlist, and for local clones also match `[A-Za-z0-9._-]+`. Branch
names are sanitised for filesystem paths by replacing `/` with `__`. Everything
is spawned with an argv array via `execFile` or `spawn`, never through a shell
string (recipe steps are the one deliberate exception, see below). GitHub API
paths are checked against a narrow character class and rejected if they contain
`..` or a scheme.

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
| `github` | none beyond `GITHUB_ORG`, `REVIEW_GH_TOKEN` | `ghApi` inside the sandbox: `repos/{owner}/{repo}/issues/{n}` and its `/comments`; only the configured organization |
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

Issue links are read by `trackers/urls.ts` (`ticketRefFromUrl()`, pure: the
self-hosted hosts are passed in). `canonicalTicketInput()` in the registry turns
a link into the explicit `tracker:KEY` it names before step 1, so a link
resolves like a prefixed key: `linear.app/<ws>/issue/ABC-123/<slug>` →
`linear:ABC-123`; `<site>.atlassian.net/browse/ABC-123`, `…?selectedIssue=ABC-123`
and `…/issues/ABC-123` → `jira:ABC-123`; `/issue/ABC-123` on YouTrack →
`youtrack:ABC-123`; `_workitems/edit/123` or `?workitem=123` on Azure DevOps →
`azure:#123`. A link maps only on a host of its tracker (`linear.app`,
`*.atlassian.net`, `*.youtrack.cloud`, `*.myjetbrains.com`, `dev.azure.com`,
`*.visualstudio.com`, or the host of `JIRA_BASE_URL`, `YOUTRACK_BASE_URL`,
`AZURE_ORG_URL`), so an unrelated page with `/issue/ABC-1` in its path is not a
ticket; the providers' own URL parsing goes through the same function. An
unconfigured tracker's link is the usual "not configured" error. GitHub issue
links stay with the GitHub provider, and pull request links with the resolver's
PR step. `web/src/tickets.ts` mirrors the patterns for the launcher (judging an
unknown host by its path, since only the server knows the configured hosts).
GitHub Issues need no variables beyond the ones the sandbox already requires,
so that provider is always active; every other tracker is opt-in. Configuring
none of them is not an error: the input then simply has to name a branch, with
the requirements pasted instead.

## Resolver (`src/resolver.ts`)

`resolveTargets(input, { requirementsText?, includeWorkingTree?, baseBranch? })`
returns `{ ticket, targets }`. The input is first normalized by
`normalizeInput()`: trimmed, a surrounding `<…>` removed, and `http://` or
`www.github.com` rewritten to `https://github.com/`. Then, in this order:

1. **`local:<repo>[#<branch>]`** — `localRepos.ts` validates the clone and the
   branch and picks the base: an explicit `baseBranch`, else the detected parent
   (`detectParentBranch()`: the closest branch whose tip the reviewed branch
   contains, else a local branch it forked from that has moved on, else the
   default branch). `includeWorkingTree` and `baseBranch` are refused for every
   other input.
2. **A pull request** — `https://github.com/<org>/<repo>/pull/<n>` (with any
   trailing path, query, or fragment) or `<org>/<repo>#<n>`, both through
   `parsePullRequestRef()`. This runs before the ticket lookup on purpose: the
   GitHub tracker also accepts PR references, and as a ticket a PR would fan
   out to every PR it links to and every branch containing its number. A PR is
   exactly one target, its head against its base. Its ticket is the pasted
   requirements, else the tracker ticket named by its branch, else the PR
   itself read through the GitHub tracker (with its links dropped). An
   `<org>/<repo>#<n>` that is not a PR falls through to step 3 as a GitHub
   issue; a PR URL whose lookup fails is an error.
3. **Ticket key** — anything the registry claims (skipped when requirements
   were pasted), after `canonicalTicketInput()` has turned an issue link into
   `tracker:KEY`. The ticket is fetched through its provider, then targets are
   collected from, in order:
   - pull request links, asking GitHub for each PR's head and base branch;
   - a remote branch scan: `git ls-remote --heads` on every allowlisted repo,
     keeping branches whose name matches the ticket key, plus an exact match on
     the ticket's `branchName`.

   Branch discovery is provider-agnostic: the key is just a string.
   `branchPattern(key)` handles `ABC-123` (project prefix, optional dash), a
   trailing number for GitHub issue and Azure work item keys, and otherwise
   matches the key literally. Targets are deduplicated by `repo` + `branch`.
   The base branch falls back to the repository's default branch, cached per
   process. A ticket that resolves to no branch is an error naming what was
   searched.
4. **`https://github.com/<org>/<repo>/tree/<branch>`** or **`<repo>#<branch>`** —
   a single target against the default branch; the ticket is looked up from
   the branch name if it contains a ticket-key token and some tracker claims
   it.

`requirementsText` replaces the tracker entirely: the ticket becomes a manual
`TicketInfo` (`provider: 'manual'`, empty `key`, title from the first line), no
lookup happens, and the input only has to name a branch. The empty key is what
stores `ticket_key` as `NULL`. A run with neither ticket nor pasted text tells
the reviewer to infer the requirements from the branch name, the commit
messages, and the diff.

`src/prLinks.ts` extracts `{ repo, prNumber }` from pull request URLs
(`parsePrUrls()`, dropping anything outside the organization or the allowlist)
and finds pull request links in the free text of trackers that have no
attachment list (`collectPrUrls()`).

Anything else throws.

## Reviewers (`src/reviewers/`)

A reviewer is a `ReviewerDefinition`: a name (`claude`, `cursor`, `codex`,
`grok`), a label, a binary, a default model, `buildArgs(prompt, model, dir)`,
`buildChildEnv()`, `parseStreamLine()`, `listModels()`, `isAvailable()`, and
`describeFailure()` for a human hint on known failures (mostly "not logged
in"). `reviewers/index.ts` is the registry; `DEFAULT_REVIEWER` picks the
default.

- **Availability** is a walk of `PATH` (no shell), cached per process. An
  unavailable reviewer is refused before a review row is created.
- **Models** come from `cursor-agent --list-models`, `grok models`, Codex's
  `$CODEX_HOME/models_cache.json` (entries with `visibility: "list"`, ordered by
  `priority`), or a static alias list for Claude. Helper calls time out after
  20 s, never throw, and fall back to a short built-in list; results are
  cached for ten minutes.
- **Streams.** Claude Code, Cursor Agent, and the Grok CLI share the
  Anthropic-style `stream-json` events (`anthropicStream.ts`); Codex speaks its
  own JSONL (`codexStream.ts`), where the answer is the last `agent_message`.
- **Re-runs.** `resolveRerunChoice()` keeps the previous reviewer unless one is
  named, and keeps the previous model only while the reviewer stays the same: a
  model id belongs to one CLI, so `opus` is never handed to Codex.

## Review runner (`src/reviewRunner.ts`)

One review is six reviewer processes, not one.

**Why.** A single pass produced zero findings on every real run. Three reasons:
the prompt banned nitpicking, so a reviewer noticing something non-blocking had
nowhere to put it; every finding fed the merge gate, so mentioning anything
blocked the merge; and one pass has whatever recall that one pass happens to
have, which varied run to run.

**Fan-out.** Five lenses (`LENS_NAMES`) run concurrently (`Promise.all`)
against the same checkout, each its own process with its own mandate:

| lens | mandate |
|---|---|
| `correctness` | logic errors, data integrity, migrations, transactions, error handling, data loss, edge cases |
| `security` | authz/authn, multi-tenant isolation, injection, secrets, information disclosure, unsafe defaults |
| `tests` | is the new behaviour actually covered, missing negative and edge cases, tests that assert nothing |
| `contracts` | API and response shape changes, backward compatibility, migrations versus consumers, stale documentation |
| `regressions` | what the rest of the repo depends on: call sites of changed or deleted symbols, shared-helper behaviour, migrations versus untouched readers, changed defaults and flags, tests encoding the old behaviour, widened or narrowed filters |

A lens returns only `{ findings, observations }`. Lenses do not evaluate ticket
requirements and do not emit a verdict: five passes deriving their own
requirement list produce five contradictory lists. A lens whose pass fails — an
answer that is still not valid JSON after one corrective retry, a crash, or a
timeout — is recorded as failed and the review continues with the rest; if all
five fail the review fails. A cancel aborts the whole review instead of
degrading it.

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
placeholder is left unresolved. The re-anchor prompt is `reanchor.md` alone,
with `{{FINDINGS}}` for the findings it must fix. Previous findings are the blocker and major
findings of the branch's previous finished run; the synthesis reports which of
them are fixed.

**Per process.** Every process — lens and synthesis alike — is started from the
chosen reviewer's `buildArgs()` and `buildChildEnv()`, in its own process
group. Its stream is parsed line by line; assistant text and tool names are
forwarded to the log, prefixed with the lens name, and lens start and
completion are logged as `lens security: started` /
`lens security: 2 findings, 1 observation`. The JSON payload is extracted from
the last fenced `json` block, falling back to the last balanced `{...}`, and
validated with zod; on failure the pass retries once with a corrective prompt,
then throws. `REVIEW_TIMEOUT_MS` bounds each process, and the process group is
killed (SIGKILL) on timeout or cancel.

**Process groups and shutdown.** Because every reviewer CLI leads its own
process group, a signal sent to the server or the CLI never reaches it. The
runner therefore tracks the live groups: a module-level set in
`reviewRunner.ts` (added on spawn, removed on `close`), and per review the
`reviewer_pgids` column, a JSON array of `{ pgid, bin, spawnedAt }` rewritten
on every spawn and exit. On SIGTERM or SIGINT, `stopAllReviews()` in
`queue.ts` fails every queued and running review of the process (the server
writes "interrupted by shutdown", the CLI "interrupted: the CLI was stopped"),
then `stopAllReviewers()` refuses new processes and sends SIGTERM to every live
group, and SIGKILL to the ones still there after 3 s; a second signal sends
SIGKILL at once. An `exit` handler SIGKILLs anything left on any other exit
path. When the process dies without running any of this (SIGKILL, a crash),
`reviewer_pgids` is what the next recovery uses to stop the orphans (see
[Queue and events](#queue-and-events)).

**Finding anchors (`src/anchors.ts`, `src/findingFields.ts`).** Every finding
has a `kind` (`diff` | `regression` | `stale_doc` | `consumer`) and, for a
non-diff kind, `cause_file` / `cause_line`: the changed line behind a finding
anchored at an untouched site. A diff finding may carry its `hunk` header. The
prompts require `kind`, require a cause in the changed set for the other kinds,
and require HEAD line numbers read from a numbered listing (Read, `cat -n`,
`grep -n`), never counted from `sed -n` or diff text. The zod schemas are
lenient where the model is sloppy: a missing or unknown `kind` is `diff`, a few
aliases map (`dependent_site` -> `regression`), a `hunk` is cut to its
`@@ ... @@` part, and an unknown `lens` is null; an answer written for the old
prompt still parses.

After synthesis, `attributeLenses()` fills `lens` (the one synthesis named, or
the single lens with a candidate at the same `file:line`) and restores a
non-diff `kind` and its cause from that candidate when synthesis dropped them.
Then `anchorFindings()` checks every finding on the host-side checkout, read
only: the path is normalised (`./`, an absolute path inside the checkout, `a/`
/ `b/`, a `path:line` suffix, a pre-rename path), must resolve to a regular file
inside the checkout (no `..`, no symlink out, nothing under `.git`), the line
and `end_line` must be within the file, and the path must be in the changed set
unless the kind is non-diff and the cause is a changed file (a deleted file
counts; its lines refer to the base) with an in-range line. The result is
`anchor_status`: `ok`, `off_diff`, `missing_path`, `line_out_of_range`, or
`unverified` (no file). Findings, not observations, with any of the three bad
statuses go into ONE re-anchor pass (`reanchor.md`, at most `MAX_REANCHOR` =
40 findings, one attempt, no corrective retry). That prompt prefers keeping an
off-diff location as the dependent site, adding the kind and the cause, over
moving the finding into the diff: the reader needs both places. An answer replaces a finding's
anchor only when its re-checked status ranks strictly higher (ok > off_diff >
line_out_of_range > missing_path); a failed pass logs a warning and keeps the
first statuses. Findings are never dropped for their anchor.

**Raw pass outputs.** `runReview()` returns the `ReviewOutput` plus each lens's
extracted JSON, the synthesis JSON, and the re-anchor JSON. The queue writes
them next to the report as `run-N-<ts>.lenses/<lens>.json`, `synthesis.json`,
and `reanchor.json`.

**Slices.** A review whose group key is a ticket (not the `repo#branch`
fallback) is a slice of a ticket group. The queue passes `SliceInfo` (every
branch of the group, parents first, with its base) to `runReview()`:
`{{TICKET_SCOPE}}` in `common-preamble.md` lists the slices and tells every
pass that work missing from this branch is not a finding, and `{{SLICE_RULES}}`
in `synthesis.md` replaces the requirement parts of its steps: requirements
are still listed (what THIS branch implements), but never drive the verdict.
Both placeholders are empty for a branch without a group, so its prompts are
unchanged.

`normalize()` always derives `code_verdict` / `code_can_merge` from the
findings alone (approve without a blocker or major; `blocked` only when
synthesis said so and a blocker exists). For a slice, `verdict` / `can_merge`
are the code ones. For a branch without a group the old rule stays:
`normalize()` re-derives `can_merge` defensively (no blocker or major finding,
no `partial` or `missing` requirement — `not_verifiable` does not block) and
downgrades an `approve` verdict that contradicts it to `changes_requested`.
Observations are deliberately absent from that computation.

## Database (`src/db.ts`, better-sqlite3, `data/review.db`)

Migrations run at startup from an in-code array plus `ensureColumn()` calls for
columns added later, idempotent, with `PRAGMA journal_mode = WAL` and foreign
keys on. The effective schema:

```sql
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT,                -- 'ABC-123', 'my-org/my-service#12', or NULL
  ticket_title TEXT,
  ticket_url TEXT,
  ticket_body TEXT,               -- also holds pasted requirements
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
  reviewer TEXT,                  -- claude|cursor|codex|grok      (added)
  model TEXT,
  error TEXT,
  files_changed INTEGER,
  additions INTEGER,
  deletions INTEGER,
  created_at TEXT NOT NULL,       -- ISO8601 UTC
  started_at TEXT,
  finished_at TEXT,
  source TEXT NOT NULL DEFAULT 'github',      -- github|local      (added)
  working_tree INTEGER NOT NULL DEFAULT 0,    -- local only         (added)
  base_reason TEXT,               -- parent|chosen|default, local only (added)
  group_key TEXT,                 -- see groupKey.ts               (added)
  runner_pid INTEGER,             -- process that enqueued it      (added)
  runner_started_at TEXT,         -- that process's start, ISO8601 (added)
  reviewer_pgids TEXT             -- live reviewer processes, JSON (added)
);
CREATE INDEX idx_reviews_ticket ON reviews(ticket_key);
CREATE INDEX idx_reviews_branch ON reviews(repo, branch);
CREATE INDEX idx_reviews_group ON reviews(group_key, created_at);

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
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'diff',  -- diff|regression|stale_doc|consumer (added)
  cause_file TEXT,                -- non-diff kinds: the changed file behind it (added)
  cause_line INTEGER,             --                                         (added)
  hunk TEXT,                      -- '@@ -a,b +c,d @@', diff findings        (added)
  anchor_status TEXT NOT NULL DEFAULT 'unverified',
                                  -- ok|off_diff|missing_path|line_out_of_range|unverified (added)
  lens TEXT                       -- source lens, when known                 (added)
);
CREATE INDEX idx_findings_review ON findings(review_id);

-- The changed set of a review (git diff --name-status -z -M), as the anchor check used it.
CREATE TABLE review_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  path TEXT NOT NULL,             -- HEAD-side path; a rename under its new path
  status TEXT NOT NULL,           -- A|M|D|R|C|T
  old_path TEXT,                  -- R and C only
  additions INTEGER,              -- NULL for binary files
  deletions INTEGER,
  ord INTEGER NOT NULL
);
CREATE INDEX idx_review_files_review ON review_files(review_id);

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

-- A preview outlives the review it came from: the reference is nulled, not cascaded.
CREATE TABLE previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER REFERENCES reviews(id) ON DELETE SET NULL,
  recipe TEXT NOT NULL,
  ticket_key TEXT,
  roles_json TEXT NOT NULL,       -- [{ role, repo, branch, base, usedBase }]
  ports_json TEXT NOT NULL,       -- { <port id>: <host port> }
  url TEXT,
  db_name TEXT,
  dump_mode TEXT,                 -- pg_dump|dump-dir|clean
  dump_source TEXT,
  status TEXT NOT NULL,           -- queued|preparing|starting|ready|stopping|stopped|failed|expired
  error TEXT,
  credentials_hint TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  expires_at TEXT,
  stopped_at TEXT
);
CREATE INDEX idx_previews_status ON previews(status);
CREATE INDEX idx_previews_review ON previews(review_id);

CREATE TABLE preview_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id INTEGER NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX idx_preview_logs_preview ON preview_logs(preview_id);
```

Every log line, of reviews and previews alike, goes through
`sanitizeLogMessage()` first: ANSI escapes and C0 control characters would
otherwise make a JSON response unparseable.

```sql
-- Ticket groups (added). A group per ticket key; its branches with the parent each is diffed against.
CREATE TABLE ticket_groups (
  key TEXT PRIMARY KEY, title TEXT, ticket_url TEXT,
  requirements_text TEXT,         -- added to the ticket text of runs and coverage
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ticket_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL REFERENCES ticket_groups(key) ON DELETE CASCADE,
  repo TEXT NOT NULL, branch TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'github',
  parent_branch TEXT,             -- the base: a group branch, an outside branch, or the default branch
  parent_reason TEXT,             -- pr|detected|default|user|stored
  default_branch TEXT,
  position INTEGER NOT NULL DEFAULT 0,  -- order among siblings
  pr_number INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (ticket_key, repo, branch)
);
CREATE TABLE ticket_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  status TEXT NOT NULL,           -- running|done|failed
  verdict TEXT,                   -- covered|needs_work
  summary TEXT,
  review_ids TEXT NOT NULL,       -- JSON: the branch runs the pass read
  requirements_json TEXT,         -- JSON: [{ text, status, note, branches: [{ repo, branch, review_id, status, note, evidence: [{ file, line, anchor_status }] }] }]
  reviewer TEXT, model TEXT, report_path TEXT, error TEXT, trigger TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE ticket_runs (           -- one "review the ticket" batch
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  review_ids TEXT NOT NULL,       -- JSON
  status TEXT NOT NULL,           -- running|done (done once its runs settled and a coverage pass ended)
  coverage_id INTEGER,
  created_at TEXT NOT NULL, finished_at TEXT
);
-- reviews gains code_verdict TEXT and code_can_merge INTEGER (NULL on older rows).
```

The tables are created with `IF NOT EXISTS` and the columns with
`ensureColumn()`, so an older database migrates in place. A group that
predates them is built lazily: `syncMembersFromReviews()` adds every
repo/branch of the group's runs that the group lacks, with the base of its
latest run as a `stored` parent (never for a `repo#branch` fallback group).

### Ticket groups (`ticketChains.ts`, `ticketStore.ts`, `ticketGroups.ts`)

`ticketChains.ts` is pure: `orderChains()` builds one chain per repository, a
depth-first walk from the branches whose parent is outside the group, so
parents come before children (siblings by `position`, a loop cannot hide a
branch); `wouldCycle()`; `linearParents()` for a hand-made order; and
`chooseRemoteParent()`. `ticketStore.ts` reads and writes the rows.
`ticketGroups.ts` holds the logic:

- `detectGroupParents()` decides every eligible branch first (four at a time),
  then applies the decisions to the whole graph and drops a decision that
  would close a loop, so the result does not depend on the order. A `user`
  parent is skipped unless `includeUser`; a learnt `pr` parent stays until a
  newer PR base is seen. Local branches use `describeParent()`; pushed ones a
  PR base other than the default branch, else `ghCompare()` (GitHub's
  `compare/<base>...<head>` reduced to status and counts, in the sandbox) of
  the default branch and of every sibling: the closest sibling that is
  `ahead` wins when strictly closer than the default branch. A failed lookup
  keeps the stored parent.
- `joinGroup()` makes targets members and detects parents for new members'
  repositories (`detect: 'new'`, used by `POST /api/reviews`) or for all
  (`'all'`, used by a ticket review). `applyGroupBases()` turns a member into a
  target diffed against its parent (`base_reason` `parent`, `chosen` for a
  hand-set parent, `default`), unless the caller chose a base explicitly.
- `setParentByHand()` and `setChainOrder()` refuse loops and unknown branches.
- `ticketGroupView()` is what the ticket page and `get_ticket` show.

### Ticket coverage (`coverage.ts`, `coverageView.ts`, `prompts/coverage.md`)

`runCoverage(key)` collects every member in stack order with its latest
finished run, changed files (`review_files`), and requirement checklist,
writes a `running` coverage row before its first await, and runs one reviewer
pass in an empty workspace under `DATA_DIR/coverage/` (the pass needs no code:
everything is in the prompt). The answer is held to the group by
`normalizeCoverage()`: a branch must be a member with a finished run (others
are dropped with a warning), a requirement left without a branch is `missing`,
and every evidence location is checked with `checkAnchor()` in that run's
checkout when it is still on disk, else against its changed set only
(`unverified` for a changed path, `off_diff` otherwise). The queue keeps the
checkout of a finished slice for this (server only); after the pass the
checkouts it read, and those of superseded runs, are removed, unless a live
preview borrows one; a failed run's checkout stays for inspection as before.
The pass writes `reports/<ticket>/coverage-<ts>-<id>.md`, refreshes the
section between `<!-- ticket-coverage:start -->` and `:end` in each branch
report, and closes the ticket runs whose reviews have all settled (also when
the pass failed, so a waiter never hangs).

`createCoverageScheduler()` debounces: every settled run (done, failed,
cancelled) of a group restarts the group's timer (`COVERAGE_DEBOUNCE_MS`);
when it fires and nothing of the group is active, one pass runs; a signal
during a pass queues exactly one more. `runNow()` (manual recompute) skips the
timer and joins a running pass. The server enables it at start and fails
coverage rows a restart cut off; the CLI does not enable it.
`coverageView.ts` is pure (types only): the group verdict and one branch's
reading of a coverage (`here`, `elsewhere`, `nowhere`), shared with the MCP
formatter.

### History groups (`src/groupKey.ts`)

`group_key` is never taken from input; `createReview()` and `updateReview()`
derive it with `groupKeyFor()`: the ticket key when there is one, else the
first ticket-like token of the branch name (`feat/abc-123-x` → `ABC-123`;
version and encoding markers, generic words with a counter, and project keys
outside 2–10 characters are skipped, see `NOT_A_PROJECT`), else `repo#branch`.
`syncGroupKeys()` re-derives every row at startup, so a change to the rules
reaches old rows. `listReviewGroups()` aggregates in SQL: per group the last
activity, run count, active count, the latest title and ticket URL, and the
latest run of every repo/branch ("head"), with the newest PR number any run of
that branch in the group knew (a re-run found by the branch scan may not). The status filter is judged per
group: `active` — any run is queued, fetching, or reviewing; `failed` — any
head failed; `done` — nothing active or failed and at least one head is done.

## Types (`src/types.ts`)

`ReviewStatus`, `Verdict` (`approve|changes_requested|blocked`), `Severity`
(`blocker|major|minor|nit`), and `RequirementStatus`
(`met|partial|missing|not_verifiable`) mirror the columns above. `LENS_NAMES`
and `LensName` name the five lenses. `TicketInfo` carries `provider`: the
tracker that produced it, or `manual`. `TicketInfo`, `ResolvedTarget` (with
`source`, `includeWorkingTree`, `baseReason` for local targets), and
`CheckoutResult` are the values passed between the resolver, the sandbox, and
the runner; `CheckoutResult.changedFileList` holds the `ChangedFile` entries
(path, status, rename source, counts) from `git diff --name-status -z -M` and
`--numstat -z -M`, so no path ever arrives in the `{a => b}` rename form.
`FINDING_KINDS` and `ANCHOR_STATUSES` name the finding kinds and anchor
statuses. `LensOutput` is what one lens returns: `findings[]` and
`observations[]`. `ReviewOutput` is what the synthesis pass returns: `summary`,
`requirements[]`, `findings[]`, `observations[]`, `verdict`, `can_merge`,
`conclusion`. An `Observation` is `{ file, line, note, rationale }`.
`ReviewGroup` is one row of the grouped history.

## Queue and events

`src/queue.ts` runs reviews through an in-process worker pool of
`REVIEW_CONCURRENCY` (default 2) workers; the lens fan-out inside one review is
always 5 wide plus a synthesis pass, so the process ceiling is
`REVIEW_CONCURRENCY * 6`. The queue lives in memory, so nothing resumes after a
restart. A checkout is removed after a successful review and kept after a
failure for inspection.

**Dependencies.** A review queued in a batch with its parent slice records
that review in `depends_on` (`reviews.depends_on`, nullable, added). Batches
(`POST /api/tickets/:key/review`, and `POST /api/reviews` with several targets)
are ordered by `orderBatch()` in `ticketGroups.ts`: group members in chain
order, then a topological pass so a target whose base is another target of the
batch comes after it. A worker takes the first pending review whose dependency
has ended (or no longer exists), skipping the others in place; when a review
ends, or a queued one is cancelled, workers are topped up again, so a waiting
child starts as soon as its parent ends. Any terminal parent status releases
the child (a failed or cancelled one with a warning in the child's log), so a
batch always settles. Positions in `ticket_branches` are rewritten in chain
order (`renumberPositions()`) after every parent change or sync, so a parent
never sorts after its child.

**Ownership and recovery.** The server and the CLI share the database, and
each can only ever finish the rows in its own memory. So every row records its
owner: `createReview()` and `enqueueReview()` write `runner_pid` and
`runner_started_at` (`SELF` in `processOwnership.ts`, the start time fixed at
module load). `recoverInterrupted(caller)` runs once at server start
(`caller = 'server'`) and once when the CLI starts (`'cli'`), before anything
is enqueued, and `shouldRecover()` decides per `queued`, `fetching`, or
`reviewing` row:

| owner recorded on the row | server | CLI |
|---|---|---|
| none (written before ownership existed) | fail | leave |
| this process (same pid and start time) | leave | leave |
| this pid, another start time (an earlier process) | fail | fail |
| another pid that exists (`kill(pid, 0)` succeeds or EPERM) | leave | leave |
| another pid that does not exist (ESRCH) | fail | fail |

A failed row gets `status = 'failed'`, `error = 'interrupted by restart'`, and
a log line naming the gone pid. A reused pid can keep a dead owner's row
active; cancelling it clears it. For every row it fails, recovery also stops
the reviewer processes in its `reviewer_pgids` that are still running
(SIGTERM, SIGKILL after 2 s), but only those that pass `isOrphanReviewer()`:
`ps` still shows the pid as the leader of that group, its command line still
contains the recorded binary's name, and its start time is within 10 s of the
recorded spawn time. Anything else may be an unrelated process that got the
pid, and is left alone. `src/events.ts` is a process-level `EventEmitter`;
each SSE message is `data: {"type":"log"|"status"|"done","reviewId":n,...}\n\n`,
with a heartbeat comment every 15 seconds.

## HTTP API

Fastify on `127.0.0.1:PORT`, serving `web/dist` statically at `/` with an SPA
fallback, and the API under `/api` (routes in `src/server.ts` and
`src/routes/*.ts`). Handlers validate input with zod and return errors as
`{ error: string }` with a proper status code. Unknown `/api/` paths are a JSON
404; other unknown GET paths serve `index.html`. Every endpoint is listed in
[README › HTTP API](../README.md#http-api).

`GET /api/reviews/:id` also returns `comparison` — the findings of this run
against the branch's previous finished run, matched on severity, file, line,
and title (`findingCompare.ts`) into `resolved`, `new`, and `persistent` — and
`links`, the GitHub URLs built by `githubLinks.ts` from the configured
organization (the UI cannot know it). The list endpoints add a smaller
`links: { branch, pr }` (`rowLinks()`) to every row of `GET /api/reviews` and to
every branch of `GET /api/review-groups`, so run tables can link to GitHub; the
MCP formatters pick their fields explicitly and are unaffected.

## Report writer (`src/reportWriter.ts`)

`writeReport()` returns a path relative to `DATA_DIR`:
`reports/<ticket_key || repo>/<repo>__<sanitized-branch>/run-<runIndex>-<YYYYMMDD-HHmmss>.md`

The report opens with the verdict, then a meta table (ticket, repository, the
source and base reason for local runs, branch with head and base shas, diff
size, and the run: number, timestamp, reviewer, model), `## Summary`,
`## Ticket requirements` as a table with status icons (met ✅, partial ⚠️,
missing ❌, not_verifiable ❓), `## Issues to fix` ordered by severity with
`file:line` (with the kind label and an anchor warning when there is one),
`Caused by` for non-diff kinds, the hunk when given, problem, why, suggested
fix, and snippet, `## Suggestions
(non-blocking)` listing the observations as `` - `file:line` — note `` with an
indented rationale line (or `None.`), and `## Conclusion` naming exactly what is
still required before merge.

## Web UI (`web/`)

Vite + React + TypeScript, dev server on `127.0.0.1:5179` proxying `/api` to
`PORT`. Plain CSS in `web/src/styles.css` — no UI framework, no CDN.
Dark-first, compact. What each page offers is described in
[README › The web UI](../README.md#the-web-ui).

- **Home** — the launcher (GitHub or Local mode, reviewer, model; the choices
  are kept in `localStorage`) and the history. The placeholder follows what
  `/api/health` reports. A ticket-key input calls `GET /api/tickets/<input>`
  first and shows the ticket, a chip naming the tracker that answered, and the
  branches with checkboxes; the chosen targets are posted. **Paste requirements
  instead** sends `requirementsText` and skips the ticket lookup. The history
  has two views, **By ticket** (`/api/review-groups`, 20 groups a page) and
  **All runs** (`/api/reviews`, 25 a page); the chosen view is remembered, and
  both refresh every 4 s while something on screen is running. A group row is
  compact — key, title, `N branches · M runs`, one outcome badge (active, else
  the worst latest verdict, else the latest status), last activity — in a
  fixed-layout table whose ticket column takes the free width; below 640 px the
  last-activity column folds into the summary cell. Expanding a row loads its
  runs lazily and shows them per branch (one `<tbody>` each: a header with the
  branch's GitHub and PR links and latest outcome, then its runs newest first,
  five before "N older runs"). Every run table links the branch and PR to
  GitHub in a new tab, while rows and run numbers open the review page. An
  issue link in the launcher is recognized client-side (`web/src/tickets.ts`),
  named under the field, and resolved like a key.
- **Review detail** (`/review/:id`) — verdict banner with GitHub links and the
  ticket in its tracker ("Open in Linear", labelled from the `ticket_url` host),
  meta table, requirements, findings by severity (a non-diff finding shows a
  kind badge and "caused by `file:line`", a bad anchor a warning tag; the hunk
  header is the location's tooltip), observations, the comparison
  with the previous run, a live log fed by SSE, and the Preview card. Actions: cancel, re-run with an optional reviewer and model,
  download report, copy report, delete.
- **Ticket view** (`/ticket/:key`) — the ticket group (`GET
  /api/ticket-groups/:key`): chains with parents, drag or ↑ ↓ (`PUT .../order`,
  a linear chain), a parent menu per branch (`PUT .../parent`), the latest run
  and code verdict per branch, the coverage table, and Review ticket /
  Recompute coverage / Re-detect order; then all runs of the group across
  repositories, newest first. It polls every 4 s while a run is active or
  coverage is pending. A fallback `repo#branch` group shows its runs only.
  The review page of a slice shows the code verdict banner and a Ticket
  coverage card read from `ticket_group`.
- **Previews** (`/previews`, only when enabled) — start a preview from a ticket
  or from custom branches per role, and follow every preview.

Routing is a small hand-written history-based router; there is no react-router
dependency.

## MCP server (`src/mcp.ts`, `src/mcp/`)

`dist/mcp.js` (also the `code-review-mcp` bin) is a stdio MCP server built on
`@modelcontextprotocol/sdk`. It is a thin HTTP client of the running API
(`mcp/client.ts`, base URL from `CODE_REVIEW_API_URL`): it must never import
`config.ts` or anything that needs a secret, so the MCP process holds no token
and reads no `.env`. stdout carries only the protocol; diagnostics go to
stderr. Tools are registered in `mcp/server.ts` and their output is compacted
in `mcp/format.ts`; the tool list is in
[README › Use from other agents](../README.md#use-from-other-agents-mcp).

**Recursion guard.** A reviewer CLI is the same kind of agent that might have
this server configured. Each reviewer's argv keeps user MCP servers out of the
run, and as a second line of defence `mutationRefusal()` makes `start_review`,
`rerun_review`, `cancel_review`, `start_preview`, and `stop_preview` refuse
(and `start_ticket_review`, `set_branch_parent`, and `get_ticket_coverage`
with `recompute`) whenever `CODE_REVIEW_TOOL_REVIEWER` is set (and not `0`/`false`) in the MCP process's environment.

**Failures are told apart.** `ApiUnreachableError` means nothing listens at
the address (connection refused, unknown host, no route); only it suggests
starting the server. A request the server accepted but did not answer in time,
or whose connection dropped halfway, is an `ApiNoAnswerError`: the server is
busy, and a mutating request (starting a preview, say) may well have taken
effect, so the message says to check `get_*` / `list_*` instead of retrying,
and never to restart: a restart tears down every live preview and fails every
running review. Both messages carry that warning.

## Preview environments (`src/preview/`)

A preview is branches running as a clickable stack. The engine is
product-agnostic: what to run lives in a **recipe** outside this repository
(`PREVIEW_RECIPES_DIR`, `recipes/` by default, gitignored). One documented,
product-neutral sample ships in `recipes.example/`. The whole feature is off
until `PREVIEW_ENABLED` is set. No reviewer CLI is involved.

| module | responsibility |
|---|---|
| `recipes.ts` | zod schema, loading (`//` and block comments allowed), validation; errors name the field and the file |
| `roles.ts` | pure branch-per-role planning: hand-picked overrides, the review's branch, the input's and the ticket's branches, base-branch fallback |
| `ports.ts` | host port allocation, verified by binding, held until the row records it |
| `database.ts` | where the data comes from: `pg_dump` → newest file in `dumpDir` → clean |
| `steps.ts` | runs one recipe command, streams its output, enforces timeouts, kills the process group |
| `engine.ts` | lifecycle, worker pool, teardown, TTL reaper, orphan recovery |
| `store.ts` | `previews` and `preview_logs` rows |
| `events.ts` | preview SSE bus, mirroring `src/events.ts` |

**Roles.** `requestPreview()` checks hand-picked roles against the recipe, their
branches against the remote (one uncached retry, so a branch pushed a moment ago
is found) and local roles (`local: true` or `local:<repo>#<branch>`) against
their clone (`checkLocalOverrides()`, which also records the tip), then
`resolveRoles()` plans one role per recipe repository:
a hand-picked branch wins (empty = base branch); then the review's own branch
for its repository; then the branches of the input, which is resolved with
`resolveTargets()` — and when that input is a PR whose branch carries a tracker
key, the ticket is resolved as well so its other repositories join, the PR's
branch still winning for its own; otherwise the base branch, recorded as
`usedBase`. When every role is hand-picked, no ticket is resolved. A role from a
local override, a local review, or a `local:` input carries `source: 'local'`;
`checkoutTarget()` turns it into a local `ResolvedTarget`, so the sandbox
copies the clone's `refs/heads/<branch>` exactly as for a local review
(committed state only, so a branch checked out in a worktree of the clone
works). Every role records the commit it ran as `sha` in `roles_json` once its
checkout exists; a local review checkout holding a working-tree snapshot is
never reused. A role that follows a local review (no override picked it)
reuses the review's checkout, the reviewed commit, while it is on disk; only
without one is the branch copied from the clone again, so only then must it
still exist there (`checkReviewRoles()`, before anything is queued). A preview
that picks every role by hand never reads the reviewed branch. A local role
resolved to a tip (a hand-picked branch, or the reviewed branch copied again)
reuses a review checkout only when the review ran that very commit
(`canReuseReviewCheckout()`); otherwise it is copied fresh and runs the tip.

**Lifecycle.** `queued → preparing → starting → ready`, then `stopping →
stopped`, or `failed` / `expired`. At most `PREVIEW_MAX_CONCURRENT` previews are
between `preparing` and `ready` at once; the rest wait in the queue and report
their position. `preparing` reuses the review's checkout when it is still on
disk and otherwise fetches through the same Docker sandbox as a review (a
branch deleted on the remote falls back to its base branch here, preview-only:
a review of a vanished branch still fails), allocates the ports, resolves the
database source, and runs `prepare`. `starting` runs `up` and then polls
`health` every 3 s until every command exits 0. All of it shares
`readyTimeoutSec`; `stepTimeoutSec` caps a single command. A ready preview
gets `expires_at = ready_at + PREVIEW_TTL_MINUTES`, and a reaper checks every
30 s.

**Database source.** `mode: "auto"` tries `pg_dump` (the host's binary) against
the configured live database first — after a five second TCP probe, so an
unreachable host cannot hang a preview — then the newest non-empty file in
`dumpDir`, then a clean install. A launch may override the mode (`dumpMode`).
The mode that actually happened is stored as `dump_mode` and handed to the
steps as `DUMP_MODE`. Only `onFailure: "fail"` turns a missing dump into an
error; nothing ever waits for a human.

**Steps.** Commands come from a trusted local file and run through `/bin/sh`
with `PREVIEW_DIR` as the working directory. No value is ever interpolated into
a command string: checkouts, branches, ports, database coordinates and the dump
are passed through the environment (`CHECKOUT_<ROLE>`, `BRANCH_<ROLE>`,
`BASE_<ROLE>`, `USED_BASE_<ROLE>`, `PORT_<ID>`, `DB_*`, `DUMP_FILE`,
`DUMP_MODE`, …; the full list is in
[recipes.example/README.md](../recipes.example/README.md)), on top of the same
scrubbed environment the reviewer gets (`buildSanitizedEnv()`, without the
reviewer marker) and the recipe's `env`. Each child gets
its own process group, so a timeout or a stop kills the whole tree.

**Teardown.** `down` runs on stop, on any failure, on timeout, on TTL expiry,
and at server start for previews a restart left behind — it is idempotent,
every command runs even if an earlier one failed, and it runs even when
`prepare` died halfway. The context needed to tear a preview down later
(environment and checkouts) is written to
`<DATA_DIR>/previews/<id>/preview-context.json`. After teardown a reused review
checkout is verified pristine with `assertPristine`; checkouts the preview
fetched itself are removed, and so is a dump taken for it. A checkout counts
as the preview's own from before its clone starts (`checkoutDir()`), so a
fetch that fails halfway leaves no directory behind.

**Stopping.** `POST /api/previews/:id/stop` answers as soon as the row says
`stopping` (`beginStop()`): `down` can take minutes and goes on in the
background, and the row turns `stopped` when it is done. A second stop while
one is running joins it instead of running `down` again. Deleting a preview,
the TTL reaper, and the restart recovery still wait for the teardown.

**Restarts.** `recoverOrphanPreviews()` runs at server start: every preview
still `queued`, `preparing`, `starting`, `ready`, or `stopping` is torn down
with `down` and marked `stopped` with `error = 'interrupted by restart'` — a
restart ends live previews, ready ones included. Shutting the server down runs
no teardown; that happens on the next start.

## Non-goals

- No pushing, committing, or commenting on GitHub or any ticket tracker.
- No editing of reviewed repositories.
- No multi-user auth; the server is `127.0.0.1` only.
