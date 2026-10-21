import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { DELETE, POST } from './+server';
import { backendFetch } from '$lib/server/auth';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: {
  locals?: Partial<Locals>;
  sessionId?: string;
  docId?: string;
  body?: unknown;
}): Parameters<typeof POST>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.sessionId ?? '42', docId: opts.docId ?? '9' },
    request: new Request('http://web.test/x', {
      method: 'POST',
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The document read the handlers do first, with the sessions it is attached to. */
function docRead(sessionIds: unknown, status = 200) {
  mockedBackendFetch.mockResolvedValueOnce(
    jsonResponse({ id: 9, name: 'Acta', session: sessionIds }, status),
  );
}

/** The body of the nth `backendFetch` call, parsed. */
function callBody(n: number): Record<string, unknown> {
  const init = mockedBackendFetch.mock.calls[n]![2] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe('attach/detach — auth', () => {
  it('POST returns 401 and touches no backend when unauthenticated', async () => {
    const res = await POST(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('DELETE returns 401 and touches no backend when unauthenticated', async () => {
    const res = await DELETE(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });
});

// ── Attach ────────────────────────────────────────────────────────────────

describe('POST — attach', () => {
  it('appends this session and keeps every conversation the document was already in', async () => {
    docRead([7, 8]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(200);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    const patch = mockedBackendFetch.mock.calls[1]!;
    expect(patch[1]).toBe('/api/documents/9');
    expect((patch[2] as RequestInit).method).toBe('PATCH');
    // 🔴 The other conversations survive. Sending only the new id here would
    // silently detach the document from everywhere else it lives.
    expect(callBody(1).session).toEqual([7, 8, 42]);
  });

  // A double click, a retried request and a stale picker all mean the same
  // thing. None of them may write, and none of them may fail.
  it('is idempotent: attaching an already-attached document writes nothing', async () => {
    docRead([7, 42]);

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attached: true, changed: false });
    // Only the read. No PATCH.
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('sends numeric ids as numbers (Payload relationship columns are bigint)', async () => {
    docRead([7]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({}));

    expect(callBody(1).session).toEqual([7, 42]);
    for (const id of callBody(1).session as unknown[]) {
      expect(typeof id).toBe('number');
    }
  });

  it('reads a scalar `session` (a row written before the field went plural) as a one-element list', async () => {
    docRead(7);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({}));

    expect(callBody(1).session).toEqual([7, 42]);
  });

  it('reads populated `session` objects (depth>0) without losing them', async () => {
    docRead([{ id: 7 }, { id: 8 }]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({}));

    expect(callBody(1).session).toEqual([7, 8, 42]);
  });

  it('attaches a document that was in no conversation at all', async () => {
    docRead(null);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({}));

    expect(callBody(1).session).toEqual([42]);
  });
});

// ── Detach ────────────────────────────────────────────────────────────────
//
// 🔴 DETACH IS NOT DELETE. These tests exist to hold that line: the document
// row is never touched by `DELETE /api/documents/:id` from this route, and the
// conversations it was in besides this one come back untouched in the PATCH.

describe('DELETE — detach', () => {
  it('removes ONLY this session and leaves the document in its other conversations', async () => {
    docRead([7, 42, 8]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    const res = await DELETE(makeEvent({}));

    expect(res.status).toBe(200);
    // The write is a PATCH on the document, never a DELETE on it.
    const patch = mockedBackendFetch.mock.calls[1]!;
    expect(patch[1]).toBe('/api/documents/9');
    expect((patch[2] as RequestInit).method).toBe('PATCH');
    // 🔴 The other sessions are still in the body. This assertion IS the
    // "detach is not delete" guarantee.
    expect(callBody(1).session).toEqual([7, 8]);
  });

  it('never issues a DELETE against the document itself', async () => {
    docRead([7, 42]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await DELETE(makeEvent({}));

    for (const call of mockedBackendFetch.mock.calls) {
      const method = ((call[2] as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      expect(method).not.toBe('DELETE');
    }
  });

  it('is idempotent: detaching a document that is not attached writes nothing', async () => {
    docRead([7]);

    const res = await DELETE(makeEvent({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attached: false, changed: false });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('detaching the last conversation leaves an empty list, not a deleted row', async () => {
    docRead([42]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await DELETE(makeEvent({}));

    expect(callBody(1).session).toEqual([]);
  });
});

// ── Backend rejections pass through ───────────────────────────────────────
//
// The Payload hook `bindDocumentToEcosystem` is the authority on who may
// attach what: it refuses a session the caller does not own, and refuses
// mixing two ecosistemas onto one document. This route must NOT re-implement
// that check — it must forward the answer, error and all, so there is only one
// place the rule lives.

describe('backend rejections are forwarded, not swallowed', () => {
  it('passes through the hook error when the target session is not the caller’s', async () => {
    docRead([7]);
    const hookError = {
      errors: [{ path: 'session', message: 'That conversation is not yours.' }],
    };
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse(hookError, 400));

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(hookError);
  });

  it('passes through the mixed-ecosistema refusal on attach', async () => {
    docRead([7]);
    const hookError = {
      errors: [
        {
          path: 'session',
          message:
            'These conversations belong to different ecosistemas, so one document cannot be attached to both.',
        },
      ],
    };
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse(hookError, 400));

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(hookError);
  });

  // Payload's `visibleToCaller` returns a WHERE constraint, so somebody else's
  // document is not found rather than forbidden. Forward that verbatim: no
  // write is attempted on a document we could not read.
  it('forwards a 404 from the document read and attempts no write', async () => {
    docRead([7], 404);

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(404);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('forwards a 403 on detach and attempts no write', async () => {
    docRead([7, 42], 403);

    const res = await DELETE(makeEvent({}));

    expect(res.status).toBe(403);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it('passes through a backend rejection of the detach PATCH', async () => {
    docRead([7, 42]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 400));

    const res = await DELETE(makeEvent({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'nope' });
  });
});

// ── No elevated credential ────────────────────────────────────────────────

describe('every call goes out as the caller', () => {
  it('forwards `locals.token` and nothing else to the backend', async () => {
    docRead([7]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({ locals: { token: 'caller-jwt' } }));

    for (const call of mockedBackendFetch.mock.calls) {
      expect(call[0]).toBe('caller-jwt');
    }
  });
});

// ── Bug #37: a conversation that no longer exists ─────────────────────────

describe('POST — the conversation is gone (bug #37)', () => {
  // The body `bindDocumentToEcosystem` returns on dev (measured 2026-10-21)
  // when a tab attaches to a conversation that was deleted elsewhere.
  const noSuchConversation = {
    errors: [
      {
        name: 'ValidationError',
        data: {
          collection: 'documents',
          errors: [{ path: 'session', message: 'No such conversation.' }],
        },
        message: 'The following field is invalid: session',
      },
    ],
  };

  it('answers 404 session_not_found instead of a bare 400', async () => {
    docRead([]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse(noSuchConversation, 400));

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session_not_found' });
  });

  it('still forwards every other 400 verbatim', async () => {
    docRead([7]);
    const other = { errors: [{ path: 'session', message: 'That conversation is not yours.' }] };
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse(other, 400));

    const res = await POST(makeEvent({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(other);
  });
});

describe('POST — pin on attach', () => {
  it('sends isPinned: true with the attach when the body asks for it', async () => {
    docRead([7]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    const res = await POST(makeEvent({ body: { pin: true } }));

    expect(res.status).toBe(200);
    expect(callBody(1)).toEqual({ session: [7, 42], isPinned: true });
  });

  it('does not touch isPinned without the flag', async () => {
    docRead([7]);
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    await POST(makeEvent({}));

    expect(callBody(1)).toEqual({ session: [7, 42] });
  });

  it('pins a document that is already attached but not pinned', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      jsonResponse({ id: 9, session: [42], isPinned: false }, 200),
    );
    mockedBackendFetch.mockResolvedValueOnce(jsonResponse({ doc: { id: 9 } }, 200));

    const res = await POST(makeEvent({ body: { pin: true } }));

    expect(res.status).toBe(200);
    expect(callBody(1)).toEqual({ session: [42], isPinned: true });
  });
});
