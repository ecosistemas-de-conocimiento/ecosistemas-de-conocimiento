// Unit tests for org delegation: one API key acting on behalf of many orgs.
//
// Contract under test (see `delegateOrgPrefix` in `src/config/env.ts` and the
// `X-AI-Org` branch in `src/plugins/auth.ts`):
//   - A key WITHOUT `delegateOrgPrefix` behaves exactly as before. Sending
//     `X-AI-Org` with it is a 403: the header must never be silently ignored,
//     or a consumer would write every sub-tenant into one org.
//   - A key WITH `delegateOrgPrefix` and no header acts as its own `org`.
//   - With the header, the effective org is `prefix + suffix`. The suffix must
//     match `^[a-z0-9-]{1,48}$`, else 400. `project`, `role` and `apiKeyId`
//     still come from the key.
//
// Observed through the authenticated echo route `GET /v1/`, which returns the
// `{org, project}` that `requireAuth` minted.
//
// `env` is parsed once at import, so each test stubs `API_KEYS` and re-imports
// through `vi.resetModules()` (same pattern as `auth-expiry.test.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = {
  'plain-key': { org: 'solo', project: 'p1' },
  'deleg-key': { org: 'acme', project: 'p1', role: 'admin', delegateOrgPrefix: 'acme-' },
};

async function makeApp(keys: Record<string, unknown> = KEYS) {
  vi.stubEnv('API_KEYS', JSON.stringify(keys));
  const { buildServer } = await import('../server.js');
  return buildServer();
}

async function echo(
  app: Awaited<ReturnType<typeof makeApp>>,
  key: string,
  org?: string | string[],
) {
  return app.inject({
    method: 'GET',
    url: '/v1/',
    headers: {
      authorization: `Bearer ${key}`,
      ...(org !== undefined ? { 'x-ai-org': org } : {}),
    },
  });
}

describe('requireAuth — org delegation via X-AI-Org', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('LOG_LEVEL', 'silent');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a delegating key with no header acts as its own org', async () => {
    const app = await makeApp();
    const res = await echo(app, 'deleg-key');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ org: 'acme', project: 'p1' });
    await app.close();
  });

  it('a delegating key with a valid suffix acts as prefix + suffix; project stays from the key', async () => {
    const app = await makeApp();
    const res = await echo(app, 'deleg-key', 'tenant-7');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ org: 'acme-tenant-7', project: 'p1' });
    await app.close();
  });

  it('keeps the key id, role and kid: usage still traces to the key', async () => {
    vi.stubEnv(
      'API_KEYS',
      JSON.stringify({
        'deleg-key': { ...KEYS['deleg-key'], kid: 'deleg-1' },
      }),
    );
    const { buildServer } = await import('../server.js');
    const { deriveApiKeyId } = await import('./auth.js');
    const app = await buildServer();
    let seen: unknown;
    app.addHook('preHandler', async (req) => {
      seen = req.auth;
    });
    const res = await echo(app, 'deleg-key', 'tenant-7');
    expect(res.statusCode).toBe(200);
    expect(seen).toMatchObject({
      org: 'acme-tenant-7',
      project: 'p1',
      role: 'admin',
      apiKeyId: deriveApiKeyId('deleg-key'),
      kid: 'deleg-1',
    });
    await app.close();
  });

  it('a key WITHOUT delegation that sends the header gets 403 and no scope', async () => {
    const app = await makeApp();
    const res = await echo(app, 'plain-key', 'tenant-7');
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('v1');
    expect(body).not.toHaveProperty('org');
    await app.close();
  });

  it('a key without delegation still works with no header (unchanged behaviour)', async () => {
    const app = await makeApp();
    const res = await echo(app, 'plain-key');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ org: 'solo', project: 'p1' });
    await app.close();
  });

  for (const bad of [
    '',
    'Tenant',
    'a_b',
    'a.b',
    '../x',
    'a b',
    'ñ',
    'x'.repeat(49),
  ]) {
    it(`rejects suffix ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 5)}…(${bad.length})` : bad)} with 400 and no scope`, async () => {
      const app = await makeApp();
      const res = await echo(app, 'deleg-key', bad);
      expect(res.statusCode).toBe(400);
      expect(res.json()).not.toHaveProperty('v1');
      await app.close();
    });
  }

  it('accepts a 48-char suffix (the upper bound)', async () => {
    const app = await makeApp();
    const res = await echo(app, 'deleg-key', 'x'.repeat(48));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ org: `acme-${'x'.repeat(48)}` });
    await app.close();
  });

  it('rejects a repeated header (two values) with 400', async () => {
    const app = await makeApp();
    const res = await echo(app, 'deleg-key', ['a', 'b']);
    expect(res.statusCode).toBe(400);
    expect(res.json()).not.toHaveProperty('v1');
    await app.close();
  });

  it('auth failure still wins over the header: unknown key + header is 401', async () => {
    const app = await makeApp();
    const res = await echo(app, 'nope', 'tenant-7');
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('API_KEYS schema — delegateOrgPrefix', () => {
  for (const bad of ['acme', 'ACME-', '-', 'a_b-', '', `${'a'.repeat(32)}-`]) {
    it(`rejects prefix ${JSON.stringify(bad.length > 20 ? `(${bad.length} chars)` : bad)}`, async () => {
      const { apiKeyEntry } = await import('../config/env.js');
      expect(
        apiKeyEntry.safeParse({ org: 'o', project: 'p', delegateOrgPrefix: bad }).success,
      ).toBe(false);
    });
  }

  it('accepts a prefix ending in "-"', async () => {
    const { apiKeyEntry } = await import('../config/env.js');
    const parsed = apiKeyEntry.parse({ org: 'o', project: 'p', delegateOrgPrefix: 'acme-x-' });
    expect(parsed.delegateOrgPrefix).toBe('acme-x-');
  });

  it('entries without the field parse exactly as before', async () => {
    const { apiKeyEntry } = await import('../config/env.js');
    expect(apiKeyEntry.parse({ org: 'o', project: 'p' })).toEqual({
      org: 'o',
      project: 'p',
      role: 'app',
    });
  });
});

describe('normaliseApiKeys — delegation namespace overlap', () => {
  it('refuses a key whose own org sits inside ANOTHER key\'s delegation namespace', async () => {
    const { normaliseApiKeys } = await import('../config/env.js');
    const { problems } = normaliseApiKeys({
      deleg: { org: 'acme', project: 'p', role: 'app', delegateOrgPrefix: 'acme-' },
      other: { org: 'acme-tenant-7', project: 'p', role: 'app' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/acme-tenant-7/);
    expect(problems[0]).toMatch(/acme-/);
  });

  it('allows two keys sharing one prefix (rotation) and a delegator whose own org is outside it', async () => {
    const { normaliseApiKeys } = await import('../config/env.js');
    const { problems } = normaliseApiKeys({
      old: { org: 'acme', project: 'p', role: 'app', delegateOrgPrefix: 'acme-' },
      new: { org: 'acme', project: 'p', role: 'app', delegateOrgPrefix: 'acme-' },
      unrelated: { org: 'acmex', project: 'p', role: 'app' },
    });
    expect(problems).toEqual([]);
  });
});
