import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the empty landing state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/api/reviews') ? jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }) : jsonResponse({ items: [] }))
    ));
    render(<App />);
    expect(screen.getByText('Understand the change.')).toBeInTheDocument();
    expect(await screen.findByText('No reviews yet')).toBeInTheDocument();
  });

  it('opens the three-column review preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/api/reviews') ? jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }) : jsonResponse({ items: [] }))
    ));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /explore the review shell/i }));
    expect(screen.getByText('Changed files')).toBeInTheDocument();
    expect(screen.getByText('Review summary')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask about this review')).toBeInTheDocument();
    expect(screen.getByText('This shell displays only data returned by the review detail API.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Findings & chat' })).toBeInTheDocument();
  });

  it('fetches and renders persisted review detail without fabricated content', async () => {
    const now = new Date().toISOString();
    const run = { id: 'd9924f07-410b-4a84-b858-5f24e82f26c0', mergeRequestId: '5c9dc9f2-66ad-493c-9f7e-363eb008be1e', status: 'completed', sourceSha: 'abc123456789', summary: null, errorMessage: null, startedAt: now, completedAt: now, createdAt: now, updatedAt: now };
    const detail = {
      run,
      files: [{ id: '5f86ac44-7dfc-41da-bc4e-28cbd24a04c1', reviewRunId: run.id, oldPath: 'src/real.ts', newPath: 'src/real.ts', status: 'modified', additions: 1, deletions: 0 }],
      hunks: [{ id: 'c66d2a68-2c09-4ea0-92bc-39e46280ca9b', diffFileId: '5f86ac44-7dfc-41da-bc4e-28cbd24a04c1', oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '@@ persisted @@', patch: '+persistedLine', position: 0 }],
      findings: [{ id: '24dc2b1c-4745-45ef-b90d-32b343ac28ba', reviewRunId: run.id, diffHunkId: null, severity: 'warning', category: 'correctness', title: 'Persisted finding', body: 'Loaded from the API.', filePath: 'src/real.ts', line: 1, confidence: 0.8, status: 'open', createdAt: now }],
      discussions: [], comments: [], chatMessages: [{ id: 'ee755e7f-9277-41dd-80db-d2122cae1409', reviewRunId: run.id, role: 'assistant', content: 'Persisted chat answer', createdAt: now }]
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === `/api/reviews/${run.id}`) return Promise.resolve(jsonResponse(detail));
      if (url.startsWith('/api/reviews?')) return Promise.resolve(jsonResponse({ items: [run], total: 1, limit: 20, offset: 0 }));
      return Promise.resolve(jsonResponse({ items: [] }));
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review d9924f07/i }));
    expect((await screen.findAllByText('src/real.ts')).length).toBeGreaterThan(0);
    expect(screen.getByText('+persistedLine')).toBeInTheDocument();
    expect(screen.getByText('Persisted finding')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Chat 1/i }));
    expect(screen.getByText('Persisted chat answer')).toBeInTheDocument();
  });

  it('renders an honest review-detail error state', async () => {
    const now = new Date().toISOString();
    const run = { id: 'd9924f07-410b-4a84-b858-5f24e82f26c0', mergeRequestId: '5c9dc9f2-66ad-493c-9f7e-363eb008be1e', status: 'failed', sourceSha: 'abc123', summary: null, errorMessage: null, startedAt: now, completedAt: now, createdAt: now, updatedAt: now };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === `/api/reviews/${run.id}`) return Promise.resolve(jsonResponse({ error: { code: 'request_failed', message: 'Detail unavailable', requestId: 'detail-1' } }, 503));
      if (url.startsWith('/api/reviews?')) return Promise.resolve(jsonResponse({ items: [run], total: 1, limit: 20, offset: 0 }));
      return Promise.resolve(jsonResponse({ items: [] }));
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review d9924f07/i }));
    expect(await screen.findByText('Review unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Detail unavailable').length).toBeGreaterThan(0);
  });

  it('surfaces submission errors', async () => {
    const instance = { id: 'd9924f07-410b-4a84-b858-5f24e82f26c0', name: 'Work', baseUrl: 'https://gitlab.test', hasAccessToken: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ error: { code: 'integration_not_implemented', message: 'gitlab integration is not implemented in Slice 1', requestId: 'req-1' } }, 501));
      return Promise.resolve(url.startsWith('/api/reviews') ? jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }) : jsonResponse({ items: [instance] }));
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('No reviews yet')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Merge request URL'), 'https://gitlab.test/group/project/-/merge_requests/1');
    await userEvent.click(screen.getByRole('button', { name: /review mr/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not implemented in Slice 1');
  });
});
