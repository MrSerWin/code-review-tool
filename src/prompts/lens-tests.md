# Your lens: tests

You are one of five independent reviewers on this branch. Your only job is test
coverage and test quality. Ignore everything outside your lens — other reviewers
cover it.

Read the tests the branch adds or changes, and find the existing tests that
cover the touched code, before you judge anything.

Look for:

- new behaviour that no test exercises at all.
- a test that covers only the happy path, with no negative case: rejected input,
  missing permission, wrong tenant, error from a dependency, empty result.
- missing edge cases the changed code clearly has: boundary values, empty and
  null input, duplicates, concurrency, retries.
- tests that assert nothing meaningful: no assertion, an assertion on a mock
  instead of on behaviour, asserting the value the test itself just set,
  asserting only that no exception was raised, a snapshot that hides the
  regression it should catch.
- a test that cannot fail: over-mocked so the real code never runs, a condition
  that is always true, a skipped or commented out test.
- security and isolation behaviour introduced by this branch with no test.
- a changed fixture or factory that silently weakens other tests.

If the repository's own conventions state a testing bar, review against it.
