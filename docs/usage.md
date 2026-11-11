# Usage

Development, with hot reload:

```bash
npm run dev   # API on 127.0.0.1:5178, web dev server on 127.0.0.1:5179
```

Built:

```bash
npm run build && npm start   # http://127.0.0.1:5178
```

## Inputs

Every entry point — the UI, the CLI, `POST /api/reviews`, and the MCP
`start_review` tool — accepts the same inputs:

| input | what is reviewed |
|---|---|
| `ABC-123`, or `jira:ABC-123` to pick the tracker, or the ticket's issue link ([which](configuration.md#ticket-trackers)) | every branch of the ticket: the pull requests it links to (each against its PR base), plus every branch of an allowed repository whose name contains the key (any case, dash optional: `abc123`) or equals the ticket's branch name (against the default branch). One review per branch |
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

## The web UI

- **Reviews** (`/`) — the launcher and the history. Pick **GitHub** or
  **Local**, a reviewer, and a model (all three remembered per browser; a
  remembered model the reviewer no longer lists is dropped for its current
  default, and a reviewer with no models says so). A ticket key
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
  page; its Ticket column falls back to the title of pasted requirements. The filter matches ticket key and title, repository, branch, and group
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
  **Download**, **Copy report**, and **Delete** (asks first; not offered while
  the run is in progress).
- **Ticket page** (`/ticket/<key>`) — the ticket group: its chains with
  parents and the latest run of each branch, the ticket coverage, **Review
  ticket**, **Recompute coverage** and **Re-detect order** (see
  [Tickets split into several branches](#tickets-split-into-several-branches)),
  then every run of the group, grouped by repository and branch, newest first.
  A `repo#branch` group without a ticket shows its runs only.
- **Previews** (`/previews`) — only when previews are enabled; see
  [below](previews.md#preview-environments-optional).

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
model uses that reviewer's default model, and so does a previous model the
reviewer no longer lists. Every run of a branch hands the
blocker and major findings of the branch's previous finished run to the
reviewer, which reports whether each one is fixed.

## Command line

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


## Reviewing without a tracker

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

## Reviewing a local (unpushed) branch

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
  the clone's own `origin/<base>` is used and the log warns that it may be
  stale (a clone with no GitHub remote gets a plain note instead). Any other base
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
  again; see [Local branches in a preview](previews.md#local-branches-in-a-preview).

## Tickets split into several branches

A ticket is often split into several branches: a backend and a frontend
repository, and stacked slices (`main` -> `feat/a` -> `feat/b`). The tool keeps
them as a **ticket group**: per repository, a chain of branches, each with the
**parent** it is diffed against.

- **Membership.** Every branch reviewed for a ticket joins its group (the
  ticket key, or the ticket-like key in the branch name). Groups older than this
  feature are built from their runs, with the base of each branch's latest run
  as its parent (`stored`).
- **Parents.** Per branch, in order: a parent set by hand (`user`, kept until
  you reset it); the base of the branch's pull request when it is not the
  default branch (`pr`); for a pushed branch, the closest other branch of the
  group in the same repository whose tip it contains, from GitHub's compare
  API, when it is strictly closer than the default branch (`detected`); for a
  local branch, the detected parent of the clone (see above); otherwise the
  default branch (`default`). A parent that would close a loop is refused.
- **Review the ticket.** **Review ticket** on the ticket page, `POST
  /api/tickets/<key>/review`, or the MCP tool `start_ticket_review` resolves
  the ticket again, re-detects the parents, and queues every branch of every
  chain parents first, each diffed against its parent, as ordinary single-branch
  runs. A child whose parent is in the same batch waits in the queue until the
  parent's review has ended (done, failed, or cancelled: a parent that did not
  finish releases it, with a note in its log); `POST /api/reviews` with several
  branches of one ticket orders and chains them the same way and records a
  ticket run. A branch whose parent is outside the batch and has no finished
  review yet still runs; the answer says so. `requirementsText` (approved decisions, scope notes; one item per
  line or list entry) joins the ticket's requirement checklist as items added by hand. `start_review` of one branch
  works as before; when the branch belongs to a group, its base defaults to
  the group's parent (an explicit `baseBranch` wins), and so does a re-run.
- **Requirement checklist.** A ticket has one stored checklist, so every run
  of every branch and the coverage evaluate the same items with the same ids
  (`R12`). The first review of the ticket derives it before its lenses start:
  one reviewer pass (`src/prompts/requirements.md`, same reviewer and model as
  the review, no code access) reads the ticket text and its comments from the
  tracker (the stored text when the tracker does not answer) and returns
  concrete, checkable items; a decision in the comments, or an item added by
  hand, replaces the original text, and work no repository can show is listed
  apart as "not checked in code". Branch reviews running at the same time share
  that one pass. Synthesis then reports a status and evidence per id; it may
  not add or reword items, only propose additions, which the review page shows
  with **Add to ticket** (nothing is added on its own). Edit the list on the
  ticket page (edit, add, remove, reorder, **Re-derive**: derived items are
  replaced, an unchanged text keeps its id, items added or edited by hand
  stay), with `PUT /api/ticket-groups/<key>/requirements`, or with the MCP
  tools below; edits apply to the next run. Removed items keep their id, so
  older statuses stay readable. A branch without a ticket group, or a ticket
  whose derivation failed, derives its requirements in synthesis as before.
- **Code verdict per branch.** A branch of a group is told which other slices
  exist. A requirement it does not implement is not a finding: its checklist
  marks it `missing` for this branch, and its verdict (`code_verdict`, also
  stored as `verdict`) comes from its findings only: approve when there is no
  blocker or major finding. A branch without a ticket keeps the old combined
  verdict, in which unmet requirements block the merge.
- **Coverage per ticket.** Once every queued run of a group has settled (15 s
  after the last one, `COVERAGE_DEBOUNCE_MS`, so a batch is covered once), one
  more reviewer pass (`src/prompts/coverage.md`) reads the ticket and every
  branch in stack order: its changed files, review summary, and requirement
  checklist. Per requirement it returns `covered`, `partial`, or `missing`
  and the branches that cover it, with evidence `file:line` that is checked
  like a finding anchor in that branch's checkout (kept on disk for this pass,
  then removed). The group verdict is `covered` when every requirement is,
  else `needs_work`. A branch with no finished review covers nothing, so a
  planned slice that has no branch yet shows as "not covered anywhere".
  **Recompute coverage**, `POST /api/tickets/<key>/coverage`, or
  `get_ticket_coverage` with `recompute: true` runs a pass at once.
- **Cross-repository contract.** The coverage pass also gets, per branch,
  the diff of its contract files (`git diff <base>..<head>` in the sandbox,
  from the branch's checkout, at most 400 lines per branch with a note naming
  the files cut), and compares what the backend returns, renames, or removes
  with what the frontend reads or sends. It reports `contract_issues`
  (`problem`, `severity` `major`/`minor`, and `sites`: repo, branch, file,
  line), only for a mismatch it can show at both ends; each site is checked
  like a finding anchor in that branch, and an issue with fewer than two sites
  that exist is dropped. Contract files are `contractGlobs` from
  `RULES_DIR/<repo>.json` when that file sets them, else
  `**/*serializers*.py`, `**/*views*.py`, `**/*urls*.py`, `**/*schemas*.py`,
  `src/Services/**`, `src/Models/**`, `src/**/*Models.ts`,
  `src/**/*Service.ts`, without tests (a glob starting with `!` excludes). The
  issues show under the coverage table on the ticket page ("No contract
  mismatch found" when there are none), in the coverage report, and in
  `get_ticket_coverage` and `wait_for_ticket_review` (`contract.checked` is
  false for a pass that predates the check). They do not change the coverage
  verdict.
- **Where it shows.** The ticket page lists the chains (parent, why it was
  picked, the latest run and code verdict per branch; drag or ↑ ↓ to make a
  repository one chain in that order, or pick a parent per branch), the
  coverage table, and the actions. A branch's review page shows its code
  verdict and the coverage seen from it: "in this branch", "in
  `repo#branch`", or "not covered anywhere". Its report gets a Ticket coverage
  section, refreshed after each pass, and every pass writes
  `reports/<ticket>/coverage-<ts>-<id>.md`.
- **Preview the ticket.** With previews enabled, **Preview ticket** on the
  ticket page runs the whole ticket as one [preview](previews.md#preview-environments-optional):
  per recipe role, the tip of its repository's chain (the last branch in
  chain order, which contains every slice below it), copied from the local
  clone when that branch's latest review was local, else from GitHub; a
  repository without a branch in the group runs its base branch. The panel
  shows these roles, lets you change any of them (Change branches), offers a
  recipe picker when several recipes exist, and then starts the preview and
  opens it on `/previews`. When a live preview already runs exactly these
  branches, it offers **Open preview #N** instead of starting a second one.
  The plan comes from `GET /api/ticket-groups/<key>/preview-plan`; the MCP
  tool `start_preview` with only `ticket` uses the same plan
  (`get_ticket_preview_plan` shows it). A repository whose branches do not
  stack into one line is noted; the last branch in chain order runs.
- The CLI reviews branches the same way but does not run coverage (it exits
  when its reviews end); the server's next pass, or a recompute, covers them.


## Findings and their anchors

A finding points at one place, `file:line`. Not every finding sits in the diff:
a caller the branch broke, or documentation it made stale, lives in a file the
branch never touched. Each finding therefore says what its location is:

| field | meaning |
|---|---|
| `kind` | `diff` (a changed line), `regression` (untouched code that now breaks), `stale_doc` (untouched docs that describe the old behaviour), `consumer` (an untouched parser or client of a changed shape) |
| `cause_file`, `cause_line` | for a non-diff kind: the changed line that causes it; must be in the changed set |
| `hunk` | for a diff finding, when the reviewer gave it: the hunk header `@@ -a,b +c,d @@` |
| `lens` | the lens whose candidate synthesis kept, when known; `tool` for a [tool check](configuration.md#repository-rules-and-tool-checks) |
| `anchor_status` | the check below: `ok`, `off_diff`, `missing_path`, `line_out_of_range`, or `unverified` |

After synthesis the tool checks every finding at HEAD, in the sandbox
checkout: the path must exist inside the checkout, the line (and `end_line`)
must be within the file, and the path must be in the changed set (`git diff
--name-status -M`, renames under their new path) unless the finding has a
non-diff kind and a valid cause in that set. `off_diff` means a real place
outside the diff with no such cause; `unverified` means there was no location
to check (or the row is older than the check). Findings that fail get ONE
corrective re-anchor pass together (at most 40, one attempt, no retry); an
answer is applied only when it improves the status. A finding is never dropped
for its anchor: when the pass cannot fix it, it keeps its status and the UI,
the report, and `get_review` show it.

The web UI and the report render a non-diff finding with a badge (dependent
site, stale doc, consumer) and "caused by `file:line`", and a wrong anchor
with a visible warning (path not found, line out of range, outside the diff).
Plain diff findings stay a plain `file:line`.
