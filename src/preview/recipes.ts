import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ALLOWED_REPOS, config } from '../config.js';

const ROLE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

const idSchema = z
  .string()
  .min(1)
  .regex(ROLE_ID, 'must start with a letter and contain only letters, digits and underscores');

const portSchema = z.object({
  id: idSchema,
  internal: z.number().int().min(1).max(65535),
  primary: z.boolean().optional(),
});

const pgDumpSchema = z.object({
  url: z.string().min(1, 'is required when pgDump is present'),
  excludeTableData: z.array(z.string().min(1)).optional(),
  /** Hard ceiling for the dump attempt; an unreachable host must not hang a preview. */
  timeoutSec: z.number().int().positive().max(3600).optional(),
});

const sourceSchema = z.object({
  mode: z.enum(['auto', 'dump-dir', 'pg_dump', 'none']).default('auto'),
  /** Directory, optionally ending in a glob such as `*.dump`. */
  dumpDir: z.string().min(1).optional(),
  pgDump: pgDumpSchema.optional(),
  onFailure: z.enum(['clean', 'fail']).default('clean'),
});

const databaseSchema = z.object({
  engine: z.string().min(1).default('postgres'),
  version: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? undefined : String(v))),
  name: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  source: sourceSchema.default({ mode: 'auto', onFailure: 'clean' }),
});

const commands = z.array(z.string().min(1));

const stepsSchema = z.object({
  prepare: commands.default([]),
  up: commands.min(1, 'needs at least one command'),
  health: commands.default([]),
  down: commands.min(1, 'needs at least one command'),
});

export const recipeSchema = z.object({
  name: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, digits, dot, dash and underscore'),
  description: z.string().optional(),
  repos: z.record(idSchema, z.string().min(1)),
  ports: z.array(portSchema).min(1, 'needs at least one port'),
  database: databaseSchema.optional(),
  steps: stepsSchema,
  readyTimeoutSec: z.number().int().positive().max(24 * 3600).default(600),
  /** Ceiling for a single command. Defaults to the whole ready budget. */
  stepTimeoutSec: z.number().int().positive().max(24 * 3600).optional(),
  /** Extra variables handed to every step, e.g. a database password. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  credentialsHint: z.string().optional(),
});

export type Recipe = z.infer<typeof recipeSchema> & { dir: string; file: string };

export interface RecipeError {
  name: string;
  file: string;
  error: string;
}

export interface LoadedRecipes {
  recipes: Recipe[];
  errors: RecipeError[];
}

function formatIssues(file: string, error: z.ZodError): string {
  return error.issues
    .map((issue) => `${file}: ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Checks that zod cannot express: cross-field and allowlist rules. */
function extraChecks(recipe: z.infer<typeof recipeSchema>, file: string): string[] {
  const problems: string[] = [];

  const ids = recipe.ports.map((p) => p.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) problems.push(`${file}: ports: duplicate port id(s): ${[...new Set(duplicates)].join(', ')}`);

  const primaries = recipe.ports.filter((p) => p.primary);
  if (primaries.length > 1) {
    problems.push(`${file}: ports: only one port may be marked "primary" (found ${primaries.length})`);
  }

  const roles = Object.keys(recipe.repos);
  if (roles.length === 0) problems.push(`${file}: repos: at least one role is required`);
  for (const [role, repo] of Object.entries(recipe.repos)) {
    if (!ALLOWED_REPOS.includes(repo)) {
      problems.push(
        `${file}: repos.${role}: repository ${JSON.stringify(repo)} is not in ALLOWED_REPOS (${ALLOWED_REPOS.join(', ')})`,
      );
    }
  }

  const source = recipe.database?.source;
  if (source) {
    if (source.mode === 'dump-dir' && !source.dumpDir) {
      problems.push(`${file}: database.source.dumpDir: is required when mode is "dump-dir"`);
    }
    if (source.mode === 'pg_dump' && !source.pgDump) {
      problems.push(`${file}: database.source.pgDump: is required when mode is "pg_dump"`);
    }
    if (source.dumpDir && !path.isAbsolute(stripGlob(source.dumpDir))) {
      problems.push(`${file}: database.source.dumpDir: must be an absolute path`);
    }
  }

  return problems;
}

/** Splits `/data/dumps/*.dump` into its directory part. */
export function stripGlob(pattern: string): string {
  const base = path.basename(pattern);
  return base.includes('*') || base.includes('?') ? path.dirname(pattern) : pattern;
}

/** The port whose URL is shown to the user: the one marked primary, else the first. */
export function primaryPort(recipe: Recipe): { id: string; internal: number } {
  const marked = recipe.ports.find((p) => p.primary);
  return marked ?? (recipe.ports[0] as { id: string; internal: number });
}

export function parseRecipe(raw: unknown, file: string): { recipe?: z.infer<typeof recipeSchema>; error?: string } {
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) return { error: formatIssues(file, parsed.error) };
  const problems = extraChecks(parsed.data, file);
  if (problems.length) return { error: problems.join('; ') };
  return { recipe: parsed.data };
}

/**
 * Reads every `<recipesDir>/<name>/recipe.json`. A broken recipe is reported,
 * never thrown: one bad file must not keep the server from starting.
 */
export function loadRecipes(recipesDir = config.previewRecipesDir): LoadedRecipes {
  const recipes: Recipe[] = [];
  const errors: RecipeError[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(recipesDir, { withFileTypes: true });
  } catch {
    // No recipes directory is a valid state: the feature is simply unconfigured.
    return { recipes, errors };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(recipesDir, entry.name);
    const file = path.join(dir, 'recipe.json');
    if (!fs.existsSync(file)) {
      errors.push({ name: entry.name, file, error: `${file}: missing recipe.json` });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      errors.push({ name: entry.name, file, error: `${file}: invalid JSON: ${(err as Error).message}` });
      continue;
    }
    const { recipe, error } = parseRecipe(raw, file);
    if (!recipe) {
      errors.push({ name: entry.name, file, error: error ?? `${file}: invalid recipe` });
      continue;
    }
    if (recipe.name !== entry.name) {
      errors.push({
        name: entry.name,
        file,
        error: `${file}: name: ${JSON.stringify(recipe.name)} must match the directory name ${JSON.stringify(entry.name)}`,
      });
      continue;
    }
    recipes.push({ ...recipe, dir, file });
  }

  return { recipes, errors };
}

export function findRecipe(name: string, recipesDir?: string): Recipe {
  const { recipes, errors } = loadRecipes(recipesDir);
  const found = recipes.find((r) => r.name === name);
  if (found) return found;
  const broken = errors.find((e) => e.name === name);
  if (broken) throw new Error(`Recipe ${JSON.stringify(name)} is invalid: ${broken.error}`);
  const known = recipes.map((r) => r.name);
  throw new Error(
    `Unknown recipe ${JSON.stringify(name)}.${known.length ? ` Configured: ${known.join(', ')}.` : ' No recipes are configured.'}`,
  );
}

/**
 * Recipes are documentation as much as configuration, so `//` and block
 * comments are tolerated in them. Strings are respected while stripping.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out;
}
