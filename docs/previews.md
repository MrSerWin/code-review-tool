# Preview environments (optional)

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
validation and why. See [recipes.example/README.md](../recipes.example/README.md)
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
(labels and paths from the recipe's `ports`; a port with `"link": false`, such
as the database, gets none; see
[recipes.example](../recipes.example/README.md#ports-and-links)) and the recipe's
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

### Local branches in a preview

A role can run a branch of a [local clone](usage.md#reviewing-a-local-unpushed-branch)
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
