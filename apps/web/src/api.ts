import {
  sanitizeSecrets,
  type AiReviewPostResponse,
  type CreateGitLabInstance,
  type ErrorResponse,
  type GitLabDiscussionActionResponse,
  type GitLabInstance,
  type PostAiReview,
  type ReviewDetail,
  type ReviewList,
  type ReviewRunReference,
  type SubmitReviewInput,
  type TestGitLabInstanceResponse,
  type TriggerAiReview
} from '@hunkwise/contracts';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) {
    super(sanitizeSecrets(message));
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    const fallback = { error: { code: 'request_failed', message: `Request failed (${response.status})`, requestId: 'unknown' } };
    const body = await response.json().catch(() => fallback) as ErrorResponse;
    throw new ApiError(body.error.code, sanitizeSecrets(body.error.message), body.error.requestId);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  instances: async (): Promise<GitLabInstance[]> => {
    const result = await request<{ items: GitLabInstance[] }>('/api/instances');
    return result.items;
  },
  createInstance: (input: CreateGitLabInstance): Promise<GitLabInstance> =>
    request('/api/instances', { method: 'POST', body: JSON.stringify(input) }),
  testInstance: (id: string): Promise<TestGitLabInstanceResponse> =>
    request(`/api/instances/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  reviews: (): Promise<ReviewList> => request('/api/reviews?limit=20&offset=0'),
  review: (id: string): Promise<ReviewDetail> => request(`/api/reviews/${encodeURIComponent(id)}`),
  submit: (input: SubmitReviewInput): Promise<ReviewRunReference> =>
    request('/api/reviews', { method: 'POST', body: JSON.stringify(input) }),
  refreshReview: (id: string): Promise<ReviewRunReference> =>
    request(`/api/reviews/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  runAiReview: (id: string, input: TriggerAiReview): Promise<ReviewRunReference> =>
    request(`/api/reviews/${encodeURIComponent(id)}/ai-review`, { method: 'POST', body: JSON.stringify(input) }),
  postAiReview: (id: string, input: PostAiReview): Promise<AiReviewPostResponse> =>
    request(`/api/reviews/${encodeURIComponent(id)}/ai-review/post`, { method: 'POST', body: JSON.stringify(input) }),
  postOverviewDiscussion: (id: string, body: string): Promise<GitLabDiscussionActionResponse> =>
    request(`/api/reviews/${encodeURIComponent(id)}/gitlab/discussions`, { method: 'POST', body: JSON.stringify({ body }) })
};
