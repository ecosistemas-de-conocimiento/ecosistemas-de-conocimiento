/**
 * Generales / Resonancias in the store: "Nueva conversación" creates one of
 * the active tab's kind, and the open conversation always belongs to the tab.
 *
 * ⚠ The fixtures put a conversation of the OTHER kind first in `sessions`, so
 * a regression to `this.sessions[0]` (instead of the tab's list) turns red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import { toasts } from './toasts.svelte';
import type { Session } from '../types';

type Call = { url: string; method: string; body?: BodyInit | null };
let calls: Call[];
/** What `GET /api/sessions` lists (hydration). */
let listRows: Array<Record<string, unknown>>;
/** While set, every create waits for `releaseCreates()`. */
let createGate: Promise<void> | null;
let releaseCreates: () => void;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function holdCreates(): void {
  createGate = new Promise((r) => (releaseCreates = r));
}

const session = (id: string, kind?: Session['kind']): Session => ({
  id,
  title: `c${id}`,
  createdAt: 0,
  updatedAt: 0,
  messages: [{ id: `m${id}`, role: 'user', content: 'x', createdAt: 0 }],
  docs: [],
  ...(kind ? { kind } : {}),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls = [];
  listRows = [];
  createGate = null;
  let next = 40;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      if (method === 'POST' && url === '/api/sessions') {
        if (createGate) await createGate;
        const asked = JSON.parse(String(init?.body ?? '{}')) as { kind?: string };
        return json({ doc: { id: next++, title: 'Nueva conversación', kind: asked.kind } }, 201);
      }
      if (method === 'GET' && url === '/api/sessions') return json({ docs: listRows });
      if (method === 'GET' && url === '/api/ecosistemas') {
        return json({ ecosistemas: [{ id: 1, name: 'Uno', slug: 'uno' }], selectedId: '1' });
      }
      if (method === 'POST' && /^\/api\/sessions\/\d+\/documents\/9$/.test(url)) {
        return json({ error: 'session_not_found' }, 404);
      }
      return json({ docs: [] });
    }),
  );
  app.sessions = [session('1', 'resonancias'), session('2'), session('3', 'generales')];
  app.activeSessionId = null;
  app.sessionKindTab = 'generales';
  app.ecosystems = [{ id: '1', name: 'Uno', slug: 'uno' }] as typeof app.ecosystems;
  app.ecosystemId = '1';
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
});

afterEach(() => vi.unstubAllGlobals());

const createBodies = () =>
  calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions').map((c) => JSON.parse(String(c.body)));

describe('the conversation tabs', () => {
  it('lists only the active tab; a conversation with no kind is Generales', () => {
    expect(app.tabSessions.map((s) => s.id)).toEqual(['2', '3']);
    app.setSessionKindTab('resonancias');
    expect(app.tabSessions.map((s) => s.id)).toEqual(['1']);
  });

  it('switching tabs opens that tab\'s most recent conversation', () => {
    app.activeSessionId = '2';
    app.setSessionKindTab('resonancias');
    expect(app.activeSessionId).toBe('1');
  });

  it('switching to an empty tab opens nothing; the first send creates one of that kind', async () => {
    app.sessions = [session('2')];
    app.activeSessionId = '2';
    app.setSessionKindTab('resonancias');
    expect(app.activeSessionId).toBeNull();

    const id = await app.ensureSession();
    expect(createBodies()).toEqual([{ title: 'Nueva conversación', kind: 'resonancias' }]);
    expect(app.sessions.find((s) => s.id === id)?.kind).toBe('resonancias');
    expect(app.tabSessions.map((s) => s.id)).toEqual([id]);
  });

  it('"Nueva conversación" in Generales creates a Generales one', async () => {
    await app.newSession();
    expect(createBodies()[0]).toMatchObject({ kind: 'generales' });
  });

  it('🔴 an empty conversation made in the other tab is not reused', async () => {
    const g = await app.newSession();
    app.setSessionKindTab('resonancias');
    const r = await app.newSession();
    expect(r).not.toBe(g);
    expect(createBodies().map((b) => b.kind)).toEqual(['generales', 'resonancias']);
  });

  it('opening a conversation from elsewhere shows its tab', async () => {
    await app.selectSession('1');
    expect(app.sessionKindTab).toBe('resonancias');
  });
});

describe('the next conversation comes from the active tab', () => {
  it('🔴 delete: the next one is the same tab\'s, not a hidden one of the other kind', async () => {
    app.activeSessionId = '2';
    await app.deleteSession('2');
    expect(app.activeSessionId).toBe('3');
  });

  it('🔴 a vanished conversation (attach → 404) opens the same tab\'s next one', async () => {
    app.activeSessionId = '2';
    expect(await app.attachDoc('2', '9')).toBe(false);
    expect(app.sessions.map((s) => s.id)).toEqual(['1', '3']);
    expect(app.activeSessionId).toBe('3');
  });

  it('🔴 hydrate opens no conversation: the person writes first (owner ruling 2026-10-28)', async () => {
    listRows = [{ id: 1, kind: 'resonancias' }, { id: 2 }, { id: 3, kind: 'generales' }];
    app.sessionKindTab = 'generales';
    app.activeSessionId = '3';
    await app.hydrateFromServer();
    expect(app.sessions).toHaveLength(3);
    expect(app.activeSessionId).toBeNull();
    expect(app.sessionKindTab).toBe('generales');
  });

  it('🔴 hydrate opens nothing when the remembered tab is empty', async () => {
    listRows = [{ id: 2 }, { id: 3, kind: 'generales' }];
    app.sessionKindTab = 'resonancias';
    await app.hydrateFromServer();
    expect(app.sessions).toHaveLength(2);
    expect(app.activeSessionId).toBeNull();
  });
});

describe('🔴 a create racing a tab switch (audit 2026-10-26)', () => {
  it('the kind is the tab at click time; the result is listed but not opened under the other tab', async () => {
    app.sessions = [];
    holdCreates();
    const pending = app.newSession();
    await tick();
    app.setSessionKindTab('resonancias');
    releaseCreates();
    const id = await pending;

    expect(createBodies().map((b) => b.kind)).toEqual(['generales']);
    expect(app.sessions.find((s) => s.id === id)?.kind).toBe('generales');
    expect(app.activeSessionId).toBeNull();
    expect(app.tabSessions).toHaveLength(0);
  });

  it('a send after the switch does not join the other kind\'s create', async () => {
    app.sessions = [];
    holdCreates();
    const first = app.newSession();
    await tick();
    app.setSessionKindTab('resonancias');
    const send = app.ensureSession();
    releaseCreates();
    const [g, r] = await Promise.all([first, send]);

    expect(r).not.toBe(g);
    expect(createBodies().map((b) => b.kind)).toEqual(['generales', 'resonancias']);
    expect(app.sessions.find((s) => s.id === r)?.kind).toBe('resonancias');
    expect(app.activeSessionId).toBe(r);
  });

  it('a send in the same tab still joins the create on the wire', async () => {
    app.sessions = [];
    holdCreates();
    const first = app.newSession();
    const send = app.ensureSession();
    releaseCreates();
    const [a, b] = await Promise.all([first, send]);
    expect(b).toBe(a);
    expect(createBodies()).toHaveLength(1);
  });
});
