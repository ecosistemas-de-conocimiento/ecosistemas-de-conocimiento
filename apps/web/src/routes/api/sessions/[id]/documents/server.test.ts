import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

// The audio switch ships OFF (backlog #8). The audio tests below describe the
// route with it ON, so they keep guarding that path for the day it returns;
// the "switch off" block flips it back and checks the refusal.
const audioSwitch = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/uploadKind', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/uploadKind')>()),
  get AUDIO_UPLOAD_ENABLED() {
    return audioSwitch.on;
  },
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

/** First bytes that match the name's kind: the route sniffs them. */
function bytesFor(name: string): BlobPart {
  if (/\.pdf$/i.test(name)) return '%PDF-1.7';
  if (/\.docx$/i.test(name)) return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  if (/\.mp3$/i.test(name)) return 'ID3\x04\x00';
  if (/\.(m4a|mp4|mov)$/i.test(name)) return '\x00\x00\x00\x20ftypM4A ';
  return 'x';
}

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
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
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
    const file = new File([bytesFor('whatever.zip')], 'whatever.zip', { type: 'application/zip' });
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
    const file = new File(['%PDF-1.7'], 'big.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large', detail: 'too big' });
  });

  it('415 → 415 unsupported_media_type', async () => {
    withUpstream(415);
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' });
  });

  it('401 → 401 unauthorized', async () => {
    withUpstream(401);
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('403 → 403 forbidden', async () => {
    withUpstream(403);
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('400 → 400 media_upload_rejected', async () => {
    withUpstream(400);
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'media_upload_rejected' });
  });

  it('500 → 502 upstream_unavailable (with upstreamStatus echoed)', async () => {
    withUpstream(500);
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'upstream_unavailable',
      upstreamStatus: 500,
    });
  });

  it('network failure → 502 upstream_unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
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
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
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

    const file = new File(['%PDF-1.7 hello'], 'paper.pdf', { type: 'application/pdf' });
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
      // ⚠ An ARRAY. `documents.session` is `hasMany`: one document can hang off
      // several conversations. Creating one attaches it to exactly one, but the
      // wire shape is the list — a scalar here would be rejected or, worse,
      // silently coerced.
      session: [42],
      kind: 'pdf',
      mode: 'rag-retrieve',
      mediaFile: 777,
      isPinned: true,
      ingestStatus: 'pending',
    });
  });
});

// ── Audio uploads ─────────────────────────────────────────────────────────
//
// Audio takes the SAME path as a PDF on purpose — same media upload, same
// `documents` row, same webhook. The only thing this proxy decides is the
// `kind`, and getting that wrong is expensive in one direction: a document
// mislabelled as audio is handed to a transcriber that will spend CPU-hours
// discovering it has no audio track.

describe('POST /api/sessions/[id]/documents — audio', () => {
  /**
   * A multipart request whose `file` reports an arbitrary size.
   *
   * The size gate has to be exercised without allocating 200 MB, and a real
   * `Request` round-trip re-reads the body and recomputes `size`, discarding a
   * stubbed one. So hand the handler the parsed FormData directly.
   */
  function sizedMultipartRequest(file: File, size: number): Request {
    Object.defineProperty(file, 'size', { value: size, configurable: true });
    const form = new FormData();
    form.append('file', file, file.name);
    return {
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=vitest' }),
      formData: async () => form,
    } as unknown as Request;
  }

  function upstreamAccepts(mediaId = 777) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: mediaId } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 1 } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    return fetchSpy;
  }

  function createdBody(): Record<string, unknown> {
    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  // 🔴 The Safari / Android case. A phone hands us an `.m4a` with an empty MIME
  // type; rejecting it as `unsupported_kind` would break the single most likely
  // way a user records a junta.
  it('creates an .m4a with an empty MIME type as kind: audio', async () => {
    upstreamAccepts();
    const file = new File([bytesFor('junta.m4a')], 'junta.m4a', { type: '' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));

    expect(res.status).toBe(201);
    expect(createdBody()).toMatchObject({
      kind: 'audio',
      mode: 'rag-retrieve',
      ingestStatus: 'pending',
    });
  });

  it('creates an audio/mpeg file as kind: audio', async () => {
    upstreamAccepts();
    const file = new File([bytesFor('entrevista.mp3')], 'entrevista.mp3', { type: 'audio/mpeg' });
    const res = await POST(makeEvent({ request: multipartRequest(file) }));

    expect(res.status).toBe(201);
    expect(createdBody()).toMatchObject({ kind: 'audio' });
  });

  // ⚠ ORDERING. `isAudioUpload`'s extension fallback is deliberately generous,
  // so the document branches must be checked first. If this flips, a PDF with an
  // odd MIME type goes to the transcriber and costs CPU-hours to bounce.
  it.each([
    ['paper.pdf', 'application/pdf', 'pdf'],
    ['paper.pdf', '', 'pdf'],
    [
      'acta.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    ],
    ['acta.docx', '', 'docx'],
  ])('keeps %s (%p) as kind: %s — the audio branch must not capture it', async (
    name,
    type,
    kind,
  ) => {
    upstreamAccepts();
    const res = await POST(
      makeEvent({ request: multipartRequest(new File([bytesFor(name)], name, { type })) }),
    );
    expect(res.status).toBe(201);
    expect(createdBody()).toMatchObject({ kind });
  });

  // The browser checks the size too, but the browser is not a security
  // boundary: a body accepted here lands on the backend's disk before anything
  // else can refuse it. So the refusal must happen before the upload starts.
  it('rejects an oversize recording with 413 before touching the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const file = new File([bytesFor('maraton.mp3')], 'maraton.mp3', { type: 'audio/mpeg' });
    const res = await POST(
      makeEvent({ request: sizedMultipartRequest(file, 201 * 1024 * 1024) }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large', kind: 'audio' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  // The audio cap is a bigger cap, not a global one. A 25 MB PDF is still
  // refused, and the same 25 MB as audio is fine — that asymmetry IS the change.
  it('still refuses a 25 MB pdf at the document cap', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const file = new File(['%PDF-1.7'], 'escaneo.pdf', { type: 'application/pdf' });
    const res = await POST(
      makeEvent({ request: sizedMultipartRequest(file, 25 * 1024 * 1024) }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large', kind: 'pdf' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a 25 MB mp3, which the old cap would have refused', async () => {
    upstreamAccepts();
    const file = new File([bytesFor('junta.mp3')], 'junta.mp3', { type: 'audio/mpeg' });
    const res = await POST(
      makeEvent({ request: sizedMultipartRequest(file, 25 * 1024 * 1024) }),
    );

    expect(res.status).toBe(201);
    expect(createdBody()).toMatchObject({ kind: 'audio' });
  });

  // 🔴 TENANCY. The corpus and the owning ecosistema are derived server-side
  // from the session. A client that could name one could file a recording into
  // somebody else's ecosistema — and a transcript is the kind of document
  // people would least like to misplace.
  it('never names a corpus or an organization in the row it creates', async () => {
    upstreamAccepts();
    const file = new File([bytesFor('junta.m4a')], 'junta.m4a', { type: 'audio/mp4' });
    await POST(makeEvent({ request: multipartRequest(file) }));

    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit;
    const raw = init.body as string;
    expect(raw).not.toMatch(/corpus/i);
    expect(raw).not.toMatch(/organi[sz]ation/i);
    expect(raw).not.toMatch(/organizaci/i);
  });
});

// ── The `hasMany` session contract ────────────────────────────────────────
//
// 🔴 `documents.session` is a LIST on the backend, so one document can be
// attached to several conversations at once — that is what makes "usar un
// documento de otra conversación" possible without copying or moving the row.
// Both create paths must send the list shape, not the scalar the field used to
// be. See `documents/[docId]` for how the list grows and shrinks afterwards.

// 🔴 Backlog #8: with the switch off, the SERVER refuses audio, so a direct
// POST cannot get a recording past the hidden file picker.
describe('POST /api/sessions/[id]/documents — audio switch off', () => {
  beforeEach(() => {
    audioSwitch.on = false;
    return () => {
      audioSwitch.on = true;
    };
  });

  it.each([
    ['junta.m4a', ''],
    ['entrevista.mp3', 'audio/mpeg'],
    ['grabacion.mp4', 'video/mp4'],
  ])('refuses %s (%p) with 400 before the file goes up', async (name, type) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await POST(
      makeEvent({ request: multipartRequest(new File([bytesFor(name)], name, { type })) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_kind' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('still accepts a PDF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 9 } }), { status: 200 }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 1 } }), { status: 201 }),
    );
    const res = await POST(
      makeEvent({ request: multipartRequest(new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })) }),
    );
    expect(res.status).toBe(201);
  });

  // Payload validation text is English; the browser only ever gets a code.
  it('never passes a backend validation message through', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 9 } }), { status: 200 }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'That conversation belongs to…' }] }), {
        status: 400,
      }),
    );
    const res = await POST(
      makeEvent({ request: multipartRequest(new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'document_create_failed' });
  });
});

describe('POST /api/sessions/[id]/documents — session is an array', () => {
  it('sends session as a one-element array on the markdown/JSON path', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 3, kind: 'markdown' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const request = new Request('http://chat.test/api/sessions/42/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nota', bodyMarkdown: '# hola' }),
    });
    const res = await POST(makeEvent({ request }));

    expect(res.status).toBe(201);
    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit;
    const body = JSON.parse(init.body as string) as { session: unknown };
    expect(body.session).toEqual([42]);
  });

  it('coerces a non-numeric session id without wrapping it twice', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 3 } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const request = new Request('http://chat.test/api/sessions/abc/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nota' }),
    });
    await POST(makeEvent({ request, sessionId: 'abc-123' }));

    const init = mockedBackendFetch.mock.calls[0]![2] as RequestInit;
    const body = JSON.parse(init.body as string) as { session: unknown };
    expect(body.session).toEqual(['abc-123']);
  });
});

// ── Content kind — documento or Voz ───────────────────────────────────────
//
// 🔴 Audit 2026-10-17: this route never sent `contentKind`, so every upload from
// the UI landed as a `documento` and the anonymisation gate never ran on one.

describe('POST /api/sessions/[id]/documents — contentKind', () => {
  const mediaOk = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ doc: { id: 777 } }), { status: 200 }),
    );
  const created = () => new Response(JSON.stringify({ doc: { id: 12 } }), { status: 201 });
  const identity = (permissions: string[]) =>
    new Response(
      JSON.stringify({ principal: { isPlatformAdmin: false, projects: { eco: { permissions } } } }),
      { status: 200 },
    );
  const audio = () => new File([bytesFor('voz.m4a')], 'voz.m4a', { type: 'audio/mp4' });
  const createBody = () => {
    const call = mockedBackendFetch.mock.calls.find((c) => c[1] === '/api/documents')!;
    return JSON.parse((call[2] as RequestInit).body as string);
  };

  it('sends documento when the form names none', async () => {
    mediaOk();
    mockedBackendFetch.mockResolvedValueOnce(created());
    const res = await POST(makeEvent({ request: multipartRequest(audio()) }));
    expect(res.status).toBe(201);
    expect(createBody().contentKind).toBe('documento');
  });

  it('🔴 passes a testimonio through for someone holding voces:upload', async () => {
    mediaOk();
    mockedBackendFetch
      .mockResolvedValueOnce(identity(['voces:upload']))
      .mockResolvedValueOnce(created());
    const res = await POST(
      makeEvent({ request: multipartRequest(audio(), { contentKind: 'testimonio' }) }),
    );
    expect(res.status).toBe(201);
    expect(createBody()).toMatchObject({ kind: 'audio', contentKind: 'testimonio' });
  });

  it('🔴 refuses a testimonio from someone without voces:upload, before the file goes up', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockedBackendFetch.mockResolvedValueOnce(identity(['documents:write']));
    const res = await POST(
      makeEvent({ request: multipartRequest(audio(), { contentKind: 'testimonio' }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'voces_upload_forbidden' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the identity read fails', async () => {
    mockedBackendFetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const res = await POST(
      makeEvent({ request: multipartRequest(audio(), { contentKind: 'testimonio' }) }),
    );
    expect(res.status).toBe(403);
  });

  it.each(['conversacion', 'TESTIMONIO', 'otro'])('refuses contentKind=%s with 400', async (kind) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await POST(makeEvent({ request: multipartRequest(audio(), { contentKind: kind }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_content_kind' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/[id]/documents — uploadedByCaller', () => {
  it('marks the caller’s own rows, so the panel offers the note editor on them only', async () => {
    const { GET } = await import('./+server');
    vi.mocked(backendFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ docs: [{ id: 5, uploadedBy: 1 }, { id: 6, uploadedBy: { id: 2 } }] }), { status: 200 }),
    );
    const res = await GET(makeEvent({ request: new Request('http://chat.test/api/sessions/42/documents') }) as never);
    const body = (await res.json()) as { docs: Array<{ id: number; uploadedByCaller: boolean }> };
    expect(body.docs.map((d) => [d.id, d.uploadedByCaller])).toEqual([
      [5, true],
      [6, false],
    ]);
  });
});
