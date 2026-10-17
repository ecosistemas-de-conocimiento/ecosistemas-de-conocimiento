// Unit tests for `validateProductionReadiness`. The `env` object in
// `src/config/env.ts` is frozen at module-import time (Zod parses `process.env`
// once), so each test stubs the env vars and then re-imports the module via
// `vi.resetModules()` to get a fresh `env` snapshot.

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('validateProductionReadiness', () => {
  // Captured console + process.exit mocks. Re-installed per test so a probe
  // in test N can't observe spies from test N-1. Signatures are loose
  // (`unknown[]`) because we only read `.mock.calls[i]?.[0]` and call
  // `.mockRestore()` — no per-arg type inspection.
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let warnSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    // Baseline env that lets `envSchema.safeParse` succeed. Individual tests
    // override NODE_ENV + OPENROUTER_API_KEY on top.
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');

    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    // Throw on exit so the test can assert it was called AND short-circuit the
    // probe's control flow (matches what real `process.exit` would do).
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with a fatal error in production when OPENROUTER_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENROUTER_API_KEY', '');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/FATAL.*OPENROUTER_API_KEY/);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns (but does not exit) in development when OPENROUTER_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OPENROUTER_API_KEY', '');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/OPENROUTER_API_KEY is not set/);
  });

  it('warns (but does not exit) in test when OPENROUTER_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENROUTER_API_KEY', '');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns on wrong prefix without exiting (any env)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-fake-local-testing');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/sk-or-v1-/);
  });

  it('is silent when a well-formed key is present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-abc123');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('validateProductionSafetyFlags', () => {
  // Same fixture shape as above: the probe reads `process.env` directly and
  // the parsed `env.NODE_ENV` for the environment, so every test re-imports the
  // module after stubbing.
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let warnSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    // A well-formed key so the OPENROUTER_API_KEY branch never fires and the
    // only fatal these tests can observe is the safety-flag one.
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-abc123');
    // `envSchema` types CALLBACK_ALLOW_PRIVATE as an enum, so the "off"
    // baseline has to be the literal `false`, not an empty string (an empty
    // string fails safeParse and the module exits 1 at import).
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', 'false');
    // The removed mock flags refuse boot in every env; clear any ambient value
    // so the only fatal a case can observe is the one it sets up.
    vi.stubEnv('MOCK_LLM', '');
    vi.stubEnv('MOCK_EMBEDDINGS', '');
    vi.stubEnv('MOCK_LLM_STREAM', '');

    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits 1 in production when CALLBACK_ALLOW_PRIVATE is on', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', '1');

    const { validateProductionSafetyFlags } = await import('./env.js');

    expect(() => validateProductionSafetyFlags()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/FATAL.*development-only.*CALLBACK_ALLOW_PRIVATE/s);
  });

  it('does NOT exit in development when CALLBACK_ALLOW_PRIVATE is on', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', '1');

    const { validateProductionSafetyFlags } = await import('./env.js');

    expect(() => validateProductionSafetyFlags()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('accepts `true` as an on value, not just `1`', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', 'true');

    const { validateProductionSafetyFlags } = await import('./env.js');

    expect(() => validateProductionSafetyFlags()).toThrow(/process\.exit\(1\)/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/CALLBACK_ALLOW_PRIVATE/);
  });

  it('treats explicit off values as absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', 'false');

    const { validateProductionSafetyFlags } = await import('./env.js');

    expect(() => validateProductionSafetyFlags()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('is reached from validateProductionReadiness (the boot entry point)', async () => {
    // `src/index.ts` calls only `validateProductionReadiness`; the safety-flag
    // probe has to hang off it or it never runs in a real boot.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', '1');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/CALLBACK_ALLOW_PRIVATE/);
  });
});

// The in-service mock switches were REMOVED. A deploy or CI job
// still setting one expects free fake output and would get real, billed calls,
// so the boot refuses in EVERY environment and points at the fake provider.
describe('refuseRemovedMockFlags', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-abc123');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', 'false');
    vi.stubEnv('MOCK_LLM', '');
    vi.stubEnv('MOCK_EMBEDDINGS', '');
    vi.stubEnv('MOCK_LLM_STREAM', '');
    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const flag of ['MOCK_LLM', 'MOCK_EMBEDDINGS', 'MOCK_LLM_STREAM']) {
    for (const nodeEnv of ['production', 'development', 'test']) {
      it(`exits 1 in ${nodeEnv} when the removed ${flag} is set, naming the fake provider`, async () => {
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.stubEnv(flag, '1');

        const { refuseRemovedMockFlags } = await import('./env.js');

        expect(() => refuseRemovedMockFlags()).toThrow(/process\.exit\(1\)/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        const msg = String(errorSpy.mock.calls[0]?.[0]);
        expect(msg).toMatch(new RegExp(`FATAL: ${flag} was removed`));
        expect(msg).toContain('REAL and billed');
        expect(msg).toContain('test-support/fake-provider');
      });
    }
  }

  it('names every removed flag that is set, in one message', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MOCK_LLM', '1');
    vi.stubEnv('MOCK_LLM_STREAM', '1');

    const { refuseRemovedMockFlags } = await import('./env.js');

    expect(() => refuseRemovedMockFlags()).toThrow(/process\.exit\(1\)/);
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/MOCK_LLM, MOCK_LLM_STREAM were removed/);
  });

  it('treats explicit off values (`0`, ``, `n`, `N`) as absent', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MOCK_LLM', '0');
    vi.stubEnv('MOCK_EMBEDDINGS', 'n');
    vi.stubEnv('MOCK_LLM_STREAM', 'N');

    const { refuseRemovedMockFlags } = await import('./env.js');

    expect(() => refuseRemovedMockFlags()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still treats `y` as an on value', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MOCK_LLM', 'y');

    const { refuseRemovedMockFlags } = await import('./env.js');

    expect(() => refuseRemovedMockFlags()).toThrow(/process\.exit\(1\)/);
  });

  it('is reached from validateProductionReadiness, before the key check', async () => {
    // No key at all in development would `return` early — the removed-flag
    // refusal must still fire, so it runs first.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('MOCK_LLM', '1');

    const { validateProductionReadiness } = await import('./env.js');

    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/MOCK_LLM was removed/);
  });
});

// `SHUTDOWN_GRACE_MS` is the window a SIGTERM'd process gives its in-flight
// jobs. Its docstring tells the operator the PLATFORM's stop timeout must
// exceed it — a promise nothing used to enforce, so `SHUTDOWN_GRACE_MS=600000`
// parsed happily and the platform SIGKILLed at its own number anyway. The
// `.max()` moves that discovery from a truncated shutdown in production to a
// refused boot. These go through the boot IIFE because `envSchema` is private.
describe('SHUTDOWN_GRACE_MS is bounded', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as never;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('boots on the documented 30s default when the var is unset', async () => {
    const { env } = await import('./env.js');
    expect(env.SHUTDOWN_GRACE_MS).toBe(30_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts the cap itself — 300000 is a legal value, not one past the edge', async () => {
    vi.stubEnv('SHUTDOWN_GRACE_MS', '300000');
    const { env } = await import('./env.js');
    expect(env.SHUTDOWN_GRACE_MS).toBe(300_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('🔴 refuses the boot one millisecond above the cap', async () => {
    vi.stubEnv('SHUTDOWN_GRACE_MS', '300001');
    await expect(import('./env.js')).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The fieldErrors dump has to NAME the var or the operator is hunting.
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/SHUTDOWN_GRACE_MS/);
  });

  it('still refuses zero and negatives — the cap did not replace .positive()', async () => {
    vi.stubEnv('SHUTDOWN_GRACE_MS', '0');
    await expect(import('./env.js')).rejects.toThrow(/process\.exit\(1\)/);
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/SHUTDOWN_GRACE_MS/);
  });
});

// `LLM_ASYNC_REQUEST_TIMEOUT_MS` is the async worker's own provider deadline.
// Unset, it inherits `LLM_REQUEST_TIMEOUT_MS` so nothing changes by default. An
// explicit value must be a positive integer: unlike the sync knob, there is no
// "0 disables" meaning here, and a blank-coerced 0 would cut every async call
// at once.
describe('LLM_ASYNC_REQUEST_TIMEOUT_MS', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as never;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('unset ⇒ inherits LLM_REQUEST_TIMEOUT_MS at its default', async () => {
    const { env } = await import('./env.js');
    expect(env.LLM_ASYNC_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it('unset ⇒ inherits a NON-default LLM_REQUEST_TIMEOUT_MS too', async () => {
    vi.stubEnv('LLM_REQUEST_TIMEOUT_MS', '90000');
    const { env } = await import('./env.js');
    expect(env.LLM_ASYNC_REQUEST_TIMEOUT_MS).toBe(90_000);
  });

  it('an explicit value wins', async () => {
    vi.stubEnv('LLM_ASYNC_REQUEST_TIMEOUT_MS', '600000');
    const { env } = await import('./env.js');
    expect(env.LLM_ASYNC_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(env.LLM_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it.each(['0', '-1', '1.5'])('🔴 refuses the boot on %s', async (value) => {
    vi.stubEnv('LLM_ASYNC_REQUEST_TIMEOUT_MS', value);
    await expect(import('./env.js')).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/LLM_ASYNC_REQUEST_TIMEOUT_MS/);
  });
});
