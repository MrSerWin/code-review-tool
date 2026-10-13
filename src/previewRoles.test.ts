import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coversAllRoles, followUpTicketKey, mergeTargets, missingBranchMessage, missingOverrideBranches, normalizeOverrides,
  planRoles, previewLookupKey, ticketKeyFromBranches, trackerKeyOf, type RoleTarget,
} from './preview/roles.js';

const ORG = 'my-org';
const recipeRepos = { backend: 'my-service', frontend: 'my-web' };
const defaultBranches = { 'my-service': 'main', 'my-web': 'main' };

const t = (repo: string, branch: string, baseBranch = 'main'): RoleTarget => ({ repo, branch, baseBranch });

test('a PR input gets the rest of its ticket: the other repo runs the ticket branch, not its base', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches,
    explicitTargets: [t('my-service', 'feat/abc-12-export')],
    ticketTargets: [t('my-service', 'feat/abc-12-export'), t('my-web', 'feat/abc-12-export')],
  });
  assert.deepEqual(roles, [
    { role: 'backend', repo: 'my-service', branch: 'feat/abc-12-export', base: 'main', usedBase: false },
    { role: 'frontend', repo: 'my-web', branch: 'feat/abc-12-export', base: 'main', usedBase: false },
  ]);
});

test('the branch the input named wins for its repo over other ticket branches', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches,
    explicitTargets: [t('my-web', 'feat/abc-12-part-2', 'feat/abc-12-part-1')],
    ticketTargets: [t('my-web', 'feat/abc-12-part-1'), t('my-service', 'feat/abc-12-api')],
  });
  assert.equal(roles[0]?.branch, 'feat/abc-12-api');
  assert.deepEqual(roles[1], {
    role: 'frontend', repo: 'my-web', branch: 'feat/abc-12-part-2', base: 'feat/abc-12-part-1', usedBase: false,
  });
});

test('a repo runs its base branch only when the whole ticket has no branch there', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches: { 'my-service': 'main', 'my-web': 'develop' },
    explicitTargets: [t('my-service', 'feat/abc-12-export')],
    ticketTargets: [t('my-service', 'feat/abc-12-other')],
  });
  assert.equal(roles[0]?.branch, 'feat/abc-12-export');
  assert.deepEqual(roles[1], { role: 'frontend', repo: 'my-web', branch: 'develop', base: 'develop', usedBase: true });
});

test('overrides beat the review, and the review beats the ticket', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches,
    overrides: [{ role: 'frontend', branch: 'hand-picked' }],
    review: { repo: 'my-service', branch: 'feat/abc-12-reviewed', base_branch: 'release' },
    explicitTargets: [t('my-service', 'feat/abc-12-export'), t('my-web', 'feat/abc-12-web')],
    ticketTargets: [],
  });
  assert.deepEqual(roles, [
    { role: 'backend', repo: 'my-service', branch: 'feat/abc-12-reviewed', base: 'release', usedBase: false },
    { role: 'frontend', repo: 'my-web', branch: 'hand-picked', base: 'main', usedBase: false },
  ]);
});

test('an unknown default branch is an error, not a silent guess', () => {
  assert.throws(
    () => planRoles({ recipeRepos, defaultBranches: { 'my-service': 'main' }, explicitTargets: [], ticketTargets: [] }),
    /my-web/,
  );
});

test('merging keeps explicit targets first and drops ticket targets of repos they cover', () => {
  assert.deepEqual(
    mergeTargets([t('a', 'x')], [t('a', 'y'), t('b', 'z'), t('b', 'w')]),
    [t('a', 'x'), t('b', 'z'), t('b', 'w')],
  );
  assert.deepEqual(mergeTargets([], [t('b', 'z')]), [t('b', 'z')]);
});

test('the lookup key: typed input, else the review ticket, else the key in a PR review branch', () => {
  assert.equal(previewLookupKey({ ticket: '  ABC-1 ', review: undefined }, ORG), 'ABC-1');
  const review = { ticket_key: 'ABC-2', branch: 'feat/abc-3-x' };
  assert.equal(previewLookupKey({ ticket: 'ABC-1', review }, ORG), 'ABC-1');
  assert.equal(previewLookupKey({ review }, ORG), 'ABC-2');
  // A PR standing in for the ticket: the branch name says which ticket it belongs to.
  assert.equal(previewLookupKey({ review: { ticket_key: 'my-org/my-web#406', branch: 'feat/abc-3-x' } }, ORG), 'ABC-3');
  assert.equal(previewLookupKey({ review: { ticket_key: null, branch: 'feat/abc-3-x' } }, ORG), 'ABC-3');
  // No key in the branch either: the PR is all there is.
  assert.equal(
    previewLookupKey({ review: { ticket_key: 'my-org/my-web#406', branch: 'fix/no-accent' } }, ORG),
    'my-org/my-web#406',
  );
  assert.equal(previewLookupKey({ review: { ticket_key: null, branch: 'cleanup' } }, ORG), null);
  assert.equal(previewLookupKey({}, ORG), null);
});

test('only a real tracker ticket counts as a tracker key', () => {
  assert.equal(trackerKeyOf({ key: 'ABC-12', provider: 'linear' }, ORG), 'ABC-12');
  assert.equal(trackerKeyOf({ key: 'my-org/my-service#689', provider: 'github' }, ORG), null);
  assert.equal(trackerKeyOf({ key: '', provider: 'manual' }, ORG), null);
  assert.equal(trackerKeyOf({ key: 'ABC-12', provider: 'manual' }, ORG), null);
  assert.equal(trackerKeyOf(null, ORG), null);
});

test('a second lookup only when the tracker key differs from the input', () => {
  assert.equal(followUpTicketKey('https://github.com/my-org/my-service/pull/689', 'ABC-12'), 'ABC-12');
  assert.equal(followUpTicketKey('abc-12', 'ABC-12'), null);
  assert.equal(followUpTicketKey('ABC-12', null), null);
});

test('hand-picked roles must be recipe roles, each given once', () => {
  assert.throws(
    () => normalizeOverrides([{ role: 'api', branch: 'feat/x' }], recipeRepos, 'my-app'),
    /Unknown role "api" in recipe "my-app"\. Valid roles: backend, frontend/,
  );
  assert.throws(
    () => normalizeOverrides([{ role: 'backend', branch: 'a' }, { role: 'backend', branch: 'b' }], recipeRepos),
    /Role "backend" is given more than once/,
  );
  // Prototype keys are not roles.
  assert.throws(() => normalizeOverrides([{ role: 'constructor', branch: 'x' }], recipeRepos), /Unknown role/);
});

test('overrides are trimmed and an empty branch means the base branch', () => {
  assert.deepEqual(
    normalizeOverrides(
      [
        { role: ' backend ', branch: ' feat/abc-1-api ' },
        { role: 'frontend', branch: '   ', base: ' ' },
      ],
      recipeRepos,
    ),
    [
      { role: 'backend', repo: 'my-service', branch: 'feat/abc-1-api' },
      { role: 'frontend', repo: 'my-web', branch: null },
    ],
  );
  assert.deepEqual(normalizeOverrides(undefined, recipeRepos), []);
  assert.deepEqual(normalizeOverrides([{ role: 'frontend', base: 'develop' }], recipeRepos), [
    { role: 'frontend', repo: 'my-web', branch: null, base: 'develop' },
  ]);
});

test('a hand-picked branch must exist on its repository', () => {
  const overrides = normalizeOverrides(
    [
      { role: 'backend', branch: 'feat/abc-1-api' },
      { role: 'frontend', branch: 'feat/abc-2-typo', base: 'gone' },
    ],
    recipeRepos,
  );
  const remote = { 'my-service': ['main', 'feat/abc-1-api'], 'my-web': ['main', 'feat/abc-2-ui'] };
  const missing = missingOverrideBranches(overrides, remote);
  assert.deepEqual(missing, [
    { role: 'frontend', repo: 'my-web', branch: 'feat/abc-2-typo', kind: 'branch' },
    { role: 'frontend', repo: 'my-web', branch: 'gone', kind: 'base' },
  ]);
  assert.equal(
    missingBranchMessage(missing),
    'Branch feat/abc-2-typo not found in repo my-web (role frontend); '
      + 'Base branch gone not found in repo my-web (role frontend)',
  );
  // A base-branch role names nothing to check.
  assert.deepEqual(missingOverrideBranches(normalizeOverrides([{ role: 'frontend' }], recipeRepos), remote), []);
});

test('custom branches: listed roles run their branch, the rest and empty ones run the base branch', () => {
  const roles = planRoles({
    recipeRepos: { backend: 'my-service', frontend: 'my-web', worker: 'my-worker' },
    defaultBranches: { 'my-service': 'main', 'my-web': 'main', 'my-worker': 'develop' },
    overrides: [
      { role: 'backend', branch: 'feat/abc-1-api' },
      { role: 'frontend', branch: null },
    ],
    explicitTargets: [],
    ticketTargets: [],
  });
  assert.deepEqual(roles, [
    { role: 'backend', repo: 'my-service', branch: 'feat/abc-1-api', base: 'main', usedBase: false },
    { role: 'frontend', repo: 'my-web', branch: 'main', base: 'main', usedBase: true },
    { role: 'worker', repo: 'my-worker', branch: 'develop', base: 'develop', usedBase: true },
  ]);
});

test('an empty hand-picked branch beats the review and the ticket for its role', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches,
    overrides: [{ role: 'backend', branch: null }],
    review: { repo: 'my-service', branch: 'feat/abc-12-reviewed', base_branch: 'main' },
    explicitTargets: [t('my-web', 'feat/abc-12-web')],
    ticketTargets: [],
  });
  assert.deepEqual(roles, [
    { role: 'backend', repo: 'my-service', branch: 'main', base: 'main', usedBase: true },
    { role: 'frontend', repo: 'my-web', branch: 'feat/abc-12-web', base: 'main', usedBase: false },
  ]);
});

test('picking the base branch by name counts as running the base branch', () => {
  const roles = planRoles({
    recipeRepos,
    defaultBranches,
    overrides: [{ role: 'frontend', branch: 'main' }],
    explicitTargets: [],
    ticketTargets: [],
  });
  assert.deepEqual(roles[1], { role: 'frontend', repo: 'my-web', branch: 'main', base: 'main', usedBase: true });
});

test('a display ticket from branch names only when they agree on one key', () => {
  assert.equal(ticketKeyFromBranches(['feat/abc-1-api', 'fix/abc-1-ui']), 'ABC-1');
  assert.equal(ticketKeyFromBranches(['feat/abc-1-api', null]), 'ABC-1');
  assert.equal(ticketKeyFromBranches(['feat/abc-1-api', 'cleanup-imports']), 'ABC-1');
  assert.equal(ticketKeyFromBranches(['feat/abc-1-api', 'feat/abc-2-ui']), null);
  assert.equal(ticketKeyFromBranches(['main', null]), null);
  assert.equal(ticketKeyFromBranches([]), null);
});

test('overrides cover the recipe only when every role is listed', () => {
  const both = normalizeOverrides([{ role: 'backend', branch: 'x' }, { role: 'frontend' }], recipeRepos);
  assert.equal(coversAllRoles(both, recipeRepos), true);
  assert.equal(coversAllRoles(both.slice(0, 1), recipeRepos), false);
  assert.equal(coversAllRoles([], recipeRepos), false);
});

test('a local role: local: true, or a branch written local:<repo>#<branch>', () => {
  assert.deepEqual(
    normalizeOverrides(
      [
        { role: 'backend', branch: ' feat/abc-1-api ', local: true },
        { role: 'frontend', branch: 'local:my-web#feat/abc-1-ui', base: 'develop' },
      ],
      recipeRepos,
    ),
    [
      { role: 'backend', repo: 'my-service', branch: 'feat/abc-1-api', source: 'local' },
      { role: 'frontend', repo: 'my-web', branch: 'feat/abc-1-ui', base: 'develop', source: 'local' },
    ],
  );
  // No branch: the clone's checked-out branch, resolved later by the engine.
  assert.deepEqual(normalizeOverrides([{ role: 'frontend', branch: 'local:my-web' }], recipeRepos), [
    { role: 'frontend', repo: 'my-web', branch: null, source: 'local' },
  ]);
  assert.deepEqual(normalizeOverrides([{ role: 'frontend', local: true }], recipeRepos), [
    { role: 'frontend', repo: 'my-web', branch: null, source: 'local' },
  ]);
  // local: false is a plain GitHub role.
  assert.deepEqual(normalizeOverrides([{ role: 'frontend', branch: 'x', local: false }], recipeRepos), [
    { role: 'frontend', repo: 'my-web', branch: 'x' },
  ]);
});

test('a local role must name its own repo and a safe branch', () => {
  assert.throws(
    () => normalizeOverrides([{ role: 'backend', branch: 'local:my-web#feat/x' }], recipeRepos),
    /Role backend runs repo my-service, but its branch names local:my-web; use local:my-service#<branch>/,
  );
  assert.throws(() => normalizeOverrides([{ role: 'backend', branch: 'local:my-service#' }], recipeRepos), /Missing branch/);
  assert.throws(
    () => normalizeOverrides([{ role: 'backend', branch: '--upload-pack=x', local: true }], recipeRepos),
    /Unsafe branch/,
  );
  assert.throws(
    () => normalizeOverrides([{ role: 'backend', branch: 'feat/x', base: '../x', local: true }], recipeRepos),
    /Unsafe base branch/,
  );
});

test('local roles are not checked against the remote, and say "local clone" when missing', () => {
  const overrides = normalizeOverrides([{ role: 'backend', branch: 'feat/unpushed', local: true }], recipeRepos);
  assert.deepEqual(missingOverrideBranches(overrides, { 'my-service': ['main'] }), []);
  assert.equal(
    missingBranchMessage([{ role: 'backend', repo: 'my-service', branch: 'feat/x', kind: 'branch', local: true }]),
    'Branch feat/x not found in the local clone of repo my-service (role backend)',
  );
});

test('local overrides, a local review, and a local ticket target mark their roles as local', () => {
  const fromOverride = planRoles({
    recipeRepos,
    defaultBranches,
    overrides: [{ role: 'backend', branch: 'feat/abc-1-api', source: 'local', sha: 'a'.repeat(40) }],
    explicitTargets: [],
    ticketTargets: [t('my-web', 'feat/abc-1-ui')],
  });
  assert.deepEqual(fromOverride, [
    {
      role: 'backend', repo: 'my-service', branch: 'feat/abc-1-api', base: 'main', usedBase: false,
      source: 'local', sha: 'a'.repeat(40),
    },
    { role: 'frontend', repo: 'my-web', branch: 'feat/abc-1-ui', base: 'main', usedBase: false },
  ]);

  const fromReview = planRoles({
    recipeRepos,
    defaultBranches,
    review: { repo: 'my-web', branch: 'feat/abc-1-ui', base_branch: 'feat/abc-1-base', source: 'local' },
    explicitTargets: [],
    ticketTargets: [t('my-service', 'feat/abc-1-api')],
  });
  assert.equal(fromReview[0]?.source, undefined, 'the ticket branch of the other repo comes from GitHub');
  assert.deepEqual(fromReview[1], {
    role: 'frontend', repo: 'my-web', branch: 'feat/abc-1-ui', base: 'feat/abc-1-base', usedBase: false,
    source: 'local',
  });

  const fromTarget = planRoles({
    recipeRepos,
    defaultBranches,
    explicitTargets: [{ ...t('my-service', 'feat/abc-1-api'), source: 'local' }],
    ticketTargets: [],
  });
  assert.equal(fromTarget[0]?.source, 'local');
  assert.equal(fromTarget[1]?.usedBase, true);
});
