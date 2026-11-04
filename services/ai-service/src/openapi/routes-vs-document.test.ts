// GATE: the document's path set IS the server's route set.
//
// A hand-maintained route table falls behind the server it describes, and it
// does it silently — nothing type-checks a missing row and no other test
// notices. Measured before the fix, five reachable endpoints were absent from
// `GET /v1/openapi.json`: `POST /v1/generate/stream`, both
// `/v1/admin/callbacks` routes, `/v1/internal/latest-trace`, and the
// authenticated `GET /v1/` ping. A consumer reading the published contract
// could not learn that streaming generation exists.
//
// This test makes that impossible in BOTH directions:
//   · a route added to `server.ts` with no row in `route-table.ts` → red
//   · a row for a route the server does not serve → red
//
// The only sanctioned gap is `UNDOCUMENTED_ROUTES` (the Swagger UI static
// mount and the holding page), with its reason written down.

import { describe, expect, it } from 'vitest';

import { listAppRoutes } from './app-routes.js';
import { __resetOpenApiCacheForTests, getOpenApiDocument } from './registry.js';
import { ROUTES, UNDOCUMENTED_ROUTES } from './route-table.js';

/** `GET /v1/corpora/{name}` for every method/path pair the document declares. */
function documentedRoutes(): string[] {
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

describe('the served document describes exactly the routes the server serves', () => {
  it('every mounted route is declared, and every declared path is mounted', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    await app.ready();
    const mounted = listAppRoutes(app);
    await app.close();

    const documented = documentedRoutes();
    const sanctioned = new Set(UNDOCUMENTED_ROUTES);

    const undeclared = mounted.filter((r) => !documented.includes(r) && !sanctioned.has(r));
    const phantom = documented.filter((r) => !mounted.includes(r));

    // Two separate assertions, because the two failures need different fixes:
    // an undeclared route needs a row in `route-table.ts`; a phantom path
    // means the row's `path` does not match the mounted route (usually a
    // `:param` / `{param}` or trailing-slash mismatch).
    expect(undeclared, 'routes the server serves that the document does not declare').toEqual([]);
    expect(phantom, 'paths the document declares that the server does not serve').toEqual([]);
  });

  it('every sanctioned gap is a route that actually exists', async () => {
    // An entry left behind after its route was deleted would quietly widen the
    // escape hatch for the NEXT route that lands on the same key.
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    await app.ready();
    const mounted = new Set(listAppRoutes(app));
    await app.close();

    for (const key of UNDOCUMENTED_ROUTES) {
      expect(mounted.has(key), `${key} is sanctioned as undocumented but is not mounted`).toBe(
        true,
      );
    }
  });

  it('no two rows in the table claim the same method + path', () => {
    const seen = new Map<string, number>();
    for (const route of ROUTES) {
      const key = `${route.method.toUpperCase()} ${route.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('every path parameter in a row path is declared by that row', () => {
    // A `{name}` in the path with no `params` schema generates a document that
    // Swagger UI renders without an input for it.
    for (const route of ROUTES) {
      const inPath = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      if (inPath.length === 0) continue;
      const declared = Object.keys(
        (route.params as { shape?: Record<string, unknown> } | undefined)?.shape ?? {},
      );
      expect(declared.sort(), `${route.method} ${route.path}`).toEqual([...inPath].sort());
    }
  });
});
