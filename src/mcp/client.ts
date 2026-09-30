/**
 * A thin HTTP client of the running code-review-tool API, for the MCP server.
 *
 * This module (and everything the MCP server imports) must never import
 * `config.ts`: the MCP process holds no secrets and needs no `.env`. It only
 * knows the API's base URL.
 */

/** Where the API listens unless `CODE_REVIEW_API_URL` says otherwise. */
export const DEFAULT_API_URL = 'http://127.0.0.1:5178';

/** Default per-request timeout. Resolving a ticket can take longer; see `SLOW_REQUEST_MS`. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Starting a review resolves the input first (tracker lookup, branch listing). */
export const SLOW_REQUEST_MS = 90_000;

/** The API base URL from the environment, without a trailing slash. */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.CODE_REVIEW_API_URL ?? '').trim() || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

export function unreachableMessage(baseUrl: string): string {
  return `code-review-tool API is not reachable at ${baseUrl}. Is the server running? ` +
    '(launchctl kickstart -k gui/$UID/com.code-review-tool.server)';
}

/** The API could not be reached at all: connection refused, DNS failure, timeout. */
export class ApiUnreachableError extends Error {
  constructor(baseUrl: string, detail?: string) {
    super(detail ? `${unreachableMessage(baseUrl)} [${detail}]` : unreachableMessage(baseUrl));
    this.name = 'ApiUnreachableError';
  }
}

/** The API answered with a non-2xx status; `message` is its `error` field when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Error codes that mean "nothing is listening there", not "the request was bad". */
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

function networkCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  const code = (cause?.code ?? (err as { code?: unknown })?.code) as unknown;
  return typeof code === 'string' ? code : null;
}

/** Whether a thrown fetch error means the server could not be reached. */
export function isUnreachable(err: unknown): boolean {
  const code = networkCode(err);
  if (code && NETWORK_CODES.has(code)) return true;
  // undici reports every connection-level failure as `TypeError: fetch failed`.
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string = apiBaseUrl(), fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  /** A human link to one review in the web UI. */
  reviewUrl(id: number): string {
    return `${this.baseUrl}/review/${id}`;
  }

  /** Raw request: returns the response body as text, or throws ApiError / ApiUnreachableError. */
  async requestText(path: string, opts: RequestOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const init: RequestInit = { method: opts.method ?? 'GET', signal };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers = { 'Content-Type': 'application/json' };
    }

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw new Error('Request cancelled');
      if (timeout.aborted) {
        throw new ApiUnreachableError(this.baseUrl, `no answer within ${Math.round(timeoutMs / 1000)}s`);
      }
      if (isUnreachable(err)) throw new ApiUnreachableError(this.baseUrl, networkCode(err) ?? undefined);
      throw err;
    }

    if (!res.ok) {
      let message = text.trim() || res.statusText || `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
      } catch {
        /* not JSON: keep the raw text */
      }
      throw new ApiError(res.status, message);
    }
    return text;
  }

  async requestJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.requestText(path, opts);
    return (text ? JSON.parse(text) : {}) as T;
  }

  reviewers<T>(): Promise<T> {
    return this.requestJson<T>('/api/reviewers');
  }

  localRepos<T>(): Promise<T> {
    return this.requestJson<T>('/api/local-repos');
  }

  parent<T>(repo: string, branch: string): Promise<T> {
    return this.requestJson<T>(
      `/api/local-repos/${encodeURIComponent(repo)}/parent?branch=${encodeURIComponent(branch)}`,
    );
  }

  ticket<T>(key: string): Promise<T> {
    return this.requestJson<T>(`/api/tickets/${encodeURIComponent(key)}`, { timeoutMs: SLOW_REQUEST_MS });
  }

  createReviews<T>(body: unknown): Promise<T> {
    return this.requestJson<T>('/api/reviews', { method: 'POST', body, timeoutMs: SLOW_REQUEST_MS });
  }

  review<T>(id: number, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(`/api/reviews/${id}`, { signal });
  }

  report(id: number): Promise<string> {
    return this.requestText(`/api/reviews/${id}/report`);
  }

  listReviews<T>(params: Record<string, string | number | undefined>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    const query = qs.toString();
    return this.requestJson<T>(`/api/reviews${query ? `?${query}` : ''}`);
  }

  cancel<T>(id: number): Promise<T> {
    return this.requestJson<T>(`/api/reviews/${id}/cancel`, { method: 'POST' });
  }

  rerun<T>(id: number, body: { reviewer?: string; model?: string }): Promise<T> {
    return this.requestJson<T>(`/api/reviews/${id}/rerun`, { method: 'POST', body });
  }
}
