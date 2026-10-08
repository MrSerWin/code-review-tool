# Example recipe

A recipe teaches the preview engine how to run one product. The engine itself
knows nothing about any product: it allocates ports, resolves branches and a
database dump, then runs the shell commands the recipe provides. How previews
are started and which branch each role runs is described in
[README › Preview environments](../README.md#preview-environments-optional).

## Using it

```bash
cp -r recipes.example/example-app recipes/example-app
$EDITOR recipes/example-app/recipe.json
```

`recipes/` is gitignored, so a real recipe never lands in this repository. Point
`PREVIEW_RECIPES_DIR` somewhere else if you keep recipes outside the checkout,
and set `PREVIEW_ENABLED=1`.

A recipe is `<PREVIEW_RECIPES_DIR>/<name>/recipe.json`; `name` inside it must
match the directory name, every repository in `repos` must be in
`ALLOWED_REPOS`, and `//` and `/* */` comments are allowed. Files beside it
(compose files, scripts) are reachable through `RECIPE_DIR`.

`GET /api/recipes` lists what was loaded and reports every recipe that failed
validation, with the offending field and file path. A broken recipe is skipped;
it never keeps the server from starting.

## Variables every step receives

| variable | meaning |
|---|---|
| `PREVIEW_ID` | unique id, safe as a docker project name (`preview-42`) |
| `PREVIEW_DIR` | scratch directory for this preview; also the working directory of every step |
| `RECIPE_DIR` | directory holding `recipe.json` and any files beside it |
| `TICKET_KEY` | ticket the preview came from, or empty |
| `CHECKOUT_<ROLE>` | absolute path to that role's checkout, e.g. `CHECKOUT_BACKEND` |
| `BRANCH_<ROLE>` / `BASE_<ROLE>` | branch actually used, and its base branch |
| `USED_BASE_<ROLE>` | `1` when the role runs its base branch (no branch of its own, an empty hand-picked branch, or a branch gone from the remote), else empty |
| `PORT_<ID>` | allocated host port per logical port, e.g. `PORT_API` |
| `DB_NAME` `DB_USER` `DB_HOST` `DB_PORT` | preview database coordinates: `database.name` (default `preview_<id>`), `database.user` (default `postgres`), `database.host` (default `127.0.0.1`), and the port allocated for `db` (or `postgres`), else `database.port`, else `5432` |
| `DUMP_FILE` | resolved dump file, or empty for a clean install |
| `DUMP_MODE` | `pg_dump`, `dump-dir` or `clean` — what actually happened |

Steps run with the same scrubbed environment as the reviewer: no tracker token
and no GitHub token, plus whatever the recipe's own `env` block adds. Unlike a
reviewer, a step does not get `CODE_REVIEW_TOOL_REVIEWER`.

Commands are executed verbatim through `/bin/sh`; no value is ever interpolated
into the command string, so quote your variables (`"$PREVIEW_DIR"`).

## Rules the engine enforces

- Steps run in order: `prepare`, `up`, then `health`, which is polled every 3 s
  until every command exits 0. Its output is mirrored to the log on the first
  attempt and every fifth one, so a slow start does not bury the log.
- `readyTimeoutSec` is the budget from the moment the preview leaves the queue
  until `health` passes: checkouts, the database dump, `prepare`, `up`, and
  `health` together. `stepTimeoutSec` caps a single command; a timed-out
  command's whole process group is killed.
- `down` runs on stop, on failure, on timeout, on TTL expiry, and at server
  start for previews a restart left behind. Every command runs even when an
  earlier one failed. Write it so it succeeds even when nothing was started.
- Checkouts are never modified. After teardown a reused review checkout is
  checked for local changes.
- No dump is ever a reason to stop and wait: with `onFailure: "clean"` the
  preview starts on an empty database and records `dump_mode: "clean"`. The
  `pg_dump` source runs the host's `pg_dump` (custom format, to
  `$PREVIEW_DIR/live.dump`, removed at teardown) after a five-second
  reachability probe, with the recipe's `env` (put `PGPASSWORD` there).

## Background processes

Most apps do more than answer HTTP requests: a queue worker runs async jobs, a
scheduler fires periodic tasks, a listener reacts to database notifications. A
preview that runs only the web server looks fine until someone uses one of
those paths: the job never completes, the notification never arrives, and any
screen that polls for a result waits forever. Run them in the preview the way
production does.

**Declare them as compose services that reuse the api service's image and
environment.** Give the api service an explicit `image:` name and put its
environment behind a YAML anchor, so every worker runs the same build with the
same settings and nothing is built twice:

```yaml
x-api-env: &api-env
  DATABASE_URL: postgres://${DB_USER}:preview@db:5432/${DB_NAME}

services:
  # db and web as in example-app/compose.yml
  api:
    image: example-app-api:${PREVIEW_ID}
    build:
      context: ${CHECKOUT_BACKEND}
    environment: *api-env
    ports:
      - "${PORT_API}:8000"

  worker:
    image: example-app-api:${PREVIEW_ID}
    command: ["./manage.sh", "worker"]
    environment: *api-env
    network_mode: "service:api"
    depends_on:
      - api
    restart: unless-stopped
```

Build the image before `up` starts the workers — a `docker compose run --rm api
…` in `prepare` (as the example does for migrations) or a plain
`docker compose build api` — and remove it in `down`, since the tag is per
preview.

**Share the api network namespace when the app relies on localhost.**
`network_mode: "service:api"` puts the worker in the api container's network:
`127.0.0.1` and the compose service names mean exactly what they mean inside the
api container. Use it when the app talks to endpoints it reaches only as
`localhost` (a sidecar on `127.0.0.1:<port>`, URLs signed for one host name). A
service in that mode cannot publish ports of its own — publish them on the api
service — and has to be restarted when the api container is recreated.

**Make `health` wait for them.** "The web server answers" is not "the preview
works". Also check that every worker is up: a ping command its framework
offers, or a line it logs once it is ready.

**Mind `pipefail` in health scripts.** With `set -o pipefail`,
`docker compose logs worker | grep -q ready` can fail although the line is
there: `grep -q` exits at the first match, `docker compose logs` then dies of
SIGPIPE, and the pipeline reports the producer's failure. Keep the producer's
exit status out of it:

```bash
worker_up() {
  { docker compose -p "$PREVIEW_ID" -f "$PREVIEW_DIR/compose.yml" logs worker 2>/dev/null || true; } \
    | grep -q "ready"
}
```

**Never let a preview send real mail.** A restored dump holds real people's
addresses, and a worker is exactly what sends queued mail. Route the app's mail
backend to the console (log the message instead of sending it) in the
preview's settings.
