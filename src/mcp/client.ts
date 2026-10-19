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

/**
 * Starting a ticket review resolves the ticket, lists every repository's
 * branches and compares the branches with each other, one sandbox run each.
 */
export const TICKET_REVIEW_REQUEST_MS = 300_000;

/** The API base URL from the environment, without a trailing slash. */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.CODE_REVIEW_API_URL ?? '').trim() || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

/** Why restarting is never the answer to a slow server. */
const RESTART_WARNING =
  'Never restart the server while previews or reviews are live: restarting tears down every live preview and ' +
  'fails every running review.';

export function unreachableMessage(baseUrl: string): string {
  return `code-review-tool API is not reachable at ${baseUrl}. Is the server running? ` +
    'If it is not, start it (launchctl kickstart -k gui/$UID/com.code-review-tool.server). ' +
    RESTART_WARNING;
}

/** Nothing answered at the address at all: connection refused, unknown host, no route. */
export class ApiUnreachableError extends Error {
  constructor(baseUrl: string, detail?: string) {
    super(detail ? `${unreachableMessage(baseUrl)} [${detail}]` : unreachableMessage(baseUrl));
    this.name = 'ApiUnreachableError';
  }
}

/** Where to look for the outcome of a request that got no answer. */
function outcomeHint(path: string): string {
  const bare = path.split('?')[0] ?? path;
  if (bare === '/api/previews') return 'list_previews (a new preview shows there once its branches are resolved)';
  if (bare.startsWith('/api/previews/')) return 'get_preview or list_previews';
  if (bare === '/api/reviews') return 'list_reviews (new reviews show there once the input is resolved)';
  if (bare.startsWith('/api/reviews/')) return 'get_review or list_reviews';
  if (bare.startsWith('/api/tickets/')) return 'get_ticket (a started ticket review shows there as "run")';
  return 'the matching get_ or list_ tool';
}

/**
 * A request reached the server but no answer came back: it timed out, or the
 * connection dropped halfway. The server is not down (it accepted the
 * request), and a mutating request may well have taken effect, so this is
 * never reported with the restart hint: a restart would tear down the very
 * previews and reviews the request was about, and a retry could start a
 * second one.
 */
export class ApiNoAnswerError extends Error {
  readonly method: string;
  readonly path: string;
  constructor(baseUrl: string, method: string, path: string, why: string) {
    const what = `${method} ${path}`;
    super(
      method === 'GET'
        ? `code-review-tool API at ${baseUrl} accepted ${what} but ${why}; it is busy, not down. ` +
            `Try again in a moment. ${RESTART_WARNING}`
        : `code-review-tool API at ${baseUrl} accepted ${what} but ${why}. The server is most likely still ` +
            `working on it. Do not retry and do not restart the server: check the outcome with ${outcomeHint(path)}. ` +
            RESTART_WARNING,
    );
    this.name = 'ApiNoAnswerError';
    this.method = method;
    this.path = path;
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
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Error codes that mean "nothing is listening there": the request never reached a server. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** Error codes of a connection that was open and then dropped: the server got the request. */
const DROPPED_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

function networkCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  const code = (cause?.code ?? (err as { code?: unknown })?.code) as unknown;
  return typeof code === 'string' ? code : null;
}

/** Whether a thrown fetch error means the connection dropped after the request was sent. */
export function isDropped(err: unknown): boolean {
  const code = networkCode(err);
  return code !== null && DROPPED_CODES.has(code);
}

/** Whether a thrown fetch error means the server could not be reached at all. */
export function isUnreachable(err: unknown): boolean {
  if (isDropped(err)) return false;
  const code = networkCode(err);
  if (code && UNREACHABLE_CODES.has(code)) return true;
  // undici reports every connection-level failure as `TypeError: fetch failed`.
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** `path?k=v&...`, leaving out absent and empty values. */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
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

  /** Where a preview shows in the web UI: its review's page, else the previews page. */
  previewPage(reviewId: number | null): string {
    return reviewId ? this.reviewUrl(reviewId) : `${this.baseUrl}/previews`;
  }

  /**
   * Raw request: returns the response body as text, or throws ApiError,
   * ApiUnreachableError (nothing listening), or ApiNoAnswerError (the server
   * took the request but did not answer in time, or dropped the connection).
   */
  async requestText(path: string, opts: RequestOptions = {}): Promise<string> {
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const init: RequestInit = { method, signal };
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
      // A refused connection fails at once; only a server that accepted the
      // request can keep it waiting this long.
      if (timeout.aborted && !isUnreachable(err)) {
        const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
        throw new ApiNoAnswerError(this.baseUrl, method, path, `sent no answer within ${limit}`);
      }
      if (isDropped(err)) {
        throw new ApiNoAnswerError(this.baseUrl, method, path, `the connection dropped before it answered (${networkCode(err)})`);
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
    return this.requestJson<T>(withQuery('/api/reviews', params));
  }

  reviewGroups<T>(params: Record<string, string | number | undefined>): Promise<T> {
    return this.requestJson<T>(withQuery('/api/review-groups', params));
  }

  cancel<T>(id: number): Promise<T> {
    return this.requestJson<T>(`/api/reviews/${id}/cancel`, { method: 'POST' });
  }

  rerun<T>(id: number, body: { reviewer?: string; model?: string }): Promise<T> {
    return this.requestJson<T>(`/api/reviews/${id}/rerun`, { method: 'POST', body });
  }

  /** A human link to a ticket's page in the web UI. */
  ticketUrl(key: string): string {
    return `${this.baseUrl}/ticket/${encodeURIComponent(key)}`;
  }

  ticketGroup<T>(key: string, runId?: number, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(withQuery(`/api/ticket-groups/${encodeURIComponent(key)}`, { run: runId }), { signal });
  }

  startTicketReview<T>(key: string, body: unknown): Promise<T> {
    return this.requestJson<T>(`/api/tickets/${encodeURIComponent(key)}/review`, {
      method: 'POST', body, timeoutMs: TICKET_REVIEW_REQUEST_MS,
    });
  }

  recomputeCoverage<T>(key: string, body: { reviewer?: string; model?: string }): Promise<T> {
    return this.requestJson<T>(`/api/tickets/${encodeURIComponent(key)}/coverage`, { method: 'POST', body });
  }

  setBranchParent<T>(key: string, body: { repo: string; branch: string; parent: string | null }): Promise<T> {
    return this.requestJson<T>(`/api/tickets/${encodeURIComponent(key)}/parent`, { method: 'PUT', body });
  }

  setChainOrder<T>(key: string, body: { repo: string; branches: string[]; root?: string }): Promise<T> {
    return this.requestJson<T>(`/api/tickets/${encodeURIComponent(key)}/order`, { method: 'PUT', body });
  }

  recipes<T>(): Promise<T> {
    return this.requestJson<T>('/api/recipes');
  }

  createPreview<T>(body: unknown): Promise<T> {
    return this.requestJson<T>('/api/previews', { method: 'POST', body, timeoutMs: SLOW_REQUEST_MS });
  }

  preview<T>(id: number, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(`/api/previews/${id}`, { signal });
  }

  listPreviews<T>(params: Record<string, string | number | undefined>): Promise<T> {
    return this.requestJson<T>(withQuery('/api/previews', params));
  }

  /** Answers once the preview is `stopping`; its teardown goes on in the server (see get_preview). */
  stopPreview<T>(id: number): Promise<T> {
    return this.requestJson<T>(`/api/previews/${id}/stop`, { method: 'POST' });
  }
}
