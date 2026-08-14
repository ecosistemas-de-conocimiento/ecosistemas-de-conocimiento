// Central OpenAPI 3.1 registry.
//
// Builds the document from the existing Zod schemas (the runtime gate) — one
// source of truth, no parallel hand-written schema set. Each request/response
// body is registered with `.openapi('Name', { ... })`; each endpoint declared
// via `registry.registerPath(...)`. The document is generated once at first
// access and cached in module scope (cheap; Zod-to-OpenAPI is pure).
//
// Security scheme: `Bearer` (HTTP bearer token) — applied to every `/v1/*`
// path. `/v1/openapi.json` and `/v1/docs` are explicitly unauthenticated and
// declared in `src/routes/openapi.ts` so they don't appear in the security
// requirement here.
//
// Reference: plan/m3-m4-decisions.md for the surface inventory.
//
// The registry deliberately uses simplified response bodies (object with a
// `type` of `object` and `additionalProperties: true`) where the server-side
// response shape is computed at runtime (e.g. job rows from the DB) — the
// typed client carries the precise TS type. The OpenAPI doc is a contract
// surface for *external* consumers and a `/docs` viewer convenience; the
// strict end-to-end types live in the `@edc/ai-client` package.

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';

import {
  generateRequestSchema,
  generateSyncRequestSchema,
  unitSchema,
} from '../schemas/generate.js';
import {
  corpusAliasRequestSchema,
  corpusCreateSchema,
  corpusUpdateSchema,
  documentValiditySchema,
  embedRequestSchema,
  ingestRequestSchema,
  retrieveMultiRequestSchema,
  retrieveRequestSchema,
} from '../schemas/rag.js';
import { routeRequestSchema } from '../schemas/route.js';
import {
  provisionTenantRequestSchema,
  setBudgetRequestSchema,
} from '../schemas/tenant.js';
import {
  projectConfigPatchSchema,
  projectConfigResponseSchema,
  registryEntryCreateSchema,
  registryEntryResponseSchema,
  unitTypeSummarySchema,
} from '../schemas/registry.js';
import { includeContextItemSchema } from '../services/context/types.js';

// Zod gets a `.openapi(...)` method via the side-effect extension.
extendZodWithOpenApi(z);

// ---------------------------------------------------------------------------
// Component registration helpers
// ---------------------------------------------------------------------------

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Per-project bearer token. Resolves the caller to a {org, project} ' +
    'scope; every row is stamped with both.',
});

// Register request/response Zod schemas. The names below are exposed under
// `#/components/schemas/{Name}` in the generated doc.
const GenerateRequest = registry.register('GenerateRequest', generateRequestSchema);
const GenerateSyncRequest = registry.register('GenerateSyncRequest', generateSyncRequestSchema);
const Unit = registry.register('Unit', unitSchema);
registry.register('IncludeContextItem', includeContextItemSchema);

const SetBudgetRequest = registry.register('SetBudgetRequest', setBudgetRequestSchema);
const ProvisionTenantRequest = registry.register(
  'ProvisionTenantRequest',
  provisionTenantRequestSchema,
);

const ProjectConfigPatch = registry.register('ProjectConfigPatch', projectConfigPatchSchema);
const ProjectConfigResponse = registry.register('ProjectConfigResponse', projectConfigResponseSchema);
const RegistryEntryCreate = registry.register('RegistryEntryCreate', registryEntryCreateSchema);
const RegistryEntry = registry.register('RegistryEntry', registryEntryResponseSchema);
const UnitTypeSummary = registry.register('UnitTypeSummary', unitTypeSummarySchema);

const IngestRequest = registry.register('IngestRequest', ingestRequestSchema);
const RetrieveRequest = registry.register('RetrieveRequest', retrieveRequestSchema);
const RetrieveMultiRequest = registry.register(
  'RetrieveMultiRequest',
  retrieveMultiRequestSchema,
);
const DocumentValidityRequest = registry.register(
  'DocumentValidityRequest',
  documentValiditySchema,
);
const EmbedRequest = registry.register('EmbedRequest', embedRequestSchema);
const CorpusAliasRequest = registry.register('CorpusAliasRequest', corpusAliasRequestSchema);
const CorpusCreateRequest = registry.register('CorpusCreateRequest', corpusCreateSchema);
const CorpusUpdateRequest = registry.register('CorpusUpdateRequest', corpusUpdateSchema);
const RouteRequest = registry.register('RouteRequest', routeRequestSchema);

// Introspection response shared by create/get/patch (and, in an array, list).
const CorpusIntrospection = registry.register(
  'CorpusIntrospection',
  z.object({
    name: z.string(),
    embeddingModel: z.string(),
    embeddingDim: z.number().int(),
    language: z.string(),
    chunkStrategy: z.string(),
    chunkSize: z.number().int(),
    chunkOverlap: z.number().int(),
    chunkConfig: z.record(z.unknown()).nullable(),
    metadata: z.record(z.unknown()).nullable(),
    documentCount: z.number().int(),
    chunkCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
    alias: z.object({ name: z.string(), target: z.string() }).optional(),
  }),
);

// Use a permissive placeholder for response shapes whose precise structure is
// computed at runtime from DB rows. The typed client uses fine-grained TS
// types; the OpenAPI consumer can refine as needed.
const OpaqueObject = z.record(z.unknown()).openapi('OpaqueObject', {
  description: 'Open-shape object — see @edc/ai-client for precise TS types.',
});
registry.register('OpaqueObject', OpaqueObject);

// Discriminated error envelope. Mirrors what `src/routes/generate.ts` maps
// onto the response body for typed errors.
const ErrorBody = registry
  .register(
    'ErrorBody',
    z
      .object({
        error: z.string(),
        message: z.string(),
      })
      .passthrough(),
  );

// Advisory flag schema, surfaced as the optional top-level `warnings` field
// on every budget-reserving response (0007_budget_reset; see
// `plan/budget-reset-followup.md`). Today the only `code` emitted is
// `BUDGET_SOFT_CAP`; consumers should treat unknown codes as informational.
const Warning = registry.register(
  'ResponseWarning',
  z.object({
    code: z.string(),
    message: z.string(),
  }),
);

// ---------------------------------------------------------------------------
// Path registration — one block per route module, in /v1 register order.
// All paths declare `security: [{ Bearer: [] }]` (so docs viewers prompt for
// a token). The openapi.json / docs routes are *not* registered here — see
// `src/routes/openapi.ts`.
// ---------------------------------------------------------------------------

// Common response shape factories — keeps the path registrations readable.
const jsonOk = (schema: z.ZodTypeAny, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});
const BEARER = [{ Bearer: [] }];

// ── Health ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Liveness probe.',
  responses: {
    200: jsonOk(z.object({ ok: z.literal(true) })),
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/ready',
  tags: ['Health'],
  summary: 'Readiness probe — pings Postgres + Redis.',
  responses: {
    200: jsonOk(z.object({ ready: z.boolean(), checks: z.record(z.unknown()) })),
    503: jsonError('Not ready.'),
  },
});

// ── Capabilities ───────────────────────────────────────────────────────────
// Unauthenticated on purpose (ADR-0004) — hence no `security` block. Consumers
// call this at boot to decide whether they can run against this deployment.
registry.registerPath({
  method: 'get',
  path: '/v1/capabilities',
  tags: ['Health'],
  summary: 'Named capabilities this deployment ships (ADR-0004).',
  description:
    'Consumers declare the capabilities they require and negotiate at boot, so a ' +
    'wrong promotion order fails at deploy time with an actionable message instead ' +
    'of silently degrading (service ahead of consumer) or throwing mid-user-action ' +
    '(consumer ahead of service). Compatibility is decided on capability NAMES only — ' +
    'the document deliberately carries no version or build id. Unauthenticated: a ' +
    'consumer must be able to tell a missing capability apart from a bad API key.',
  responses: {
    200: jsonOk(z.object({ capabilities: z.record(z.boolean()) })),
  },
});

// ── Generate ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/generate',
  tags: ['Generate'],
  summary: 'Enqueue a batch of generation units.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: GenerateRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        requestId: z.string().uuid(),
        channel: z.string(),
        totalJobs: z.number().int(),
        estimatedCostUsd: z.number(),
        warnings: z.array(Warning).optional(),
      }),
    ),
    400: jsonError('Validation, dependency-cycle, or spec-resolution error.'),
    401: jsonError('Missing or invalid bearer token.'),
    402: jsonError(
      'Budget exceeded, or no budget configured for the org (fail-closed, ' +
        'ADR-0003 D5). `error` is `BudgetExceeded` or `BudgetNotConfigured`.',
    ),
    403: jsonError('Forbidden — cross-tenant or scope violation.'),
    409: jsonError('Idempotency conflict (same clientRequestId, different body).'),
    500: jsonError('Internal error.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/generate/sync',
  tags: ['Generate'],
  summary: 'One synchronous generation (no queue, no idempotency).',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: GenerateSyncRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        text: z.string(),
        parsed: z.unknown().optional(),
        modelUsed: z.string(),
        provider: z.string(),
        costUsd: z.number(),
        traceId: z.string(),
        warnings: z.array(Warning).optional(),
      }),
    ),
    400: jsonError('Validation or spec-resolution error.'),
    401: jsonError('Missing or invalid bearer token.'),
    402: jsonError(
      'Budget exceeded, or no budget configured for the org (fail-closed, ' +
        'ADR-0003 D5). `error` is `BudgetExceeded` or `BudgetNotConfigured`.',
    ),
    500: jsonError('Internal error.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/generate/{requestId}',
  tags: ['Generate'],
  summary: 'Fetch a generation request snapshot + per-unit job rows.',
  security: BEARER,
  request: { params: z.object({ requestId: z.string().uuid() }) },
  responses: {
    200: jsonOk(OpaqueObject),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Request not found (or owned by another tenant).'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/generate/units/{unitKey}/latest',
  tags: ['Generate'],
  summary: 'Fetch the most recent job row for a given unitKey in caller scope.',
  security: BEARER,
  request: { params: z.object({ unitKey: z.string() }) },
  responses: {
    200: jsonOk(z.object({ unit: OpaqueObject })),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('No job row for this unitKey in caller scope.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/generate/{requestId}/cancel',
  tags: ['Generate'],
  summary: 'Cancel a generation request (idempotent).',
  security: BEARER,
  request: { params: z.object({ requestId: z.string().uuid() }) },
  responses: {
    200: jsonOk(
      z.object({
        cancelled: z.boolean(),
        removedJobs: z.number().int(),
        alreadyCancelled: z.boolean().optional(),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Request not found (or owned by another tenant).'),
  },
});

// ── Events (SSE) ───────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/events/{channel}',
  tags: ['Events'],
  summary: 'Server-Sent Events stream for a generation request channel.',
  description:
    'Channel format: `request:<requestId>:generations`. Heartbeat every 15s ' +
    '(`: ping`). Cross-tenant subscription is rejected with 403 *before* any ' +
    'byte hits the wire.',
  security: BEARER,
  request: { params: z.object({ channel: z.string() }) },
  responses: {
    200: {
      description: 'SSE stream (text/event-stream).',
      content: { 'text/event-stream': { schema: { type: 'string' } } },
    },
    400: jsonError('Invalid channel format.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Channel not owned by caller scope.'),
  },
});

// ── Budget ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/budget/{org}',
  tags: ['Budget'],
  summary: 'Caller-scoped budget snapshot.',
  security: BEARER,
  request: { params: z.object({ org: z.string() }) },
  responses: {
    200: jsonOk(
      z.object({
        org: z.string(),
        limitUsd: z.number(),
        remainingUsd: z.number(),
        spentUsd: z.number(),
        currency: z.string(),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Cross-org read attempted.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/budget/{org}',
  tags: ['Budget'],
  summary: 'Set the org spending cap. Admin only.',
  description:
    'Endpoint form of `scripts/set-budget.ts` — the only thing that lifts the ' +
    'fail-closed gate (an org with no budget row 402s on every generation). ' +
    'Idempotent. `remaining` is clamped down to the new cap but never raised ' +
    'unless `refill` is true. `{org}` must equal the caller own scope; a ' +
    'mismatch is 403 (the path parameter can never widen tenancy).',
  security: BEARER,
  request: {
    params: z.object({ org: z.string() }),
    body: { content: { 'application/json': { schema: SetBudgetRequest } } },
  },
  responses: {
    200: jsonOk(
      z.object({
        org: z.string(),
        limitUsd: z.number(),
        remainingUsd: z.number(),
        currency: z.string(),
        created: z.boolean(),
      }),
    ),
    201: jsonOk(
      z.object({
        org: z.string(),
        limitUsd: z.number(),
        remainingUsd: z.number(),
        currency: z.string(),
        created: z.boolean(),
      }),
    ),
    400: jsonError('Invalid body.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required, or cross-org write attempted.'),
  },
});

// ── Tenant provisioning + readiness ────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/tenant/readiness',
  tags: ['Tenant'],
  summary: 'Which of the three provisioning pieces is this tenant missing?',
  description:
    'Standing up a consumer needs an API key, a budget, and an active registry ' +
    'entry per unit type — and a missing one fails as 401, 402 and 400 ' +
    'respectively. This reports all three in plain language for the CALLER own ' +
    'scope. Any authenticated role may call it (that is the point: the consumer ' +
    'hitting the error self-diagnoses). Pass `unitType` to check one unit type ' +
    'precisely instead of "any registered prompt at all".',
  security: BEARER,
  request: { query: z.object({ unitType: z.string().optional() }) },
  responses: {
    200: jsonOk(
      z.object({
        org: z.string(),
        project: z.string(),
        ready: z.boolean(),
        checks: z.array(
          z.object({
            id: z.enum(['api-key', 'budget', 'registry']),
            ok: z.boolean(),
            summary: z.string(),
            fix: z.string().optional(),
            detail: z.record(z.unknown()).optional(),
          }),
        ),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/tenant/provision',
  tags: ['Tenant'],
  summary: 'Provision budget + registry entries for the calling tenant. Admin only.',
  description:
    'Idempotent. Reports a per-item status rather than failing the whole call, ' +
    'and always returns the manual step that CANNOT be automated: adding the ' +
    'consumer key to the API_KEYS environment variable and recreating the ' +
    'container. `org`/`project` come from the bearer token, never the body.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: ProvisionTenantRequest } } },
  },
  responses: {
    200: jsonOk(
      z.object({
        org: z.string(),
        project: z.string(),
        items: z.array(
          z.object({
            item: z.string(),
            status: z.enum(['created', 'updated', 'unchanged', 'skipped', 'failed']),
            message: z.string(),
            detail: z.record(z.unknown()).optional(),
          }),
        ),
        manualSteps: z.array(z.object({ item: z.string(), message: z.string() })),
        readiness: z.object({
          org: z.string(),
          project: z.string(),
          ready: z.boolean(),
          checks: z.array(z.record(z.unknown())),
        }),
      }),
    ),
    400: jsonError('Invalid body.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
  },
});

// ── Admin: OpenRouter credits ──────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/openrouter/credits',
  tags: ['Admin'],
  summary: 'Platform-wide OpenRouter account credits balance. Admin only.',
  description:
    'Passthrough to OpenRouter `/api/v1/credits`. Cached for 30 seconds ' +
    'in-process. Returns the operator real provider spend; this is NOT ' +
    'something org/project users should ever see.',
  security: BEARER,
  responses: {
    200: jsonOk(
      z.object({
        totalCredits: z.number(),
        totalUsage: z.number(),
        remainingCredits: z.number(),
        updatedAt: z.string(),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
    503: jsonError('OpenRouter unreachable or not configured.'),
  },
});

// ── Registry ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/registry/config',
  tags: ['Registry'],
  summary: 'Caller-scoped project config (or null when unset).',
  security: BEARER,
  responses: {
    200: jsonOk(z.object({ config: ProjectConfigResponse.nullable() })),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/registry/config',
  tags: ['Registry'],
  summary: 'Upsert (patch) the caller-scoped project config. Admin only.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: ProjectConfigPatch } }, required: true },
  },
  responses: {
    200: jsonOk(z.object({ config: ProjectConfigResponse })),
    400: jsonError('Validation error.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/registry/unit-types',
  tags: ['Registry'],
  summary: 'Summary per unit type: active version + total versions.',
  security: BEARER,
  responses: {
    200: jsonOk(z.object({ unitTypes: z.array(UnitTypeSummary) })),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/registry/unit-types/{unitType}/versions',
  tags: ['Registry'],
  summary: 'List all versions for a unit type (newest first).',
  security: BEARER,
  request: { params: z.object({ unitType: z.string() }) },
  responses: {
    200: jsonOk(z.object({ versions: z.array(RegistryEntry) })),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/registry/unit-types/{unitType}/versions/{version}',
  tags: ['Registry'],
  summary: 'One version of a unit-type registry entry.',
  security: BEARER,
  request: {
    params: z.object({ unitType: z.string(), version: z.string() }),
  },
  responses: {
    200: jsonOk(z.object({ entry: RegistryEntry })),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Not found.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/registry/unit-types/{unitType}/versions',
  tags: ['Registry'],
  summary: 'Create a new version of a unit-type registry entry. Admin only.',
  security: BEARER,
  request: {
    params: z.object({ unitType: z.string() }),
    body: { content: { 'application/json': { schema: RegistryEntryCreate } }, required: true },
  },
  responses: {
    201: jsonOk(z.object({ entry: RegistryEntry }), 'Created.'),
    400: jsonError('Validation or conflict error.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/registry/unit-types/{unitType}/versions/{version}/activate',
  tags: ['Registry'],
  summary: 'Atomically flip the active version for a unit type. Admin only.',
  security: BEARER,
  request: {
    params: z.object({ unitType: z.string(), version: z.string() }),
  },
  responses: {
    200: jsonOk(z.object({ entry: RegistryEntry })),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
    404: jsonError('Not found.'),
  },
});

// ── Ingest ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/ingest',
  tags: ['Ingest'],
  summary: 'Enqueue a text-only ingest batch.',
  description:
    'Text-only: the service does not parse PDFs or HTML. Documents are chunked, ' +
    'embedded and indexed asynchronously; poll `GET /v1/ingest/{ingestId}` or ' +
    'supply `callbackUrl`.\n\n' +
    '**Chunking.** By default a document is split by the corpus\'s configured ' +
    'strategy (`recursive-char`, a token window). Send `chunkConfig` — at the ' +
    'batch level, or per document, where the per-document value wins — to split ' +
    'at the document\'s OWN headings instead, so a retrieved chunk corresponds ' +
    'to one addressable, citable unit:\n\n' +
    '```json\n' +
    '{\n' +
    '  "sections": [{ "key": "section", "pattern": "^\\\\s*Section\\\\s+(\\\\d+)\\\\b", "flags": "i" }],\n' +
    '  "subSections": [{ "key": "clause", "pattern": "^\\\\s*([IVX]+)[.)]\\\\s" }]\n' +
    '}\n' +
    '```\n\n' +
    '`pattern` is JS regex source with `gm` forced on; capture group 1 is the ' +
    'identifier, stored on each chunk as `metadata[key]` (under your own ' +
    'document metadata, which always wins a key collision). `sections` is the ' +
    'only required field; `maxChars` (default 4000) and `minChars` (default 80) ' +
    'are optional. The service ships NO named presets — the patterns describe ' +
    'your documents, so you own them. An unusable config, or one that matches no ' +
    'boundary in a given document, falls back to the corpus strategy with a ' +
    'warning rather than failing the ingest.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: IngestRequest } }, required: true },
  },
  responses: {
    202: jsonOk(
      z.object({
        ingestId: z.string().uuid(),
        corpusId: z.string().uuid(),
        totalDocs: z.number().int(),
      }),
      'Accepted — work proceeds asynchronously.',
    ),
    400: jsonError('Validation error.'),
    401: jsonError('Missing or invalid bearer token.'),
    500: jsonError('Internal error.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/ingest/{ingestId}',
  tags: ['Ingest'],
  summary: 'Ingest status snapshot.',
  security: BEARER,
  request: { params: z.object({ ingestId: z.string().uuid() }) },
  responses: {
    200: jsonOk(
      z.object({
        ingestId: z.string().uuid(),
        totalDocs: z.number().int(),
        completedDocs: z.number().int(),
        failedDocs: z.number().int(),
        status: z.enum(['processing', 'completed', 'partial', 'failed']),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

// ── Retrieve ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/retrieve',
  tags: ['Retrieve'],
  summary: 'Top-K retrieval over a corpus — dense, or hybrid dense+lexical (RRF).',
  description:
    'Cosine top-K over the corpus embedding index, with optional MMR rerank. ' +
    'Every parameter beyond `corpus` and `query` is additive: omitting all of ' +
    'them reproduces the original behaviour exactly.\n\n' +
    '- `filter` — jsonb-containment constraint on chunk metadata, applied ' +
    'before ranking.\n' +
    '- `asOf` — point-in-time constraint. Only chunks whose ' +
    '`[validFrom, validTo)` interval contains this instant are eligible. ' +
    'Chunks with no bounds are always eligible, so this is a no-op on a corpus ' +
    'that never sets validity. Use it together with the `validFrom`/`validTo` ' +
    'fields on ingest to keep superseded content out of the candidate set ' +
    'entirely, rather than filtering it at display time.\n' +
    '- `mode: "hybrid"` — additionally runs a Postgres full-text leg and fuses ' +
    'it with the dense leg via Reciprocal Rank Fusion. Fixes exact-identifier ' +
    'queries (codes, numbered references, other short literal tokens) that ' +
    'dense embeddings systematically miss. **In hybrid mode `score` is an RRF ' +
    'score, not a cosine similarity** — read `denseScore` if you threshold on it.\n' +
    '- `rerank: true` — re-score a capped top-N pool with a cross-encoder ' +
    '(self-hosted `bge-reranker-v2-m3`) after retrieval, then re-order before ' +
    'the final top-K, surfacing `rerankScore`. A NO-OP unless the server has ' +
    'rerank wired (`RERANK_ENABLED` + `RERANK_URL`), and it fails safe to the ' +
    'un-reranked order on any rerank error/timeout. Mutually exclusive with ' +
    '`mmr` (rerank wins). **When rerank is on, `score` is the cross-encoder ' +
    'score (0–1 sigmoid)** — threshold on `rerankScore`, not `denseScore`.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: RetrieveRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        chunks: z.array(
          z.object({
            chunkId: z.string(),
            documentId: z.string(),
            ordinal: z.number().int(),
            text: z.string(),
            score: z.number(),
            denseScore: z.number().optional(),
            lexicalScore: z.number().optional(),
            rerankScore: z.number().optional(),
            ranks: z
              .object({ dense: z.number().int().optional(), lexical: z.number().int().optional() })
              .optional(),
            metadata: z.record(z.unknown()).optional(),
          }),
        ),
      }),
    ),
    400: jsonError('Validation error.'),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus not found.'),
  },
});

// ── Retrieve (multi-corpus + optional rewrite) ───────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/retrieve/multi',
  tags: ['Retrieve'],
  summary: 'Fan out retrieval across N corpora, fuse by score, optional query rewrite.',
  description:
    'Runs `/v1/retrieve` against every `corpora[]` name in parallel (all under ' +
    'the caller\'s own `(org, project)`), merges the matches by `score`, dedupes ' +
    'by chunk, caps at `limit`, and tags each returned chunk with the `corpus` it ' +
    'came from. Every per-corpus knob (`mmr`, `mode`, `rrfK`, `filter`, `asOf`) is ' +
    'forwarded unchanged.\n\n' +
    '- A missing or erroring corpus never fails the whole call: it contributes no ' +
    'chunks and is recorded in the `corpora` diagnostics of the response.\n' +
    '- `rewrite` (optional) condenses an anaphoric follow-up into a standalone ' +
    'query using the supplied conversation `history` and the cheapest LLM tier ' +
    'BEFORE fan-out. The service ships no prompt wording — `rewrite.instruction` ' +
    'carries all of it (locale included). It fails safe to the raw `query` on the ' +
    'first turn or any error. `query` in the response is the query actually used, ' +
    'and `rewritten` says whether it changed.\n' +
    '- `rerank: true` (optional) re-scores a capped top-N pool with a cross-encoder ' +
    '(self-hosted `bge-reranker-v2-m3`) **once, AFTER cross-corpus fusion** — not ' +
    'per corpus — then re-orders before the final `limit`, surfacing `rerankScore`. ' +
    'The reranked pool spans multiple corpora, which is fine: a cross-encoder scores ' +
    'each (query, chunk) pair independently of its source, and `corpus` provenance is ' +
    'preserved. A NO-OP unless the server has rerank wired (`RERANK_ENABLED` + ' +
    '`RERANK_URL`), and it fails safe to the fused order on any rerank error/timeout. ' +
    'Mutually exclusive with `mmr` (rerank wins; `mmr` is not forwarded to the legs). ' +
    '**When rerank is on, `score` is the cross-encoder score (0–1 sigmoid)** — ' +
    'threshold on `rerankScore`, not `denseScore`.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: RetrieveMultiRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        query: z.string(),
        rewritten: z.boolean(),
        chunks: z.array(
          z.object({
            chunkId: z.string(),
            documentId: z.string(),
            ordinal: z.number().int(),
            text: z.string(),
            score: z.number(),
            corpus: z.string(),
            denseScore: z.number().optional(),
            lexicalScore: z.number().optional(),
            rerankScore: z.number().optional(),
            ranks: z
              .object({ dense: z.number().int().optional(), lexical: z.number().int().optional() })
              .optional(),
            metadata: z.record(z.unknown()).optional(),
          }),
        ),
        corpora: z.array(
          z.object({
            corpus: z.string(),
            matched: z.number().int(),
            error: z.enum(['not_found', 'failed']).optional(),
          }),
        ),
      }),
    ),
    400: jsonError('Validation error.'),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

// ── Route (capability router) ────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/route',
  tags: ['Route'],
  summary: 'Classify a question onto exactly one caller-supplied candidate id.',
  description:
    'Single cheap LLM classification over a GENERIC candidate list. FAIL-SAFE: ' +
    'any error / ambiguity / invalid routeId returns `defaultRouteId` (else ' +
    '`candidates[0].id`) with an explanatory reason — never a 5xx on a routable ' +
    'request. The chosen `routeId` is always one of the supplied candidate ids. ' +
    'Override the router prompt/model/effort by registering the `capability-router` ' +
    'unit-type in the registry: a registered entry WINS over the built-in English ' +
    'prompt, which is only the fallback used when no entry exists.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: RouteRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        routeId: z.string(),
        reason: z.string(),
      }),
    ),
    400: jsonError('Validation error (malformed request body).'),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

// ── Embed ──────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/embed',
  tags: ['Embed'],
  summary: 'Direct embedding pass-through (no corpus write).',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: EmbedRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        embeddings: z.array(z.array(z.number())),
        model: z.string(),
        usage: z.object({
          inputTokens: z.number().int(),
          estimatedCostUsd: z.number(),
        }),
        warnings: z.array(Warning).optional(),
      }),
    ),
    400: jsonError('Validation error.'),
    401: jsonError('Missing or invalid bearer token.'),
    402: jsonError(
      'Budget exceeded, or no budget configured for the org (fail-closed, ' +
        'ADR-0003 D5). `error` is `BudgetExceeded` or `BudgetNotConfigured`.',
    ),
    500: jsonError('Internal error.'),
  },
});

// ── Corpus control plane (/v1/corpora) ───────────────────────────────────────
// App-role, scoped to the caller's (org, project). Explicit create/list/get/
// patch/delete — the alternative to "corpus auto-creates on first ingest".
// Auto-create-on-ingest still works; this surface is additive.
registry.registerPath({
  method: 'post',
  path: '/v1/corpora',
  tags: ['Corpus'],
  summary: 'Create a corpus with an explicit config (model, dim, language, chunking).',
  description:
    'App-role bearer token. Configure a corpus BEFORE any data lands, instead of ' +
    'letting the first ingest silently decide its config. `embeddingModel` is ' +
    'validated against its known vector dimension (a model that cannot fit the ' +
    'live vector column is a 400). `language` is a Postgres text-search config ' +
    'name directly (`spanish`/`english`/`simple`/…), not an ISO locale code. ' +
    'Scoped to the caller\'s (org, project); the name must be unique within it and ' +
    'must not collide with an alias name.',
  security: BEARER,
  request: {
    body: { content: { 'application/json': { schema: CorpusCreateRequest } }, required: true },
  },
  responses: {
    201: jsonOk(CorpusIntrospection, 'Corpus created.'),
    400: jsonError('Validation error, or model↔dimension mismatch.'),
    401: jsonError('Missing or invalid bearer token.'),
    409: jsonError('Name already names a corpus (CORPUS_ALREADY_EXISTS) or alias (CORPUS_NAME_IS_ALIAS).'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/corpora',
  tags: ['Corpus'],
  summary: 'List the caller\'s corpora with document + chunk counts.',
  security: BEARER,
  responses: {
    200: jsonOk(z.object({ corpora: z.array(CorpusIntrospection) })),
    401: jsonError('Missing or invalid bearer token.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/corpora/{name}',
  tags: ['Corpus'],
  summary: 'Introspect one corpus (config + counts). Resolves an alias to its target.',
  description:
    'Returns the corpus config plus live document/chunk counts. If `{name}` is an ' +
    'ALIAS rather than a real corpus, the config + counts are the TARGET corpus\'s ' +
    'and an `alias` field records the pointer.',
  security: BEARER,
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: jsonOk(CorpusIntrospection),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus not found (CORPUS_NOT_FOUND).'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/corpora/{name}',
  tags: ['Corpus'],
  summary: 'Reconfigure a corpus (chunking, language, metadata; model only while empty).',
  description:
    'App-role bearer token. Only the fields present in the body change. ' +
    'Changing `language` affects how NEW chunks are lexically indexed; ' +
    'already-ingested chunks keep their tsvector until re-ingested (dense ' +
    'retrieval is unaffected). `embeddingModel` may change ONLY while the corpus ' +
    'is still empty — otherwise 409 EMBEDDING_MODEL_LOCKED, because re-embedding ' +
    'existing vectors is a separate, future operation.',
  security: BEARER,
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { 'application/json': { schema: CorpusUpdateRequest } }, required: true },
  },
  responses: {
    200: jsonOk(CorpusIntrospection),
    400: jsonError('Validation error, empty patch, or model↔dimension mismatch.'),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus not found (CORPUS_NOT_FOUND).'),
    409: jsonError('Model change on a non-empty corpus (EMBEDDING_MODEL_LOCKED).'),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/corpora/{name}',
  tags: ['Corpus'],
  summary: 'Delete a whole corpus (chunks → documents → corpora).',
  description:
    'App-role bearer token, scoped to the caller\'s (org, project). Idempotent: ' +
    '200 with counts on the first delete, 404 thereafter. Shares the delete ' +
    'primitive with the legacy `DELETE /v1/corpus/{name}`.',
  security: BEARER,
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: jsonOk(
      z.object({
        deleted: z.object({
          chunks: z.number().int(),
          documents: z.number().int(),
          corpora: z.number().int(),
        }),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus not found (CORPUS_NOT_FOUND).'),
  },
});

// ── Corpus lifecycle ─────────────────────────────────────────────────────────
// The two DELETE routes are app-role (standard per-project bearer token),
// scoped to the caller's (org, project) — symmetric with ingest/retrieve. The
// alias POST stays admin-only.
registry.registerPath({
  method: 'delete',
  path: '/v1/corpus/{name}',
  tags: ['Corpus'],
  summary: 'Delete a whole corpus (chunks → documents → corpora).',
  description:
    'App-role bearer token. Scoped to the caller\'s (org, project) — a corpus in ' +
    'another tenant is indistinguishable from a missing one (no cross-tenant ' +
    'delete). Idempotent: 200 with counts on the first delete, 404 thereafter.',
  security: BEARER,
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: jsonOk(
      z.object({
        deleted: z.object({
          chunks: z.number().int(),
          documents: z.number().int(),
          corpora: z.number().int(),
        }),
      }),
    ),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus not found (CORPUS_NOT_FOUND).'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/corpus/{name}/alias',
  tags: ['Corpus'],
  summary: 'Create or repoint a corpus alias (a cheap, re-embed-free pointer).',
  description:
    'Admin role required. Makes the alias `{name}` resolve to the same chunks as ' +
    '`target` WITHOUT re-embedding — the `:latest`-pointer use-case. Retrieval ' +
    'against the alias name returns the target corpus\'s chunks. Idempotent: 201 ' +
    'on create, 200 on repoint (an atomic single-row swap of the target). Scoped ' +
    'to the caller\'s (org, project): the target must be in the same tenant, and an ' +
    'alias name cannot collide with a real corpus name. If the target corpus is ' +
    'later deleted, the alias is removed (FK cascade) and a retrieve via it 404s.',
  security: BEARER,
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { 'application/json': { schema: CorpusAliasRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        alias: z.string(),
        target: z.string(),
        targetCorpusId: z.string().uuid(),
        created: z.boolean(),
      }),
      'Alias repointed at a new target.',
    ),
    201: jsonOk(
      z.object({
        alias: z.string(),
        target: z.string(),
        targetCorpusId: z.string().uuid(),
        created: z.boolean(),
      }),
      'Alias created.',
    ),
    400: jsonError('Validation error, or alias target equals the alias name.'),
    401: jsonError('Missing or invalid bearer token.'),
    403: jsonError('Admin role required.'),
    404: jsonError('Target corpus not found (TARGET_CORPUS_NOT_FOUND).'),
    409: jsonError('Alias name collides with a real corpus (ALIAS_NAME_CONFLICT).'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/corpus/{name}/documents/{externalId}/validity',
  tags: ['Corpus'],
  summary: "Set or clear a document's temporal validity — no re-embedding.",
  description:
    'Rewrites the `[validFrom, validTo)` bounds on an ingested document and every ' +
    'chunk it owns, in one transaction, WITHOUT touching embeddings. This is how a ' +
    'consumer retires superseded content: supersession is normally discovered after ' +
    'ingest, and the alternative — re-POSTing the full text to `/v1/ingest` just to ' +
    'write two timestamps — would re-chunk and re-embed the whole document. That ' +
    'cost is what tempts a consumer to skip the step and leave stale content ' +
    'retrievable.\n\n' +
    '`null` CLEARS a bound (back to unbounded); OMITTING a field leaves the stored ' +
    'bound untouched — the distinction is what makes un-retiring expressible. At ' +
    'least one field must be present.\n\n' +
    'App role, scoped to the caller\'s (org, project) — same posture as the DELETE ' +
    'routes. Retrieval honours the bounds via the `asOf` parameter on `/v1/retrieve`.',
  security: BEARER,
  request: {
    params: z.object({ name: z.string(), externalId: z.string() }),
    body: { content: { 'application/json': { schema: DocumentValidityRequest } }, required: true },
  },
  responses: {
    200: jsonOk(
      z.object({
        documentId: z.string().uuid(),
        chunksUpdated: z.number().int(),
        validFrom: z.string().nullable(),
        validTo: z.string().nullable(),
      }),
    ),
    400: jsonError(
      'Validation error, no bound supplied, or the resulting interval would be empty.',
    ),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus or document not found (CORPUS_NOT_FOUND / DOCUMENT_NOT_FOUND).'),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/corpus/{name}/documents/{externalId}',
  tags: ['Corpus'],
  summary: 'Delete a single document (by consumer external id) + its chunks.',
  description:
    'App-role bearer token. Removes one document and its chunks, leaving the corpus ' +
    'and sibling documents intact — for the doc-removed-entirely case that ' +
    're-ingest (which only replaces a doc\'s chunks) cannot express. Scoped to the ' +
    'caller\'s (org, project); a document in another tenant is indistinguishable ' +
    'from a missing one (no cross-tenant delete).',
  security: BEARER,
  request: { params: z.object({ name: z.string(), externalId: z.string() }) },
  responses: {
    200: jsonOk(
      z.object({
        deleted: z.object({ chunks: z.number().int(), documents: z.number().int() }),
      }),
    ),
    400: jsonError('Missing corpus name or externalId.'),
    401: jsonError('Missing or invalid bearer token.'),
    404: jsonError('Corpus or document not found (CORPUS_NOT_FOUND / DOCUMENT_NOT_FOUND).'),
  },
});

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
        'Standalone, domain-agnostic AI + RAG service. Consumed over HTTP by ' +
        'the application layer. See `@edc/ai-client` for the typed client.',
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
      { name: 'Admin' },
    ],
  });
  return cached;
}

// Test seam — clear the module-scope cache so a regenerate picks up fresh
// definitions. Production never calls this.
export function __resetOpenApiCacheForTests(): void {
  cached = undefined;
}
