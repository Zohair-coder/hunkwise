import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDetail, ReviewRun } from '@hunkwise/contracts';
import App from './App.js';

const now = new Date('2026-06-19T12:00:00.000Z').toISOString();
const instance = { id: '10000000-0000-4000-8000-000000000000', name: 'Work GitLab', baseUrl: 'https://gitlab.test', hasAccessToken: true, createdAt: now, updatedAt: now };
const runId = '20000000-0000-4000-8000-000000000000';
const fileId = '30000000-0000-4000-8000-000000000000';
const findingId = '40000000-0000-4000-8000-000000000000';
const postedFindingId = '40000000-0000-4000-8000-000000000001';

const run: ReviewRun = {
  id: runId,
  mergeRequestId: '50000000-0000-4000-8000-000000000000',
  status: 'completed',
  sourceSha: 'head-sha-123456',
  summary: 'One issue found.',
  errorMessage: null,
  aiModel: 'gpt-test',
  overviewCommentBody: 'Hunkwise reviewed this MR.',
  startedAt: now,
  completedAt: now,
  createdAt: now,
  updatedAt: now,
  mergeRequest: {
    id: '50000000-0000-4000-8000-000000000000',
    projectId: '60000000-0000-4000-8000-000000000000',
    gitlabIid: 7,
    title: 'Fix parser',
    authorUsername: 'alice',
    sourceBranch: 'feature/parser',
    targetBranch: 'main',
    sourceSha: 'head-sha-123456',
    targetSha: 'base-sha-123456',
    state: 'open',
    webUrl: 'https://gitlab.test/group/project/-/merge_requests/7',
    createdAt: now,
    updatedAt: now
  }
};

const detail: ReviewDetail = {
  run,
  files: [{ id: fileId, reviewRunId: runId, oldPath: 'src/parser.ts', newPath: 'src/parser.ts', status: 'modified', additions: 1, deletions: 1 }],
  hunks: [{ id: '70000000-0000-4000-8000-000000000000', diffFileId: fileId, oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, header: '@@ -10,2 +10,2 @@', patch: '@@ -10,2 +10,2 @@\n const value = parse(input);\n-throw new Error("bad");\n+return failure("bad");', position: 0 }],
  findings: [
    {
      id: findingId,
      reviewRunId: runId,
      diffHunkId: '70000000-0000-4000-8000-000000000000',
      severity: 'error',
      category: 'bug',
      title: 'Avoid throwing from parser',
      body: 'The parser should return a typed failure.',
      rationale: 'Throwing changes the caller contract.',
      filePath: 'src/parser.ts',
      line: 11,
      lineEnd: 11,
      confidence: 0.92,
      suggestedFix: 'Return a parse failure object.',
      shouldPost: true,
      gitlabPosition: { baseSha: 'base-sha', startSha: 'start-sha', headSha: 'head-sha', oldPath: 'src/parser.ts', newPath: 'src/parser.ts', positionType: 'text', newLine: 11 },
      gitlabDiscussionId: null,
      gitlabNoteId: null,
      postedAt: null,
      status: 'open',
      createdAt: now
    },
    {
      id: postedFindingId,
      reviewRunId: runId,
      diffHunkId: null,
      severity: 'warning',
      category: 'test',
      title: 'Add parser regression test',
      body: 'The change needs a test.',
      rationale: 'Tests protect this behavior.',
      filePath: 'src/parser.ts',
      line: 10,
      lineEnd: 10,
      confidence: 0.73,
      suggestedFix: null,
      shouldPost: true,
      gitlabPosition: { baseSha: 'base-sha', startSha: 'start-sha', headSha: 'head-sha', oldPath: 'src/parser.ts', newPath: 'src/parser.ts', positionType: 'text', newLine: 10 },
      gitlabDiscussionId: 'posted-discussion',
      gitlabNoteId: 'posted-note',
      postedAt: now,
      status: 'open',
      createdAt: now
    }
  ],
  discussions: [
    { id: '80000000-0000-4000-8000-000000000000', reviewRunId: runId, findingId, gitlabDiscussionId: 'discussion-1', resolved: false, createdAt: now },
    { id: '80000000-0000-4000-8000-000000000001', reviewRunId: runId, findingId: null, gitlabDiscussionId: 'existing-discussion', resolved: false, createdAt: now }
  ],
  comments: [
    { id: '90000000-0000-4000-8000-000000000000', discussionId: '80000000-0000-4000-8000-000000000000', authorType: 'gitlab', authorName: 'bob', body: 'Existing inline note', gitlabNoteId: 'note-1', createdAt: now },
    { id: '90000000-0000-4000-8000-000000000001', discussionId: '80000000-0000-4000-8000-000000000001', authorType: 'gitlab', authorName: 'carol', body: 'Existing overview note', gitlabNoteId: 'note-2', createdAt: now }
  ],
  chatMessages: []
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

function jsonBody(call: readonly [string, (RequestInit | undefined)?] | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected string request body');
  return JSON.parse(body) as unknown;
}

function mockWorkspace(options: { reviews?: ReviewRun[]; instances?: typeof instance[]; detail?: ReviewDetail; extra?: (url: string, init?: RequestInit) => Response | undefined } = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const extra = options.extra?.(url, init);
    if (extra) return Promise.resolve(extra);
    if (url === `/api/reviews/${runId}`) return Promise.resolve(jsonResponse(options.detail ?? detail));
    if (url.startsWith('/api/reviews?')) return Promise.resolve(jsonResponse({ items: options.reviews ?? [run], total: options.reviews?.length ?? 1, limit: 20, offset: 0 }));
    if (url === '/api/instances') return Promise.resolve(jsonResponse({ items: options.instances ?? [instance] }));
    return Promise.resolve(jsonResponse({ error: { code: 'not_found', message: `Unhandled ${url}`, requestId: 'req' } }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('creates and tests a GitLab instance without keeping the token displayed', async () => {
    const fetchMock = mockWorkspace({
      instances: [],
      reviews: [],
      extra: (url, init) => {
        if (url === '/api/instances' && init?.method === 'POST') return jsonResponse(instance, 201);
        if (url === `/api/instances/${instance.id}/test`) return jsonResponse({ ok: true, username: 'alice', version: '17.0' });
        if (url === '/api/instances') return jsonResponse({ items: [instance] });
      }
    });

    render(<App />);
    await userEvent.type(await screen.findByLabelText('Name'), 'Work GitLab');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://gitlab.test');
    await userEvent.type(screen.getByLabelText('Access token'), 'glpat-secret-token');
    await userEvent.click(screen.getByRole('button', { name: 'Save instance' }));

    await screen.findByText('Instance saved. Token was submitted and cleared locally.');
    expect(screen.queryByDisplayValue('glpat-secret-token')).not.toBeInTheDocument();
    expect(jsonBody(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST'))).toMatchObject({ accessToken: 'glpat-secret-token' });

    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connected as alice, GitLab 17.0.')).toBeInTheDocument();
  });

  it('validates and submits a merge request URL with AI options', async () => {
    const fetchMock = mockWorkspace({
      reviews: [],
      extra: (url, init) => {
        if (url === '/api/reviews' && init?.method === 'POST') return jsonResponse({ runId, status: 'queued', summary: null }, 202);
      }
    });

    render(<App />);
    await userEvent.type(await screen.findByLabelText('Merge request URL'), 'https://gitlab.test/group/project/-/merge_requests/7?token=secret');
    await userEvent.click(screen.getByRole('button', { name: 'Review MR' }));
    expect(await screen.findByText('Use an HTTP(S) MR URL without credentials, query strings, or fragments.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/reviews' && call[1]?.method === 'POST')).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText('Merge request URL'));
    await userEvent.type(screen.getByLabelText('Merge request URL'), 'https://gitlab.test/group/project/-/merge_requests/7');
    await userEvent.click(screen.getByRole('button', { name: 'Review MR' }));
    await screen.findByText('Fix parser');

    const submitCall = fetchMock.mock.calls.find((call) => call[0] === '/api/reviews' && call[1]?.method === 'POST');
    expect(jsonBody(submitCall)).toMatchObject({ instanceId: instance.id, runAi: true, autoPost: false });
  });

  it('renders review metadata, grouped hunks, line numbers, findings, and existing discussions', async () => {
    mockWorkspace();
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Fix parser/i }));

    expect(await screen.findByRole('heading', { name: 'Fix parser' })).toBeInTheDocument();
    expect(screen.getByText('feature/parser -> main')).toBeInTheDocument();
    expect(screen.getAllByText('src/parser.ts').length).toBeGreaterThan(0);
    expect(screen.getByText('@@ -10,2 +10,2 @@')).toBeInTheDocument();
    expect(screen.getByText('return failure("bad");')).toBeInTheDocument();
    expect(screen.getAllByText('11').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avoid throwing from parser').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Existing inline note').length).toBeGreaterThan(0);
    expect(screen.getByText((_content, element) => element?.textContent === 'carol: Existing overview note')).toBeInTheDocument();
  });

  it('filters findings and posts the selected finding', async () => {
    const fetchMock = mockWorkspace({
      extra: (url, init) => {
        if (url === `/api/reviews/${runId}/ai-review/post` && init?.method === 'POST') {
          return jsonResponse({ items: [{ findingId, gitlabDiscussionId: 'new-discussion', gitlabNoteId: 'new-note', skipped: false }] }, 201);
        }
      }
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Fix parser/i }));
    await waitFor(() => expect(screen.getAllByText('Avoid throwing from parser').length).toBeGreaterThan(0));

    await userEvent.selectOptions(screen.getByLabelText('Filter findings by severity'), 'warning');
    const findingList = document.querySelector('.finding-list');
    expect(findingList).not.toBeNull();
    expect(within(findingList as HTMLElement).queryByText('Avoid throwing from parser')).not.toBeInTheDocument();
    expect(within(findingList as HTMLElement).getByText('Add parser regression test')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Filter findings by severity'), 'all');
    await userEvent.selectOptions(screen.getByLabelText('Filter findings by post state'), 'postable');
    expect(within(findingList as HTMLElement).getByText('Avoid throwing from parser')).toBeInTheDocument();
    expect(within(findingList as HTMLElement).queryByText('Add parser regression test')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Post selected finding' }));
    expect(await screen.findByText('1 posted, 0 skipped.')).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find((call) => call[0] === `/api/reviews/${runId}/ai-review/post`);
    expect(jsonBody(postCall)).toEqual({ includeOverview: false, findingIds: [findingId] });
  });

  it('posts the overview comment and refreshes or reruns the review', async () => {
    const fetchMock = mockWorkspace({
      extra: (url, init) => {
        if (url === `/api/reviews/${runId}/ai-review/post` && init?.method === 'POST') {
          return jsonResponse({ items: [{ findingId: null, gitlabDiscussionId: 'overview', gitlabNoteId: 'note', skipped: false }] }, 201);
        }
        if (url === `/api/reviews/${runId}/refresh`) return jsonResponse({ runId, status: 'completed', summary: 'refreshed' }, 202);
        if (url === `/api/reviews/${runId}/ai-review`) return jsonResponse({ runId, status: 'completed', summary: 'rerun' }, 202);
      }
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Fix parser/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Post overview' }));
    expect(await screen.findByText('1 posted, 0 skipped.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh MR' }));
    expect(await screen.findByText('Refresh accepted: completed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-run AI' }));
    expect(await screen.findByText('AI review completed.')).toBeInTheDocument();

    expect(fetchMock.mock.calls.some((call) => call[0] === `/api/reviews/${runId}/refresh`)).toBe(true);
    expect(fetchMock.mock.calls.some((call) => call[0] === `/api/reviews/${runId}/ai-review`)).toBe(true);
  });

  it('shows redacted loading and detail errors with targeted help', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/reviews?')) return Promise.resolve(jsonResponse({ error: { code: 'gitlab_unauthorized', message: 'GitLab rejected glpat-secret-token', requestId: 'req-1' } }, 401));
      return Promise.resolve(jsonResponse({ items: [instance] }));
    }));
    render(<App />);
    expect(await screen.findByText('GitLab rejected [redacted-gitlab-token]')).toBeInTheDocument();

    cleanup();
    mockWorkspace({
      extra: (url, init) => {
        if (url === `/api/reviews/${runId}/ai-review` && init?.method === 'POST') {
          return jsonResponse({ error: { code: 'ai_not_configured', message: 'OPENAI_API_KEY=sk-super-secret is missing', requestId: 'req-2' } }, 503);
        }
      }
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Fix parser/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Re-run AI' }));
    expect(screen.getByText('OPENAI_API_KEY=[redacted] is missing')).toBeInTheDocument();
    expect(screen.getByText('Set OPENAI_API_KEY on the API process, then re-run the review.')).toBeInTheDocument();
    expect(within(document.body).getByText('Action failed')).toBeTruthy();
  });
});
