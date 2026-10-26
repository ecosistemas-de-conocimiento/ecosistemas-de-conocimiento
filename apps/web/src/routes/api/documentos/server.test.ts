import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

vi.mock('$lib/server/ecosystem', () => ({
  resolveEcosystem: vi.fn(),
}));

import { GET } from './+server';
import { backendFetch } from '$lib/server/auth';
import { resolveEcosystem } from '$lib/server/ecosystem';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: {
  locals?: Partial<Locals>;
  url?: string;
} = {}): Parameters<typeof GET>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 5, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    // `resolveEcosystem` is mocked, so nothing ever reads these.
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    url: new URL(opts.url ?? 'http://app.test/api/documentos'),
  } as unknown as Parameters<typeof GET>[0];
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;
const mockedResolveEcosystem = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;

function listResponse(docs: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ docs, totalDocs: docs.length }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function doc(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Doc ${id}`,
    kind: 'pdf',
    ingestStatus: 'ready',
    publicationStatus: 'draft',
    isPinned: false,
    session: [{ id: 7, title: 'Riego' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The path of the nth backendFetch call. */
function pathOf(n: number): string {
  return mockedBackendFetch.mock.calls[n]![1] as string;
}

/** The query string of the nth backendFetch call. */
function queryOf(n: number): URLSearchParams {
  return new URLSearchParams(pathOf(n).split('?')[1] ?? '');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockedBackendFetch.mockReset();
  mockedResolveEcosystem.mockReset();
  mockedResolveEcosystem.mockResolvedValue({
    list: [{ id: '3', name: 'Milpa' }],
    selected: { id: '3', name: 'Milpa' },
    source: 'cookie',
    ok: true,
  });
});

describe('GET /api/documentos — auth', () => {
  it('returns 401 and touches nothing when unauthenticated', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedResolveEcosystem).not.toHaveBeenCalled();
  });
});

describe('GET /api/documentos — scoping', () => {
  it('takes the ecosistema from the resolved cookie and never from the query string', async () => {
    // 🔴 Every spelling of "give me another tenant's documents" at once. The
    // resolved ecosistema is 3; nothing the caller typed may reach the backend.
    mockedBackendFetch.mockResolvedValueOnce(listResponse([doc(10)]));

    await GET(
      makeEvent({
        url:
          'http://app.test/api/documentos?organization=999&organizationId=999&eco=999' +
          '&where[organization][equals]=999',
      }),
    );

    const q = queryOf(0);
    expect(q.get('where[organization][equals]')).toBe('3');
    // Both constraints are pinned here, never delegated to Payload's access rules.
    expect(q.get('where[uploadedBy][equals]')).toBe('5');
    expect(pathOf(0)).not.toContain('999');
  });

  it('reads with depth=1 so the conversation titles come back', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([doc(10)]));

    await GET(makeEvent({}));

    expect(queryOf(0).get('depth')).toBe('1');
  });
});

describe('GET /api/documentos — the list', () => {
  /** One document per shape `documents.session` is known to arrive in. */
  function mixed() {
    return [
      doc(1, { session: [] }),
      doc(2, { session: [{ id: 7, title: 'Riego' }] }),
      doc(3, { session: null }),
      doc(4, { session: 7 }), // a legacy row, written before the field went plural
      doc(5, {
        session: [
          { id: 8, title: 'Milpa' },
          { id: 9, title: 'Semillas' },
        ],
      }),
    ];
  }

  it('returns every document by default', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse(mixed()));

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as { docs: { id: number }[]; totalDocs: number };

    expect(res.status).toBe(200);
    expect(body.docs.map((d) => d.id)).toEqual([1, 2, 3, 4, 5]);
    expect(body.totalDocs).toBe(5);
  });

  it('returns every document for `?filter=all`', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse(mixed()));

    const res = await GET(makeEvent({ url: 'http://app.test/api/documentos?filter=all' }));
    const body = (await res.json()) as { docs: { id: number }[] };

    expect(body.docs.map((d) => d.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns only the documents attached to no conversation for `?filter=sueltos`', async () => {
    // The empty array and the null are loose. A populated row, a bare scalar id
    // and a two-conversation row are all attached to something.
    mockedBackendFetch.mockResolvedValueOnce(listResponse(mixed()));

    const res = await GET(makeEvent({ url: 'http://app.test/api/documentos?filter=sueltos' }));
    const body = (await res.json()) as { docs: { id: number }[]; totalDocs: number; filter: string };

    expect(body.docs.map((d) => d.id)).toEqual([1, 3]);
    expect(body.totalDocs).toBe(2);
    expect(body.filter).toBe('sueltos');
  });

  it('names the conversations a document is used in as `[{id, title}]`, ids stringified', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([
        doc(5, {
          session: [
            { id: 8, title: 'Milpa' },
            { id: 9, title: 'Semillas' },
          ],
        }),
      ]),
    );

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as { docs: { session: unknown }[] };

    expect(body.docs[0]!.session).toEqual([
      { id: '8', title: 'Milpa' },
      { id: '9', title: 'Semillas' },
    ]);
  });

  it('never returns `extractedText`, anywhere in the body', async () => {
    // ⚠ For an audio document that field is the whole transcript, and this list
    // can hold every recording a person ever made.
    const transcript = 'la milpa se sembró en mayo '.repeat(2000);
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([
        doc(10, {
          kind: 'audio',
          extractedText: transcript,
          embeddingVector: [0.1, 0.2, 0.3],
          audioMeta: { durationSeconds: 90 },
        }),
      ]),
    );

    const res = await GET(makeEvent({}));
    const text = await res.text();
    const body = JSON.parse(text) as { docs: Record<string, unknown>[] };

    expect(body.docs[0]!.extractedText).toBeUndefined();
    expect(text).not.toContain('extractedText');
    expect(text).not.toContain('la milpa se sembró en mayo');
    // The allow-list is not a delete-list: an unexpected field stays behind too.
    expect(body.docs[0]!.embeddingVector).toBeUndefined();
    // …and the fields the view does need survive.
    expect(body.docs[0]!.audioMeta).toEqual({ durationSeconds: 90 });
    expect(body.docs[0]!.name).toBe('Doc 10');
  });

  // Drives the graph badge and the "Reconstruir grafo" button. The backend's
  // graph-retry lets only the uploader in, so the row says whether that is us
  // — as a boolean, without sending the uploader object itself.
  it('sends graphStatus, graphError and uploadedByCaller, not the uploader', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([
        doc(11, {
          graphStatus: 'failed',
          graphError: 'timeout',
          uploadedBy: { id: 5, email: 'u@test' },
        }),
        doc(12, { graphStatus: 'ready', uploadedBy: 99 }),
      ]),
    );

    const res = await GET(makeEvent({}));
    const text = await res.text();
    const body = JSON.parse(text) as { docs: Record<string, unknown>[] };

    expect(body.docs[0]).toMatchObject({
      graphStatus: 'failed',
      graphError: 'timeout',
      uploadedByCaller: true,
    });
    expect(body.docs[1]).toMatchObject({ graphStatus: 'ready', uploadedByCaller: false });
    expect(body.docs[0]!.uploadedBy).toBeUndefined();
    expect(text).not.toContain('u@test');
  });

  it('sends contentKind and testimonioTitle, so Mis documentos shows the generated title', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([doc(11, { contentKind: 'testimonio', testimonioTitle: 'Rampas que nadie mantiene' })]),
    );
    const body = (await (await GET(makeEvent({}))).json()) as { docs: Record<string, unknown>[] };
    expect(body.docs[0]).toMatchObject({ contentKind: 'testimonio', testimonioTitle: 'Rampas que nadie mantiene' });
  });
});

describe('GET /api/documentos — degradation', () => {
  it('passes a backend 401 through as a real 401', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 401));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('degrades a backend 403 to an empty list with reason `forbidden`', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 403));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      docs: [],
      totalDocs: 0,
      degraded: true,
      reason: 'forbidden',
    });
  });

  it('degrades a backend 500 to an empty list with reason `unavailable`', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 500));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      docs: [],
      totalDocs: 0,
      degraded: true,
      reason: 'unavailable',
    });
  });

  // "We could not find out", not "you have none". Listing nothing without the
  // flag would tell someone their documents are gone because a backend blinked.
  it('degrades and reads no documents when the ecosistema cannot be resolved', async () => {
    mockedResolveEcosystem.mockResolvedValue({
      list: [],
      selected: null,
      source: 'none',
      ok: false,
    });

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      docs: [],
      totalDocs: 0,
      degraded: true,
      reason: 'unavailable',
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('returns an undegraded empty list when the caller belongs to no ecosistema', async () => {
    // Genuinely no membership: an empty list is the true answer, and the view's
    // own empty state explains it. No banner.
    mockedResolveEcosystem.mockResolvedValue({
      list: [],
      selected: null,
      source: 'none',
      ok: true,
    });

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ docs: [], totalDocs: 0 });
    expect(body.degraded).toBeUndefined();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });
});
