/**
 * Test-only: the three required variables, filled in only when they are absent,
 * so importing `config.ts` in a unit test never depends on a real `.env`.
 * Import this before anything that reaches `config.ts`.
 */
const DEFAULTS: Record<string, string> = {
  REVIEW_GH_TOKEN: 'test-token',
  GITHUB_ORG: 'test-org',
  ALLOWED_REPOS: 'test-repo',
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}
