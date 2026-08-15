// Unit tests for /v1/openapi.json + /v1/docs.
//
// Both endpoints are unauthenticated (the spec documents the surface; the
// docs HTML is a static viewer). Existence is the contract; the test asserts
// minimal OpenAPI 3.1 structure on the JSON and a recognisable Swagger UI
// snippet on the HTML.

import { describe, expect, it } from 'vitest';

import { __resetOpenApiCacheForTests, getOpenApiDocument } from '../openapi/registry.js';
import { useBuildServer } from '../test/server-harness.js';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`. The OpenAPI cache
// reset stays per-test: it is cheap, and each run wants a fresh generation
// pass.
const buildServer = useBuildServer();

async function makeApp() {
  // Reset between tests so each run picks up a fresh generation pass.
  __resetOpenApiCacheForTests();
  return buildServer();
}

describe('GET /v1/openapi.json', () => {
  it('returns 200 with a valid OpenAPI 3.1 document (no auth required)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.info?.title).toBe('ai-service');
    expect(body.paths).toBeDefined();
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    expect(body.components?.schemas).toBeDefined();
    expect(body.components.schemas.GenerateRequest).toBeDefined();
    // The bearer security scheme is present and reachable.
    expect(body.components.securitySchemes?.Bearer?.type).toBe('http');
    await app.close();
  });

  // Documented, deliberate exceptions to "every /v1/* path is bearer-gated".
  // Keep this list short and justified — each entry is a publicly readable
  // surface, so anything added here must contain no tenant data.
  //   /v1/capabilities — ADR-0004. Consumers negotiate at boot, before any
  //     tenant context exists, and must be able to tell "missing capability"
  //     apart from "bad API key".
  const UNAUTHENTICATED_V1_PATHS = new Set(['/v1/capabilities']);

  it('declares every documented /v1/* path with Bearer security', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const body = res.json();
    for (const [pathKey, methods] of Object.entries<Record<string, unknown>>(body.paths)) {
      if (!pathKey.startsWith('/v1/')) continue;
      if (UNAUTHENTICATED_V1_PATHS.has(pathKey)) continue;
      for (const op of Object.values(methods)) {
        const security = (op as { security?: unknown[] }).security;
        expect(Array.isArray(security), `${pathKey} missing security`).toBe(true);
      }
    }
    await app.close();
  });
});

describe('GET /v1/docs', () => {
  it('returns 200 with an HTML page that loads Swagger UI', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('swagger-ui');
    expect(res.body).toContain('/v1/openapi.json');
    await app.close();
  });

  it('does not reference any external CDN (air-gap safe)', async () => {
    // Air-gapped deployments can't reach jsdelivr / unpkg / generic
    // `https://cdn.*` hosts. The UI must load all assets from same-origin
    // /v1/docs/* paths.
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('jsdelivr.net');
    expect(res.body).not.toContain('unpkg.com');
    expect(res.body).not.toMatch(/https:\/\/cdn\./);
    await app.close();
  });

  it('serves vendored swagger-ui-bundle.js from /v1/docs/', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/docs/swagger-ui-bundle.js',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/javascript/);
    // Sanity: the body looks like the real swagger-ui bundle.
    expect(res.body.length).toBeGreaterThan(1000);
    await app.close();
  });

  it('serves vendored swagger-ui.css from /v1/docs/', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/docs/swagger-ui.css',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    await app.close();
  });
});

describe('getOpenApiDocument()', () => {
  it('produces a cached, structurally valid document', () => {
    __resetOpenApiCacheForTests();
    const doc = getOpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    const paths = doc.paths ?? {};
    expect(paths['/v1/generate']).toBeDefined();
    expect(paths['/v1/generate/sync']).toBeDefined();
    expect(paths['/v1/events/{channel}']).toBeDefined();
    expect(paths['/v1/budget/{org}']).toBeDefined();
    expect(paths['/v1/ingest']).toBeDefined();
    expect(paths['/v1/retrieve']).toBeDefined();
    expect(paths['/v1/embed']).toBeDefined();
    expect(paths['/v1/tenant/readiness']).toBeDefined();
    expect(paths['/v1/tenant/provision']).toBeDefined();
    // Identity-cache: second call returns the same object.
    expect(getOpenApiDocument()).toBe(doc);
  });

  it('documents the system-prompt fields as optional (forward-compatible)', () => {
    __resetOpenApiCacheForTests();
    const doc = getOpenApiDocument();
    const schemas = (doc.components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
    // New request fields must never be `required` — an unmigrated consumer's
    // body has to keep validating byte-for-byte.
    expect(schemas.Unit?.properties?.systemPrompt).toBeDefined();
    expect(schemas.Unit?.required ?? []).not.toContain('systemPrompt');
    expect(schemas.GenerateRequest?.properties?.systemPromptOverride).toBeDefined();
    expect(schemas.GenerateRequest?.required ?? []).not.toContain('systemPromptOverride');
    expect(schemas.GenerateSyncRequest?.properties?.systemPromptOverride).toBeDefined();
  });

  it('documents the budget write + tenant provisioning surface', () => {
    __resetOpenApiCacheForTests();
    const doc = getOpenApiDocument();
    const paths = doc.paths ?? {};
    expect((paths['/v1/budget/{org}'] as Record<string, unknown>)?.put).toBeDefined();
    const schemas = (doc.components?.schemas ?? {}) as Record<string, unknown>;
    expect(schemas.SetBudgetRequest).toBeDefined();
    expect(schemas.ProvisionTenantRequest).toBeDefined();
  });

  it('RetrieveRequest exposes the optional metadata `filter` (auto-derived from Zod)', () => {
    __resetOpenApiCacheForTests();
    const doc = getOpenApiDocument();
    const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    const retrieve = schemas.RetrieveRequest;
    expect(retrieve).toBeDefined();
    // The new field is present and optional (not in `required`), so filter-less
    // requests keep validating — the forward-compat guarantee.
    expect(retrieve?.properties?.filter).toBeDefined();
    expect(retrieve?.required ?? []).not.toContain('filter');
  });
});
