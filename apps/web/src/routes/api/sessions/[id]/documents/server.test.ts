import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { POST } from './+server';
import { mapUpstreamMediaError } from '$lib/server/documents';
import { backendFetch } from '$lib/server/auth';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: {
  locals?: Partial<Locals>;
  request: Request;
  sessionId?: string;
}): Parameters<typeof POST>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.sessionId ?? '42' },
    request: opts.request,
  } as unknown as Parameters<typeof POST>[0];
}

function multipartRequest(file: File, extra: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request('http://chat.test/api/sessions/42/documents', {
    method: 'POST',
    body: form,
  });
}

function emptyMultipartRequest(): Request {
  // FormData with no `file` field. Build a multipart body by hand so the
  // boundary stays consistent and Request honors the content-type header.
  const boundary = '----vitest-empty';
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="other"\r\n\r\n' +
    'no-file\r\n' +
    `--${boundary}--\r\n`;
  return new Request('http://chat.test/api/sessions/42/documents', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
});

// ── Pure helper ───────────────────────────────────────────────────────────

describe('mapUpstreamMediaError', () => {
  it.each([
    [400, 400, 'media_upload_rejected'],
    [401, 401, 'unauthorized'],
    [403, 403, 'forbidden'],
    [413, 413, 'file_too_large'],
    [415, 415, 'unsupported_media_type'],
  ])('maps upstream %i → %i %s', (upstream, expectedStatus, expectedError) => {
    const mapped = mapUpstreamMediaError(upstream, 'detail text');
    expect(mapped.status).toBe(expectedStatus);
    expect(mapped.body.error).toBe(expectedError);
    expect(mapped.body.detail).toBe('detail text');
  });

  it('masks 5xx as 502 upstream_unavailable with the original status attached', () => {
    const mapped = mapUpstreamMediaError(500, 'oops');
    expect(mapped.status).toBe(502);
    expect(mapped.body.error).toBe('upstream_unavailable');
    expect(mapped.body.upstreamStatus).toBe(500);
  });

  it('truncates detail to 500 chars', () => {
    const big = 'x'.repeat(5000);
    const mapped = mapUpstreamMediaError(413, big);
    expect((mapped.body.detail as string).length).toBe(500);
  });
});

// ── Auth / shape rejections (no upstream call) ────────────────────────────

describe('POST /api/sessions/[id]/documents — early rejections', () => {
  it('returns 401 unauthorized when locals.user is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(
      makeEvent({ locals: { user: null }, request: multipartRequest(file) }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('returns 400 multipart_missing_file when no `file` field present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await POST(makeEvent({ request: emptyMultipartRequest() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'multipart_missing_file' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 unsupported_kind for an unrecognized extension/MIME', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const file = new File(['x'], 'whatever.zip', { type: 'application/zip' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_kind' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Upstream media-upload error mapping ───────────────────────────────────

describe('POST /api/sessions/[id]/documents — upstream media error mapping', () => {
  function withUpstream(status: number, body = 'upstream err') {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(body, { status }));
  }

  it('413 → 413 file_too_large', async () => {
    withUpstream(413, 'too big');
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large', detail: 'too big' });
  });

  it('415 → 415 unsupported_media_type', async () => {
    withUpstream(415);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' });
  });

  it('401 → 401 unauthorized', async () => {
    withUpstream(401);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('403 → 403 forbidden', async () => {
    withUpstream(403);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('400 → 400 media_upload_rejected', async () => {
    withUpstream(400);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'media_upload_rejected' });
  });

  it('500 → 502 upstream_unavailable (with upstreamStatus echoed)', async () => {
    withUpstream(500);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'upstream_unavailable',
      upstreamStatus: 500,
    });
  });

  it('network failure → 502 upstream_unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'upstream_unreachable',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('upstream 200 but missing doc.id → 502 media_id_missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'media_id_missing' });
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe('POST /api/sessions/[id]/documents — success', () => {
  it('uploads + creates documents row with ingestStatus: pending and the returned mediaId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 777 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 12, kind: 'pdf', ingestStatus: 'pending' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const file = new File(['hello'], 'paper.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));

    expect(res.status).toBe(201);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
    const call = mockedBackendFetch.mock.calls[0]!;
    const path = call[1] as string;
    const init = call[2] as RequestInit;
    expect(path).toBe('/api/documents');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      session: 42,
      kind: 'pdf',
      mode: 'rag-retrieve',
      mediaFile: 777,
      isPinned: true,
      ingestStatus: 'pending',
    });
  });
});
