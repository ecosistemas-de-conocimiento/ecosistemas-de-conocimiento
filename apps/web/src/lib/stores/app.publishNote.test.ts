/**
 * 🔴 "Publicar" / "Publicar cambios" on a student's note publishes the text ON
 * SCREEN (re-audit 2026-10-28). Autosave is debounced; a click within its
 * window used to process the older stored body, and "Publicar cambios" then
 * waited for a body that never arrived, its button disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import { toasts } from './toasts.svelte';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  app.sessions = [];
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
});
afterEach(() => vi.unstubAllGlobals());

describe('publishDoc on a note', () => {
  it.each(['draft', 'published'] as const)('%s: saves the on-screen body before asking to publish', async (status) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/publish')) return json({ publicationStatus: status, processing: true, ingestStatus: 'pending' }, 202);
        return json({ ok: true });
      }),
    );
    app.ownedDocs = [
      {
        id: '5',
        title: 'Mi nota',
        body: 'texto nuevo, aún sin autoguardar',
        processedBody: status === 'published' ? 'texto viejo' : null,
        isNote: true,
        kind: 'markdown',
        ingestStatus: status === 'published' ? 'ready' : 'n/a',
        publicationStatus: status,
        includeInContext: true,
        sessionIds: [],
        updatedAt: 0,
      } as never,
    ];

    await app.publishDoc(null, '5', { note: true });

    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual(['PATCH /api/documents/5/note', 'POST /api/documents/5/publish']);
    expect(writes[0]!.body).toEqual({ bodyMarkdown: 'texto nuevo, aún sin autoguardar' });
  });
});

describe('editNote (Mis documentos "Editar")', () => {
  it('puts the text on the row and PATCHes the narrow note route, published note included', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({ ok: true });
      }),
    );
    app.ownedDocs = [
      {
        id: '5',
        title: 'Mi nota',
        body: 'texto viejo',
        processedBody: 'texto viejo',
        isNote: true,
        uploadedByCaller: true,
        kind: 'markdown',
        ingestStatus: 'ready',
        publicationStatus: 'published',
        includeInContext: true,
        sessionIds: [],
        updatedAt: 0,
      } as never,
    ];

    expect(await app.editNote('5', { body: 'texto nuevo' })).toBe(true);

    expect(app.ownedDocs[0]!.body).toBe('texto nuevo');
    expect(calls).toEqual([{ url: '/api/documents/5/note', method: 'PATCH', body: { bodyMarkdown: 'texto nuevo' } }]);
  });
});
