import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
// Names only, from a module that imports nothing of ours: the reviewer
// registry imports this file, so it must never be imported back from here.
import { REVIEWER_NAMES } from './reviewers/types.js';

// src/config.ts -> <root>/src, dist/config.js -> <root>/dist; the project root is one level up in both.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

/** Comma-separated repository names, trimmed, with empty entries dropped. */
const repoList = z
  .string({ error: 'ALLOWED_REPOS is required: a comma-separated list of repository names, e.g. "my-service,my-frontend"' })
  .transform((raw) => raw.split(',').map((name) => name.trim()).filter(Boolean))
  .refine((names) => names.length > 0, {
    message: 'ALLOWED_REPOS is required: a comma-separated list of repository names, e.g. "my-service,my-frontend"',
  });

/** `1/true/yes/on` (any case) is true; anything else, including absent, is false. */
const envFlag = z
  .string()
  .optional()
  .transform((raw) => /^(1|true|yes|on)$/i.test((raw ?? '').trim()));

/** `<from>-<to>`, inclusive, ascending, inside the unprivileged range. */
const portRange = z
  .string()
  .default('21000-21999')
  .transform((raw, ctx) => {
    const match = /^\s*(\d{2,5})\s*-\s*(\d{2,5})\s*$/.exec(raw);
    if (!match) {
      ctx.addIssue({ code: 'custom', message: 'PREVIEW_PORT_RANGE must look like "21000-21999"' });
      return z.NEVER;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from < 1024 || to > 65535 || from >= to) {
      ctx.addIssue({ code: 'custom', message: 'PREVIEW_PORT_RANGE must be an ascending range within 1024-65535' });
      return z.NEVER;
    }
    return { from, to };
  });

/** An optional credential: absent and empty are both "not configured". */
const optionalSecret = z
  .string()
  .transform((raw) => raw.trim())
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  // --- ticket trackers: all optional, all validated only when actually used ---
  LINEAR_API_KEY: optionalSecret,
  JIRA_BASE_URL: optionalSecret,
  JIRA_EMAIL: optionalSecret,
  JIRA_API_TOKEN: optionalSecret,
  AZURE_ORG_URL: optionalSecret,
  AZURE_PROJECT: optionalSecret,
  AZURE_PAT: optionalSecret,
  YOUTRACK_BASE_URL: optionalSecret,
  YOUTRACK_TOKEN: optionalSecret,
  // Which tracker wins when a bare key like ABC-123 matches several of them.
  DEFAULT_TRACKER: optionalSecret,
  REVIEW_GH_TOKEN: z.string({ error: 'REVIEW_GH_TOKEN is required' }).min(1, 'REVIEW_GH_TOKEN is required'),
  GITHUB_ORG: z
    .string({ error: 'GITHUB_ORG is required: the GitHub organization or user that owns the repositories' })
    .min(1, 'GITHUB_ORG is required: the GitHub organization or user that owns the repositories'),
  ALLOWED_REPOS: repoList,
  PORT: z.coerce.number().int().positive().default(5178),
  DATA_DIR: z.string().min(1).default(path.join(projectRoot, 'data')),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  REVIEW_MODEL: z.string().min(1).default('opus'),
  DEFAULT_REVIEWER: z.enum(REVIEWER_NAMES).default('claude'),
  CURSOR_BIN: z.string().min(1).default('cursor-agent'),
  CURSOR_REVIEW_MODEL: z.string().min(1).default('auto'),
  CURSOR_API_KEY: optionalSecret,
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_REVIEW_MODEL: z.string().min(1).default('gpt-5.5'),
  GROK_BIN: z.string().min(1).default('grok'),
  GROK_REVIEW_MODEL: z.string().min(1).default('grok-4.6'),
  REVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  // How many reviews (branches) run at once. The lens fan-out inside one
  // review is five lenses plus synthesis, so the process ceiling is this * 6.
  REVIEW_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DOCKER_BIN: z.string().min(1).default('docker'),
  GIT_IMAGE: z.string().min(1).default('code-review-tool-git:latest'),
  // --- preview environments; off unless PREVIEW_ENABLED is set ---
  PREVIEW_ENABLED: envFlag,
  PREVIEW_RECIPES_DIR: z.string().min(1).default(path.join(projectRoot, 'recipes')),
  PREVIEW_PORT_RANGE: portRange,
  PREVIEW_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  PREVIEW_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}\nCopy .env.example to .env and fill it in.`);
}

const dataDir = path.resolve(parsed.data.DATA_DIR);

// Both spellings are exposed: the UPPER_SNAKE names mirror the .env keys,
// the camelCase aliases are what the rest of the code reads.
export const config = Object.freeze({
  ...parsed.data,
  DATA_DIR: dataDir,
  projectRoot,
  dockerfile: path.join(projectRoot, 'docker', 'Dockerfile.git'),
  reviewGhToken: parsed.data.REVIEW_GH_TOKEN,
  githubOrg: parsed.data.GITHUB_ORG,
  port: parsed.data.PORT,
  dataDir,
  claudeBin: parsed.data.CLAUDE_BIN,
  reviewModel: parsed.data.REVIEW_MODEL,
  defaultReviewer: parsed.data.DEFAULT_REVIEWER,
  cursorBin: parsed.data.CURSOR_BIN,
  cursorReviewModel: parsed.data.CURSOR_REVIEW_MODEL,
  cursorApiKey: parsed.data.CURSOR_API_KEY,
  codexBin: parsed.data.CODEX_BIN,
  codexReviewModel: parsed.data.CODEX_REVIEW_MODEL,
  grokBin: parsed.data.GROK_BIN,
  grokReviewModel: parsed.data.GROK_REVIEW_MODEL,
  reviewTimeoutMs: parsed.data.REVIEW_TIMEOUT_MS,
  reviewConcurrency: parsed.data.REVIEW_CONCURRENCY,
  dockerBin: parsed.data.DOCKER_BIN,
  gitImage: parsed.data.GIT_IMAGE,
  PREVIEW_RECIPES_DIR: path.resolve(parsed.data.PREVIEW_RECIPES_DIR),
  previewEnabled: parsed.data.PREVIEW_ENABLED,
  previewRecipesDir: path.resolve(parsed.data.PREVIEW_RECIPES_DIR),
  previewPortRange: parsed.data.PREVIEW_PORT_RANGE,
  previewTtlMinutes: parsed.data.PREVIEW_TTL_MINUTES,
  previewMaxConcurrent: parsed.data.PREVIEW_MAX_CONCURRENT,
});

export type Config = typeof config;

/** The security boundary: nothing outside this list may ever be fetched. */
export const ALLOWED_REPOS: readonly string[] = Object.freeze([...parsed.data.ALLOWED_REPOS]);

export function assertAllowedRepo(name: string): void {
  if (!ALLOWED_REPOS.includes(name)) {
    throw new Error(`Repository not allowed: ${JSON.stringify(name)}. Allowed: ${ALLOWED_REPOS.join(', ')}`);
  }
}

export function assertAllowedRemote(url: string): void {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  if (!match) throw new Error(`Remote not allowed: ${JSON.stringify(url)}`);
  const [, org, repo] = match;
  if (org !== config.GITHUB_ORG) throw new Error(`Remote organization not allowed: ${JSON.stringify(org)}`);
  assertAllowedRepo(repo as string);
}

export function repoUrl(repo: string): string {
  assertAllowedRepo(repo);
  const url = `https://github.com/${config.GITHUB_ORG}/${repo}.git`;
  assertAllowedRemote(url);
  return url;
}
