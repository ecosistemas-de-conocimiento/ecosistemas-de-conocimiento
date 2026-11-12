import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { DELETE, GET, POST } from './+server';
import { backendFetch } from '$lib/server/auth';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: {
  locals?: Partial<Locals>;
  request?: Request;
  sessionId?: string;
}): Parameters<typeof POST>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.sessionId ?? '42' },
    request:
      opts.request ??
      new Request('http://web.test/api/sessions/42/ratings', { method: 'GET' }),
  } as unknown as Parameters<typeof POST>[0];
}

function postRequest(body: unknown): Request {
  return new Request('http://web.test/api/sessions/42/ratings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

/**
 * The path each `backendFetch` call was made against, in order, percent-decoded
 * — `URLSearchParams` escapes the `[`/`]` of Payload's `where[...]` syntax.
 */
function calledPaths(): string[] {
  return mockedBackendFetch.mock.calls.map((c) => decodeURIComponent(String(c[1])));
}

/** The parsed JSON body of the nth `backendFetch` call. */
function calledBody(n: number): Record<string, unknown> {
  const init = mockedBackendFetch.mock.calls[n]?.[2] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
});

// ── GET ───────────────────────────────────────────────────────────────────

describe('GET /api/sessions/[id]/ratings', () => {
  it('401s without a session', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('scopes the read to this session AND this user', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ docs: [] }));
    await GET(makeEvent({ sessionId: '42' }));
    const path = calledPaths()[0]!;
    expect(path).toContain('where[and][0][session][equals]=42');
    expect(path).toContain('where[and][1][user][equals]=1');
  });

  it('passes the rating rows through on a healthy read', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ docs: [{ id: 9, message: 7, stars: 4 }] }),
    );
    const res = await GET(makeEvent({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: { stars: number }[] };
    expect(body.docs[0]!.stars).toBe(4);
  });

  it('degrades a 403 (empty tenant) to an empty list, not an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ errors: [] }, 403));
    const res = await GET(makeEvent({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: unknown[]; degraded?: boolean };
    expect(body.docs).toEqual([]);
    expect(body.degraded).toBe(true);
  });
});

// ── POST ──────────────────────────────────────────────────────────────────

describe('POST /api/sessions/[id]/ratings', () => {
  it('401s without a session', async () => {
    const res = await POST(
      makeEvent({ locals: { user: null }, request: postRequest({ messageId: '7', stars: 4 }) }),
    );
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('400s on a body that is not JSON', async () => {
    const res = await POST(makeEvent({ request: postRequest('{nope') }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('400s without a message id', async () => {
    const res = await POST(makeEvent({ request: postRequest({ stars: 4 }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'message_required' });
  });

  it.each([0, 6, 4.5, '4', null])('400s on an off-scale value: %s', async (stars) => {
    const res = await POST(makeEvent({ request: postRequest({ messageId: '7', stars }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_stars' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('upserts in ONE call, after proving the message belongs to the session', async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 })) // message check
      .mockResolvedValueOnce(jsonResponse({ doc: { id: 5, stars: 4 } }, 200)); // upsert

    const res = await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 4 }) }));

    expect(res.status).toBe(200);
    const [messagePath, writePath] = calledPaths();
    expect(messagePath).toBe('/api/messages/7?depth=0');
    // The backend's dedicated upsert route — no look-up-then-PATCH dance, so
    // no race between two clients rating the same message at once.
    expect(writePath).toBe('/api/ratings/upsert');
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    expect(mockedBackendFetch.mock.calls[1]![2]).toMatchObject({ method: 'POST' });
    // Numeric ids go on the wire as numbers — Payload's relationship column is
    // bigint and rejects the string form.
    expect(calledBody(1)).toEqual({ message: 7, session: 42, stars: 4, reason: null, comment: null });
  });

  // 🔴 Fable audit #8 follow-up: at Payload's default depth the upsert reply
  // populates `doc.message`, provenance and all, with raw chunk `sessionId`,
  // `authoredBy` and another conversation's `msg-…` id. The echo collapses
  // the relations to ids; the store never reads the reply body anyway.
  it('🔴 the echo carries no populated message or provenance, only ids', async () => {
    const populated = {
      id: 7,
      role: 'assistant',
      content: 'a',
      session: { id: 42, title: 't' },
      provenance: {
        chunks: [
          {
            chunkId: 'c1',
            documentId: 'u',
            score: 1,
            corpus: 'eco-7',
            metadata: { docId: 'msg-41', authoredBy: 'assistant', sessionId: '77', title: 'Conversación' },
          },
        ],
      },
    };
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(
        jsonResponse({ doc: { id: 5, stars: 4, message: populated, session: { id: 42 } }, message: 'ok' }),
      );

    const res = await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 4 }) }));
    const text = await res.text();
    for (const leaked of ['"authoredBy"', '"sessionId"', 'msg-41', '"provenance"']) {
      expect(text).not.toContain(leaked);
    }
    expect(JSON.parse(text)).toEqual({ doc: { id: 5, stars: 4, message: '7', session: '42' }, message: 'ok' });
  });

  // The backend derives both from the session. A client that can name them can
  // write into another ecosistema.
  it('never sends user or organization', async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(jsonResponse({ doc: { id: 5 } }));
    await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 4 }) }));
    const body = calledBody(1);
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('organization');
  });

  it('ignores a user or organization the client tries to smuggle in', async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(jsonResponse({ doc: { id: 5 } }));
    await POST(
      makeEvent({
        request: postRequest({
          messageId: '7',
          stars: 4,
          user: 999,
          organization: 999,
        }),
      }),
    );
    expect(calledBody(1)).toEqual({ message: 7, session: 42, stars: 4, reason: null, comment: null });
  });

  it('refuses when the message belongs to another session', async () => {
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ id: 7, session: 999 }));

    const res = await POST(
      makeEvent({ sessionId: '42', request: postRequest({ messageId: '7', stars: 4 }) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'message_session_mismatch' });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1); // nothing written
  });

  it('404s when the message is not readable by this user', async () => {
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ errors: [] }, 403));
    const res = await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 4 }) }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'message_not_found' });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('sends the comment, and clears it explicitly when re-rated without one', async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(jsonResponse({ doc: { id: 88 } }));
    await POST(
      makeEvent({
        request: postRequest({
          messageId: '7',
          stars: 5,
          reason: 'other',
          comment: '  útil  ',
        }),
      }),
    );
    expect(calledBody(1)).toMatchObject({ stars: 5, reason: 'other', comment: 'útil' });

    mockedBackendFetch.mockReset();
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(jsonResponse({ doc: { id: 88 } }));
    await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 1 }) }));
    expect(calledBody(1)).toMatchObject({ stars: 1, reason: null, comment: null });
  });

  it('passes an upstream write failure through with its status', async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(jsonResponse({ id: 7, session: 42 }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'nope' }] }, 403));
    const res = await POST(makeEvent({ request: postRequest({ messageId: '7', stars: 3 }) }));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/sessions/[id]/ratings', () => {
  it('401s without a session', async () => {
    const res = await DELETE(
      makeEvent({ locals: { user: null }, request: postRequest({ messageId: '7' }) }),
    );
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('finds MY rating by message, then deletes it by id', async () => {
    // The client never names a rating id — it names a message. That is what
    // stops a guessed id reaching the delete at all.
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      String(path).startsWith('/api/ratings?')
        ? jsonResponse({ docs: [{ id: 99 }] })
        : jsonResponse({}),
    );

    const res = await DELETE(makeEvent({ request: postRequest({ messageId: '7' }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });

    const paths = mockedBackendFetch.mock.calls.map((c) => decodeURIComponent(String(c[1])));
    expect(paths[0]).toContain('where[message][equals]=7');
    expect(paths[1]).toBe('/api/ratings/99');
    expect((mockedBackendFetch.mock.calls[1]?.[2] as RequestInit)?.method).toBe('DELETE');
  });

  it('⚠ already absent is success, not 404', async () => {
    // Two fast clicks on "quitar" should both leave the person with no rating,
    // which is exactly what they asked for.
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ docs: [] }));
    const res = await DELETE(makeEvent({ request: postRequest({ messageId: '7' }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
  });

  it('requires a messageId', async () => {
    const res = await DELETE(makeEvent({ request: postRequest({}) }));
    expect(res.status).toBe(400);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('reports an upstream refusal instead of claiming success', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      String(path).startsWith('/api/ratings?')
        ? jsonResponse({ docs: [{ id: 99 }] })
        : jsonResponse({ errors: [] }, 403),
    );
    const res = await DELETE(makeEvent({ request: postRequest({ messageId: '7' }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('delete_failed');
  });

  it('🔴 an upstream 5xx body never reaches the browser', async () => {
    const ROW_TEXT = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz';
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      String(path).startsWith('/api/ratings?')
        ? jsonResponse({ docs: [{ id: 99 }] })
        : new Response(`Failed query: delete from "ratings"\nparams: ${ROW_TEXT}`, { status: 500 }),
    );
    const res = await DELETE(makeEvent({ request: postRequest({ messageId: '7' }) }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('Lucía');
  });

  it('a Payload refusal keeps its message', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      String(path).startsWith('/api/ratings?')
        ? jsonResponse({ docs: [{ id: 99 }] })
        : jsonResponse({ errors: [{ message: 'You are not allowed to perform this action.' }] }, 403),
    );
    const res = await DELETE(makeEvent({ request: postRequest({ messageId: '7' }) }));
    expect(await res.json()).toEqual({
      error: 'delete_failed',
      detail: 'You are not allowed to perform this action.',
    });
  });
});
