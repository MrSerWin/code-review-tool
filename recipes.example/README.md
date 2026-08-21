# Example recipe

A recipe teaches the preview engine how to run one product. The engine itself
knows nothing about any product: it allocates ports, resolves branches and a
database dump, then runs the shell commands the recipe provides.

## Using it

```bash
cp -r recipes.example/example-app recipes/example-app
$EDITOR recipes/example-app/recipe.json
```

`recipes/` is gitignored, so a real recipe never lands in this repository. Point
`PREVIEW_RECIPES_DIR` somewhere else if you keep recipes outside the checkout,
and set `PREVIEW_ENABLED=1`.

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
| `USED_BASE_<ROLE>` | `1` when the role had no branch and runs its base branch |
| `PORT_<ID>` | allocated host port per logical port, e.g. `PORT_API` |
| `DB_NAME` `DB_USER` `DB_HOST` `DB_PORT` | preview database coordinates |
| `DUMP_FILE` | resolved dump file, or empty for a clean install |
| `DUMP_MODE` | `pg_dump`, `dump-dir` or `clean` — what actually happened |

Steps run with the same scrubbed environment as the reviewer: no tracker token
and no GitHub token, plus whatever the recipe's own `env` block adds.

Commands are executed verbatim through `/bin/sh`; no value is ever interpolated
into the command string, so quote your variables (`"$PREVIEW_DIR"`).

## Rules the engine enforces

- `down` runs on stop, on failure, on timeout, on TTL expiry, and at server
  start for previews a crash left behind. Write it so it succeeds even when
  nothing was started.
- Checkouts are never modified. After teardown a reused review checkout is
  checked for local changes.
- No dump is ever a reason to stop and wait: with `onFailure: "clean"` the
  preview starts on an empty database and records `dump_mode: "clean"`.
