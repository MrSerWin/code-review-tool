# Contributing

Thanks for helping. Bug reports, feature requests, and pull requests are welcome.

## Development setup

Requirements: Node 20 or newer, and Docker for anything that runs a real review.

```bash
git clone https://github.com/MrSerWin/code-review-tool.git
cd code-review-tool
cp .env.example .env   # set REVIEW_GH_TOKEN, GITHUB_ORG, ALLOWED_REPOS
npm run setup          # installs both workspaces and builds the sandbox image
npm run dev            # API on 127.0.0.1:5178, web dev server on 127.0.0.1:5179
```

Configuration is described in [docs/configuration.md](docs/configuration.md), the
internals in [docs/design.md](docs/design.md).

## Checks

```bash
npm run build   # type-checks the API and builds the web UI
npm test        # unit tests for src/ and web/src/
```

Both must pass before you open a pull request. CI runs the same commands.

## Commits

One logical change per commit. The subject is a short imperative sentence with
no prefix, for example `Discover every reviewer's models at runtime, with no
model id in the source`. Use the body to explain why when it is not obvious.

## Pull requests

- Say what changed and why, and link the issue if there is one.
- Include tests for new behaviour and for bug fixes.
- Update the matching file under `docs/`, or the README, when behaviour or
  configuration changes.
- Keep the tool read-only: a change must never modify, push to, or comment on
  the reviewed repositories.
- Keep the diff focused; unrelated refactors belong in their own pull request.
