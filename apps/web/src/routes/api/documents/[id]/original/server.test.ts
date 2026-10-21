import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { GET } from './+server';
import { backendFetch } from '$lib/server/auth';

type Locals = {
  user: { id: number; email: string } | null;
  token: string | undefined;
};

function makeEvent(opts: { locals?: Partial<Locals>; id?: string } = {}): Parameters<
  typeof GET
>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1, email: 'u@test' } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.id ?? '7' },
    request: new Request('http://web.test/api/documents/7/original'),
  } as unknown as Parameters<typeof GET>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;

const ownDoc = {
  id: 7,
  uploadedBy: { id: 1 },
  mediaFile: { id: 3, filename: 'Diagnóstico – campo 2026.pdf' },
};

beforeEach(() => {
  mocked.mockReset();
});

describe('GET /api/documents/[id]/original', () => {
  it('401s without a session, without asking the backend', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('400s on a blank id', async () => {
    const res = await GET(makeEvent({ id: '  ' }));
    expect(res.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('streams the uploader their own file as an attachment', async () => {
    mocked.mockImplementation(async (_t: string, path: string) =>
      path.startsWith('/api/documents/')
        ? jsonResponse(ownDoc)
        : new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(ownDoc.mediaFile.filename)}`);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(mocked.mock.calls[0]![1]).toBe('/api/documents/7?depth=1');
    expect(mocked.mock.calls[1]![1]).toBe(
      `/api/media/file/${encodeURIComponent(ownDoc.mediaFile.filename)}`,
    );
    // Both reads run under the caller's own token.
    expect(mocked.mock.calls.every((c) => c[0] === 'tok')).toBe(true);
  });

  // 🔴 A Voz's original is the un-anonymised file. Only its uploader gets it here.
  it('404s someone who is not the uploader, without fetching the file', async () => {
    mocked.mockImplementation(async () => jsonResponse({ ...ownDoc, uploadedBy: 2 }));
    const res = await GET(makeEvent());
    expect(res.status).toBe(404);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])('reads an upstream %i on the document as not found', async (status) => {
    mocked.mockImplementation(async () => jsonResponse({ errors: [] }, status));
    const res = await GET(makeEvent());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('404s a note with no file behind it', async () => {
    mocked.mockImplementation(async () => jsonResponse({ ...ownDoc, mediaFile: null }));
    const res = await GET(makeEvent());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_original' });
  });

  it('502s when the backend is unreachable', async () => {
    mocked.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await GET(makeEvent());
    expect(res.status).toBe(502);
  });
});
