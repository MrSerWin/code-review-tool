import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_REPOS } from './config.js';
import { previewLinks } from './preview/links.js';
import { parseRecipe, type Recipe } from './preview/recipes.js';

const FILE = '/recipes/demo/recipe.json';

function recipeWith(ports: unknown[]): Record<string, unknown> {
  return {
    name: 'demo',
    repos: { backend: ALLOWED_REPOS[0] },
    ports,
    steps: { up: ['true'], down: ['true'] },
  };
}

function parsedPorts(ports: unknown[]): Pick<Recipe, 'ports'> {
  const { recipe, error } = parseRecipe(recipeWith(ports), FILE);
  assert.ok(recipe, error);
  return recipe;
}

test('a port may carry a label and links', () => {
  const recipe = parsedPorts([
    { id: 'api', internal: 8000, label: 'Backend API', links: [{ label: 'Django admin', path: '/admin/' }] },
    { id: 'web', internal: 3000, primary: true },
  ]);
  assert.equal(recipe.ports[0]?.label, 'Backend API');
  assert.deepEqual(recipe.ports[0]?.links, [{ label: 'Django admin', path: '/admin/' }]);
  assert.equal(recipe.ports[1]?.links, undefined);
});

test('link paths must start with a slash and stay on the port', () => {
  for (const [path, expected] of [
    ['admin/', 'must start with "/"'],
    ['/a b', 'must start with "/"'],
    ['//evil.example/', 'not a "//host" URL'],
  ] as const) {
    const { error } = parseRecipe(recipeWith([{ id: 'api', internal: 8000, links: [{ label: 'x', path }] }]), FILE);
    assert.ok(error?.includes(`${FILE}: ports.0.links.0.path:`), error);
    assert.ok(error?.includes(expected), error);
  }
});

test('labels must not be empty, and links, when present, not an empty list', () => {
  const blankLabel = parseRecipe(recipeWith([{ id: 'api', internal: 8000, label: '  ' }]), FILE);
  assert.match(blankLabel.error ?? '', /ports\.0\.label: must not be empty/);

  const blankLink = parseRecipe(recipeWith([{ id: 'api', internal: 8000, links: [{ label: '', path: '/' }] }]), FILE);
  assert.match(blankLink.error ?? '', /ports\.0\.links\.0\.label: must not be empty/);

  const noLinks = parseRecipe(recipeWith([{ id: 'api', internal: 8000, links: [] }]), FILE);
  assert.match(noLinks.error ?? '', /ports\.0\.links: needs at least one link/);

  const noPath = parseRecipe(recipeWith([{ id: 'api', internal: 8000, links: [{ label: 'x' }] }]), FILE);
  assert.match(noPath.error ?? '', /ports\.0\.links\.0\.path:/);
});

test('a port may not list the same path twice', () => {
  const { error } = parseRecipe(
    recipeWith([{ id: 'api', internal: 8000, links: [{ label: 'a', path: '/x/' }, { label: 'b', path: '/x/' }] }]),
    FILE,
  );
  assert.equal(error, `${FILE}: ports.api.links: duplicate path(s): /x/`);
});

test('links: primary port first, labels default to the port id, links replace the root link', () => {
  const recipe = parsedPorts([
    { id: 'db', internal: 5432, label: 'Postgres' },
    {
      id: 'api',
      internal: 8000,
      label: 'Backend API',
      links: [{ label: 'Backend API', path: '/api/' }, { label: 'Django admin', path: '/admin/' }],
    },
    { id: 'web', internal: 2000, primary: true },
  ]);
  const links = previewLinks({ db: 41000, api: 41001, web: 41002 }, recipe, 'http://127.0.0.1:41002');
  assert.deepEqual(links, [
    { label: 'web', url: 'http://127.0.0.1:41002', port_id: 'web', primary: true },
    { label: 'Postgres', url: 'http://127.0.0.1:41000', port_id: 'db', primary: false },
    { label: 'Backend API', url: 'http://127.0.0.1:41001/api/', port_id: 'api', primary: false },
    { label: 'Django admin', url: 'http://127.0.0.1:41001/admin/', port_id: 'api', primary: false },
  ]);
});

test('without a primary mark the first port leads; unallocated ports are skipped', () => {
  const recipe = parsedPorts([
    { id: 'api', internal: 8000, links: [{ label: 'Docs', path: '/docs' }, { label: 'Health', path: '/healthz' }] },
    { id: 'web', internal: 3000 },
  ]);
  assert.deepEqual(previewLinks({ api: 42000 }, recipe), [
    { label: 'Docs', url: 'http://127.0.0.1:42000/docs', port_id: 'api', primary: true },
    { label: 'Health', url: 'http://127.0.0.1:42000/healthz', port_id: 'api', primary: false },
  ]);
  assert.deepEqual(previewLinks({}, recipe), []);
});

test('without a usable recipe each allocated port gets a root link, the one behind url first', () => {
  const links = previewLinks({ db: 43000, api: 43001, web: 43002 }, null, 'http://127.0.0.1:43002');
  assert.deepEqual(links, [
    { label: 'web', url: 'http://127.0.0.1:43002', port_id: 'web', primary: true },
    { label: 'db', url: 'http://127.0.0.1:43000', port_id: 'db', primary: false },
    { label: 'api', url: 'http://127.0.0.1:43001', port_id: 'api', primary: false },
  ]);
  assert.ok(previewLinks({ api: 43001 }, null, null).every((l) => !l.primary));
});
