// Central OpenAPI 3.1 builder — now THIN.
//
// It used to be 1256 lines: every path registered by hand, and every response
// body restated as a fresh inline `z.object({...})` next to it. That made the
// document a SECOND source of truth about what the service sends, and it
// drifted from the first one. Measured before the fix:
//
//   1. `GET /health` declared `{ok:true}`; it returns `{status, service}`.
//   2. `GET /health/ready` declared `{ready, checks}`; it returns
//      `{status, checks}`, and its 503 was declared as an error envelope
//      although it sends the same body as the 200.
//   3. The nested `{error:{code,message}}` envelope — what eight `/v1/corpora`
//      and `/v1/corpus` routes actually send on 404/409 — was not modelled at
//      all; the document declared the flat one everywhere.
//   4. `POST /v1/generate/sync` omitted `systemPromptApplied`, which is
//      returned unconditionally and is the handle `src/capabilities.ts` names
//      for the system-prompt migration.
//   5. `/v1/generate/sync` can answer 503 (with `retry-after`), 504 and 499.
//      None was declared.
//   6. `POST /v1/generate` declared a 403 no code path can produce.
//   7. `POST /v1/generate/{requestId}/cancel` omitted `lostJobs` — the only
//      signal that a cancel was incomplete.
//   8. A 429 is producible on every authenticated `/v1` route. Declared on none.
//   9. `ProjectConfigResponse` / `RegistryEntry` published wrong `required`
//      sets: `z.unknown()` parses as required under Zod 4 but zod-to-openapi
//      still emits it as optional, so `validators` — `notNull default '[]'`,
//      always an array on the wire — was documented as optional and untyped.
//  10. `PATCH /v1/corpora/{name}` has a SECOND 409 code, `CHUNK_SIZE_LOCKED`,
//      documented nowhere; and `GET /v1/ingest/{ingestId}` declared its path
//      parameter `uuid()` while the handler echoes it unvalidated.
//  11. `POST /v1/generate/stream`, both `/v1/admin/callbacks` routes,
//      `/v1/internal/*` and the authenticated `GET /v1/` ping were absent from
//      `paths` entirely.
//
// Now: the shapes live in `src/contract/` (requests AND responses), the names
// live in `components.ts`, one row per route lives in `route-table.ts`, and
// this file only turns rows into `registerPath` calls. Nothing here restates a
// shape, so there is nothing left to drift.
//
// Three tests hold it: `document-golden.test.ts` (the exact served bytes),
// `routes-vs-document.test.ts` (the document's path set equals the server's),
// and `response-parse.integration.test.ts` (a real response parses through the
// schema that claims to describe it).
//
// Security scheme: `Bearer` (HTTP bearer token). Applied by the builder to
// every row whose `auth` is not `none`.

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

// Importing `components.ts` is what REGISTERS every named schema — the module
// does its work as an import side effect, before any path references it.
import './components.js';
import { registry } from './registry-instance.js';
import { ROUTES, responsesFor, type ResponseRow, type RouteRow } from './route-table.js';

registry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Per-project bearer token. Resolves the caller to a {org, project} ' +
    'scope; every row is stamped with both. A key configured with a ' +
    'delegation prefix may also send `X-AI-Org: <suffix>` (suffix ' +
    '^[a-z0-9-]{1,48}$) to act as org `<prefix><suffix>`: budget, usage and ' +
    'corpora then belong to that org. The header on a key without a prefix ' +
    'is 403 org_delegation_forbidden; an invalid suffix is 400 invalid_org. ' +
    'Capability: orgDelegation.',
});

const BEARER = [{ Bearer: [] }];

function toResponseObject(row: ResponseRow): Record<string, unknown> {
  const out: Record<string, unknown> = { description: row.description };
  if (row.schema) {
    out['content'] = { [row.contentType ?? 'application/json']: { schema: row.schema } };
  }
  // 🔴 VERBATIM, and that is the whole hazard. `@asteasolutions/zod-to-openapi`
  // walks `content` and converts the Zod schema it finds there; it never looks
  // under `headers`. So whatever a row puts here is what reaches the wire. A
  // `z.number()` here published the Zod 4 instance — 41 headers, 82 raw `def`
  // keys in the served bytes. `ResponseRow.headers` is therefore typed as
  // PLAIN OpenAPI, and `no-zod-internals.test.ts` greps the finished document.
  if (row.headers) out['headers'] = row.headers;
  return out;
}

/** Status-keyed response objects, in ascending status order. */
function responseObjects(route: RouteRow): Record<string, unknown> {
  const rows = responsesFor(route);
  const out: Record<string, unknown> = {};
  for (const status of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    out[String(status)] = toResponseObject(rows[status] as ResponseRow);
  }
  return out;
}

for (const route of ROUTES) {
  const request: Record<string, unknown> = {};
  if (route.params) request['params'] = route.params;
  if (route.query) request['query'] = route.query;
  if (route.body) {
    request['body'] = {
      content: { 'application/json': { schema: route.body.schema } },
      ...(route.body.required === true ? { required: true } : {}),
    };
  }

  registry.registerPath({
    method: route.method,
    path: route.path,
    tags: [route.tag],
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    ...(route.auth === 'none' ? {} : { security: BEARER }),
    ...(Object.keys(request).length > 0 ? { request } : {}),
    responses: responseObjects(route),
  } as Parameters<typeof registry.registerPath>[0]);
}

// ---------------------------------------------------------------------------
// Document generation — cached.
// ---------------------------------------------------------------------------

let cached: OpenAPIObject | undefined;

export function getOpenApiDocument(): OpenAPIObject {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV31(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ai-service',
      version: '0.1.0',
      description:
        'Standalone, project-agnostic AI + RAG service. Consumed over HTTP by ' +
        'multiple applications. See `@edc/ai-client` for the typed client.\n\n' +
        'This document is DERIVED: every request and response shape in it comes ' +
        'from the Zod schemas in `src/contract/`, which are the same schemas the ' +
        'service gates on at runtime. Nothing here is restated by hand, so it ' +
        'cannot drift from the service.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Health' },
      { name: 'Generate' },
      { name: 'Events' },
      { name: 'Registry' },
      { name: 'Ingest' },
      { name: 'Retrieve' },
      { name: 'Route' },
      { name: 'Embed' },
      { name: 'Corpus' },
      { name: 'Budget' },
      { name: 'Tenant' },
      { name: 'Admin' },
      { name: 'Internal' },
    ],
  });
  return cached;
}

// Test seam — clear the module-scope cache so a regenerate picks up fresh
// definitions. Production never calls this.
export function __resetOpenApiCacheForTests(): void {
  cached = undefined;
}
