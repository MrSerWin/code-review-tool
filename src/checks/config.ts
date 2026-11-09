import { z } from 'zod';

/** Django-style numbered migrations. */
export const DEFAULT_MIGRATION_GLOBS = ['apps/*/migrations/[0-9][0-9][0-9][0-9]_*.py'];
/** Test files the em-dash check skips unless the config sets `excludeGlobs`. */
export const DEFAULT_TEST_EXCLUDES = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**', '**/test_*.py'];
export const DEFAULT_BLOCKER_PATTERNS = ['.venv/', 'venv/', '.env'];
export const DEFAULT_FORBIDDEN_PATTERNS = ['node_modules/', '__pycache__/', '*.pyc', '.DS_Store'];
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 40;

const globs = z.array(z.string().min(1));

/** `true` or `{}` turns a check on with its defaults; `false` or absence leaves it off. */
function toggle<T extends z.ZodRawShape>(shape: T) {
  return z
    .preprocess((v) => (v === true ? {} : v === false || v === null ? undefined : v), z.object(shape).strict().optional())
    .transform((v) => v ?? null);
}

export const checksConfigSchema = z.object({
  checks: z.object({
    'migration-collision': toggle({
      globs: globs.default(DEFAULT_MIGRATION_GLOBS),
    }),
    'data-migration-idempotence': toggle({
      globs: globs.default(DEFAULT_MIGRATION_GLOBS),
    }),
    'em-dash': toggle({
      globs: globs.min(1),
      // Explicit `excludeGlobs` replace the defaults; `[]` checks test files too.
      excludeGlobs: globs.default(DEFAULT_TEST_EXCLUDES),
    }),
    'forbidden-paths': toggle({
      blockerPatterns: globs.default(DEFAULT_BLOCKER_PATTERNS),
      patterns: globs.default(DEFAULT_FORBIDDEN_PATTERNS),
      maxFileBytes: z.number().int().positive().default(DEFAULT_MAX_FILE_BYTES),
    }),
    'commit-identity': toggle({
      allowedEmails: z.array(z.string().min(3)).default([]),
      allowedDomains: z.array(z.string().min(1)).default([]),
    }).refine((v) => v === null || v.allowedEmails.length + v.allowedDomains.length > 0, {
      message: 'needs allowedEmails or allowedDomains',
    }),
    'doc-update-heuristic': toggle({
      behaviourGlobs: globs.min(1),
      docGlobs: globs.min(1),
    }),
    'diff-size': toggle({
      maxFiles: z.number().int().positive().default(DEFAULT_MAX_FILES),
    }),
  }).strict(),
}).strict();

export type ChecksConfig = z.infer<typeof checksConfigSchema>;
export type CheckId = keyof ChecksConfig['checks'];

/** Parses `<repo>.json`; the error names every bad key. */
export function parseChecksConfig(raw: unknown): ChecksConfig {
  const parsed = checksConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
