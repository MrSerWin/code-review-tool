# code-review-tool

A local, read-only code-review tool. Give it a Linear ticket key, a GitHub pull
request URL, or `repo#branch`. It resolves the matching branches, fetches them
into an isolated Docker sandbox, runs a Claude Code review against the ticket
requirements, stores the run in SQLite, and writes a Markdown report.

The tool never modifies the reviewed code, never pushes, and never comments on
GitHub or Linear. Reports are local files; what you do with them is up to you.

## How a review works

1. **Resolve.** The input is turned into one or more `repo` + `branch` targets.
   A ticket key is looked up in Linear; its pull-request attachments and any
   branch whose name contains the ticket key are collected.
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
- A Linear API key (Linear → Settings → Security & access → Personal API keys).
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
| `LINEAR_API_KEY` | yes | — | Linear personal API key (`lin_api_...`), sent raw |
| `REVIEW_GH_TOKEN` | yes | — | GitHub token with read access to the allowed repositories |
| `GITHUB_ORG` | yes | — | GitHub organization or user that owns the repositories |
| `ALLOWED_REPOS` | yes | — | Comma-separated repository names, e.g. `my-service,my-frontend` |
| `PORT` | no | `5178` | API port, bound to `127.0.0.1` |
| `DATA_DIR` | no | `<repo>/data` | Where the database, checkouts, and reports live |
| `CLAUDE_BIN` | no | `claude` | Path to the Claude Code CLI |
| `REVIEW_MODEL` | no | `opus` | Model passed to `claude --model` |
| `REVIEW_TIMEOUT_MS` | no | `1800000` | Hard timeout for one review |
| `DOCKER_BIN` | no | `docker` | Path to the Docker CLI |
| `GIT_IMAGE` | no | `code-review-tool-git:latest` | Sandbox image tag |

`GITHUB_ORG` and `ALLOWED_REPOS` have no defaults; the server refuses to start
without them.

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

## Where things live

- `data/review.db` — run history, findings, requirements, logs (SQLite).
- `data/reports/<ticket|repo>/<repo>__<branch>/run-N-<timestamp>.md` — reports.
- `data/checkouts/` — temporary checkouts, removed after a successful review.

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
  and `LINEAR_API_KEY` removed from its environment. After each run the checkout
  is verified to be unchanged; a modified checkout fails the review.
- **The allowlist bounds what can be fetched at all.** Only
  `https://github.com/$GITHUB_ORG/<repo>` for a repo in `ALLOWED_REPOS` is
  accepted, both in the Node process and again in the container entrypoint,
  which refuses any argument pointing at another host or organization.
- **The server is local.** It binds to `127.0.0.1` only and has no
  authentication, because it is not reachable from outside the machine.

## License

MIT. See [LICENSE](LICENSE).
