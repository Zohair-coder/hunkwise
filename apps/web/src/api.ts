import type { ErrorResponse, GitLabInstance, ReviewDetail, ReviewList, SubmitReview } from '@hunkwise/contracts';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  });
  if (!response.ok) {
    const fallback = { error: { code: 'request_failed', message: `Request failed (${response.status})`, requestId: 'unknown' } };
    const body = await response.json().catch(() => fallback) as ErrorResponse;
    throw new ApiError(body.error.code, body.error.message, body.error.requestId);
  }
  return response.json() as Promise<T>;
}

export const api = {
  instances: async (): Promise<GitLabInstance[]> => {
    const result = await request<{ items: GitLabInstance[] }>('/api/instances');
    return result.items;
  },
  reviews: (): Promise<ReviewList> => request('/api/reviews?limit=20&offset=0'),
  review: (id: string): Promise<ReviewDetail> => request(`/api/reviews/${encodeURIComponent(id)}`),
  submit: (input: SubmitReview): Promise<{ runId: string }> => request('/api/reviews', { method: 'POST', body: JSON.stringify(input) })
};
