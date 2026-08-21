# code-review-tool

A local, read-only code-review tool. Give it a ticket key, a GitHub pull request
URL, or `repo#branch`. It resolves the matching branches, fetches them into an
isolated Docker sandbox, runs a Claude Code review against the ticket
requirements, stores the run in SQLite, and writes a Markdown report.

Tickets can come from Linear, Jira, GitHub Issues, Azure DevOps, or YouTrack —
whichever you configure. With none configured you paste the requirements
instead, and everything else works the same.

The tool never modifies the reviewed code, never pushes, and never comments
back on any of them. Reports are local files; what you do with them is up to
you.

## How a review works

1. **Resolve.** The input is turned into one or more `repo` + `branch` targets.
   A ticket key is looked up in whichever tracker claims it; its pull-request
   links and any branch whose name contains the ticket key are collected.
2. **Fetch.** Each branch is cloned inside the Docker sandbox, together with its
   base branch. The checkout's remote and credentials are then stripped.
3. **Review.** The `claude` CLI runs against the checkout with edit tools
   disabled. It restates the ticket as a requirement list, reads the diff and
   the surrounding code, honours the reviewed repository's own `CLAUDE.md` /
   `AGENTS.md` conventions, and returns a structured JSON verdict.
4. **Report.** The verdict, requirement checklist, and findings are stored in
   SQLite and rendered to a Markdown report.

## Prerequisites

- Docker, running. The git sandbox image is built from `docker/Dockerfile.git`.
- Node 20 or newer.
- The `claude` CLI, installed and already logged in.
- Optionally, credentials for a ticket tracker (see below).
- A GitHub token with read access (`repo` scope) to the repositories you want to
  review. Use a dedicated read-only token, not your everyday personal one.

## Setup

```bash
cp .env.example .env   # then fill it in
npm run setup          # installs both workspaces and builds the sandbox image
```

### Environment

| var | required | default | meaning |
|---|---|---|---|
| `REVIEW_GH_TOKEN` | yes | — | GitHub token with read access to the allowed repositories |
| `GITHUB_ORG` | yes | — | GitHub organization or user that owns the repositories |
| `ALLOWED_REPOS` | yes | — | Comma-separated repository names, e.g. `my-service,my-frontend` |
| `PORT` | no | `5178` | API port, bound to `127.0.0.1` |
| `DATA_DIR` | no | `<repo>/data` | Where the database, checkouts, and reports live |
| `CLAUDE_BIN` | no | `claude` | Path to the Claude Code CLI |
| `REVIEW_MODEL` | no | `opus` | Model passed to `claude --model` |
| `REVIEW_TIMEOUT_MS` | no | `1800000` | Hard timeout for one review process (each lens and the synthesis pass) |
| `REVIEW_CONCURRENCY` | no | `2` | How many reviews run at once. Each review fans out to 5 lens processes plus a synthesis pass, so the process ceiling is this value * 6 |
| `DOCKER_BIN` | no | `docker` | Path to the Docker CLI |
| `GIT_IMAGE` | no | `code-review-tool-git:latest` | Sandbox image tag |

`GITHUB_ORG` and `ALLOWED_REPOS` have no defaults; the server refuses to start
without them.

### Ticket trackers

Every tracker is optional. A tracker is active only when all of its variables
are set, and a missing one is reported only when you actually use it.

| tracker | prefix | variables | recognises |
|---|---|---|---|
| Linear | `linear:` | `LINEAR_API_KEY` | `ABC-123` |
| Jira Cloud | `jira:` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | `ABC-123`, a `/browse/ABC-123` URL |
| GitHub Issues | `github:` | none beyond `GITHUB_ORG` and `REVIEW_GH_TOKEN` | `my-org/my-service#123`, an issue URL |
| Azure DevOps | `azure:` | `AZURE_ORG_URL`, `AZURE_PROJECT`, `AZURE_PAT` | `123`, `#123`, a `_workitems/edit/123` URL |
| YouTrack | `youtrack:` | `YOUTRACK_BASE_URL`, `YOUTRACK_TOKEN` | `ABC-123`, an `/issue/ABC-123` URL |

Linear, Jira, and YouTrack all read `ABC-123` the same way. If more than one of
them is configured, set `DEFAULT_TRACKER` to the one that should win, or say it
per input with a prefix: `jira:ABC-123`. Without either, an ambiguous key is an
error that names the trackers involved.

`GET /api/health` lists the active tracker names, never their values.

### Reviewing without a tracker

You do not need a tracker at all. In the UI, open **Paste requirements
instead**, type what the branch is supposed to do, and give a pull request URL,
a tree URL, or `repo#branch` as the input. The first line becomes the title, the
text becomes the requirements, and the run is stored with no ticket key. From
the terminal it is `--requirements`:

```bash
npm run review my-service#feature/example --requirements "Reject expired tokens on refresh."
```

## Usage

Development, with hot reload:

```bash
npm run dev   # API on 127.0.0.1:5178, web dev server on 127.0.0.1:5179
```

Built:

```bash
npm run build && npm start   # http://127.0.0.1:5178
```

In the UI, type a ticket key (`ABC-123`), a pull request URL, or `repo#branch`.
A prefix picks the tracker explicitly (`jira:ABC-123`).
For a ticket key the tool first shows the ticket and every branch it found, so
you can pick which ones to review. Each run has its own page with the verdict,
the requirement checklist, findings grouped by severity, and a live log.

From the terminal:

```bash
npm run review ABC-123
npm run review my-service#feature/abc-123-example
npm run review https://github.com/my-org/my-service/pull/12
```

The CLI streams progress, prints the report path, and exits `0` only when every
review says the branch can be merged.

## Preview environments (optional)

A preview runs the reviewed branches as a real, clickable stack, started from
the UI and torn down on demand or when its time to live runs out. There is no
manual step between the click and a working URL.

The tool itself knows nothing about any product: what to start lives in a
**recipe** — a directory with a `recipe.json` naming the repositories, the ports
to allocate, where the database comes from, and the shell commands for
`prepare`, `up`, `health` and `down`. `recipes.example/` holds one documented,
product-neutral sample; `recipes/` is gitignored so a real recipe never lands in
the repository.

```bash
cp -r recipes.example/example-app recipes/example-app
$EDITOR recipes/example-app/recipe.json
echo 'PREVIEW_ENABLED=1' >> .env
```

Then `GET /api/recipes` lists what loaded, together with any recipe that failed
validation and why. See [recipes.example/README.md](recipes.example/README.md)
for every variable a step receives.

Data comes from the freshest source that works: a `pg_dump` of a live database,
otherwise the newest dump file in a directory, otherwise a clean install. An
unreachable database never blocks a preview; the mode that actually happened is
shown in the UI.

| variable | default | meaning |
|---|---|---|
| `PREVIEW_ENABLED` | `0` | turns the feature on |
| `PREVIEW_RECIPES_DIR` | `<repo>/recipes` | where recipes live |
| `PREVIEW_PORT_RANGE` | `21000-21999` | host ports the engine may allocate |
| `PREVIEW_TTL_MINUTES` | `120` | how long a preview stays up |
| `PREVIEW_MAX_CONCURRENT` | `3` | previews running at once; the rest queue |

## Where things live

- `data/review.db` — run history, findings, requirements, logs (SQLite).
- `data/reports/<ticket|repo>/<repo>__<branch>/run-N-<timestamp>.md` — reports.
- `data/checkouts/` — temporary checkouts, removed after a successful review.
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
- **The reviewer has no write tools and no tokens.** The `claude` process runs
  with `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`,
  and `Task` disabled, and with `GH_TOKEN`, `GITHUB_TOKEN`, `REVIEW_GH_TOKEN`,
  and every tracker token removed from its environment. After each run the checkout
  is verified to be unchanged; a modified checkout fails the review.
- **The allowlist bounds what can be fetched at all.** Only
  `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` is
  accepted, both in the Node process and again in the container entrypoint,
  which refuses any argument pointing at another host or organization.
- **The server is local.** It binds to `127.0.0.1` only and has no
  authentication, because it is not reachable from outside the machine.

## License

MIT. See [LICENSE](LICENSE).
