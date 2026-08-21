import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

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

const schema = z.object({
  LINEAR_API_KEY: z.string({ error: 'LINEAR_API_KEY is required' }).min(1, 'LINEAR_API_KEY is required'),
  REVIEW_GH_TOKEN: z.string({ error: 'REVIEW_GH_TOKEN is required' }).min(1, 'REVIEW_GH_TOKEN is required'),
  GITHUB_ORG: z
    .string({ error: 'GITHUB_ORG is required: the GitHub organization or user that owns the repositories' })
    .min(1, 'GITHUB_ORG is required: the GitHub organization or user that owns the repositories'),
  ALLOWED_REPOS: repoList,
  PORT: z.coerce.number().int().positive().default(5178),
  DATA_DIR: z.string().min(1).default(path.join(projectRoot, 'data')),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  REVIEW_MODEL: z.string().min(1).default('opus'),
  REVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  // How many reviews (branches) run at once. The lens fan-out inside one
  // review is always 4 wide, so the process ceiling is this value * 4.
  REVIEW_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DOCKER_BIN: z.string().min(1).default('docker'),
  GIT_IMAGE: z.string().min(1).default('code-review-tool-git:latest'),
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
  linearApiKey: parsed.data.LINEAR_API_KEY,
  reviewGhToken: parsed.data.REVIEW_GH_TOKEN,
  githubOrg: parsed.data.GITHUB_ORG,
  port: parsed.data.PORT,
  dataDir,
  claudeBin: parsed.data.CLAUDE_BIN,
  reviewModel: parsed.data.REVIEW_MODEL,
  reviewTimeoutMs: parsed.data.REVIEW_TIMEOUT_MS,
  reviewConcurrency: parsed.data.REVIEW_CONCURRENCY,
  dockerBin: parsed.data.DOCKER_BIN,
  gitImage: parsed.data.GIT_IMAGE,
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
