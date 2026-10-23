import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));
vi.mock('$lib/server/ecosystem', () => ({
  ECOSYSTEM_COOKIE: 'eco_selected',
  resolveEcosystem: vi.fn(),
}));
vi.mock('$lib/server/holds', () => ({
  readReviewCapability: vi.fn(async () => ({ ok: true, isPlatformAdmin: false, slugs: [] })),
}));

import { POST } from './+server';
import { backendFetch } from '$lib/server/auth';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { MAX_UPLOAD_BYTES } from '$lib/config';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;
const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const fetchSpy = vi.fn();

const ECO = { id: '3', name: 'Organización Demo' };

function makeEvent(
  file: File | null,
  user: { id: number } | null = { id: 5 },
  cookie?: string,
) {
  const form = new FormData();
  if (file) form.append('file', file);
  const request = new Request('http://app.test/api/documentos', { method: 'POST', body: form });
  return {
    locals: { user, token: 'tok' },
    cookies: {
      get: (name: string) => (name === 'eco_selected' ? cookie : undefined),
      set: () => {},
      delete: () => {},
    },
    request,
  } as unknown as Parameters<typeof POST>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const pdf = () => new File(['%PDF-1.7'], 'informe.pdf', { type: 'application/pdf' });

beforeEach(() => {
  mockedBackendFetch.mockReset();
  mockedResolve.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  mockedResolve.mockResolvedValue({ ok: true, selected: ECO, list: [ECO], source: 'cookie' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/documentos (upload with no conversation)', () => {
  it('401s without a session', async () => {
    const res = await POST(makeEvent(pdf(), null));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Someone in several ecosistemas uploads into the one selected in the switcher.
  it('files it in the SELECTED ecosistema for someone in several', async () => {
    const OTRO = { id: '4', name: 'Otro' };
    mockedResolve.mockResolvedValue({
      ok: true,
      selected: OTRO,
      list: [ECO, OTRO],
      source: 'requested',
    });
    fetchSpy.mockResolvedValue(jsonResponse({ doc: { id: 11 } }, 201));
    mockedBackendFetch.mockResolvedValue(jsonResponse({ doc: { id: 21 } }, 201));
    const res = await POST(makeEvent(pdf(), { id: 5 }, '4'));
    expect(res.status).toBe(201);
    const sent = JSON.parse(mockedBackendFetch.mock.calls[0]![2].body as string);
    expect(sent).toMatchObject({ session: [], organization: '4' });
  });

  // 🔴 A forged cookie: `resolveEcosystem` falls back to a real membership, but
  // the upload must not silently land there.
  it('403s a cookie naming an ecosistema the caller is not in, before uploading', async () => {
    mockedResolve.mockResolvedValue({
      ok: true,
      selected: ECO,
      list: [ECO, { id: '4', name: 'Otro' }],
      source: 'fallback',
    });
    const res = await POST(makeEvent(pdf(), { id: 5 }, '999'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'ecosystem_forbidden' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('403s someone with no ecosistema, before uploading', async () => {
    mockedResolve.mockResolvedValue({ ok: true, selected: null, list: [], source: 'none' });
    const res = await POST(makeEvent(pdf()));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The backend refuses a non-member org too; its 403 reaches the browser as a 403.
  it('passes a backend membership refusal through as 403', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ doc: { id: 11 } }, 201));
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: 'You are not allowed to perform this action.' }] }, 403),
    );
    const res = await POST(makeEvent(pdf()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'document_create_failed' });
  });

  it('503s when the ecosistema cannot be read', async () => {
    mockedResolve.mockResolvedValue({ ok: false, selected: null, list: [], source: 'none' });
    const res = await POST(makeEvent(pdf()));
    expect(res.status).toBe(503);
  });

  // 🔴 Backlog #8: audio stays off until audio-service runs on EDC.
  it('refuses audio while the audio switch is off', async () => {
    const res = await POST(makeEvent(new File(['x'], 'voz.m4a', { type: 'audio/mp4' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_kind' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Audit fix: the cap follows the SETTLED kind, not the browser's MIME. A PDF
  // sent as `audio/mp4` used to get the 200 MB audio cap instead of 20 MB.
  it('caps a PDF at the document limit even when its MIME type says audio', async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'informe.pdf', {
      type: 'audio/mp4',
    });
    const res = await POST(makeEvent(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: 'file_too_large',
      limit: MAX_UPLOAD_BYTES,
      kind: 'pdf',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Single-ecosistema person, no cookie yet: same flow as before, now naming
  // their only ecosistema explicitly.
  it('uploads a PDF and creates a document attached to no conversation', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ doc: { id: 11 } }, 201));
    mockedBackendFetch.mockResolvedValue(jsonResponse({ doc: { id: 21 } }, 201));
    const res = await POST(makeEvent(pdf()));
    expect(res.status).toBe(201);
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://backend.test/api/media');
    const sent = JSON.parse(mockedBackendFetch.mock.calls[0]![2].body as string);
    expect(sent).toMatchObject({
      session: [],
      kind: 'pdf',
      contentKind: 'documento',
      mediaFile: 11,
      name: 'informe.pdf',
    });
    // The validated selection, never anything from the request body.
    expect(sent.organization).toBe('3');
  });

  it('never passes a backend validation message to the browser', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ doc: { id: 11 } }, 201));
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: 'You belong to several ecosistemas' }] }, 400),
    );
    const res = await POST(makeEvent(pdf()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'document_create_failed' });
  });
});
