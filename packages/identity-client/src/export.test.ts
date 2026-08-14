import { describe, expect, it, vi } from 'vitest';
import { resolveExport } from './export.js';

const BASE = 'https://backend.example.org/api';
const OPTS = { baseUrl: BASE, serviceToken: 's3cret' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BODY = {
  project: 'edc',
  exportedAt: '2026-08-05T12:00:00.000Z',
  members: [
    {
      email: 'ana@example.org',
      name: 'Ana Ruiz',
      isPlatformAdmin: false,
      roles: ['coordinator'],
      permissions: ['story:edit', 'surface:brainstorm'],
    },
    {
      email: 'root@example.org',
      name: 'Root',
      isPlatformAdmin: true,
      roles: ['admin', 'coordinator'],
      permissions: ['story:edit'],
    },
  ],
};

describe('resolveExport', () => {
  it('calls the right URL with the service token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, BODY));
    await resolveExport('edc', { ...OPTS, fetch: fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/identity/export?project=edc`);
    expect((init.headers as Record<string, string>)['X-Service-Token']).toBe('s3cret');
    expect(init.method).toBe('GET');
  });

  it('returns the export unchanged', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, BODY));
    await expect(resolveExport('edc', { ...OPTS, fetch: fetchImpl })).resolves.toEqual(BODY);
  });

  it('normalises the slug and tolerates a trailing slash on baseUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, BODY));
    await resolveExport('  EDC ', { ...OPTS, baseUrl: `${BASE}//`, fetch: fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE}/v1/identity/export?project=edc`);
  });

  it('keeps the platform-admin flag', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, BODY));
    const result = await resolveExport('edc', { ...OPTS, fetch: fetchImpl });
    expect(result.members.find((m) => m.email === 'root@example.org')?.isPlatformAdmin).toBe(true);
    expect(result.members.find((m) => m.email === 'ana@example.org')?.isPlatformAdmin).toBe(false);
  });

  it('accepts an empty member list for a project that exists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { project: 'chat', exportedAt: '2026-08-05T12:00:00.000Z', members: [] }),
    );
    await expect(resolveExport('chat', { ...OPTS, fetch: fetchImpl })).resolves.toEqual({
      project: 'chat',
      exportedAt: '2026-08-05T12:00:00.000Z',
      members: [],
    });
  });

  // ⚠ The behaviour that differs from resolveGrant, on purpose.
  it('THROWS on 404 rather than returning an empty export', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { errors: [{ message: 'Unknown or inactive project "nope".' }] }));
    const err = await resolveExport('nope', { ...OPTS, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IdentityRequestError', status: 404 });
    expect((err as Error).message).toContain('Unknown or inactive project');
    expect((err as { isRetryable: boolean }).isRetryable).toBe(false);
  });

  it('reports a rejected service token as non-retryable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { errors: [{ message: 'Invalid service token.' }] }));
    const err = await resolveExport('edc', { ...OPTS, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IdentityRequestError', status: 401 });
    expect((err as Error).message).toContain('X-Service-Token rejected');
    expect((err as { isRetryable: boolean }).isRetryable).toBe(false);
  });

  it('surfaces a 429 with its Retry-After, and marks it non-retryable-now', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { errors: [{ message: 'Too many requests.' }], retryAfterSeconds: 42 }),
    );
    const err = await resolveExport('edc', { ...OPTS, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IdentityRequestError', status: 429 });
    expect((err as Error).message).toContain('Retry in 42s');
  });

  it('marks 5xx as retryable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const err = await resolveExport('edc', { ...OPTS, fetch: fetchImpl }).catch((e: unknown) => e);
    expect((err as { isRetryable: boolean }).isRetryable).toBe(true);
  });

  it('throws rather than returning an empty export on a malformed body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { project: 'edc' }));
    const err = await resolveExport('edc', { ...OPTS, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IdentityRequestError' });
    expect((err as Error).message).toContain('`members`');
  });

  it('throws on an HTML error page instead of pretending it parsed', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 200 }));
    await expect(resolveExport('edc', { ...OPTS, fetch: fetchImpl })).rejects.toMatchObject({
      name: 'IdentityRequestError',
    });
  });

  it('rejects missing config before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveExport('edc', { baseUrl: BASE, serviceToken: '', fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    await expect(
      resolveExport('', { ...OPTS, fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out rather than hanging a seed job forever', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const err = await resolveExport('edc', { ...OPTS, timeoutMs: 5, fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'IdentityRequestError', status: 0 });
    expect((err as Error).message).toContain('timed out');
  });
});
