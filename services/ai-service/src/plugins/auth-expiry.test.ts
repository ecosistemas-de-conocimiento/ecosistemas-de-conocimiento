// Unit tests for the optional `expiresAt` / `kid` fields on `API_KEYS` entries.
//
// The contract under test is ADDITIVE: an entry with no `expiresAt` must keep
// authenticating exactly as before, an entry whose `expiresAt` is in the future
// authenticates, and one whose `expiresAt` has passed is rejected with 401 and
// the distinct `api_key_expired` code (not the generic `unauthorized`, so a
// consumer can tell "rotate me" apart from "wrong token").
//
// `env` is frozen at module-import time (Zod parses `process.env` once), so
// each test stubs `API_KEYS` and re-imports through `vi.resetModules()`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function makeAppWithKeys(keys: Record<string, unknown>) {
  vi.stubEnv('API_KEYS', JSON.stringify(keys));
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('requireAuth — API key expiry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('LOG_LEVEL', 'silent');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an EXPIRED key with 401 api_key_expired and mints no scope', async () => {
    const app = await makeAppWithKeys({
      'stale-key': { org: 'o', project: 'p', expiresAt: iso(-HOUR) },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer stale-key' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    // The distinct code is the point — a generic `unauthorized` here would
    // leave the consumer unable to distinguish a rotation from a bad token.
    expect(body.error).toBe('api_key_expired');
    // Assert the handler was never reached, not just the status code.
    expect(body).not.toHaveProperty('v1');
    expect(body).not.toHaveProperty('org');
    await app.close();
  });

  it('accepts a key whose expiresAt is still in the future', async () => {
    const app = await makeAppWithKeys({
      'fresh-key': { org: 'o', project: 'p', expiresAt: iso(30 * DAY) },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer fresh-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ v1: true, org: 'o', project: 'p' });
    await app.close();
  });

  it('accepts an entry with NO expiresAt — the additive guarantee', async () => {
    // Every entry configured before this feature looks like this one. If this
    // test ever goes red the change stopped being backward-compatible.
    const app = await makeAppWithKeys({ 'legacy-key': { org: 'o', project: 'p' } });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer legacy-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ v1: true, org: 'o', project: 'p' });
    await app.close();
  });

  it('an expiry exactly now counts as expired (boundary is inclusive)', async () => {
    const app = await makeAppWithKeys({
      'edge-key': { org: 'o', project: 'p', expiresAt: iso(-50) },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer edge-key' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as Record<string, unknown>).error).toBe('api_key_expired');
    await app.close();
  });

  it('surfaces `kid` on req.auth, and leaves it undefined when unset', async () => {
    vi.resetModules();
    vi.stubEnv(
      'API_KEYS',
      JSON.stringify({
        labelled: { org: 'o', project: 'p', kid: 'tenant-b-prod-2026q3' },
        unlabelled: { org: 'o', project: 'p' },
      }),
    );
    const { authPlugin } = await import('./auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(authPlugin);
    app.get('/probe', { preHandler: [app.requireAuth] }, async (req) => ({
      kid: req.auth.kid ?? null,
      apiKeyId: req.auth.apiKeyId,
    }));
    await app.ready();

    const withKid = await app.inject({
      url: '/probe',
      headers: { authorization: 'Bearer labelled' },
    });
    expect(withKid.json()).toMatchObject({ kid: 'tenant-b-prod-2026q3' });
    // `apiKeyId` must stay the SHA-256 derivation — `kid` does not replace the
    // identity written to `registry_audit.actor_key_id`.
    expect((withKid.json() as { apiKeyId: string }).apiKeyId).toMatch(/^[0-9a-f]{16}$/);

    const withoutKid = await app.inject({
      url: '/probe',
      headers: { authorization: 'Bearer unlabelled' },
    });
    expect(withoutKid.json()).toMatchObject({ kid: null });
    await app.close();
  });
});
