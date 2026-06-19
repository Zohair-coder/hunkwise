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
