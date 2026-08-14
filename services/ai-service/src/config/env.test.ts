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
