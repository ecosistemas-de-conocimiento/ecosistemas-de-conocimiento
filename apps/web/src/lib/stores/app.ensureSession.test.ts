/**
 * A person with no conversations lands on an empty composer and no session.
 * The first send or upload creates exactly one, then acts inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import { toasts } from './toasts.svelte';

type Call = { url: string; method: string; body?: BodyInit | null };
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch() {
  calls = [];
  let next = 40;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      if (method === 'POST' && url === '/api/sessions') {
        await new Promise((r) => setTimeout(r, 5));
        return json({ doc: { id: next++, title: 'Nueva conversación' } }, 201);
      }
      if (method === 'POST' && /^\/api\/sessions\/\d+\/documents$/.test(url)) {
        return json({ doc: { id: 77, name: 'a.pdf', ingestStatus: 'ready', publicationStatus: 'draft' } }, 201);
      }
      return json({ docs: [] });
    }),
  );
}

const creates = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions');

beforeEach(() => {
  app.sessions = [];
  app.activeSessionId = null;
  app.ecosystems = [{ id: '1', name: 'Uno', slug: 'uno' }] as typeof app.ecosystems;
  app.ecosystemId = '1';
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
  installFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe('ensureSession', () => {
  it('creates the first conversation once, even when called twice at once', async () => {
    const [a, b] = await Promise.all([app.ensureSession(), app.ensureSession()]);

    expect(a).toBe('40');
    expect(b).toBe('40');
    expect(creates()).toHaveLength(1);
    expect(app.sessions.map((s) => s.id)).toEqual(['40']);
    expect(app.activeSessionId).toBe('40');
  });

  it('returns the open conversation without creating one', async () => {
    await app.ensureSession();
    calls = [];

    expect(await app.ensureSession()).toBe('40');
    expect(creates()).toHaveLength(0);
  });

  it('upload with no chat open: creates the conversation, then uploads into it', async () => {
    const sessionId = await app.ensureSession();
    const doc = await app.uploadDoc(sessionId!, new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));

    expect(doc).not.toBeNull();
    expect(creates()).toHaveLength(1);
    const upload = calls.find((c) => c.url === '/api/sessions/40/documents');
    expect(upload?.method).toBe('POST');
    // A conversation upload, not a standalone one.
    expect(calls.some((c) => c.url.startsWith('/api/documentos'))).toBe(false);
    expect((upload?.body as FormData).get('isPinned')).toBe('true');
  });

  it('a failed create returns null and leaves no conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));

    expect(await app.ensureSession()).toBeNull();
    expect(app.sessions).toHaveLength(0);
    expect(app.activeSessionId).toBeNull();
  });
});

describe('newSession: an empty conversation is reused only by the tab that made it', () => {
  const empty = (id: string) =>
    ({ id, title: 'Nueva conversación', messages: [], docs: [], createdAt: 0, updatedAt: 0 }) as unknown as (typeof app.sessions)[number];

  it('🔴 dev 2026-10-24: an empty conversation another tab made is not joined', async () => {
    // Another tab of the same account made session 9 and has not sent yet.
    // Joining it would put two people's turns into one conversation.
    app.sessions = [empty('9')];

    const id = await app.newSession();

    expect(id).toBe('40');
    expect(creates()).toHaveLength(1);
    expect(app.activeSessionId).toBe('40');
  });

  it('pressing "Nueva conversación" twice in one tab reuses the empty one it made (UX #25)', async () => {
    const first = await app.newSession();
    const second = await app.newSession();

    expect(second).toBe(first);
    expect(creates()).toHaveLength(1);
  });
});

describe('🔴 dev 2026-10-24: a send right after "Nueva conversación" goes to the new one', () => {
  const full = (id: string) =>
    ({
      id,
      title: 'Una conversación vieja',
      messages: [{ id: 'm1', role: 'user', content: 'hola' }],
      docs: [],
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as (typeof app.sessions)[number];

  it('while the create is on the wire, no conversation is open and a send joins the create', async () => {
    // Conversation 172 is open. Two quick sends after "Nueva conversación"
    // used to land in 172, because it stayed open until the create returned.
    app.sessions = [full('172')];
    app.activeSessionId = '172';

    const created = app.newSession();
    // The old conversation is no longer the send target.
    expect(app.active).toBeNull();
    // What `Chat.svelte`'s send (and the mic, and an upload) call.
    const target = await app.ensureSession();

    expect(target).toBe('40');
    expect(await created).toBe('40');
    expect(creates()).toHaveLength(1);
    expect(app.activeSessionId).toBe('40');
  });

  it('a second "Nueva conversación" while the first is on the wire makes no second one', async () => {
    const [a, b] = await Promise.all([app.newSession(), app.newSession()]);

    expect(a).toBe('40');
    expect(b).toBe('40');
    expect(creates()).toHaveLength(1);
  });

  it('a failed create reopens the conversation that was open', async () => {
    app.sessions = [full('172')];
    app.activeSessionId = '172';
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));

    expect(await app.newSession()).toBeNull();
    expect(app.activeSessionId).toBe('172');
  });

  it('a conversation picked while the create is on the wire stays open', async () => {
    app.sessions = [full('172'), full('9')];
    app.activeSessionId = '172';

    const created = app.newSession();
    app.activeSessionId = '9';
    await created;

    expect(app.activeSessionId).toBe('9');
  });
});
