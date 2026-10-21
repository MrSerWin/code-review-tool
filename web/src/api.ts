import type {
  DumpModeRequest,
  Health,
  LocalParent,
  LocalReposPayload,
  Preview,
  PreviewDetailPayload,
  PreviewRoleRequest,
  RecipesPayload,
  RepoBranchesPayload,
  TicketPreviewPlan,
  Review,
  ReviewDetailPayload,
  ReviewGroupsPayload,
  ReviewersPayload,
  ResolvedTarget,
  TicketGroupPayload,
  TicketInfo,
} from './types';

type Params = Record<string, string | number | undefined>;

/** `path?k=v&...`, leaving out absent and empty values. */
function withQuery(path: string, params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* keep raw text */
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  health: () => req<Health>('/api/health'),
  reviewers: () => req<ReviewersPayload>('/api/reviewers'),
  repos: () => req<{ repos: string[] }>('/api/repos'),
  localRepos: () => req<LocalReposPayload>('/api/local-repos'),
  localParent: (repo: string, branch: string) =>
    req<LocalParent>(
      `/api/local-repos/${encodeURIComponent(repo)}/parent?branch=${encodeURIComponent(branch)}`,
    ),
  ticket: (key: string) =>
    req<{ ticket: TicketInfo; targets: ResolvedTarget[] }>(`/api/tickets/${encodeURIComponent(key)}`),
  createReviews: (body: {
    input: string;
    targets?: ResolvedTarget[];
    reviewer?: string;
    model?: string;
    requirementsText?: string;
    includeWorkingTree?: boolean;
    baseBranch?: string;
  }) =>
    req<{ reviews: Review[] }>('/api/reviews', { method: 'POST', body: JSON.stringify(body) }),
  listReviews: (params: Params = {}) =>
    req<{ reviews: Review[]; total: number }>(withQuery('/api/reviews', params)),
  /** The history grouped by ticket: `q`, `status` (active | failed | done), `limit`, `offset`. */
  reviewGroups: (params: Params = {}) => req<ReviewGroupsPayload>(withQuery('/api/review-groups', params)),
  review: (id: number) => req<ReviewDetailPayload>(`/api/reviews/${id}`),
  report: async (id: number) => {
    const res = await fetch(`/api/reviews/${id}/report`);
    if (!res.ok) throw new Error('Report is not available yet');
    return res.text();
  },
  rerun: (id: number, overrides: { reviewer?: string; model?: string } = {}) =>
    req<{ review: Review }>(`/api/reviews/${id}/rerun`, {
      method: 'POST',
      body: JSON.stringify(overrides),
    }),
  cancel: (id: number) => req<{ review: Review }>(`/api/reviews/${id}/cancel`, { method: 'POST' }),
  remove: (id: number) => req<{ ok: true }>(`/api/reviews/${id}`, { method: 'DELETE' }),
  eventsUrl: (id: number) => `/api/reviews/${id}/events`,
  reportUrl: (id: number) => `/api/reviews/${id}/report`,

  /** A ticket group: chains in stack order, latest runs, coverage. 404 when the key has none. */
  ticketGroup: (key: string) => req<TicketGroupPayload>(`/api/ticket-groups/${encodeURIComponent(key)}`),
  reviewTicket: (key: string, body: { reviewer?: string; model?: string; requirementsText?: string; branches?: string[] } = {}) =>
    req<TicketGroupPayload & { reviews: Review[]; notes: string[]; resolve_warning?: string }>(
      `/api/tickets/${encodeURIComponent(key)}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  recomputeCoverage: (key: string) =>
    req<{ started: boolean }>(`/api/tickets/${encodeURIComponent(key)}/coverage`, { method: 'POST', body: JSON.stringify({}) }),
  setBranchParent: (key: string, body: { repo: string; branch: string; parent: string | null }) =>
    req<TicketGroupPayload>(`/api/tickets/${encodeURIComponent(key)}/parent`, { method: 'PUT', body: JSON.stringify(body) }),
  setChainOrder: (key: string, body: { repo: string; branches: string[] }) =>
    req<TicketGroupPayload>(`/api/tickets/${encodeURIComponent(key)}/order`, { method: 'PUT', body: JSON.stringify(body) }),
  detectParents: (key: string, reset = false) =>
    req<TicketGroupPayload>(`/api/tickets/${encodeURIComponent(key)}/detect`, { method: 'POST', body: JSON.stringify({ reset }) }),
  coverageReportUrl: (key: string) => `/api/ticket-groups/${encodeURIComponent(key)}/coverage/report`,

  recipes: () => req<RecipesPayload>('/api/recipes'),
  /** What "Preview ticket" runs: per role its repo's chain tip, plus a live preview that runs it already. */
  ticketPreviewPlan: (key: string, recipe?: string) =>
    req<TicketPreviewPlan>(withQuery(`/api/ticket-groups/${encodeURIComponent(key)}/preview-plan`, { recipe })),
  listPreviews: (params: Params = {}) =>
    req<{ previews: Preview[]; total: number }>(withQuery('/api/previews', params)),
  preview: (id: number) => req<PreviewDetailPayload>(`/api/previews/${id}`),
  /** Remote branches of an allowed repository, default branch first; `q` filters by substring. */
  repoBranches: (repo: string, q?: string) =>
    req<RepoBranchesPayload>(withQuery(`/api/repos/${encodeURIComponent(repo)}/branches`, { q })),
  createPreview: (body: {
    reviewId?: number;
    ticket?: string;
    recipe?: string;
    /** Branches picked by hand; roles left out follow the ticket, or their base branch without one. */
    roles?: PreviewRoleRequest[];
    dumpMode?: DumpModeRequest;
  }) => req<{ preview: Preview }>('/api/previews', { method: 'POST', body: JSON.stringify(body) }),
  stopPreview: (id: number) =>
    req<{ preview: Preview | null }>(`/api/previews/${id}/stop`, { method: 'POST' }),
  removePreview: (id: number) => req<{ ok: true }>(`/api/previews/${id}`, { method: 'DELETE' }),
  previewEventsUrl: (id: number) => `/api/previews/${id}/events`,
};
