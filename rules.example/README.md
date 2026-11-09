# Example repository rules

Repository rules tell every review what the repository itself requires, and
switch on deterministic tool checks for it. The setup and the check table are
in [README › Repository rules and tool checks](../README.md#repository-rules-and-tool-checks).

## Using it

```bash
mkdir -p rules
cp rules.example/example-service.md rules/my-service.md
cp rules.example/example-service.json rules/my-service.json
$EDITOR rules/my-service.md rules/my-service.json
```

`rules/` is gitignored, so real rules never land in this repository. Point
`RULES_DIR` somewhere else to keep them outside the checkout. The files are
read on every review, so an edit applies to the next run without a restart.

| File | Effect |
|---|---|
| `<repo>.md` | Added to the lens and synthesis prompts of `<repo>` as "Repository rules (binding)". |
| `_all.md` | Added to the prompts of every repository, before `<repo>.md`. |
| `<repo>.json` | Which tool checks run for `<repo>`, with their parameters. |

`<repo>` is the name in `ALLOWED_REPOS`. A missing file means no section and no
checks; an invalid `<repo>.json` is logged and runs no checks.

## Writing the rules file

- Summarise the repository's own CLAUDE.md / AGENTS.md and the docs they point
  to. The rules file is binding and wins where the two differ.
- One rule per line, grouped by topic, under about 80 lines.
- Name the customer-facing docs and their paths: a stale customer doc is
  `major`, a stale internal doc `minor`.

## Writing the checks file

A check runs when its key is present and not `false`; `true` or `{}` uses its
defaults. Unknown keys are rejected, so a typo cannot silently disable a check.
