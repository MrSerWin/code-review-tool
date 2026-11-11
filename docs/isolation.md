# Isolation and storage

## Where things live

- `data/review.db` — run history, findings, requirements, observations, logs,
  and previews (SQLite).
- `data/reports/<ticket|repo>/<repo>__<branch>/run-N-<timestamp>.md` — reports.
- `data/reports/.../run-N-<timestamp>.lenses/`: the raw JSON answer of each
  lens (`<lens>.json`, or `{ "error": ... }` for a failed lens), of the
  synthesis (`synthesis.json`), and of the re-anchor pass when it ran
  (`reanchor.json`), for debugging a finding back to its source.
- `rules/` (or `RULES_DIR`): repository rules and tool-check configs,
  gitignored; see [rules.example/](../rules.example/README.md).
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
  write tool removed (see [Reviewers](configuration.md#reviewers)). All four
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
