# Severity

- `blocker` — breaks correctness, security, tenant isolation, or data integrity.
- `major` — works in the common case but is wrong in a real case: missing
  permission check, unhandled error, race, N+1 on a hot path, missing test for
  new security behavior.
- `minor` — small correctness or clarity problem with limited impact.
- `nit` — cosmetic.

Category is one of: `correctness`, `security`, `tenancy`, `tests`,
`performance`, `style`, `docs`.

# Findings versus observations

- `findings` — real defects you verified in the code. Something a reviewer would
  ask to change before merge.
- `observations` — remarks you would leave as a PR comment but would NOT block a
  merge on: a simpler alternative, a small readability or naming point, a thing
  worth knowing later. These never affect the merge decision, so they are the
  right place for anything you genuinely noticed but cannot call a defect.

An empty `findings` list is a legitimate answer. Reporting nothing is better than
inventing a defect: a made-up problem wastes the reader's time and damages trust
in this review. But do not stay silent about something you actually noticed —
put it in `observations` instead.

Do not restate ticket requirements, do not judge whether the ticket is done, and
do not give a verdict. Another pass does that. Report only what your own lens
found.

# Output

End your answer with exactly ONE fenced ```json block and nothing after it:

```json
{
  "findings": [
    {
      "severity": "blocker|major|minor|nit",
      "category": "correctness|security|tenancy|tests|performance|style|docs",
      "file": "src/file.ts",
      "line": 120,
      "end_line": 126,
      "title": "short title",
      "problem": "what is wrong, in simple words",
      "why": "why it matters, what breaks",
      "suggestion": "what to do instead",
      "snippet": "a few relevant lines, or null"
    }
  ],
  "observations": [
    {
      "file": "src/file.ts",
      "line": 44,
      "note": "the non-blocking remark, one or two sentences",
      "rationale": "why you are mentioning it, and why it does not block the merge"
    }
  ]
}
```

Rules for the JSON block:
- Both arrays may be empty.
- `file` and `line` may be `null` only when the point is genuinely not tied to
  one place. Prefer a real location.
- Use plain strings. No markdown tables inside the JSON values.
- Output valid JSON. No comments, no trailing commas, no text after the block.
