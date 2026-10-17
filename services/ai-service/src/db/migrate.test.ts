// Unit test for the production guard at the top of `src/db/migrate.ts`.
//
// Why this test exists: `Dockerfile` runs `db:migrate:prod && exec node
// dist/index.js`. The migration therefore runs BEFORE `src/index.ts`, which is
// the only place `validateProductionReadiness` used to be called. A container
// carrying a forbidden dev flag would apply the whole schema and only then exit
// 1 into a restart loop — a failed deploy whose database had already moved.
//
// The assertion that carries the weight is `createMigrationClient` never being
// called: that is the module holding the `postgres()` pool, so "never called"
// is "never touched the database".

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMigrationClient = vi.fn(() => {
  throw new Error('createMigrationClient must not be reached on the refusal path');
});

vi.mock('./client.js', () => ({
  createMigrationClient,
  db: {},
  closeDb: vi.fn(),
}));

describe('db/migrate entrypoint', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;
  // When true, the mocked `process.exit` throws so it halts its caller the way
  // the real one would. See the mock installation in `beforeEach`.
  let exitHalts = false;

  beforeEach(() => {
    vi.resetModules();
    createMigrationClient.mockClear();

    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');

    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;

    // `process.exit` is replaced, so the control flow does NOT stop by itself.
    // A test that needs the guard's refusal to actually halt `main()` sets
    // `exitHalts` and the FIRST exit call throws, reproducing what the real
    // `process.exit` does to the control flow. The flag is one-shot: every
    // later call returns quietly. That matters because the module's own
    // `main().catch(...)` handler ends by calling exit again, and a throw there
    // would escape the handler as an unhandled rejection and fail the run.
    exitHalts = false;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (exitHalts) {
        exitHalts = false;
        throw new Error(`process.exit(${code ?? ''})`);
      }
      return undefined;
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('refuses before opening a connection when a forbidden flag is set in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-realish');
    vi.stubEnv('CALLBACK_ALLOW_PRIVATE', '1');
    exitHalts = true;

    // Importing the module runs `main()`.
    await import('./migrate.js');
    // Let the rejected `main()` promise reach its `.catch` handler.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createMigrationClient).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/FATAL.*CALLBACK_ALLOW_PRIVATE/s);
  });

  it('gets past the guard and opens a connection when no forbidden flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-realish');

    await import('./migrate.js');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The guard is silent, so `main()` proceeds and the mocked client factory —
    // which throws by design — is what stops it. Without this case the first
    // test would still pass if the guard refused unconditionally.
    expect(createMigrationClient).toHaveBeenCalled();
  });
});
