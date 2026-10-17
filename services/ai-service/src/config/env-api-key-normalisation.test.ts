// Unit tests for the boot-time API_KEYS normalisation guard (`normaliseApiKeys`
// + the `API_KEYS` transform in `envSchema`).
//
// The defect being closed: `src/plugins/auth.ts` trims the PRESENTED bearer
// token but matched it against configured keys verbatim, so an `API_KEYS` entry
// with a stray leading/trailing space could never be matched by any request.
// The operator saw a generic `401 unauthorized`, which reads as "the consumer
// has the wrong credential" while the real defect was a malformed env var.
//
// Posture asserted here: REFUSE the boot (fatal, every environment), never
// silently accept the trimmed key — and never print the raw token while doing
// it. Sabotage check: drop the `trimmed !== rawKey` push in `normaliseApiKeys`
// and the first three cases below go RED (the import stops throwing).

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('LOG_LEVEL', 'silent');

  errorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined) as unknown as MockInstance<
    (...args: unknown[]) => unknown
  >;
  // Throw on exit so the module-level IIFE short-circuits the way a real
  // `process.exit` would, instead of falling through to `return parsed.data`
  // on a failed parse.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? ''})`);
  }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

/** Everything `console.error` was handed, flattened for substring assertions. */
function reportedText(): string {
  return errorSpy.mock.calls.map((call) => call.map((a) => JSON.stringify(a)).join(' ')).join('\n');
}

async function bootWith(keys: Record<string, unknown>) {
  vi.stubEnv('API_KEYS', JSON.stringify(keys));
  return import('./env.js');
}

describe('API_KEYS boot refusal — padded tokens', () => {
  it('refuses to boot on a trailing-space token, naming the kid and never the token', async () => {
    await expect(
      bootWith({
        'super-secret-token ': { org: 'tenant-b', project: 'tenant-b', kid: 'tenant-b-prod-2026q3' },
      }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = reportedText();
    expect(text).toMatch(/whitespace/i);
    // Named by its operator label...
    expect(text).toContain('tenant-b-prod-2026q3');
    // ...and the raw credential is NOT in the boot log.
    expect(text).not.toContain('super-secret-token');
  });

  it('refuses on a leading-space token, naming the derived id when there is no kid', async () => {
    const raw = ' another-secret-token';
    await expect(bootWith({ [raw]: { org: 'o', project: 'p' } })).rejects.toThrow(
      /process\.exit\(1\)/,
    );

    const { createHash } = await import('node:crypto');
    const derived = createHash('sha256').update(raw).digest('hex').slice(0, 16);

    const text = reportedText();
    expect(text).toContain(derived);
    expect(text).not.toContain('another-secret-token');
  });

  it('refuses on a token that is only whitespace', async () => {
    await expect(bootWith({ '   ': { org: 'o', project: 'p' } })).rejects.toThrow(
      /process\.exit\(1\)/,
    );
    expect(reportedText()).toMatch(/whitespace|empty/i);
  });
});

describe('API_KEYS boot refusal — collisions after trimming', () => {
  it('refuses when two entries trim to the same token, naming both labels', async () => {
    await expect(
      bootWith({
        'shared-token': { org: 'org-a', project: 'proj-a', kid: 'label-a' },
        'shared-token ': { org: 'org-b', project: 'proj-b', kid: 'label-b' },
      }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const text = reportedText();
    expect(text).toMatch(/shadow/i);
    expect(text).toContain('label-a');
    expect(text).toContain('label-b');
    expect(text).not.toContain('shared-token');
  });
});

describe('API_KEYS normalisation — clean configs are untouched', () => {
  it('boots and keeps every well-formed key addressable', async () => {
    const { env } = await bootWith({
      'tok-app': { org: 'tenant-b', project: 'tenant-b', role: 'app' },
      'tok-admin': { org: 'tenant-b', project: 'tenant-b', role: 'admin' },
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(Object.keys(env.API_KEYS).sort()).toEqual(['tok-admin', 'tok-app']);
    expect(env.API_KEYS['tok-admin']?.role).toBe('admin');
    expect(env.API_KEYS['tok-app']?.role).toBe('app');
  });

  it('an empty map still boots (the default), so nothing regresses for a bare config', async () => {
    const { env } = await bootWith({});
    expect(exitSpy).not.toHaveBeenCalled();
    expect(env.API_KEYS).toEqual({});
  });
});

describe('normaliseApiKeys — unit level', () => {
  it('reports padded and colliding entries separately', async () => {
    const { normaliseApiKeys } = await bootWith({});
    const { problems, keys } = normaliseApiKeys({
      good: { org: 'o', project: 'p', role: 'app' },
      'good ': { org: 'o', project: 'p', role: 'app' },
    });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/whitespace/i);
    expect(problems[1]).toMatch(/shadow/i);
    // The colliding entry never overwrites the one that claimed the token.
    expect(Object.keys(keys)).toEqual(['good']);
  });
});
