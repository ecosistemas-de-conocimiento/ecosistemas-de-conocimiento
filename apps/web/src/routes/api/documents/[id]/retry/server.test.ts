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
    request: new Request('http://web.test/api/documents/7/retry', { method: 'POST' }),
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

describe('POST /api/documents/[id]/retry', () => {
  it('401s without a session, without asking the backend anything', async () => {
    const res = await POST(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('400s on a blank id (%p) rather than proxying it', async (id) => {
    const res = await POST(makeEvent({ id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'document_required' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('calls the retry endpoint for that document', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ ok: true }));
    await POST(makeEvent({ id: '7' }));
    const [, path, init] = mockedBackendFetch.mock.calls[0]!;
    expect(path).toBe('/api/documents/7/retry');
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('reports only that the document is queued again', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ doc: { id: 7 } }));
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingestStatus: 'pending' });
  });

  // An id is a path segment. A document id that is not a plain number must not
  // be able to walk out of its own route and hit some other backend endpoint.
  it('URL-encodes the id into the upstream path', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ ok: true }));
    await POST(makeEvent({ id: 'a b/../7' }));
    const path = mockedBackendFetch.mock.calls[0]![1] as string;
    expect(path).toBe('/api/documents/a%20b%2F..%2F7/retry');
  });

  /**
   * ⚠ The browser sends NO body — the id in the URL is the whole request.
   *
   * Whether there is anything to retry, and whether retrying means "re-embed
   * the text we already have" or "transcribe the two-hour recording again", is
   * decided entirely on the backend. A client that could choose would be a
   * client that could burn CPU-hours just by asking for the expensive option.
   */
  it('sends no body at all — the client does not get to define "retry"', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ ok: true }));
    await POST(makeEvent({}));
    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });

  // 403 is "not yours" and 409 is "there is nothing to retry". Collapsing them
  // into one generic failure leaves the UI with nothing useful to say, and a
  // retry button that appears to do nothing is worse than no button.
  it.each([
    [403, 'not yours'],
    [409, 'nothing to retry'],
    [404, 'gone'],
    [500, 'backend on fire'],
  ])('passes upstream %i through with its own status', async (status, message) => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({ errors: [{ message }] }, status),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ errors: [{ message }] });
  });

  // Nothing changed upstream, so the caller should keep rendering the document
  // exactly as it was — including its `failed` badge and its retry button.
  it('502s when the backend is unreachable', async () => {
    mockedBackendFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'upstream_unreachable',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  // 🔴 A retry starts a job that can take hours. Answering anything that reads
  // as "done" would send the user looking for text that does not exist yet.
  it.each([
    ['an accepted retry', () => jsonResponse({ doc: { ingestStatus: 'ready' } })],
    ['an unreadable answer', () => new Response('not json', { status: 200 })],
  ])('never claims a completed state — %s', async (_label, upstream) => {
    mockedBackendFetch.mockImplementation(async () => upstream());
    const res = await POST(makeEvent({}));
    expect(await res.text()).not.toContain('ready');
  });
});
