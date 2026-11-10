// GOLDEN: the exact bytes of `GET /v1/openapi.json`.
//
// `src/routes/openapi.test.ts` asserts the document's SHAPE (it is 3.1, every
// /v1 path is bearer-gated, a handful of schemas exist). That is the right
// test for "did someone break the spec", and the wrong test for "did anything
// about the published contract move" — it passes while a field's type, a
// description, an enum member or a required-list silently changes.
//
// This file pins the whole document. Its job is to make a refactor that is
// *supposed* to be behaviour-free provable: the Zod 3 → 4 upgrade and the
// single-contract-source extraction both claim "the served document does not
// change", and a claim like that is worth exactly as much as the diff that
// backs it.
//
// Re-record deliberately, and read the diff:
//     RECORD_OPENAPI_GOLDEN=1 npx vitest run src/openapi/document-golden.test.ts
// A changed line here is a change to what every consumer generates from.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { __resetOpenApiCacheForTests, getOpenApiDocument } from './registry.js';

const GOLDEN_PATH = fileURLToPath(new URL('./document.golden.json', import.meta.url));

/** Exactly what the route returns, serialised exactly as the route serialises it. */
function servedDocument(): string {
  __resetOpenApiCacheForTests();
  return `${JSON.stringify(getOpenApiDocument(), null, 2)}\n`;
}

// ── CORRECTED, first re-record ───────────────────────────────────────────────────
//
// The golden was re-recorded once, deliberately, and this block is the reason.
// Until this lane the served bytes were kept identical on purpose — the Zod
// 3→4 upgrade and the contract extraction both claimed "the document does not
// move", and the golden is what made those claims provable. This change is the
// opposite kind: the document was WRONG and is now derived from the same Zod
// schemas the service gates on, so it cannot go wrong the same way again.
//
// Each assertion below names one correction, so the diff that re-recorded the
// golden is legible from the test file rather than from a 4 000-line JSON diff.
// They are real assertions, not comments: a regression puts the old lie back
// and one of them goes red.
describe('corrected vs the earlier contract', () => {
  const doc = () => {
    __resetOpenApiCacheForTests();
    return getOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, Response> }>>;
      components: { schemas: Record<string, Schema> };
    };
  };
  interface Schema {
    required?: string[];
    properties?: Record<string, unknown>;
    $ref?: string;
  }
  interface Response {
    content?: Record<string, { schema: Schema }>;
    headers?: Record<string, unknown>;
  }
  const body = (path: string, method: string, status: string, type = 'application/json') =>
    doc().paths[path]?.[method]?.responses[status]?.content?.[type]?.schema as Schema;

  it('1. GET /health declares {status, service} — it never returned {ok:true}', () => {
    expect(body('/health', 'get', '200').required).toEqual(['status', 'service']);
  });

  it('2. GET /health/ready declares {status, checks}, and its 503 is NOT an error body', () => {
    // The handler sends the SAME object for both statuses, with
    // `status: 'degraded'` on the 503. The old document declared `{ready,
    // checks}` for the 200 and the flat error envelope for the 503.
    expect(body('/health/ready', 'get', '200').required).toEqual(['status', 'checks']);
    expect(body('/health/ready', 'get', '503').required).toEqual(['status', 'checks']);
  });

  it('3. the nested {error:{code,message}} envelope is modelled and used on the RAG plane', () => {
    // Eight `/v1/corpora` + `/v1/corpus` routes answer 404/409 with this shape
    // and the document declared the FLAT one — with `message` required at the
    // top level, where these bodies do not have it.
    expect(doc().components.schemas['NestedErrorBody']?.required).toEqual(['error']);
    expect(body('/v1/corpora/{name}', 'get', '404').$ref).toBe(
      '#/components/schemas/NestedErrorBody',
    );
    expect(body('/v1/corpora/{name}', 'patch', '409').$ref).toBe(
      '#/components/schemas/NestedErrorBody',
    );
  });

  it('4. POST /v1/generate/sync declares systemPromptApplied', () => {
    // Returned unconditionally, and the handle `src/capabilities.ts` names for
    // the system-prompt migration — so a consumer planning that migration was
    // reading a field the contract did not admit existed.
    const sync = doc().components.schemas['SyncGenerationResult'];
    expect(sync?.required).toContain('systemPromptApplied');
  });

  it('5. POST /v1/generate/sync declares 502, 503 (with retry-after), 504 and 499', () => {
    const responses = doc().paths['/v1/generate/sync']?.['post']?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '402',
      '429',
      '499',
      '502',
      '503',
      '504',
    ]);
    expect(Object.keys(responses['503']?.headers ?? {})).toEqual(['retry-after']);
    // 499 is a zero-byte body — declared, and declared as having no content.
    expect(responses['499']?.content).toBeUndefined();
  });

  it('6. POST /v1/generate no longer declares an impossible 403', () => {
    // No code path on that route can produce one; the 403s in this service are
    // `requireAdmin` and the two cross-tenant guards, none of which it has.
    expect(doc().paths['/v1/generate']?.['post']?.responses['403']).toBeUndefined();
  });

  it('7. the cancel response declares lostJobs', () => {
    // The ONLY signal that a cancel was incomplete — those jobs were already
    // in flight and may still bill.
    const cancel = body('/v1/generate/{requestId}/cancel', 'post', '200');
    expect(Object.keys(cancel.properties ?? {})).toContain('lostJobs');
  });

  it('8. every authenticated /v1 route declares a 429', () => {
    // The limiter is registered on the whole `/v1` prefix. It was declared on
    // no route at all.
    const missing: string[] = [];
    for (const [path, item] of Object.entries(doc().paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const secured = '401' in operation.responses;
        if (secured && !('429' in operation.responses)) missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('9. RegistryEntry and ProjectConfigResponse publish complete required sets', () => {
    // `z.unknown()` parses as REQUIRED under Zod 4 but zod-to-openapi still
    // emits it as optional, so four jsonb columns — `validators` among them,
    // which is `notNull default '[]'` and therefore always an array on the
    // wire — were published as optional AND untyped (`{}`).
    const entry = doc().components.schemas['RegistryEntry'];
    expect(entry?.required).toContain('validators');
    expect(entry?.properties?.['validators']).toMatchObject({ type: 'array' });
    expect(doc().components.schemas['ProjectConfigResponse']?.required).toContain('effortProfiles');
  });

  it('10. the second 409 code and the unvalidated ingest id are declared honestly', () => {
    const conflict = doc().paths['/v1/corpora/{name}']?.['patch']?.responses['409'];
    expect(JSON.stringify(conflict)).toContain('CHUNK_SIZE_LOCKED');
    // The handler echoes `{ingestId}` without validating it; declaring
    // `format: uuid` told consumers a constraint the service does not enforce.
    const parameters = JSON.stringify(doc().paths['/v1/ingest/{ingestId}']?.['get']);
    expect(parameters).not.toContain('uuid');
  });

  it('11. every route the server serves is in paths', () => {
    // `POST /v1/generate/stream`, both `/v1/admin/callbacks` routes,
    // `/v1/internal/*` and the authenticated `GET /v1/` ping were absent.
    // `routes-vs-document.test.ts` is the general gate; these are the five that
    // were actually missing.
    const paths = doc().paths;
    expect(paths['/v1/generate/stream']?.['post']).toBeDefined();
    expect(paths['/v1/admin/callbacks']?.['get']).toBeDefined();
    expect(paths['/v1/admin/callbacks/{deliveryId}/replay']?.['post']).toBeDefined();
    // Under `NODE_ENV=test`, which is what both vitest configs pin. In a
    // PRODUCTION document this row is absent on purpose — see block 16 below
    // and `internal-route-gate.test.ts`.
    expect(paths['/v1/internal/latest-trace']?.['get']).toBeDefined();
    expect(paths['/v1']?.['get']).toBeDefined();
  });
});

// ── CORRECTED, second re-record ───────────────────────────────────────────────────
//
// The second re-record, and the same rule: one assertion per correction, so
// the 929 changed leaves in the golden are legible from here.
//
// What moved, and why: the original fix removed nine route-layer catches that
// re-flattened a typed error, so twelve rows in `route-table.ts` were
// describing bodies the routes had stopped sending. Two more corrections are
// independent of it: 41 response headers were publishing raw Zod internals,
// and `GenerationJob.output` was declared optional while `serializeJob` writes
// it unconditionally.
describe('corrected vs the earlier spec', () => {
  const doc = () => {
    __resetOpenApiCacheForTests();
    return getOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, Response> }>>;
      components: { schemas: Record<string, Schema> };
    };
  };
  interface Schema {
    required?: string[];
    properties?: Record<string, unknown>;
    $ref?: string;
    anyOf?: { $ref?: string }[];
  }
  interface Response {
    content?: Record<string, { schema: Schema }>;
    headers?: Record<string, { schema?: unknown }>;
  }
  const body = (path: string, method: string, status: string) =>
    doc().paths[path]?.[method]?.responses[status]?.content?.['application/json']?.schema as Schema;
  /** The component names a status resolves to, `$ref` or `anyOf` alike. */
  const envelopes = (path: string, method: string, status: string): string[] => {
    const schema = body(path, method, status);
    const refs = schema?.$ref ? [schema.$ref] : (schema?.anyOf ?? []).map((a) => a.$ref ?? '?');
    return refs.map((r) => r.replace('#/components/schemas/', ''));
  };

  it('12. no response header publishes a Zod instance', () => {
    // `registry.ts` copies `row.headers` verbatim — zod-to-openapi converts
    // schemas under `content`, never under `headers`. 41 `retry-after` headers
    // were serialising a `ZodNumber`: 82 raw `def` keys on the wire.
    // `no-zod-internals.test.ts` is the general gate; this is the one that was
    // actually broken.
    const schemas: unknown[] = [];
    for (const item of Object.values(doc().paths)) {
      for (const operation of Object.values(item)) {
        for (const response of Object.values(operation.responses)) {
          const header = response.headers?.['retry-after'];
          if (header) schemas.push(header.schema);
        }
      }
    }
    expect(schemas.length).toBe(41);
    for (const schema of schemas) expect(schema).toEqual({ type: 'integer', minimum: 1 });
  });

  it('13. POST /v1/retrieve declares the NESTED 404 — one class, one envelope', () => {
    // Was `ProblemBody`: the route caught `CorpusNotFoundError` and re-sent it
    // through `reply.notFound`, so the same class answered two shapes
    // depending on which route raised it.
    expect(envelopes('/v1/retrieve', 'post', '404')).toEqual(['NestedErrorBody']);
  });

  it('14. the activate 404 declares the CODED flat envelope', () => {
    // `RegistryNotFoundError` reaches the wire now; it was flattened before.
    // Its sibling GET is deliberately NOT the same — that route still answers
    // through `reply.notFound`.
    expect(
      envelopes('/v1/registry/unit-types/{unitType}/versions/{version}/activate', 'post', '404'),
    ).toEqual(['CodedErrorBody']);
    expect(
      envelopes('/v1/registry/unit-types/{unitType}/versions/{version}', 'get', '404'),
    ).toEqual(['ProblemBody']);
    expect(doc().components.schemas['CodedErrorBody']?.required).toEqual([
      'error',
      'code',
      'message',
    ]);
  });

  it('15. every status with two producers declares BOTH envelopes', () => {
    // A 400 on a route that `safeParse`s its body is fastify-sensible when
    // validation fails and the raising class's own envelope when the handler
    // throws. Ten statuses were declaring only the first.
    const expected: Record<string, string[]> = {
      'POST /v1/corpora 400': ['ProblemBody', 'CodedErrorBody'],
      'PATCH /v1/corpora/{name} 400': ['ProblemBody', 'CodedErrorBody'],
      'POST /v1/ingest 400': ['ProblemBody', 'CodedErrorBody'],
      'PATCH /v1/corpus/{name}/documents/{externalId}/validity 400': [
        'ProblemBody',
        'CodedErrorBody',
      ],
      'POST /v1/registry/unit-types/{unitType}/versions 400': ['ProblemBody', 'CodedErrorBody'],
      // The pre-existing four: these send a FLAT body with no `code` and no
      // `statusCode` (`RenderError`, `SpecResolutionError`, …). `/v1/generate`
      // adds the coded arm on top, for the blocked callback URL.
      'POST /v1/generate 400': ['ProblemBody', 'ErrorBody', 'CodedErrorBody'],
      'POST /v1/generate/sync 400': ['ProblemBody', 'ErrorBody'],
      'POST /v1/generate/stream 400': ['ProblemBody', 'ErrorBody'],
      'POST /v1/embed 400': ['ProblemBody', 'ErrorBody'],
    };
    const actual: Record<string, string[]> = {};
    for (const key of Object.keys(expected)) {
      const [method, path, status] = key.split(' ') as [string, string, string];
      actual[key] = envelopes(path, method.toLowerCase(), status);
    }
    expect(actual).toEqual(expected);
    // `anyOf`, not `oneOf`, and deliberately: a `ProblemBody` ALSO validates
    // against the passthrough `ErrorBody`, so `oneOf` (exactly one match)
    // would be false for a body the service really sends.
    expect(body('/v1/generate', 'post', '400').anyOf).toHaveLength(3);
  });

  it('16. /v1/internal/latest-trace is declared only when it is mounted', () => {
    // Declared unconditionally before, while `server.ts` refuses to mount it
    // in production — so a production document advertised a 404. The full
    // both-modes gate is `internal-route-gate.test.ts`; this pins the
    // test-mode half and the prose that goes with it.
    const description = JSON.stringify(doc().paths['/v1/internal/latest-trace']?.['get']);
    expect(description).toContain('absent from ITS copy of this document too');
  });

  it('17. GenerationJob.output is REQUIRED and typed', () => {
    // `serializeJob` writes all ten keys unconditionally. `z.unknown()` parses
    // as required under Zod 4 but zod-to-openapi emitted it as OPTIONAL with
    // the empty schema `{}` — so a client typed it `output?: unknown`.
    const job = doc().components.schemas['GenerationJob'];
    expect(job?.required).toContain('output');
    expect(JSON.stringify(job?.properties?.['output'])).not.toBe('{}');
    // The `{text, flags}` branch is named, so `flags` is discoverable.
    expect(doc().components.schemas['GenerationFlag']?.required).toEqual([
      'severity',
      'code',
      'message',
    ]);
  });

  it('18. the four concretely-modelled jsonb fields are no longer opaque records', () => {
    // Measured against their writers: `effortProfiles` (two sites, one named
    // component), the readiness `checks[].detail` and the provision
    // `items[].detail`. The other six stay records ON PURPOSE — the reason is
    // written on each field in `contract/responses.ts`.
    const profiles = doc().components.schemas['EffortProfiles'];
    expect(Object.keys(profiles?.properties ?? {})).toEqual([
      'quick',
      'standard',
      'deep',
      'maximum',
    ]);
    for (const name of ['RegistryEntry', 'ProjectConfigResponse']) {
      expect(doc().components.schemas[name]?.properties?.['effortProfiles']).toMatchObject({
        anyOf: [{ $ref: '#/components/schemas/EffortProfiles' }, { type: 'null' }],
      });
    }
    const readiness = JSON.stringify(doc().components.schemas['ReadinessReport']);
    expect(readiness).toContain('activeUnitTypes');
    expect(readiness).toContain('remainingUsd');
  });
});

describe('golden: GET /v1/openapi.json', () => {
  it('the generated document is byte-identical to the recorded one', () => {
    const actual = servedDocument();

    if (process.env.RECORD_OPENAPI_GOLDEN === '1') {
      // A golden that can re-record itself under CI is not a gate: a change that
      // moves the document would rewrite the baseline and report green. The
      // flag is a LOCAL convenience for accepting a change you have read.
      if (process.env.CI) throw new Error('golden re-record is forbidden in CI');
      writeFileSync(GOLDEN_PATH, actual);
    }

    expect(actual).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });

  it('the route serves the same document the golden pins', async () => {
    // The comparison above runs the generator directly. This one goes through
    // the HTTP route, so a change to how the route serialises (or a cache that
    // hands out a stale document) cannot hide behind a green generator test.
    __resetOpenApiCacheForTests();
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
    await app.close();
  });
});
