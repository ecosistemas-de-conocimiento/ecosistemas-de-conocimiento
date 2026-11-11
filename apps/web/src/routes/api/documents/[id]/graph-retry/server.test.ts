import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { POST } from './+server';
import { backendFetch } from '$lib/server/auth';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: { locals?: Partial<Locals>; id?: string } = {}): Parameters<
  typeof POST
>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.id ?? '7' },
    request: new Request('http://web.test/api/documents/7/graph-retry', { method: 'POST' }),
  } as unknown as Parameters<typeof POST>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
});

describe('POST /api/documents/[id]/graph-retry', () => {
  it('401s without a session, without asking the backend anything', async () => {
    const res = await POST(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('400s on a blank id (%p)', async (id) => {
    const res = await POST(makeEvent({ id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'document_required' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('calls the graph-retry endpoint with the caller token and no body', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ ok: true }, 202));
    await POST(makeEvent({ id: '7' }));
    const [token, path, init] = mockedBackendFetch.mock.calls[0]!;
    expect(token).toBe('tok');
    expect(path).toBe('/api/documents/7/graph-retry');
    expect(init).toMatchObject({ method: 'POST' });
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('URL-encodes the id so it cannot walk to another endpoint', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ ok: true }, 202));
    await POST(makeEvent({ id: 'a b/../7' }));
    expect(mockedBackendFetch.mock.calls[0]![1]).toBe('/api/documents/a%20b%2F..%2F7/graph-retry');
  });

  it('reports only that the graph is queued, with the upstream 202', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ ok: true, graphStatus: 'ready' }, 202),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, graphStatus: 'pending' });
  });

  it.each([
    [403, 'Only the person who uploaded a document can rebuild its graph.'],
    [409, 'Ya se está construyendo el grafo de este documento.'],
    [404, 'No such document.'],
    [500, 'boom'],
  ])('passes upstream %i through with its body', async (status, message) => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ errors: [{ message }] }, status),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ errors: [{ message }] });
  });

  it('502s when the backend is unreachable, with the error\'s name and code only', async () => {
    mockedBackendFetch.mockImplementation(async () => {
      throw Object.assign(new Error('Failed query: select * from users\nparams: ana@ejemplo.mx'), {
        code: 'ECONNREFUSED',
      });
    });
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unreachable', detail: 'Error(ECONNREFUSED)' });
  });
});
