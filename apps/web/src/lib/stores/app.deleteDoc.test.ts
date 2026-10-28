/**
 * "Eliminar" on Mis documentos answered 200 and the row stayed on screen until
 * a reload (dev, 2026-10-28). The cause: a list read already on the wire when
 * the delete was pressed (opening the screen, switching the filter, the
 * re-read after an upload) lands AFTER the optimistic removal and writes the
 * pre-delete rows back. Measured in a browser by slowing `GET /api/documentos`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import { toasts } from './toasts.svelte';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function row(id: number) {
  return { id, name: `doc ${id}`, kind: 'pdf', ingestStatus: 'ready', session: [] };
}

/** A promise we resolve by hand, so a read can be held on the wire. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ⚠ The store is one instance for the whole file and remembers what it deleted,
// so each test uses its own document ids.
beforeEach(() => {
  app.sessions = [];
  app.ownedDocs = [];
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
});

afterEach(() => vi.unstubAllGlobals());

describe('deleteDoc while a list read is in flight', () => {
  it('Mis documentos: the stale read does not bring the deleted row back', async () => {
    const list = deferred<Response>();
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'DELETE' && url === '/api/documents/7') return json({ id: 7 });
        if (url.startsWith('/api/documentos')) {
          reads += 1;
          // The first read answers at once; the second is held on the wire.
          return reads === 1 ? json({ docs: [row(7), row(8)] }) : list.promise;
        }
        return json({});
      }),
    );

    await app.loadOwnedDocs('all');
    expect(app.ownedDocs.map((d) => d.id)).toEqual(['7', '8']);

    const stale = app.loadOwnedDocs('all');
    expect(await app.deleteDoc(null, '7')).toBe(true);
    expect(app.ownedDocs.map((d) => d.id)).toEqual(['8']);

    // The read that left before the delete now lands, still holding row 7.
    list.resolve(json({ docs: [row(7), row(8)] }));
    await stale;

    expect(app.ownedDocs.map((d) => d.id)).toEqual(['8']);
  });

  it('a conversation panel: the stale read does not bring the deleted row back', async () => {
    const list = deferred<Response>();
    const asked = deferred<void>();
    app.sessions = [
      { id: '5', title: 'c', messages: [], docs: [], createdAt: 0, updatedAt: 0 } as unknown as (typeof app.sessions)[number],
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'DELETE' && url === '/api/documents/27') return json({ id: 7 });
        if (url === '/api/sessions/5/documents') {
          asked.resolve();
          return list.promise;
        }
        if (url === '/api/sessions/5/messages') return json({ docs: [] });
        return json({});
      }),
    );
    // `selectSession` reads the documents of a conversation that has none cached.
    const stale = app.selectSession('5');
    await asked.promise;
    expect(await app.deleteDoc('5', '27')).toBe(true);

    list.resolve(json({ docs: [row(27), row(28)] }));
    await stale;

    expect(app.sessions[0]?.docs.map((d) => d.id)).toEqual(['28']);
  });

  it('a refused delete puts the row back, and a later read keeps it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'DELETE') return json({ error: 'forbidden' }, 403);
        if (url.startsWith('/api/documentos')) return json({ docs: [row(37), row(38)] });
        return json({});
      }),
    );
    await app.loadOwnedDocs('all');

    expect(await app.deleteDoc(null, '37')).toBe(false);
    expect(app.ownedDocs.map((d) => d.id)).toEqual(['37', '38']);

    await app.loadOwnedDocs('all');
    expect(app.ownedDocs.map((d) => d.id)).toEqual(['37', '38']);
  });
});
