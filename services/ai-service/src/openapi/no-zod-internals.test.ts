// GATE: the SERVED document contains no Zod internals.
//
// ── The defect this pins (measured on 07f63a3) ────────────────────────────
// `route-table.ts` declared response HEADERS with Zod schemas
// (`schema: z.number().int().positive()`) exactly the way it declares bodies.
// Bodies work: `registry.registerPath` hands them to
// `@asteasolutions/zod-to-openapi`, which converts them. Headers do NOT — the
// generator walks `content`, never `headers`, and `registry.ts` copied the
// header object into the response VERBATIM (`out['headers'] = row.headers`).
//
// So `GET /v1/openapi.json` published the Zod 4 instance itself. MEASURED on
// 07f63a3: 41 `retry-after` headers, each serialising the same `ZodNumber`, for
// 82 raw internal keys in the served bytes. Every code generator run against
// that document saw a header schema that was an opaque blob with `def` and a
// nested `checks` array instead of `{type:'integer'}`.
//
// The fix is upstream of this test: `ResponseRow.headers` is typed as PLAIN
// OpenAPI, so a Zod schema there no longer typechecks. This file is the second
// line — it greps the finished document, so ANY future path that smuggles a
// schema object through un-converted goes red here regardless of which field
// carried it.
//
// ⚠ SABOTAGE (measured): put `schema: z.number().int().positive()`
// back in `RETRY_AFTER_HEADER` (cast past the type) and ALL THREE tests here
// go red — the walk reports
// `$.paths./v1.get.responses.429.headers.retry-after.schema.def`, the byte
// check reports `def` present, and the positive check reports a `ZodNumber`
// where `{type:'integer',minimum:1}` belongs. The walk names only two paths
// rather than 41 because one shared `ZodNumber` instance is reachable from all
// 41 responses and the `WeakSet` visits it once; the byte check is what covers
// the other 40.
//
// ⚠ `checks` is deliberately NOT in the forbidden list even though a Zod
// internal carries one. It is also a REAL published field name — the
// `/health/ready` body and `ReadinessReport` both have `checks` — so
// forbidding it outright would be a false red on a legitimate contract field.
// `def` and `_zod` have no such collision: nothing in `src/contract/` names a
// field either of those, and `_zod` alone is enough to identify a Zod 4
// instance.

import { describe, expect, it } from 'vitest';

import { __resetOpenApiCacheForTests, getOpenApiDocument } from './registry.js';

/** Keys that can only come from a Zod instance that was never converted. */
const ZOD_INTERNAL_KEYS = ['def', '_zod', '~standard', '_def'] as const;

function offendingPaths(): string[] {
  __resetOpenApiCacheForTests();
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((ZOD_INTERNAL_KEYS as readonly string[]).includes(key)) hits.push(`${path}.${key}`);
      walk(value, `${path}.${key}`);
    }
  };
  walk(getOpenApiDocument(), '$');
  return hits;
}

describe('the served OpenAPI document publishes no Zod internals', () => {
  it('has no `def` / `_zod` / `~standard` key anywhere', () => {
    expect(offendingPaths()).toEqual([]);
  });

  it('serialises to JSON with none of those key names in the bytes', () => {
    // The walk above stops at a value it cannot enumerate. This one reads what
    // the route actually writes, so a getter-backed internal is caught too.
    __resetOpenApiCacheForTests();
    const bytes = JSON.stringify(getOpenApiDocument());
    for (const key of ZOD_INTERNAL_KEYS) {
      expect(bytes.includes(`"${key}":`), `\`${key}\` appears in the served bytes`).toBe(false);
    }
  });

  it('declares `retry-after` as a plain integer schema, on every route that sends it', () => {
    // The positive half: the fix must not have been "delete the headers".
    __resetOpenApiCacheForTests();
    const doc = getOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          { responses?: Record<string, { headers?: Record<string, { schema?: unknown }> }> }
        >
      >;
    };
    const found: unknown[] = [];
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const response of Object.values(op.responses ?? {})) {
          const header = response.headers?.['retry-after'];
          if (header) found.push(header.schema);
        }
      }
    }
    expect(found.length).toBeGreaterThan(30);
    for (const schema of found) expect(schema).toEqual({ type: 'integer', minimum: 1 });
  });
});
