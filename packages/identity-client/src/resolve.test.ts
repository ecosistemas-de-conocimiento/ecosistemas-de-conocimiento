import { describe, expect, it, vi } from 'vitest';
import { resolveGrant, resolvePrincipal } from './resolve.js';
import { canInProject, grantOf } from './permissions.js';

const BASE = 'https://backend.example.org';
const OPTS = { baseUrl: BASE, serviceToken: 's3cret' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveGrant', () => {
  it('reads the flat body the endpoint actually returns', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        project: 'edc',
        roles: ['coordinator'],
        permissions: ['story:edit'],
        isPlatformAdmin: false,
      }),
    );
    await expect(resolveGrant('ana@example.org', 'edc', { ...OPTS, fetch: fetchImpl })).resolves.toEqual({
      roles: ['coordinator'],
      permissions: ['story:edit'],
    });
  });

  it('keeps isPlatformAdmin on the principal form', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'root@example.org',
        name: null,
        project: 'chat',
        roles: [],
        permissions: [],
        isPlatformAdmin: true,
      }),
    );
    const principal = await resolvePrincipal('root@example.org', 'chat', { ...OPTS, fetch: fetchImpl });
    expect(principal?.isPlatformAdmin).toBe(true);
  });

  it('sends X-Service-Token and normalises the email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        isPlatformAdmin: false,
        projects: { 'edc': { roles: ['coordinator'], permissions: ['story:edit'] } },
      }),
    );

    const grant = await resolveGrant('  ANA@example.org ', 'edc', { ...OPTS, fetch: fetchImpl });

    expect(grant).toEqual({ roles: ['coordinator'], permissions: ['story:edit'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/identity/resolve?email=ana%40example.org&project=edc`);
    expect((init.headers as Record<string, string>)['X-Service-Token']).toBe('s3cret');
  });

  it('returns null for an unknown user (404)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    await expect(resolveGrant('ghost@example.org', 'chat', { ...OPTS, fetch: fetchImpl })).resolves.toBeNull();
  });

  it('returns an empty grant when the user exists but holds nothing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { email: 'ana@example.org', name: 'Ana', isPlatformAdmin: false, projects: {} }),
    );
    await expect(resolveGrant('ana@example.org', 'chat', { ...OPTS, fetch: fetchImpl })).resolves.toEqual({
      roles: [],
      permissions: [],
    });
  });

  it('accepts a bare ProjectGrant body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { roles: ['facilitator'], permissions: ['x'] }));
    const principal = await resolvePrincipal('ana@example.org', 'workshops', {
      ...OPTS,
      fetch: fetchImpl,
    });
    expect(principal?.projects.workshops).toEqual({ roles: ['facilitator'], permissions: ['x'] });
  });

  it('throws a non-retryable error on a rejected service token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: 'bad token' }));
    const err = await resolveGrant('ana@example.org', 'chat', { ...OPTS, fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'IdentityRequestError', status: 401 });
    expect((err as { isRetryable: boolean }).isRetryable).toBe(false);
  });

  it('marks 5xx as retryable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const err = await resolveGrant('ana@example.org', 'chat', { ...OPTS, fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect((err as { isRetryable: boolean }).isRetryable).toBe(true);
  });

  it('rejects missing config before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveGrant('ana@example.org', 'chat', { baseUrl: BASE, serviceToken: '', fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveGrant — the service-to-service path denies malformed and mismatched bodies', () => {
  it('🔴 a STRING `permissions` in the projects map collapses to `[]` and DENIES', async () => {
    // 0.3.2 closed the substring-GRANT hazard in `grantOf()`, but `resolveGrant()`
    // read `principal.projects[slug]` RAW, so `'story:edit'.includes('story')`
    // was still reachable through this path.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        isPlatformAdmin: false,
        projects: { 'edc': { roles: 'coordinator', permissions: 'story:edit' } },
      }),
    );

    const grant = await resolveGrant('ana@example.org', 'edc', { ...OPTS, fetch: fetchImpl });

    expect(grant).toEqual({ roles: [], permissions: [] });
    expect(grant?.permissions.includes('story')).toBe(false);
  });

  it('🔴 the same malformed body denies through the principal + `canInProject` path', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        isPlatformAdmin: false,
        projects: { 'edc': { roles: [], permissions: 'story:edit' } },
      }),
    );

    const principal = await resolvePrincipal('ana@example.org', 'edc', {
      ...OPTS,
      fetch: fetchImpl,
    });

    expect(canInProject(principal!, 'edc', 'story')).toBe(false);
    expect(canInProject(principal!, 'edc', 'story:edit')).toBe(false);
    expect(grantOf(principal!, 'edc')).toEqual({ roles: [], permissions: [] });
  });

  it('🔴 a slug MISMATCH returns no grant — never some other project\'s', async () => {
    // The old fallback was `Object.values(principal.projects)[0]`, which handed
    // back whichever project happened to be first. That is a cross-project leak.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        isPlatformAdmin: false,
        projects: { chat: { roles: ['owner'], permissions: ['dm:use'] } },
      }),
    );

    const grant = await resolveGrant('ana@example.org', 'edc', { ...OPTS, fetch: fetchImpl });

    expect(grant).toEqual({ roles: [], permissions: [] });
    expect(grant?.permissions).not.toContain('dm:use');
    expect(grant?.roles).not.toContain('owner');
  });

  it('a non-object `projects` denies instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        isPlatformAdmin: false,
        projects: 'edc',
      }),
    );

    await expect(
      resolveGrant('ana@example.org', 'edc', { ...OPTS, fetch: fetchImpl }),
    ).resolves.toBeNull();
  });

  it('the flat body still answers when the server echoes the slug in another case', async () => {
    // What the removed fallback was really covering. The flat body IS the answer
    // to our request, so it is keyed by the slug we asked for.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        email: 'ana@example.org',
        name: 'Ana',
        project: 'EDC',
        roles: ['coordinator'],
        permissions: ['story:edit'],
        isPlatformAdmin: false,
      }),
    );

    await expect(
      resolveGrant('ana@example.org', 'edc', { ...OPTS, fetch: fetchImpl }),
    ).resolves.toEqual({ roles: ['coordinator'], permissions: ['story:edit'] });
  });
});
