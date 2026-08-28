import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { PATCH } from './+server';
import { backendFetch } from '$lib/server/auth';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

type Locals = { user: { id: number } | null; token: string | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeEvent(
  opts: { locals?: Partial<Locals>; id?: string; body?: unknown } = {},
): Parameters<typeof PATCH>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1 } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.id ?? '7' },
    request: new Request('http://web.test/api/documents/7/transcript', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body ?? { transcript: 'texto corregido' }),
    }),
  } as unknown as Parameters<typeof PATCH>[0];
}

/** A draft audio document, owned by user 1, at rest. The editable case. */
const EDITABLE = {
  kind: 'audio',
  publicationStatus: 'draft',
  ingestStatus: 'ready',
  uploadedBy: 1,
};

/** GET returns `row`; the following PATCH succeeds. */
function stack(row: Record<string, unknown>) {
  mockedBackendFetch.mockImplementation(async (_t: unknown, _p: string, init?: RequestInit) =>
    init?.method === 'PATCH' ? jsonResponse({ doc: { id: 7 } }) : jsonResponse(row),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
});

describe('PATCH /api/documents/[id]/transcript', () => {
  it('401s without a session, without asking the backend anything', async () => {
    const res = await PATCH(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('400s on a blank id (%p)', async (id) => {
    expect((await PATCH(makeEvent({ id }))).status).toBe(400);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  // ⚠ Saving an empty transcript would embed an empty document: retrieval finds
  // nothing, the row still says `listo`, and the recording silently disappears
  // from every answer with nothing looking broken.
  it.each(['', '   ', undefined, 42])('refuses an empty transcript (%p)', async (transcript) => {
    const res = await PATCH(makeEvent({ body: { transcript } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'transcript_empty' });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  // ── The gate ─────────────────────────────────────────────────────────────

  it('accepts a draft audio document owned by the caller', async () => {
    stack(EDITABLE);
    const res = await PATCH(makeEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ingestStatus: 'pending',
      transcript: 'texto corregido',
    });
  });

  // 🔴 THE WINDOW IS THE DRAFT. Once published, other people may have read or
  // cited it, and changing text under a citation is worse than the typo.
  it.each(['published', 'publishing', 'unpublishing', 'failed'])(
    'refuses to edit a %s document',
    async (publicationStatus) => {
      stack({ ...EDITABLE, publicationStatus });
      const res = await PATCH(makeEvent());
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('already_published');
    },
  );

  /**
   * 🔴 A WRITE GATE FAILS CLOSED, AND THIS IS THE TEST THAT SAYS SO.
   *
   * `parsePublicationStatus` reads anything it does not recognise as `draft` —
   * the right direction for a badge, where under-claiming visibility is
   * harmless, and the wrong one here. `unpublishing` is a real backend value
   * this app's own union does not list, and it is exactly the shape of thing
   * that would have slipped through.
   */
  it.each([undefined, null, '', 'unpublishing', 'algo-nuevo'])(
    'refuses a publication status it does not recognise (%p)',
    async (publicationStatus) => {
      stack({ ...EDITABLE, publicationStatus });
      expect((await PATCH(makeEvent())).status).toBe(409);
    },
  );

  it('refuses a document that is not a transcript', async () => {
    for (const kind of ['pdf', 'docx', 'markdown']) {
      stack({ ...EDITABLE, kind });
      const res = await PATCH(makeEvent());
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('not_a_transcript');
    }
  });

  // ⚠ Belt to the backend's braces: `documents.update` access is already
  // `uploadedBy`-scoped. This turns "not yours" into a clean 403.
  it('refuses someone who is not the uploader', async () => {
    stack({ ...EDITABLE, uploadedBy: 99 });
    const res = await PATCH(makeEvent());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_uploader');
  });

  // Two writers on one column is not a race worth having.
  it.each(['pending', 'extracting', 'transcribing', 'embedding', 'n/a'])(
    'refuses while the pipeline is at %s',
    async (ingestStatus) => {
      stack({ ...EDITABLE, ingestStatus });
      const res = await PATCH(makeEvent());
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('ingest_in_progress');
    },
  );

  it.each(['ready', 'transcribed', 'failed'])('allows an edit at %s', async (ingestStatus) => {
    stack({ ...EDITABLE, ingestStatus });
    expect((await PATCH(makeEvent())).status).toBe(200);
  });

  it('404s a document the caller may not see, without leaking that it exists', async () => {
    for (const status of [403, 404]) {
      mockedBackendFetch.mockResolvedValue(jsonResponse({}, status));
      const res = await PATCH(makeEvent());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  // ── The write ────────────────────────────────────────────────────────────

  /**
   * 🔴 THE RE-INGEST, AND WHY IT IS EXACTLY THESE THREE FIELDS.
   *
   *   `extractedText` — the correction. Present, so the backend's extractor is
   *                     skipped and Whisper is NOT re-run over the recording.
   *   `ingestId: null` — opens the "already enqueued" guard so the existing
   *                     `enqueueIngestForDoc` runs again.
   *   `ingestStatus`  — back to `pending`, which is what the row honestly is.
   *
   * Same three fields the backend's own `planIngestRetry` writes. If this test
   * has to change, the pipeline contract changed.
   */
  it('re-ingests through the existing pipeline rather than a second path', async () => {
    stack(EDITABLE);
    await PATCH(makeEvent());
    const patchCall = mockedBackendFetch.mock.calls.find(
      (c) => (c[2] as RequestInit | undefined)?.method === 'PATCH',
    )!;
    expect(patchCall[1]).toBe('/api/documents/7');
    expect(JSON.parse((patchCall[2] as RequestInit).body as string)).toEqual({
      extractedText: 'texto corregido',
      ingestId: null,
      ingestStatus: 'pending',
      ingestError: null,
    });
  });

  it('never sends the transcript before it has checked the gate', async () => {
    stack({ ...EDITABLE, publicationStatus: 'published' });
    await PATCH(makeEvent());
    expect(
      mockedBackendFetch.mock.calls.some((c) => (c[2] as RequestInit | undefined)?.method === 'PATCH'),
    ).toBe(false);
  });

  it('URL-encodes the id into both upstream paths', async () => {
    stack(EDITABLE);
    await PATCH(makeEvent({ id: 'a b/../7' }));
    for (const call of mockedBackendFetch.mock.calls) {
      expect(call[1] as string).toContain('a%20b%2F..%2F7');
    }
  });

  it('refuses an absurdly long transcript rather than storing it', async () => {
    const res = await PATCH(makeEvent({ body: { transcript: 'a'.repeat(1_000_001) } }));
    expect(res.status).toBe(413);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('400s on a body that is not JSON', async () => {
    const event = {
      locals: { user: { id: 1 }, token: 'tok' },
      params: { id: '7' },
      request: new Request('http://web.test/api/documents/7/transcript', {
        method: 'PATCH',
        body: 'not json',
      }),
    } as unknown as Parameters<typeof PATCH>[0];
    expect((await PATCH(event)).status).toBe(400);
  });

  it('reports an unreachable backend as a 502, changing nothing', async () => {
    mockedBackendFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await PATCH(makeEvent());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unreachable');
  });

  it('passes an upstream write failure through with its status', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, _p: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? jsonResponse({ errors: [{ message: 'nope' }] }, 422)
        : jsonResponse(EDITABLE),
    );
    expect((await PATCH(makeEvent())).status).toBe(422);
  });
});
