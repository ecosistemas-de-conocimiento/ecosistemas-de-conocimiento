// GATE: a real response parses through the schema that claims to describe it.
//
// The golden pins the document's BYTES and `routes-vs-document.test.ts` pins
// its PATH SET. Neither can tell whether the shapes are true — a document can
// be byte-stable, complete, and wrong, which is exactly what it was before the fix:
// `GET /health` declared `{ok:true}` and had been answering `{status,service}`
// the whole time.
//
// So this test closes the loop from the other end. For each case below it
// injects a real request, looks up the row in `route-table.ts` for that
// method+path+status, and parses the response body through the row's schema.
// A handler that adds, drops or retypes a field goes red HERE, naming the
// field, instead of silently in a consumer weeks later.
//
// ── What is covered, and what is not ──────────────────────────────────────
// Everything reachable without an upstream LLM: every DB-backed happy path
// plus at least one error per route. NOT covered: the 200 of
// `/v1/generate/sync`, `/v1/generate/stream`, `/v1/route` and `/v1/embed` —
// this repo has no mock-provider switch, so a 200 there would need a real
// OpenRouter call and a real bill. Those four are covered on their ERROR
// paths, and their 200 bodies are pinned instead by the unit tests that build
// the projection (`routes/generate-usage-wire.test.ts`,
// `errors/wire-golden.test.ts`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import { sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls config/env.ts / server.ts.
process.env.API_KEYS = JSON.stringify({
  'app-acme-chat': { org: 'acme', project: 'chat', role: 'app' },
  'admin-acme-chat': { org: 'acme', project: 'chat', role: 'admin' },
  // 🔴 ITS OWN BUCKET, and nothing else may present it. The limiter keys on
  // the API key (`v1RateLimitKey`, `server.ts`), the window is a full minute
  // and one server is shared by every case in this file — so a second case
  // using this token would inherit an exhausted bucket and 429 by accident.
  'burn-acme-chat': { org: 'acme', project: 'chat', role: 'app' },
});

// Keeps the REAL router — budget reservation, cache, traces, validators — and
// points the provider at the TEST-ONLY fake provider
// (`test-support/fake-provider/`) over real HTTP. Three tokens, unpaced, is
// enough to prove the `delta`* + `done` framing.
const fake = await startFakeProvider({ bodyTokens: 3 });
Object.assign(process.env, fake.env);

import type { FastifyInstance } from 'fastify';
import type { z } from '../contract/zod.js';

import { ROUTES, responsesFor } from './route-table.js';

import { GENERATE_RATE_LIMIT_MAX } from '../server-limits.js';

const APP = { authorization: 'Bearer app-acme-chat' };
const ADMIN = { authorization: 'Bearer admin-acme-chat' };
const BURN = { authorization: 'Bearer burn-acme-chat' };

/** One inject, reused for both the case itself and its `setup` steps. */
interface Inject {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly payload?: Record<string, unknown>;
}

/** Seeds reused by several cases. Each case runs its own — see `Case.setup`. */
const CREATE_CORPUS: Inject = {
  method: 'POST',
  url: '/v1/corpora',
  headers: APP,
  payload: { name: 'parse-gate', language: 'spanish', chunkSize: 1200 },
};
const SET_BUDGET: Inject = {
  method: 'PUT',
  url: '/v1/budget/acme',
  headers: ADMIN,
  payload: { limitUsd: 5 },
};
const CREATE_REGISTRY_ENTRY: Inject = {
  method: 'POST',
  url: '/v1/registry/unit-types/parse-gate-type/versions',
  headers: ADMIN,
  payload: { version: '1', promptTemplate: 'hello {{x}}', activate: true },
};

/**
 * A FULLY POPULATED registry entry — all four jsonb columns non-empty.
 *
 * Why it matters: `CREATE_REGISTRY_ENTRY` above leaves `effortProfiles`,
 * `responseSchema`, `metadata` null and `validators` at its `'[]'` default, so
 * every registry case was parsing the EMPTY rendering of the four columns the
 * document had most recently got wrong. A `null` parses against any nullable
 * schema, which is why the old declaration could be wrong and green at once.
 *
 * The `effortProfiles` value is the shape `pickProfileFromMap` reads — keyed
 * by effort level, each value a partial `EffortProfile` — which is what
 * `contract/responses.ts` now models concretely. A different unit type from
 * `CREATE_REGISTRY_ENTRY` so the two can never collide.
 */
const CREATE_POPULATED_ENTRY: Inject = {
  method: 'POST',
  url: '/v1/registry/unit-types/parse-gate-full/versions',
  headers: ADMIN,
  payload: {
    version: '1',
    promptTemplate: 'Resume {{documento}} en {{idioma}}.',
    metaPromptTemplate: 'Eres un asistente de redaccion clara.',
    model: 'deepseek/deepseek-chat-v3.1',
    defaultEffort: 'standard',
    effortProfiles: {
      quick: { model: 'deepseek/deepseek-chat-v3.1', maxOutputTokens: 400, temperature: 0.3 },
      standard: { maxOutputTokens: 800, validationPasses: 1, estimatedCostUsdPerCall: 0.000737 },
      deep: { maxOutputTokens: 3500, validationPasses: 2, multiSample: 1 },
      maximum: { maxOutputTokens: 6000, validationPasses: 2, multiSample: 3 },
    },
    responseSchema: {
      type: 'object',
      properties: { titulo: { type: 'string' } },
      required: ['titulo'],
    },
    // Both arms of `validatorSchema`: a builtin named as a bare string, and an
    // inline rule object whose only required field is `type`.
    validators: ['json-parses', { type: 'maxLength', max: 4000, severity: 'warn' }],
    renderer: 'markdown',
    contentKind: 'summary',
    metadata: { owner: 'parse-gate', ticket: 'PH2-OPENAPI' },
    activate: true,
  },
};

/**
 * 30 counted requests on `POST /v1/generate`'s OWN bucket.
 *
 * `@fastify/rate-limit` gives a route with its own `config.rateLimit` a CHILD
 * store with a separate LRU, so this spends the generate cap without touching
 * the 100/min every other `/v1` route shares. The limiter is an `onRequest`
 * hook — ahead of auth and of body validation — so these 400s still count.
 */
const BURN_GENERATE_BUCKET: readonly Inject[] = Array.from(
  { length: GENERATE_RATE_LIMIT_MAX },
  () => ({ method: 'POST' as const, url: '/v1/generate', headers: BURN, payload: {} }),
);

interface Case extends Inject {
  /** The row key in `route-table.ts` — OpenAPI path form. */
  /** The row key in `route-table.ts` — OpenAPI path form. */
  readonly route: string;
  readonly status: number;
  /**
   * Requests to run first, in order, whose responses are ignored.
   *
   * 🔴 EVERY CASE MUST BE SELF-CONTAINED. `integration-setup.ts` installs a
   * `beforeEach` that TRUNCATES the core tables, so a case cannot inherit a
   * row an earlier case created — that was measured here as a create landing
   * 201 and the read that followed it answering 404. Seed what you assert on.
   */
  readonly setup?: readonly Inject[];
}

/**
 * The schema the DOCUMENT publishes for one method+path+status.
 *
 * Reads through `responsesFor`, the same fold the builder uses, so the 401 /
 * 403 / 429 rows the table never restates are checked against real bodies too.
 */
function schemaFor(routeKey: string, status: number): z.ZodTypeAny | undefined {
  const [method, path] = routeKey.split(' ') as [string, string];
  const row = ROUTES.find((r) => r.method === method.toLowerCase() && r.path === path);
  if (!row) throw new Error(`no row in route-table.ts for ${routeKey}`);
  const response = responsesFor(row)[status];
  if (!response) throw new Error(`${routeKey} declares no ${status}`);
  return response.schema;
}

/**
 * Keys a response carries that its CLOSED schema never declared.
 *
 * Reads `catchall` off the Zod 4 object node: `undefined` means the shape is
 * closed (the default `strip` mode), anything else means `.passthrough()` /
 * `.catchall()` and the object is allowed extra keys. Unwraps optional,
 * nullable, default, array and union nodes so a nested addition is caught too.
 *
 * ⚠ SABOTAGE (measured): add a key to any handler's response literal — e.g.
 * `spare: 1` on the `/health` body — and the case for that route reports
 * `['$.spare']` while the parse itself stays green. That gap is the whole
 * reason this function exists.
 */
function undeclaredKeys(schema: z.ZodTypeAny, value: unknown, path: string): string[] {
  const node = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!node) return [];
  const type = node['type'] as string | undefined;

  if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'readonly') {
    return undeclaredKeys(node['innerType'] as z.ZodTypeAny, value, path);
  }
  if (type === 'union') {
    const options = node['options'] as z.ZodTypeAny[];
    // A union is only violated if EVERY arm that parses the value complains.
    // Arms that reject it outright are not evidence of an undeclared key.
    const matching = options.filter((o) => o.safeParse(value).success);
    if (matching.length === 0) return [];
    const perArm = matching.map((o) => undeclaredKeys(o, value, path));
    return perArm.every((hits) => hits.length > 0) ? (perArm[0] as string[]) : [];
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, i) =>
      undeclaredKeys(node['element'] as z.ZodTypeAny, item, `${path}[${i}]`),
    );
  }
  if (type !== 'object') return [];
  if (node['catchall'] !== undefined) return []; // .passthrough() / .catchall()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];

  const shape = node['shape'] as Record<string, z.ZodTypeAny>;
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const declared = shape[key];
    if (!declared) hits.push(`${path}.${key}`);
    else hits.push(...undeclaredKeys(declared, child, `${path}.${key}`));
  }
  return hits;
}

const CASES: readonly Case[] = [
  // ── Health ───────────────────────────────────────────────────────────────
  { route: 'GET /health', status: 200, url: '/health' },
  { route: 'GET /health/ready', status: 200, url: '/health/ready' },
  { route: 'GET /v1/capabilities', status: 200, url: '/v1/capabilities' },
  { route: 'GET /v1', status: 200, url: '/v1', headers: APP },
  { route: 'GET /v1', status: 401, url: '/v1' },

  // ── Corpora ──────────────────────────────────────────────────────────────
  {
    route: 'POST /v1/corpora',
    status: 201,
    method: 'POST',
    url: '/v1/corpora',
    headers: APP,
    payload: { name: 'parse-gate', language: 'spanish', chunkSize: 1200 },
  },
  { route: 'GET /v1/corpora', status: 200, url: '/v1/corpora', headers: APP },
  {
    route: 'GET /v1/corpora/{name}',
    status: 200,
    url: '/v1/corpora/parse-gate',
    headers: APP,
    setup: [CREATE_CORPUS],
  },
  { route: 'GET /v1/corpora/{name}', status: 404, url: '/v1/corpora/nope', headers: APP },
  {
    route: 'PATCH /v1/corpora/{name}',
    status: 200,
    method: 'PATCH',
    url: '/v1/corpora/parse-gate',
    headers: APP,
    payload: { chunkOverlap: 42 },
    setup: [CREATE_CORPUS],
  },
  {
    route: 'PATCH /v1/corpora/{name}',
    status: 400,
    method: 'PATCH',
    url: '/v1/corpora/parse-gate',
    headers: APP,
    payload: {},
    setup: [CREATE_CORPUS],
  },
  {
    route: 'DELETE /v1/corpora/{name}',
    status: 200,
    method: 'DELETE',
    url: '/v1/corpora/parse-gate',
    headers: APP,
    setup: [CREATE_CORPUS],
  },
  {
    route: 'DELETE /v1/corpus/{name}',
    status: 404,
    method: 'DELETE',
    url: '/v1/corpus/never-existed',
    headers: APP,
  },
  {
    route: 'POST /v1/corpus/{name}/alias',
    status: 404,
    method: 'POST',
    url: '/v1/corpus/an-alias/alias',
    headers: ADMIN,
    payload: { target: 'no-such-corpus' },
  },
  {
    route: 'POST /v1/corpus/{name}/alias',
    status: 403,
    method: 'POST',
    url: '/v1/corpus/an-alias/alias',
    headers: APP,
    payload: { target: 'whatever' },
  },
  {
    route: 'DELETE /v1/corpus/{name}/documents/{externalId}',
    status: 404,
    method: 'DELETE',
    url: '/v1/corpus/nope/documents/doc-1',
    headers: APP,
  },
  {
    route: 'PATCH /v1/corpus/{name}/documents/{externalId}/validity',
    status: 404,
    method: 'PATCH',
    url: '/v1/corpus/nope/documents/doc-1/validity',
    headers: APP,
    payload: { validFrom: '2026-01-01T00:00:00.000Z' },
  },
  {
    route: 'PATCH /v1/corpus/{name}/titles',
    status: 404,
    method: 'PATCH',
    url: '/v1/corpus/nope/titles',
    headers: ADMIN,
    payload: { documents: [{ externalId: 'doc-1', title: 'x' }] },
  },
  {
    route: 'PATCH /v1/corpus/{name}/titles',
    status: 403,
    method: 'PATCH',
    url: '/v1/corpus/nope/titles',
    headers: APP,
    payload: { documents: [{ externalId: 'doc-1', title: 'x' }] },
  },

  // ── Ingest / retrieve / embed / route ────────────────────────────────────
  {
    // 404 since PLAN-live-ingest L1 (finding A11): an unknown id used to be
    // echoed back as a 200 `processing` snapshot. The 200 is parsed by the
    // bespoke case below, which needs a real ingest id.
    route: 'GET /v1/ingest/{ingestId}',
    status: 404,
    url: '/v1/ingest/00000000-0000-4000-8000-000000000000',
    headers: APP,
  },
  {
    route: 'POST /v1/ingest',
    status: 400,
    method: 'POST',
    url: '/v1/ingest',
    headers: APP,
    payload: {},
  },
  {
    route: 'POST /v1/retrieve',
    status: 404,
    method: 'POST',
    url: '/v1/retrieve',
    headers: APP,
    payload: { corpus: 'no-such-corpus', query: 'hello' },
  },
  {
    route: 'POST /v1/retrieve/multi',
    status: 400,
    method: 'POST',
    url: '/v1/retrieve/multi',
    headers: APP,
    payload: {},
  },
  {
    route: 'POST /v1/embed',
    status: 400,
    method: 'POST',
    url: '/v1/embed',
    headers: APP,
    payload: {},
  },
  {
    route: 'POST /v1/route',
    status: 400,
    method: 'POST',
    url: '/v1/route',
    headers: APP,
    payload: {},
  },

  // ── Generate ─────────────────────────────────────────────────────────────
  {
    route: 'POST /v1/generate',
    status: 400,
    method: 'POST',
    url: '/v1/generate',
    headers: APP,
    payload: {},
  },
  {
    route: 'POST /v1/generate/sync',
    status: 400,
    method: 'POST',
    url: '/v1/generate/sync',
    headers: APP,
    payload: {},
  },
  {
    route: 'POST /v1/generate/stream',
    status: 400,
    method: 'POST',
    url: '/v1/generate/stream',
    headers: APP,
    payload: {},
  },
  {
    route: 'GET /v1/generate/{requestId}',
    status: 404,
    url: '/v1/generate/00000000-0000-4000-8000-000000000000',
    headers: APP,
  },
  {
    route: 'POST /v1/generate/{requestId}/cancel',
    status: 404,
    method: 'POST',
    url: '/v1/generate/00000000-0000-4000-8000-000000000000/cancel',
    headers: APP,
  },
  {
    route: 'GET /v1/generate/units/{unitKey}/latest',
    status: 404,
    url: '/v1/generate/units/no-such-unit/latest',
    headers: APP,
  },
  { route: 'GET /v1/events/{channel}', status: 400, url: '/v1/events/not-a-channel', headers: APP },

  // ── Budget / tenant ──────────────────────────────────────────────────────
  {
    route: 'PUT /v1/budget/{org}',
    status: 201,
    method: 'PUT',
    url: '/v1/budget/acme',
    headers: ADMIN,
    payload: { limitUsd: 5 },
  },
  {
    route: 'PUT /v1/budget/{org}',
    status: 200,
    method: 'PUT',
    url: '/v1/budget/acme',
    headers: ADMIN,
    payload: { limitUsd: 7 },
    setup: [SET_BUDGET],
  },
  {
    route: 'GET /v1/budget/{org}',
    status: 200,
    url: '/v1/budget/acme',
    headers: APP,
    setup: [SET_BUDGET],
  },
  { route: 'GET /v1/budget/{org}', status: 403, url: '/v1/budget/someone-else', headers: APP },
  { route: 'GET /v1/tenant/readiness', status: 200, url: '/v1/tenant/readiness', headers: APP },
  {
    route: 'POST /v1/tenant/provision',
    status: 200,
    method: 'POST',
    url: '/v1/tenant/provision',
    headers: ADMIN,
    payload: { budget: { limitUsd: 5 } },
  },
  {
    route: 'POST /v1/tenant/provision',
    status: 403,
    method: 'POST',
    url: '/v1/tenant/provision',
    headers: APP,
    payload: {},
  },

  // ── Registry ─────────────────────────────────────────────────────────────
  { route: 'GET /v1/registry/config', status: 200, url: '/v1/registry/config', headers: APP },
  {
    route: 'PUT /v1/registry/config',
    status: 200,
    method: 'PUT',
    url: '/v1/registry/config',
    headers: ADMIN,
    payload: { defaultModel: 'openai/gpt-4o-mini' },
  },
  { route: 'GET /v1/registry/unit-types', status: 200, url: '/v1/registry/unit-types', headers: APP },
  {
    route: 'POST /v1/registry/unit-types/{unitType}/versions',
    status: 201,
    method: 'POST',
    url: '/v1/registry/unit-types/parse-gate-type/versions',
    headers: ADMIN,
    payload: { version: '1', promptTemplate: 'hello {{x}}', activate: true },
  },
  {
    route: 'GET /v1/registry/unit-types/{unitType}/versions',
    status: 200,
    url: '/v1/registry/unit-types/parse-gate-type/versions',
    headers: APP,
    setup: [CREATE_REGISTRY_ENTRY],
  },
  {
    route: 'GET /v1/registry/unit-types/{unitType}/versions/{version}',
    status: 200,
    url: '/v1/registry/unit-types/parse-gate-type/versions/1',
    headers: APP,
    setup: [CREATE_REGISTRY_ENTRY],
  },
  {
    route: 'GET /v1/registry/unit-types/{unitType}/versions/{version}',
    status: 404,
    url: '/v1/registry/unit-types/parse-gate-type/versions/99',
    headers: APP,
  },
  {
    route: 'POST /v1/registry/unit-types/{unitType}/versions/{version}/activate',
    status: 200,
    method: 'POST',
    url: '/v1/registry/unit-types/parse-gate-type/versions/1/activate',
    headers: ADMIN,
    setup: [CREATE_REGISTRY_ENTRY],
  },
  {
    route: 'POST /v1/registry/unit-types/{unitType}/versions/{version}/activate',
    status: 404,
    method: 'POST',
    url: '/v1/registry/unit-types/parse-gate-type/versions/99/activate',
    headers: ADMIN,
  },

  // ── Admin / internal ─────────────────────────────────────────────────────
  { route: 'GET /v1/admin/callbacks', status: 200, url: '/v1/admin/callbacks', headers: ADMIN },
  { route: 'GET /v1/admin/callbacks', status: 403, url: '/v1/admin/callbacks', headers: APP },
  {
    route: 'POST /v1/admin/callbacks/{deliveryId}/replay',
    status: 404,
    method: 'POST',
    url: '/v1/admin/callbacks/00000000-0000-4000-8000-000000000000/replay',
    headers: ADMIN,
  },
  {
    route: 'GET /v1/openrouter/credits',
    status: 403,
    url: '/v1/openrouter/credits',
    headers: APP,
  },
  {
    route: 'GET /v1/internal/latest-trace',
    status: 400,
    url: '/v1/internal/latest-trace',
    headers: APP,
  },
  {
    route: 'GET /v1/internal/latest-trace',
    status: 404,
    url: '/v1/internal/latest-trace?unitKey=no-such-unit',
    headers: APP,
  },

  // ── The CODED flat envelope, `{error, code, message}` ────────────────────
  // Until the original fix every one of these was caught by its route and
  // re-sent through fastify-sensible, so the shape below has never been on the
  // wire before and no case here had ever parsed it.
  {
    // `openai/text-embedding-3-small` emits 1536-dim vectors; this
    // deployment's `chunks.embedding` column is `vector(1024)`
    // (`EMBEDDING_DIM` default). `routes/corpora.ts` does NOT catch, so
    // `EmbeddingDimensionMismatchError` reaches the wire with its own `code`
    // AND its extra fields — which is why `CodedErrorBody` is passthrough.
    route: 'POST /v1/corpora',
    status: 400,
    method: 'POST',
    url: '/v1/corpora',
    headers: APP,
    payload: { name: 'dim-mismatch', embeddingModel: 'openai/text-embedding-3-small' },
  },
  {
    // The same `(unitType, version)` twice. `createVersion` throws
    // `RegistryConflictError` inside the transaction and the route
    // deliberately does not catch. 400, NOT 409 — the class adopted the status
    // the route had always sent.
    route: 'POST /v1/registry/unit-types/{unitType}/versions',
    status: 400,
    method: 'POST',
    url: '/v1/registry/unit-types/parse-gate-type/versions',
    headers: ADMIN,
    payload: { version: '1', promptTemplate: 'hello {{x}}', activate: true },
    setup: [CREATE_REGISTRY_ENTRY],
  },

  // ── A POPULATED registry entry — all four jsonb columns non-empty ────────
  {
    route: 'POST /v1/registry/unit-types/{unitType}/versions',
    status: 201,
    ...CREATE_POPULATED_ENTRY,
  },
  {
    // The READ side is where a populated jsonb column can drift from its
    // declared schema; the 201 above only echoes what it just wrote.
    route: 'GET /v1/registry/unit-types/{unitType}/versions/{version}',
    status: 200,
    url: '/v1/registry/unit-types/parse-gate-full/versions/1',
    headers: APP,
    setup: [CREATE_POPULATED_ENTRY],
  },

  // ── The 429, and it MUST STAY LAST ──────────────────────────────────────
  // 31 requests on one key inside a one-minute window. Anything added after it
  // that presents `burn-acme-chat` inherits the spent bucket.
  {
    route: 'POST /v1/generate',
    status: 429,
    method: 'POST',
    url: '/v1/generate',
    headers: BURN,
    payload: {},
    setup: BURN_GENERATE_BUCKET,
  },
];

describe('every declared response schema parses a real response', () => {
  let app: FastifyInstance;

  // RAG tables are not in the shared per-test truncate list, so this file
  // wipes them itself — before EVERY case, so a corpus seeded by one case
  // cannot make another case's "not found" pass for the wrong reason.
  beforeEach(async () => {
    const { db } = await import('../db/client.js');
    await db.execute(
      sql`TRUNCATE TABLE chunks, documents, corpus_aliases, corpora RESTART IDENTITY CASCADE`,
    );
  });

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  await fake.close();
  });

  const inject = async (step: Inject) =>
    app.inject({
      method: step.method ?? 'GET',
      url: step.url,
      ...(step.headers ? { headers: step.headers } : {}),
      ...(step.payload === undefined ? {} : { payload: step.payload }),
    });

  for (const testCase of CASES) {
    it(`${testCase.route} → ${testCase.status}`, async () => {
      for (const step of testCase.setup ?? []) await inject(step);
      const res = await app.inject({
        method: testCase.method ?? 'GET',
        url: testCase.url,
        ...(testCase.headers ? { headers: testCase.headers } : {}),
        ...(testCase.payload === undefined ? {} : { payload: testCase.payload }),
      });

      // Status first: a wrong status means the case, not the schema, is stale,
      // and parsing the body would report a confusing field error instead.
      expect(res.statusCode, res.body.slice(0, 400)).toBe(testCase.status);

      const schema = schemaFor(testCase.route, testCase.status);
      if (!schema) {
        expect(res.body).toBe('');
        return;
      }
      const body: unknown = res.json();
      const parsed = schema.safeParse(body);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        `${testCase.route} ${testCase.status} body does not match its declared schema`,
      ).toEqual([]);

      // A parse alone cannot see an ADDED field — Zod 4 objects STRIP unknown
      // keys, so a handler that grows one stays green forever. `.strict()`
      // would catch it and is the wrong fix: it publishes
      // `additionalProperties: false`, and a strict generated client would
      // then reject the NEXT field ai-service ships. So the check lives here
      // instead of in the schema, and it honours `.passthrough()` — the four
      // error envelopes carry class-specific fields by design.
      expect(
        undeclaredKeys(schema, body, '$'),
        `${testCase.route} ${testCase.status} sends fields its declared schema does not name`,
      ).toEqual([]);
    });
  }

  it('GET /v1/ingest/{ingestId} → 200, a real snapshot parses through its schema', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: APP,
      payload: { corpus: 'parse-ingest', documents: [{ id: 'd1', text: 'hello' }] },
    });
    expect(post.statusCode, post.body.slice(0, 400)).toBe(202);
    const { ingestId } = post.json() as { ingestId: string };
    const res = await app.inject({ method: 'GET', url: `/v1/ingest/${ingestId}`, headers: APP });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const schema = schemaFor('GET /v1/ingest/{ingestId}', 200)!;
    const body: unknown = res.json();
    const parsed = schema.safeParse(body);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.message)).toEqual([]);
    expect(undeclaredKeys(schema, body, '$')).toEqual([]);
  });

  /**
   * SSE frames as JSON. The `data: ` filter is what skips the opening `: ok`
   * comment frame, which is not JSON and has no schema.
   */
  const frames = (payload: string): Record<string, unknown>[] =>
    payload
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice('data: '.length)) as Record<string, unknown>);

  it('POST /v1/generate/stream → 200, every SSE frame parses through its declared union', async () => {
    // The one 200 in this file that `res.json()` cannot read, so it does not
    // ride the `CASES` loop. It is worth the bespoke case: the stream 200 is
    // the only response whose declared schema is a discriminated UNION, and
    // nothing had ever parsed a real frame through it.
    //
    // 🔴 BUDGET FIRST. `/stream` reserves budget INSIDE `router.route()` — i.e.
    // after the reply is hijacked — so a missing `budget_state` row is a 200
    // carrying an `error` frame, not a 402. The row is truncated per test, so
    // this case seeds its own.
    await inject(SET_BUDGET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/stream',
      headers: APP,
      payload: {
        unit: {
          // ⚠ UNIQUE. The router cache is a process-wide singleton keyed on
          // (model, messages, …) and the per-test truncate does not touch it —
          // a repeated prompt is a cache HIT and emits ZERO delta frames.
          unitKey: `parse-gate-stream-${Date.now()}`,
          input: { name: 'parse-gate' },
          // No registry row needed: an inline override satisfies both
          // `resolveSpec`'s precondition and its prompt precedence.
          specOverride: { promptTemplate: 'hola {{name}} — parse gate' },
        },
      },
    });

    expect(res.statusCode, res.payload.slice(0, 400)).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const parsedFrames = frames(res.payload);
    expect(parsedFrames.length).toBeGreaterThan(1);
    // `done`, never `error`. An error frame here means the budget seed or the
    // spec override did not take — and the 200 status line would hide it.
    expect(parsedFrames.at(-1)?.['type']).toBe('done');
    expect(parsedFrames.slice(0, -1).map((f) => f['type'])).toEqual(
      parsedFrames.slice(0, -1).map(() => 'delta'),
    );

    const schema = schemaFor('POST /v1/generate/stream', 200);
    if (!schema) throw new Error('the table declares no schema for the stream 200');
    for (const [i, frame] of parsedFrames.entries()) {
      const parsed = schema.safeParse(frame);
      expect(
        parsed.success ? [] : parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`),
        `frame ${i} (${String(frame['type'])}) does not match the declared frame union`,
      ).toEqual([]);
      expect(undeclaredKeys(schema, frame, `frame[${i}]`)).toEqual([]);
    }
  });

  it('covers every route in the table on at least one status', () => {
    // Without this, a route added to the table with no case here would be
    // "declared" and never checked against a real response — which is the
    // exact failure mode this file exists to remove.
    const covered = new Set(CASES.map((c) => c.route));
    const uncovered = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).filter(
      (key) => !covered.has(key),
    );
    // The document-only surfaces: `/robots.txt`, `/metrics`, `/v1/openapi.json`
    // and `/v1/docs` are not JSON and are pinned by their own tests.
    expect(uncovered).toEqual([
      'GET /robots.txt',
      'GET /metrics',
      'GET /v1/openapi.json',
      'GET /v1/docs',
    ]);
  });
});
