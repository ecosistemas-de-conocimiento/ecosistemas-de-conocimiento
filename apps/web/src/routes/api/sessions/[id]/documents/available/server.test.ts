import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

vi.mock('$lib/server/ecosystem', () => ({
  sessionEcosystemId: vi.fn(),
}));

import { GET } from './+server';
import { backendFetch } from '$lib/server/auth';
import { sessionEcosystemId } from '$lib/server/ecosystem';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: {
  locals?: Partial<Locals>;
  sessionId?: string;
} = {}): Parameters<typeof GET>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 5, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.sessionId ?? '42' },
  } as unknown as Parameters<typeof GET>[0];
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;
const mockedSessionEcosystemId = sessionEcosystemId as unknown as ReturnType<typeof vi.fn>;

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
    isPinned: true,
    session: [id === 9 ? 42 : 7],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The query string of the nth backendFetch call. */
function queryOf(n: number): URLSearchParams {
  const path = mockedBackendFetch.mock.calls[n]![1] as string;
  return new URLSearchParams(path.split('?')[1] ?? '');
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  mockedSessionEcosystemId.mockReset();
  mockedSessionEcosystemId.mockResolvedValue('3');
});

describe('GET …/documents/available — auth', () => {
  it('returns 401 and touches no backend when unauthenticated', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedSessionEcosystemId).not.toHaveBeenCalled();
  });
});

describe('GET …/documents/available — the list', () => {
  it('offers the caller’s own documents in this ecosistema, minus the ones already here', async () => {
    // 1st call: what is already attached to session 42.
    mockedBackendFetch.mockResolvedValueOnce(listResponse([doc(9)]));
    // 2nd call: every document the caller uploaded in this ecosistema.
    mockedBackendFetch.mockResolvedValueOnce(listResponse([doc(9), doc(10), doc(11)]));

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as { docs: { id: number }[] };

    expect(res.status).toBe(200);
    expect(body.docs.map((d) => d.id)).toEqual([10, 11]);
  });

  it('excludes a document whose own `session` list already names this conversation', async () => {
    // The attached read came back short (a stale index, a cap). The row's own
    // list is still the authority, so the document must not be offered twice.
    mockedBackendFetch.mockResolvedValueOnce(listResponse([]));
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([doc(10, { session: [7, 42] }), doc(11)]),
    );

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as { docs: { id: number }[] };

    expect(body.docs.map((d) => d.id)).toEqual([11]);
  });

  it('scopes the read to the caller and to the session’s ecosistema, and accepts neither from the client', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([]));
    mockedBackendFetch.mockResolvedValueOnce(listResponse([doc(10)]));

    await GET(makeEvent({}));

    // 🔴 The ecosistema comes off the SESSION, never off a query string. A
    // client-named org id here would enumerate another tenant's document titles.
    expect(mockedSessionEcosystemId).toHaveBeenCalledWith('tok', '42');
    const q = queryOf(1);
    expect(q.get('where[uploadedBy][equals]')).toBe('5');
    expect(q.get('where[organization][equals]')).toBe('3');
  });

  it('returns a slim row: no `extractedText`, and every field `docFromBackend` reads', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([]));
    mockedBackendFetch.mockResolvedValueOnce(
      listResponse([
        doc(10, {
          kind: 'audio',
          // Hours of transcript. A picker that shows a name and a badge has no
          // business shipping this to the browser.
          extractedText: 'x'.repeat(100000),
          audioMeta: { durationSeconds: 90 },
        }),
      ]),
    );

    const res = await GET(makeEvent({}));
    const body = (await res.json()) as { docs: Record<string, unknown>[] };
    const row = body.docs[0]!;

    expect(row.extractedText).toBeUndefined();
    for (const key of [
      'id',
      'name',
      'kind',
      'ingestStatus',
      'publicationStatus',
      'isPinned',
      'session',
      'updatedAt',
    ]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.audioMeta).toEqual({ durationSeconds: 90 });
  });
});

describe('GET …/documents/available — degradation', () => {
  // The list is defined as "what is NOT already here". Without the exclusion
  // read we cannot compute that, and a picker re-offering documents already in
  // the panel reads as broken.
  it('degrades to an empty list when the attached read fails, and never asks for more', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 403));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ docs: [], degraded: true, reason: 'forbidden' });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('passes a 401 from the attached read through as a real 401', async () => {
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 401));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  // Null means "we could not find out", not "none". Offering documents we
  // cannot place would list rows the backend hook will refuse to attach.
  it('degrades to an empty list when the session’s ecosistema cannot be resolved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedBackendFetch.mockResolvedValueOnce(listResponse([]));
    mockedSessionEcosystemId.mockResolvedValue(null);

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ docs: [], degraded: true });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty list when the second read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedBackendFetch.mockResolvedValueOnce(listResponse([]));
    mockedBackendFetch.mockResolvedValueOnce(listResponse([], 500));

    const res = await GET(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ docs: [], degraded: true, reason: 'unavailable' });
  });
});
