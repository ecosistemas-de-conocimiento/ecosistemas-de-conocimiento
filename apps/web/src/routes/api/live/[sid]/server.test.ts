/**
 * 🔴 The live proxy names the CONVERSATION the recording belongs to, so the
 * backend checks `liveMic` on that conversation's ecosistema — not on the one
 * selected in the cookie, which can differ (re-audit 2026-10-26).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backendFetch } = vi.hoisted(() => ({
  backendFetch: vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 })),
}));
vi.mock('$lib/server/auth', () => ({ backendFetch }));

import { POST } from './+server';

const call = (query: string, cookie = '8') =>
  POST({
    locals: { user: { id: 1 }, token: 't' },
    params: { sid: 'sid-1' },
    url: new URL(`http://x/api/live/sid-1${query}`),
    request: new Request('http://x', { method: 'POST', body: new Uint8Array([1]) }),
    cookies: { get: () => cookie },
  } as never);

beforeEach(() => backendFetch.mockClear());

describe('POST /api/live/:sid', () => {
  it('🔴 forwards the conversation id alongside the cookie ecosistema', async () => {
    await call('?offset=3&conversation=55');
    expect(String(backendFetch.mock.calls[0]![1])).toBe('/api/live/sid-1?organization=8&conversation=55&offset=3');
  });

  it('without a conversation, only the cookie ecosistema', async () => {
    await call('?offset=0');
    expect(String(backendFetch.mock.calls[0]![1])).toBe('/api/live/sid-1?organization=8&offset=0');
  });

  it('a backend 429 keeps its Retry-After', async () => {
    backendFetch.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }));
    const res = await call('?offset=0');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
