// Unit tests for the boot-time API-key expiry probe (`warnOnExpiringApiKeys`)
// and the shared `isApiKeyExpired` predicate.
//
// The probe WARNS and never exits: an expired key must not take the service
// down for every other tenant — `requireAuth` rejects it per request instead.
// It must also never print the raw token, only `kid` or the derived id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Re-imports `config/env.js` against a stubbed `API_KEYS`. */
async function loadEnv(keys: Record<string, unknown>) {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('LOG_LEVEL', 'warn');
  vi.stubEnv('API_KEYS', JSON.stringify(keys));
  return import('./env.js');
}

/** Collects the warn-level lines the probe writes, via a fake pino logger. */
function fakeLog() {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    logger: {
      warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }),
    } as never,
  };
}

describe('warnOnExpiringApiKeys', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('warns once for an expired key, naming kid and never the token', async () => {
    const { warnOnExpiringApiKeys } = await loadEnv({
      'super-secret-token': {
        org: 'o',
        project: 'p',
        kid: 'tenant-b-prod-2026q3',
        expiresAt: iso(-DAY),
      },
    });
    const { lines, logger } = fakeLog();
    warnOnExpiringApiKeys(new Date(), logger);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.obj).toMatchObject({ keyId: 'tenant-b-prod-2026q3', expired: true });
    expect(lines[0]?.msg).toContain('EXPIRED');
    // The whole point of `kid`: a nameable key in the log with no token in it.
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('super-secret-token');
  });

  it('warns for a key expiring inside the 7-day window, marked not-yet-expired', async () => {
    const { warnOnExpiringApiKeys } = await loadEnv({
      'tok-abc': { org: 'o', project: 'p', expiresAt: iso(3 * DAY) },
    });
    const { lines, logger } = fakeLog();
    warnOnExpiringApiKeys(new Date(), logger);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.obj.expired).toBe(false);
    expect(lines[0]?.msg).toContain('within 7 days');
    // No `kid` configured, so the line falls back to the derived id — 16 hex
    // chars, the same derivation `req.auth.apiKeyId` uses.
    expect(lines[0]?.obj.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(lines)).not.toContain('tok-abc');
  });

  it('stays silent for keys with no expiry or an expiry beyond the window', async () => {
    const { warnOnExpiringApiKeys } = await loadEnv({
      legacy: { org: 'o', project: 'p' },
      distant: { org: 'o', project: 'p', expiresAt: iso(90 * DAY) },
    });
    const { lines, logger } = fakeLog();
    warnOnExpiringApiKeys(new Date(), logger);
    expect(lines).toEqual([]);
  });

  it('emits exactly one line per affected key and never exits the process', async () => {
    const { warnOnExpiringApiKeys } = await loadEnv({
      a: { org: 'o', project: 'p', kid: 'a', expiresAt: iso(-DAY) },
      b: { org: 'o', project: 'p', kid: 'b', expiresAt: iso(DAY) },
      c: { org: 'o', project: 'p', expiresAt: iso(30 * DAY) },
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const { lines, logger } = fakeLog();
    warnOnExpiringApiKeys(new Date(), logger);
    expect(lines.map((l) => l.obj.keyId)).toEqual(['a', 'b']);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('isApiKeyExpired', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is false without expiresAt, true once it has passed, false before', async () => {
    const { isApiKeyExpired } = await loadEnv({});
    const base = { org: 'o', project: 'p', role: 'app' as const };
    expect(isApiKeyExpired({ ...base })).toBe(false);
    expect(isApiKeyExpired({ ...base, expiresAt: iso(-1000) })).toBe(true);
    expect(isApiKeyExpired({ ...base, expiresAt: iso(1000) })).toBe(false);
  });
});

describe('API_KEYS schema — additive fields', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('parses entries with and without the new fields', async () => {
    const { env } = await loadEnv({
      old: { org: 'o', project: 'p' },
      new: { org: 'o', project: 'p', kid: 'k1', expiresAt: '2030-01-01T00:00:00Z' },
    });
    expect(env.API_KEYS.old?.expiresAt).toBeUndefined();
    expect(env.API_KEYS.old?.kid).toBeUndefined();
    expect(env.API_KEYS.new?.kid).toBe('k1');
    expect(env.API_KEYS.new?.expiresAt).toBe('2030-01-01T00:00:00Z');
  });
});
