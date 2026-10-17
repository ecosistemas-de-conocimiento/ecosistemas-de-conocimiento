// GATE: the internal-route decision is the SAME on both sides, in BOTH modes.
//
// ── The defect this pins (measured on 07f63a3) ────────────────────────────
// `server.ts` refuses to mount `/v1/internal/*` when `NODE_ENV=production`.
// The route table declared `GET /v1/internal/latest-trace` unconditionally. So
// the document a production deployment serves advertised a path that same
// deployment answers 404 on — a consumer reading the published contract could
// not tell the seam is absent.
//
// `routes-vs-document.test.ts` compares the two sets and would have caught it
// instantly — except that BOTH vitest configs pin `NODE_ENV: 'test'`
// (`vitest.config.ts:38`, `vitest.integration.config.ts:77`), so the gate has
// never once run the production way. The whole suite was green on a mismatch
// that only exists in production.
//
// This file forces the production branch on both sides at once:
//   · the DOCUMENT, by resetting the module registry with `NODE_ENV` set
//     before `route-table.ts` is evaluated (the row is a spread, decided at
//     module evaluation);
//   · the SERVER, by injecting a `Runtime` whose `config.NODE_ENV` is
//     `production` — `buildServer` reads `config.NODE_ENV`, never
//     `process.env`, so the injection is the whole gate.
//
// ⚠ SABOTAGE (measured): replace the `internalRoutesEnabled()`
// spread in `route-table.ts` with `...(true ? [...] : [])`. Two tests go red:
// `production: neither declares it` (the document lists the path among 45
// while the server mounts 44) and `production: the two sets agree, in BOTH
// directions` (`declaredButUnmounted: ['GET /v1/internal/latest-trace']`).
// Under `NODE_ENV=test` — the only mode the suite ran before this file — the
// sabotage stays fully green, which is exactly why it survived.
//
// 🔴 `vi.resetModules()` is load-bearing and so is the dynamic import. A
// static import of `route-table.js` at the top of this file would evaluate the
// spread once, under `NODE_ENV=test`, and the production case would silently
// assert against the test-mode table.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.API_KEYS ??= JSON.stringify({
  'gate-app': { org: 'acme', project: 'chat', role: 'app' },
});

const INTERNAL = 'GET /v1/internal/latest-trace';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

/** Every `METHOD /path` the document declares, built fresh under `nodeEnv`. */
async function documentedRoutes(nodeEnv: string): Promise<string[]> {
  process.env['NODE_ENV'] = nodeEnv;
  vi.resetModules();
  const { __resetOpenApiCacheForTests, getOpenApiDocument } = await import('./registry.js');
  __resetOpenApiCacheForTests();
  const doc = getOpenApiDocument();
  const keys: string[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      keys.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys.sort();
}

/**
 * Every `METHOD /path` the SERVER mounts, built with `config.NODE_ENV` forced.
 *
 * The config value is overridden in-test rather than through `process.env`
 * because `buildServer` reads `runtime.config`, and that is the seam the
 * production gate actually sits on.
 */
async function mountedRoutes(nodeEnv: 'test' | 'production'): Promise<string[]> {
  const { loadConfig } = await import('../config/config.js');
  const { createRuntime } = await import('../runtime.js');
  const { buildServer } = await import('../server.js');
  const { listAppRoutes } = await import('./app-routes.js');

  const config = { ...loadConfig(), NODE_ENV: nodeEnv, rateLimitRedisStore: false };
  // `mockQueues` defaults off `config.NODE_ENV`, so forcing `production`
  // without this would open a real BullMQ connection.
  const runtime = createRuntime(config, { mockQueues: true });
  const app = await buildServer(runtime);
  await app.ready();
  try {
    return listAppRoutes(app);
  } finally {
    await app.close();
    await runtime.close();
  }
}

describe('`/v1/internal/*` is declared exactly when it is mounted', () => {
  it('non-production: both the document and the server have it', async () => {
    expect(await documentedRoutes('test')).toContain(INTERNAL);
    expect(await mountedRoutes('test')).toContain(INTERNAL);
  });

  it('production: neither declares it', async () => {
    // Asserted separately from each other so a failure names WHICH side moved.
    expect(await documentedRoutes('production')).not.toContain(INTERNAL);
    expect(await mountedRoutes('production')).not.toContain(INTERNAL);
  });

  it('production: the two sets agree, in BOTH directions', async () => {
    // The real invariant `routes-vs-document.test.ts` asserts, re-run in the
    // mode config has never let it see. BOTH directions matter and they catch
    // different mistakes: a route mounted with no row is an undocumented
    // surface, a row with nothing mounted is the 07f63a3 defect itself.
    const { UNDOCUMENTED_ROUTES } = await import('./route-table.js');
    const documented = await documentedRoutes('production');
    const mounted = (await mountedRoutes('production')).filter(
      (key) => !UNDOCUMENTED_ROUTES.includes(key),
    );
    const documentedSet = new Set(documented);
    const mountedSet = new Set(mounted);
    expect({
      mountedButUndeclared: mounted.filter((key) => !documentedSet.has(key)),
      declaredButUnmounted: documented.filter((key) => !mountedSet.has(key)),
    }).toEqual({ mountedButUndeclared: [], declaredButUnmounted: [] });
  });

  it('the predicate itself is what both sides read', async () => {
    const { internalRoutesEnabled } = await import('../routes/internal-gate.js');
    expect(internalRoutesEnabled('production')).toBe(false);
    expect(internalRoutesEnabled('test')).toBe(true);
    expect(internalRoutesEnabled('development')).toBe(true);
    expect(internalRoutesEnabled(undefined)).toBe(true);
  });
});
