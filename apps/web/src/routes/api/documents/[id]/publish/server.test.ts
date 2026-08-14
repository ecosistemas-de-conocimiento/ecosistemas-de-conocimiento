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
    request: new Request('http://web.test/api/documents/7/publish', { method: 'POST' }),
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

describe('POST /api/documents/[id]/publish', () => {
  it('401s without a session', async () => {
    const res = await POST(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('calls the publish endpoint for that document', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ doc: { publicationStatus: 'publishing' } }),
    );
    await POST(makeEvent({ id: '7' }));
    const [, path, init] = mockedBackendFetch.mock.calls[0]!;
    expect(path).toBe('/api/documents/7/publish');
    expect(init).toMatchObject({ method: 'POST' });
  });

  // The org and the owner come from the session upstream. A client that could
  // name an ecosistema could publish into someone else's.
  it('sends no body at all — no org, no user, no target visibility', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ doc: { publicationStatus: 'publishing' } }),
    );
    await POST(makeEvent({}));
    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });

  it('reports the status the backend returned', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ doc: { publicationStatus: 'publishing' } }),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicationStatus: 'publishing', publicationError: null });
  });

  it('accepts a flat document as well as a Payload `{ doc }` wrapper', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ publicationStatus: 'publishing' }),
    );
    const res = await POST(makeEvent({}));
    expect(await res.json()).toEqual({ publicationStatus: 'publishing', publicationError: null });
  });

  it('passes a failure reason through when the backend sends one', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ doc: { publicationStatus: 'failed', publicationError: 'embedding timeout' } }),
    );
    const res = await POST(makeEvent({}));
    expect(await res.json()).toEqual({
      publicationStatus: 'failed',
      publicationError: 'embedding timeout',
    });
  });

  // Never invent `publishing`: an unreadable answer must not paint a state the
  // server did not confirm, and `draft` is the private (safe) reading.
  it('falls back to draft when the backend answer is unreadable', async () => {
    mockedBackendFetch.mockImplementation(
      async () => new Response('not json', { status: 200 }),
    );
    const res = await POST(makeEvent({}));
    expect(await res.json()).toEqual({ publicationStatus: 'draft', publicationError: null });
  });

  it('passes an upstream refusal through with its status', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ errors: [{ message: 'not yours' }] }, 403),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(403);
  });

  it('502s when the backend is unreachable, without inventing a status', async () => {
    mockedBackendFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; publicationStatus?: string };
    expect(body.error).toBe('upstream_unreachable');
    expect(body.publicationStatus).toBeUndefined();
  });
});
