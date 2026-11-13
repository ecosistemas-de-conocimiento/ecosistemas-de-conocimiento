import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendUrl: () => 'http://backend.test', backendFetch: vi.fn() }));

import { load } from './+page.server';
import { backendFetch } from '$lib/server/auth';

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const body = {
  documentId: 456,
  receipt: {
    id: 123,
    folio: 'EDC-2026-000123',
    consentVersion: 1,
    contentKind: 'testimonio',
    acceptedAt: '2026-11-12T18:00:00.000Z',
    ecosystem: { id: 3, name: 'Semiosis' },
  },
  document: { kind: 'audio', contentKind: 'testimonio', createdAt: '2026-11-12T18:00:00.000Z', title: null },
};

const event = (user: unknown = { id: 2 }) =>
  ({ locals: { user, token: 'tok' }, params: { id: '456' } }) as never;

beforeEach(() => mocked.mockReset());

describe('/documentos/[id]/constancia load', () => {
  it("reads the backend constancia with the caller's token and keeps its shape", async () => {
    mocked.mockResolvedValue(json(body));
    const data = (await load(event())) as { constancia: typeof body };
    expect(mocked.mock.calls[0]?.[0]).toBe('tok');
    expect(mocked.mock.calls[0]?.[1]).toBe('/api/documents/456/constancia');
    expect(data.constancia).toEqual(body);
  });

  it('🔴 a backend 404 (not the uploader nor an admin) is a 404', async () => {
    mocked.mockResolvedValue(json({ error: 'not_found' }, 404));
    await expect(load(event())).rejects.toMatchObject({ status: 404, body: { kind: 'not-found' } });
  });

  it('a signed-out caller is a 404 without asking the backend', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 404 });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('receipt null and document null pass through', async () => {
    mocked.mockResolvedValue(json({ documentId: 7, receipt: null, document: null }));
    expect(((await load(event())) as { constancia: unknown }).constancia).toEqual({ documentId: 7, receipt: null, document: null });
  });

  it('a backend failure or a malformed body is a 502, not a blank constancia', async () => {
    mocked.mockResolvedValue(json({}, 500));
    await expect(load(event())).rejects.toMatchObject({ status: 502 });
    mocked.mockResolvedValue(json({ nope: true }));
    await expect(load(event())).rejects.toMatchObject({ status: 502 });
  });
});
