/**
 * Bug #37: attaching a document to a conversation this tab still lists but the
 * server has deleted. The BFF answers `404 session_not_found`; the store must
 * forget the conversation and, for "Nueva conversación con este documento",
 * make a real one and pin the document there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app, ATTACH_GONE_TOAST } from './app.svelte';
import { toasts } from './toasts.svelte';

type Call = { url: string; init?: RequestInit };
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function session(id: string, title = 'Nueva conversación') {
  return {
    id,
    title,
    messages: [],
    docs: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as (typeof app.sessions)[number];
}

/** Routes the store's fetches. `stale` is the deleted conversation's id. */
function installFetch(stale: string, fresh: string) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === `/api/sessions/${stale}/documents/9`) {
        return json({ error: 'session_not_found' }, 404);
      }
      if (method === 'POST' && url === '/api/sessions') {
        return json({ doc: { id: Number(fresh), title: 'Nueva conversación' } }, 201);
      }
      if (method === 'POST' && url === `/api/sessions/${fresh}/documents/9`) {
        return json({ doc: { id: 9 } });
      }
      // A deleted conversation's lazy reads answer 200 with empty lists
      // (measured on dev, 2026-10-21) — that is why reuse cannot tell.
      return json({ docs: [] });
    }),
  );
}

beforeEach(() => {
  app.sessions = [session('5')];
  app.activeSessionId = '5';
  app.ecosystems = [{ id: '1', name: 'Uno', slug: 'uno' }] as typeof app.ecosystems;
  app.ecosystemId = '1';
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
});

afterEach(() => vi.unstubAllGlobals());

describe('attaching to a conversation the server deleted', () => {
  it('startSessionWithDoc forgets the stale empty conversation and pins the doc in a new one', async () => {
    installFetch('5', '6');

    const id = await app.startSessionWithDoc('9');

    expect(id).toBe('6');
    expect(app.sessions.map((s) => s.id)).toEqual(['6']);
    expect(app.activeSessionId).toBe('6');
    const attach = calls.find((c) => c.url === '/api/sessions/6/documents/9');
    expect(JSON.parse(String(attach?.init?.body))).toEqual({ pin: true });
    expect(toasts.list).toHaveLength(0);
  });

  it('attachDoc forgets the conversation and says it no longer exists', async () => {
    installFetch('5', '6');

    const ok = await app.attachDoc('5', '9');

    expect(ok).toBe(false);
    expect(app.sessions).toHaveLength(0);
    expect(toasts.list.map((t) => t.title)).toEqual([ATTACH_GONE_TOAST.title]);
  });
});

describe('Mis documentos picks up a finished extraction without a reload', () => {
  afterEach(() => vi.useRealTimers());

  it('polls an in-flight owned document and flips its badge to ready', async () => {
    vi.useFakeTimers();
    app.sessions = [];
    let status = 'extracting';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/documentos')) {
          return json({ docs: [{ id: 31, name: 'a.pdf', kind: 'pdf', ingestStatus: 'extracting', session: [] }] });
        }
        if (url === '/api/documents/31') return json({ id: 31, ingestStatus: status });
        return json({ docs: [] });
      }),
    );

    await app.loadOwnedDocs();
    expect(app.ownedDocs[0]?.ingestStatus).toBe('extracting');

    status = 'ready';
    await vi.advanceTimersByTimeAsync(2_100);

    expect(app.ownedDocs[0]?.ingestStatus).toBe('ready');
  });
});
