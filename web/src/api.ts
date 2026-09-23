import type {
  DumpModeRequest,
  Health,
  Preview,
  PreviewDetailPayload,
  RecipesPayload,
  Review,
  ReviewDetailPayload,
  ReviewersPayload,
  ResolvedTarget,
  TicketInfo,
} from './types';

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
  ticket: (key: string) =>
    req<{ ticket: TicketInfo; targets: ResolvedTarget[] }>(`/api/tickets/${encodeURIComponent(key)}`),
  createReviews: (body: {
    input: string;
    targets?: ResolvedTarget[];
    reviewer?: string;
    model?: string;
    requirementsText?: string;
  }) =>
    req<{ reviews: Review[] }>('/api/reviews', { method: 'POST', body: JSON.stringify(body) }),
  listReviews: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    return req<{ reviews: Review[]; total: number }>(`/api/reviews${q ? `?${q}` : ''}`);
  },
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

  recipes: () => req<RecipesPayload>('/api/recipes'),
  listPreviews: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    return req<{ previews: Preview[]; total: number }>(`/api/previews${q ? `?${q}` : ''}`);
  },
  preview: (id: number) => req<PreviewDetailPayload>(`/api/previews/${id}`),
  createPreview: (body: {
    reviewId?: number;
    ticket?: string;
    recipe?: string;
    dumpMode?: DumpModeRequest;
  }) => req<{ preview: Preview }>('/api/previews', { method: 'POST', body: JSON.stringify(body) }),
  stopPreview: (id: number) =>
    req<{ preview: Preview | null }>(`/api/previews/${id}/stop`, { method: 'POST' }),
  removePreview: (id: number) => req<{ ok: true }>(`/api/previews/${id}`, { method: 'DELETE' }),
  previewEventsUrl: (id: number) => `/api/previews/${id}/events`,
};
