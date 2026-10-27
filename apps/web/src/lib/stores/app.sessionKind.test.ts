/**
 * Generales / Resonancias in the store: "Nueva conversación" creates one of
 * the active tab's kind, and the open conversation always belongs to the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import type { Session } from '../types';

type Call = { url: string; method: string; body?: BodyInit | null };
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

beforeEach(() => {
  calls = [];
  let next = 40;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      if (method === 'POST' && url === '/api/sessions') {
        const asked = JSON.parse(String(init?.body ?? '{}')) as { kind?: string };
        return json({ doc: { id: next++, title: 'Nueva conversación', kind: asked.kind } }, 201);
      }
      return json({ docs: [] });
    }),
  );
  app.sessions = [session('1', 'resonancias'), session('2'), session('3', 'generales')];
  app.activeSessionId = null;
  app.sessionKindTab = 'generales';
  app.ecosystems = [{ id: '1', name: 'Uno', slug: 'uno' }] as typeof app.ecosystems;
  app.ecosystemId = '1';
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
