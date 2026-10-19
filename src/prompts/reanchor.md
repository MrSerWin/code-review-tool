You are fixing the locations of findings from a finished code review of one
branch. The findings themselves are settled. Your only job is where each one
points.

- Repository: `{{REPO}}`
- Branch: `{{BRANCH}}`
- Base commit: `{{BASE_SHA}}`
- Working directory: the checked out branch at HEAD. You are already inside it.

Changed files (the changed set; renames are listed under their new path):

{{CHANGED_FILES}}

# Hard rules

- You MUST NOT modify, create, or delete any file, and run no `git` command
  that writes. You only read.
- Read line numbers from a numbered listing at HEAD: the Read tool, `cat -n`,
  `grep -n`, or `nl -ba`. Never count lines from `sed -n` output or diff text.
- `file` is a repository-relative path at HEAD. No `a/` or `b/` prefix, no
  absolute path, no `:line` suffix.

# What to do with each finding

The tool checked every anchor and these failed. For each one, find the right
location:

1. If the problem sits in a changed line, point `file` and `line` at that line
   in the changed set and set `kind` to `diff`.
2. If the problem sits in untouched code that the diff broke, keep `file` and
   `line` at that untouched site (fix them if they are wrong), set `kind` to
   `regression`, `stale_doc` (documentation, comments, docstrings), or
   `consumer` (a parser or client of a changed shape), and set `cause_file` and
   `cause_line` to the changed line that causes it. `cause_file` MUST be in the
   changed set above.
3. If you cannot find a correct location, return the finding with its current
   values. Do not guess.

Search with Grep and Glob, use `git diff {{BASE_SHA}}..HEAD -- <file>` for the
hunks, and give the hunk header (`@@ -a,b +c,d @@`) as `hunk` for a `diff`
finding when you have it.

# Findings

{{FINDINGS}}

# Output

End your answer with exactly ONE fenced ```json block and nothing after it:

```json
{
  "anchors": [
    {
      "id": 1,
      "file": "src/file.ts",
      "line": 120,
      "end_line": null,
      "kind": "diff|regression|stale_doc|consumer",
      "cause_file": "a changed file, or null for diff",
      "cause_line": 88,
      "hunk": "@@ -110,8 +110,12 @@ or null",
      "note": "one short sentence: what you checked"
    }
  ]
}
```

One entry per finding above, with its `id`. Output valid JSON. No comments, no
trailing commas, no text after the block.
