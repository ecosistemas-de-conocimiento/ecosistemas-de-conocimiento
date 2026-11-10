// RESPONSE schemas — the half of the contract that did not exist.
//
// `src/contract/*` modelled every REQUEST body in Zod and nothing else, so
// `GET /v1/openapi.json` described its responses from shapes restated by hand
// inside `src/openapi/registry.ts`. Restated shapes drift, and before the fix
// eleven of them had: `GET /health` declared `{ok:true}` and returns
// `{status,service}`; `POST /v1/generate/sync` omitted `systemPromptApplied`,
// the field `capabilities.ts` names as the system-prompt migration handle;
// eight corpus routes published a flat error envelope they have never sent.
//
// Everything here is derived by READING THE HANDLER and matching its object
// literal exactly — including which keys are conditionally spread, which is
// the difference between `optional()` and required. `response-parse` tests
// (`src/openapi/response-parse.integration.test.ts`) then parse a real
// `app.inject` body through the schema that claims to describe it, so a
// handler that grows or drops a field goes red here rather than silently in a
// consumer.
//
// ── Two rules for editing this file ────────────────────────────────────────
// 1. `.strict()` is deliberately NOT used, and a plain `safeParse` therefore
//    cannot see an ADDED field: Zod 4 objects STRIP unknown keys and the
//    envelopes are explicitly `.passthrough()`. That is on purpose —
//    `.strict()` publishes `additionalProperties: false`, and a strict
//    generated client would then reject the next field ai-service adds, which
//    is exactly the consumer break this service may not ship.
//
//    The capability is not lost. `response-parse.integration.test.ts` reads
//    the schema's own `catchall` to tell a CLOSED shape from a passthrough one
//    and reports any key a closed shape did not declare — so an added field
//    still goes red, without narrowing the published document. The four
//    passthrough envelopes opt out by construction, which is the right answer
//    for them: their extra fields are class-specific by design.
// 2. A field that is spread conditionally (`...(x ? {x} : {})`) is
//    `.optional()`, NOT `.nullable()`. The key is ABSENT, and a consumer
//    telling "not measured" from "measured as zero" depends on that.

import { z } from './zod.js';
import { effortLevelSchema, validatorSchema } from './registry.js';
import { ROUTE_FALLBACK_CAUSES } from './route.js';

// ── `.openapi('Name')` on a leaf, and why it is HERE ──────────────────────
// A schema used by more than one response is tagged with its component name
// at the point of DEFINITION, not later in `src/openapi/components.ts`.
// `@asteasolutions/zod-to-openapi` returns a NEW instance from `.openapi()`,
// so a name applied afterwards lands on a copy the composites never reference
// — and the generator then INLINES the shape at every use site instead of
// emitting one `$ref`. Measured: `RetrievedChunk` appeared six times in the
// document. Tagging at definition is what makes the composites point at the
// named instance. This module already imports `z` from `./zod.js`, which is
// the extended one, so nothing else is needed.

// ── `jsonb` columns: which are OPEN, and why ──────────────────────────────
// Ten response fields map to a `jsonb` column or a computed JSON blob. They
// are NOT all the same kind of thing, and lumping them under one alias hid
// that. Measured against every writer and reader on this tree:
//
//   MODELLED CONCRETELY (4): `effortProfiles` on both `ProjectConfigResponse`
//   and `RegistryEntry` (one named `EffortProfiles` component), the readiness
//   `checks[].detail`, and the provision `items[].detail`. Each has a closed
//   producer whose branches are enumerable — see the schema comments below.
//
//   GENUINELY OPEN (6), each with the reason stated at its field:
//   `chunkConfig`, `metadata` (corpus), `metadata` (chunk), `contextRules`,
//   `metadata` (project config), `metadata` (registry entry) — plus
//   `responseSchema`, which is a JSON Schema and must not be re-modelled in
//   Zod, and `parsed` / `output`, whose shape is the CALLER's `responseSchema`.
//
// The rule for adding one: if you can name the producer and list its keys,
// model it. If the value is a blob the caller supplied and no service code
// reads a key out of it, leave the record and say so on the field.
/** An OPEN `jsonb` blob — no service code reads a key out of it. */
const jsonObject = z.record(z.string(), z.unknown());

/**
 * Any JSON value, `null` included — and REQUIRED, unlike `z.unknown()`.
 *
 * 🔴 `z.unknown()` is the trap this exists to avoid. Under Zod 4 it parses as
 * required, but `@asteasolutions/zod-to-openapi` emits it as OPTIONAL with the
 * empty schema `{}` — so a field the handler writes UNCONDITIONALLY was
 * published as `field?: unknown`. A real union has neither problem.
 */
const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

/**
 * One validator finding. `src/services/ai/validators/types.ts` — a `blocker`
 * is what turns a completed generation into `status: 'failed'` while still
 * writing an `output`.
 */
export const generationFlagSchema = z
  .object({
    severity: z.enum(['blocker', 'warning']),
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
  })
  .openapi('GenerationFlag');

/**
 * `effortProfiles` — an OVERLAY on the built-in profile table, not a full
 * profile. Keys are the closed `EffortLevel` set; every member is optional
 * because `mergeProfile` layers what is present over the built-in default
 * (`src/services/registry/resolve.ts`). Passthrough on the entry: the merge
 * copies keys it does not itself read.
 */
const effortProfileEntrySchema = z
  .object({
    model: z.string().optional(),
    maxOutputTokens: z.number().optional(),
    validationPasses: z.number().optional(),
    multiSample: z.number().optional(),
    temperature: z.number().optional(),
    estimatedCostUsdPerCall: z
      .number()
      .optional()
      .describe('Zero or non-finite here is what raises `BudgetMisconfigured` on a 402.'),
  })
  .passthrough();

const effortProfilesObjectSchema = z
  .object({
    quick: effortProfileEntrySchema.optional(),
    standard: effortProfileEntrySchema.optional(),
    deep: effortProfileEntrySchema.optional(),
    maximum: effortProfileEntrySchema.optional(),
  })
  .openapi('EffortProfiles');

/**
 * 🔴 `.nullable()` on a NAMED schema LOSES the null. Measured: with
 * `effortProfilesSchema.nullable()` the generator emitted a bare
 * `{$ref: '#/components/schemas/EffortProfiles'}` and dropped the null arm
 * entirely — every generated client would have typed a nullable column
 * non-nullable. `z.union([named, z.null()])` is what produces the honest
 * `anyOf: [{$ref}, {type:'null'}]`. Both columns are `jsonb` with no
 * `notNull`, so the null is not decorative.
 */
export const effortProfilesSchema = z.union([effortProfilesObjectSchema, z.null()]);

// ---------------------------------------------------------------------------
// Health (unauthenticated, outside /v1)
// ---------------------------------------------------------------------------

/** `GET /health` — `{ status: 'ok', service: 'ai-service' }`. */
export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
});

/**
 * `GET /health/ready`, BOTH statuses. 200 carries `status: 'ok'`, 503 carries
 * `status: 'degraded'` — the 503 is NOT an error envelope, which is what the
 * document claimed before the fix.
 *
 * `checks` carries booleans ONLY. The raw dependency error strings name
 * connection targets and driver internals, and this endpoint is
 * unauthenticated, so they are logged server-side instead
 * (`routes/health-ready.test.ts` pins the redaction).
 */
export const healthReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.object({ ok: z.boolean() }),
    redis: z.object({ ok: z.boolean() }),
  }),
});

/** `GET /v1/` — the authenticated ping. Confirms the token resolved to a scope. */
export const v1PingResponseSchema = z.object({
  v1: z.literal(true),
  org: z.string(),
  project: z.string(),
});

// ---------------------------------------------------------------------------
// RAG control plane — corpora / corpus
// ---------------------------------------------------------------------------

/**
 * One corpus as `introspectionFromRow` builds it. All thirteen fields are
 * always present; `alias` is a fourteenth added ONLY by `GET /v1/corpora/{name}`
 * and only when the requested name resolved through `corpus_aliases`.
 */
export const corpusIntrospectionSchema = z.object({
  name: z.string(),
  embeddingModel: z.string(),
  embeddingDim: z.number().int(),
  language: z.string().describe('The corpus `text_search_config`.'),
  chunkStrategy: z.string(),
  chunkSize: z.number().int(),
  chunkOverlap: z.number().int(),
  chunkConfig: jsonObject
    .nullable()
    .describe(
      'OPEN. The caller\'s own chunking config, stored verbatim by ' +
        '`services/rag/corpus-crud.ts` and read back verbatim. The structural ' +
        'validator runs at READ time, ignores unknown keys and falls back on a ' +
        'config it cannot use — it never rejects a write, so nothing here fixes ' +
        'the shape.',
    ),
  metadata: jsonObject.nullable().describe('OPEN. Consumer blob — no service code reads it.'),
  documentCount: z.number().int(),
  chunkCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  alias: z
    .object({ name: z.string(), target: z.string() })
    .optional()
    .describe('Present only when the path name resolved via an alias.'),
}).openapi('CorpusIntrospection');

/** `GET /v1/corpora`. `[]` when the scope has none — never a 404. */
export const corpusListResponseSchema = z.object({
  corpora: z.array(corpusIntrospectionSchema),
});

/** `DELETE /v1/corpora/{name}` and `DELETE /v1/corpus/{name}` — THREE counters. */
export const deleteCorpusResponseSchema = z.object({
  deleted: z.object({
    chunks: z.number().int(),
    documents: z.number().int(),
    corpora: z.number().int(),
  }),
}).openapi('DeleteCorpusResult');

/**
 * `DELETE /v1/corpus/{name}/documents/{externalId}` — TWO counters.
 * ⚠ Deliberately a different shape from `deleteCorpusResponseSchema`: no
 * `corpora` key, because deleting a document never removes the corpus.
 */
export const deleteDocumentResponseSchema = z.object({
  deleted: z.object({
    chunks: z.number().int(),
    documents: z.number().int(),
  }),
});

/** `PATCH /v1/corpus/{name}/documents/{externalId}/validity`. */
export const setDocumentValidityResponseSchema = z.object({
  documentId: z.string().uuid(),
  chunksUpdated: z.number().int(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
});

/**
 * `POST /v1/corpus/{name}/alias`. The body is identical on 201 and 200; the
 * status is the only signal, mirrored in `created`.
 */
export const corpusAliasResponseSchema = z.object({
  alias: z.string(),
  target: z.string(),
  targetCorpusId: z.string(),
  created: z.boolean().describe('`true` ⇒ 201, `false` ⇒ 200 (the alias already pointed there).'),
}).openapi('CorpusAliasResult');

// ---------------------------------------------------------------------------
// RAG data plane — ingest / retrieve / embed
// ---------------------------------------------------------------------------

/** `POST /v1/ingest` (202 Accepted). */
export const ingestAcceptedResponseSchema = z.object({
  ingestId: z.string(),
  corpusId: z.string(),
  totalDocs: z.number().int(),
});

/**
 * `GET /v1/ingest/{ingestId}`.
 *
 * An id that does not exist in the caller's org/project answers 404
 * `IngestNotFoundError`. `chunkCount` and `documents` appear once the batch
 * is terminal (not while `processing`).
 */
export const ingestStatusResponseSchema = z.object({
  ingestId: z.string(),
  totalDocs: z.number().int(),
  completedDocs: z.number().int(),
  failedDocs: z.number().int(),
  status: z.enum(['processing', 'completed', 'partial', 'failed']),
  chunkCount: z.number().int().optional(),
  documents: z
    .array(
      z.object({
        docId: z.string(),
        chunkCount: z.number().int(),
      }),
    )
    .optional(),
});

/** One retrieved chunk. Every score beyond `score` is leg-dependent. */
export const retrievedChunkSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  ordinal: z.number().int(),
  text: z.string(),
  score: z.number(),
  denseScore: z.number().optional(),
  lexicalScore: z.number().optional(),
  rerankScore: z.number().optional().describe('Present only when rerank ran; `score` mirrors it.'),
  ranks: z.object({ dense: z.number().optional(), lexical: z.number().optional() }).optional(),
  metadata: jsonObject
    .optional()
    .describe(
      'OPEN. Merged from the document metadata and the chunker, with the ' +
        "CALLER'S keys spread last (`workers/ingest.worker.ts`) — so even the " +
        "chunker's own keys can be shadowed, and the caller's `sections` " +
        'patterns name their keys themselves.',
    ),
}).openapi('RetrievedChunk');

/**
 * A retrieval leg — one independent source of candidate rows.
 *
 * `lexical` (Postgres full-text over `chunks.text_search`) and `sparse`
 * (learned-sparse bge-m3 inner product over `chunks.sparse_embedding`) are two
 * DIFFERENT legs whose scores both land in `RetrievedChunk.lexicalScore`. That
 * shared slot is why this enum exists: without it a response cannot say which
 * of the two filled it, or whether it was filled at all. `trigram` (pg_trgm
 * word similarity over `chunks.text`, opt-in via `HYBRID_LEXICAL_LEG`) is a
 * third lexical leg sharing that slot; it appears only where enabled.
 */
export const retrievalLegSchema = z
  .enum(['dense', 'lexical', 'sparse', 'trigram', 'rerank'])
  .openapi('RetrievalLeg');

/**
 * An advisory flag on a retrieval response: the call SUCCEEDED, but not in the
 * shape the caller asked for. Same `{ code, message }` core as
 * `ResponseWarning`, so a consumer can handle both lists with one reader;
 * consumers must treat an unknown `code` as informational.
 *
 * Codes today:
 *   - `RERANK_DEGRADED` — `rerank: true` was asked for and the cross-encoder
 *     did not fully order the result. `reason` says why: `timeout`, `error`,
 *     `unavailable` (no reranker configured on this server) or `backfilled`
 *     (the reranker scored fewer rows than the result holds). The chunks are in
 *     fused order wherever they carry no `rerankScore`.
 *   - `BUDGET_SOFT_CAP` — the org's remaining budget fell below its soft cap.
 *
 * Never carries the query or any chunk text.
 */
export const retrievalWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  reason: z.string().optional(),
}).openapi('RetrievalWarning');

/** `POST /v1/retrieve`. */
export const retrieveResponseSchema = z.object({
  chunks: z.array(retrievedChunkSchema),
  legs: z
    .array(retrievalLegSchema)
    .optional()
    .describe(
      'The legs that returned CANDIDATE rows — not the legs requested, and ' +
        'not the legs whose rows survived into `chunks`. The unit differs by ' +
        'leg: `dense`, `lexical` and `sparse` count rows returned into the ' +
        'fusion POOL, before RRF and before the final top-K slice, while ' +
        '`rerank` counts rows in the RESPONSE. So `topK: 1` on a hybrid ' +
        'retrieve whose lexical leg returned 50 rows that all lost the fusion ' +
        'still reports `[dense, lexical]` alongside one dense chunk. Pool ' +
        'contribution is the liveness signal: a leg is alive when it produces ' +
        'candidates; whether they win slots is ranking, not health. ' +
        '`rerank` appears ONLY when the cross-encoder really scored rows; the ' +
        'rerank rung is fail-safe, so a timeout or a down reranker returns the ' +
        'fused order and omits `rerank` here. Read it as a SET: today a hybrid ' +
        'retrieve runs dense plus exactly ONE lexical leg (`SPARSE_ENABLED` ' +
        'picks which), so `[dense, lexical]` and `[dense, sparse]` are the ' +
        'shapes you see — plus `rerank` when the cross-encoder scored rows, ' +
        'and minus any leg that returned zero rows, which is the very case ' +
        'this field exposes. The declared next change fuses all three, so ' +
        'never key on length or index. ' +
        'OPTIONAL on the wire only because an OLDER deployment omits it ' +
        'entirely; a build that advertises the `retrievalLegs` capability ' +
        'always sends it. Check the capability, not the field, to decide ' +
        'whether absence means "no legs ran" (it never does) or "old service". ' +
        '`POST /v1/retrieve/multi` carries its own `legs`: the union over ' +
        'every corpus queried, plus `rerank` for its post-fusion rung.',
    ),
  warnings: z
    .array(retrievalWarningSchema)
    .optional()
    .describe(
      'Present only when something degraded. `RERANK_DEGRADED` replaces the ' +
        'old log-only signal for a rerank that timed out, failed, is not ' +
        'configured, or backfilled. Absent on older deployments.',
    ),
});

/**
 * `POST /v1/retrieve/multi`. A corpus that could not be read does NOT fail the
 * request — it lands in `corpora[].error`, which is why this route has no 404.
 */
export const retrieveMultiResponseSchema = z.object({
  query: z.string(),
  rewritten: z.boolean(),
  chunks: z.array(retrievedChunkSchema.extend({ corpus: z.string() })),
  corpora: z.array(
    z.object({
      corpus: z.string(),
      matched: z.number().int(),
      error: z.enum(['not_found', 'failed']).optional(),
      /**
       * Chunks this corpus won a slot for in the FINAL `chunks`, after fusion,
       * the optional rerank and the `limit` cap. `matched` is what it FOUND;
       * this is what survived. `matched: 8, contributed: 0` means the corpus
       * was queried and DID match and still reached you with nothing — the
       * fingerprint of the cross-corpus fusion defect measured,
       * and of any future variant of it.
       *
       * Optional in the CONTRACT so an older consumer parsing this response
       * keeps validating; the service always sends it from this release on.
       */
      contributed: z.number().int().optional(),
    }),
  ),
  /**
   * Which cross-corpus ordering rule produced `chunks`.
   *
   *  - `cross-corpus-rrf` — `mode: 'hybrid'` over MORE THAN ONE corpus. The
   *    per-corpus RRF scores are RANK-based and are not comparable across
   *    corpora (the deeper corpus is penalised for its depth), so ranks are
   *    rebuilt over one global pool per leg and RRF is re-run. `score` is that
   *    global RRF value, on the same scale as before.
   *  - `score` — a single corpus, or `mode: 'dense'` where `score` is cosine
   *    against the same query vector and already comparable. Unchanged.
   *
   * Optional in the CONTRACT for the same forward-compatibility reason.
   */
  fusion: z.enum(['score', 'cross-corpus-rrf']).optional(),
  /**
   * The legs that returned candidate rows, as a SET: the union of every
   * per-corpus retrieve's `legs`, plus `rerank` when the post-fusion
   * cross-encoder really scored rows. Same units and reading rules as
   * `RetrieveResponse.legs`. A corpus that errored contributes no legs.
   *
   * Optional in the CONTRACT so older deployments (which omit it) validate.
   */
  legs: z.array(retrievalLegSchema).optional(),
  /** Same as `RetrieveResponse.warnings`; deduplicated across corpora. */
  warnings: z.array(retrievalWarningSchema).optional(),
});

/**
 * The advisory flag every budget-reserving response may carry. Today the only
 * `code` is `BUDGET_SOFT_CAP`; consumers must treat an unknown code as
 * informational rather than failing on it.
 */
export const responseWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
}).openapi('ResponseWarning');

/** `POST /v1/embed`. `warnings` is spread only when the soft cap tripped. */
export const embedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
  model: z.string(),
  usage: z.object({
    inputTokens: z.number().int(),
    estimatedCostUsd: z.number(),
  }),
  warnings: z.array(responseWarningSchema).optional(),
});

// ---------------------------------------------------------------------------
// Capability router
// ---------------------------------------------------------------------------

/**
 * `POST /v1/route`.
 *
 * ⚠ FAIL-SAFE, NOT FAIL-FAST: a router outage still answers 200, with
 * `reason` prefixed `fallback:`. Now the body also says
 * `fallback: true` + `fallbackCause` (both optional on the wire, so older
 * servers and clients stay compatible); there is still no status code for it.
 */
export const routeDecisionResponseSchema = z.object({
  routeId: z.string(),
  reason: z.string().describe('`fallback: …` ⇒ the default route was used, not a model choice.'),
  fallback: z
    .boolean()
    .optional()
    .describe('True ⇒ the default route was used, not a model choice. Sent on every 200 since 2026-10-06.'),
  fallbackCause: z
    .enum(ROUTE_FALLBACK_CAUSES)
    .optional()
    .describe(
      'Why the router degraded (only with `fallback: true`): `router_call_failed` (provider ' +
        'error, budget refusal, bad spec), `router_unparseable` (no `routeId` readable), ' +
        '`router_invalid_route` (an id that was not offered).',
    ),
});

// ---------------------------------------------------------------------------
// Registry write surface
// ---------------------------------------------------------------------------
// ⚠ `z.unknown()` used to model the four `jsonb` columns below. It parses as
// REQUIRED under Zod 4, but `@asteasolutions/zod-to-openapi` still emits it as
// OPTIONAL — so `RegistryEntry.required` published without `validators`,
// `effortProfiles`, `responseSchema` or `metadata`, and their `properties`
// entries were the empty schema `{}`. `validators` is `notNull default '[]'`:
// it is ALWAYS an array on the wire, and a client typing it `validators?:
// unknown` is simply wrong. Modelling the columns concretely fixes the
// `required` set and the property schema in one move.

export const projectConfigResponseBodySchema = z.object({
  config: z
    .object({
      id: z.string().uuid(),
      org: z.string(),
      project: z.string(),
      defaultModel: z.string().nullable(),
      defaultEffort: effortLevelSchema.nullable(),
      effortProfiles: effortProfilesSchema,
      contextRules: jsonObject
        .nullable()
        .describe(
          'OPEN. Keys are caller-invented recipe names, each an inline ' +
            '`includeContext` item without `name`. An `includeContext: [{ name }]` ' +
            'with no entry here, or a malformed one, fails the generation with a ' +
            '400 `SpecResolutionError` (cause `unknown context recipe`).',
        ),
      callbackUrl: z.string().nullable(),
      metadata: jsonObject.nullable().describe('OPEN. Consumer blob — no service code reads it.'),
      createdAt: z.string(),
      updatedAt: z.string().nullable(),
      updatedBy: z.string().nullable(),
    })
    .openapi('ProjectConfigResponse')
    .nullable()
    .describe('`null` when the scope has never been configured — a real 200 body.'),
});

export const registryEntrySchema = z.object({
  id: z.string().uuid(),
  org: z.string(),
  project: z.string(),
  unitType: z.string(),
  version: z.string(),
  isActive: z.boolean(),
  promptTemplate: z.string(),
  metaPromptTemplate: z.string().nullable(),
  model: z.string().nullable(),
  defaultEffort: effortLevelSchema.nullable(),
  effortProfiles: effortProfilesSchema,
  responseSchema: jsonObject
    .nullable()
    .describe(
      'OPEN, and deliberately so: this IS a JSON Schema, handed to Ajv ' +
        '(`services/ai/validators/json-schema.ts`). Re-modelling JSON Schema in ' +
        'Zod would publish a second, narrower dialect than the one Ajv accepts.',
    ),
  validators: z.array(validatorSchema).describe('`notNull default \'[]\'` — always present.'),
  renderer: z.string().nullable(),
  contentKind: z.string().nullable(),
  createdBy: z.string().nullable(),
  metadata: jsonObject.nullable().describe('OPEN. Consumer blob — no service code reads it.'),
  createdAt: z.string(),
}).openapi('RegistryEntry');

export const registryEntryResponseBodySchema = z.object({ entry: registryEntrySchema });
export const registryVersionsResponseSchema = z.object({
  versions: z.array(registryEntrySchema).describe('Newest first. `[]` when none — never a 404.'),
});
export const unitTypesResponseSchema = z.object({
  unitTypes: z.array(
    z
      .object({
        unitType: z.string(),
        activeVersion: z.string().nullable(),
        versionCount: z.number().int().nonnegative(),
      })
      .openapi('UnitTypeSummary'),
  ),
});

// ---------------------------------------------------------------------------
// Tenant provisioning
// ---------------------------------------------------------------------------

const readinessReportSchema = z.object({
  org: z.string(),
  project: z.string(),
  ready: z.boolean(),
  checks: z.array(
    z.object({
      id: z.enum(['api-key', 'budget', 'registry']),
      ok: z.boolean(),
      summary: z.string(),
      fix: z.string().optional(),
      // CONCRETE. One producer, `services/tenant/provision.ts:getTenantReadiness`,
      // and it emits exactly five literals — one per check id, two of them
      // branching. The `registry` branches share NO keys, which is why this is
      // a union and not one object with everything optional: flattening it
      // would tell a consumer `activeVersion` and `allUnitTypes` can co-occur.
      detail: z
        .union([
          z.object({ org: z.string(), project: z.string(), role: z.enum(['app', 'admin']) }),
          z.object({ configured: z.literal(false) }),
          z.object({
            configured: z.literal(true),
            limitUsd: z.number(),
            remainingUsd: z.number(),
            currency: z.string(),
          }),
          z.object({ unitType: z.string(), activeVersion: z.string().nullable() }),
          z.object({ activeUnitTypes: z.array(z.string()), allUnitTypes: z.array(z.string()) }),
        ])
        .optional(),
    }),
  ),
}).openapi('ReadinessReport');

/** `GET /v1/tenant/readiness` — the report at the TOP LEVEL, no wrapper. */
export const tenantReadinessResponseSchema = readinessReportSchema;

/**
 * `POST /v1/tenant/provision`. `manualSteps` is always exactly one entry: the
 * API key, which cannot be provisioned from inside the service.
 */
export const tenantProvisionResponseSchema = z.object({
  org: z.string(),
  project: z.string(),
  items: z.array(
    z.object({
      item: z.string().describe('`budget`, or `registry:<unitType>`.'),
      status: z.enum(['created', 'updated', 'unchanged', 'skipped', 'failed']),
      message: z.string(),
      // CONCRETE. One producer, `services/tenant/provision.ts:provisionTenant`,
      // four literals. `.optional()` is real: the budget `failed` and `skipped`
      // arms write no `detail` at all.
      detail: z
        .union([
          z.object({ limitUsd: z.number(), remainingUsd: z.number(), currency: z.string() }),
          z.object({ unitType: z.string(), version: z.string(), isActive: z.boolean() }),
          z.object({ unitType: z.string(), version: z.string() }),
          z.object({ unitType: z.string() }),
        ])
        .optional(),
    }),
  ),
  manualSteps: z.array(z.object({ item: z.string(), message: z.string() })),
  readiness: readinessReportSchema,
});

// ---------------------------------------------------------------------------
// Callback dead-letter admin
// ---------------------------------------------------------------------------

/**
 * `GET /v1/admin/callbacks`.
 *
 * ⚠ Rows are the WHOLE `callback_deliveries` row — `body` and `signature` are
 * the signed callback envelope, i.e. generated output. Admin-gated for that
 * reason. Modelled open (`passthrough`) on purpose: pinning every column here
 * would make a migration a published-contract change.
 */
export const callbackDeliveryListResponseSchema = z.object({
  deliveries: z.array(
    z
      .object({
        id: z.string(),
        org: z.string(),
        project: z.string().nullable(),
        event: z.string(),
        url: z.string(),
        status: z.string(),
        attempt: z.number().int(),
        createdAt: z.string(),
      })
      .passthrough(),
  ),
});

/** `POST /v1/admin/callbacks/{deliveryId}/replay`. */
export const callbackReplayResponseSchema = z.object({
  deliveryId: z.string(),
  status: z
    .string()
    .describe("A `callback_delivery_status` value, or `unknown` if the row vanished."),
});

// ---------------------------------------------------------------------------
// Internal (test-only; NOT registered when NODE_ENV=production)
// ---------------------------------------------------------------------------

/** `GET /v1/internal/latest-trace`. Costs are JSON numbers or null, not strings. */
export const latestTraceResponseSchema = z.object({
  traceId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
  actualCostUsd: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
  model: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Capabilities (ADR-0004) — unauthenticated, and NOT rate-limited
// ---------------------------------------------------------------------------

/**
 * `GET /v1/capabilities`.
 *
 * OPEN ACROSS VERSIONS, not open in this build: `SERVICE_CAPABILITIES`
 * (`src/capabilities.ts`) is a frozen literal of nine names, all `true`, with
 * no env or plugin switch — `routes/capabilities.test.ts` pins it by exact
 * equality. The record models what a CONSUMER must tolerate (a newer
 * deployment shipping a name this client has never heard of), which is the
 * whole negotiation posture of ADR-0004. Enumerating today's nine here would
 * publish a closed set that a deploy is allowed to grow, so it stays a record.
 */
export const capabilitiesResponseSchema = z.object({
  capabilities: z.record(z.string(), z.boolean()),
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** `GET /v1/budget/{org}`. */
export const budgetSnapshotResponseSchema = z.object({
  org: z.string(),
  limitUsd: z.number(),
  remainingUsd: z.number(),
  spentUsd: z.number(),
  currency: z.string(),
});

/** `PUT /v1/budget/{org}` — SAME body on 200 and 201; only `created` differs. */
export const setBudgetResponseSchema = z.object({
  org: z.string(),
  limitUsd: z.number(),
  remainingUsd: z.number(),
  currency: z.string(),
  created: z.boolean().describe('`true` ⇒ 201 (the org had no budget row), `false` ⇒ 200.'),
}).openapi('SetBudgetResult');

// ---------------------------------------------------------------------------
// OpenRouter credits passthrough (admin)
// ---------------------------------------------------------------------------

export const openRouterCreditsResponseSchema = z.object({
  totalCredits: z.number(),
  totalUsage: z.number(),
  remainingCredits: z.number(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Token accounting for one generation. OPTIONAL as a whole, by design: the
 * object is omitted when the provider reported no counts, so a consumer can
 * tell "not measured" from "measured as zero" and fall back to its own
 * estimate. Cost is NOT here — it stays on the sibling `costUsd`.
 */
export const generationUsageSchema = z.object({
  outputTokens: z
    .number()
    .int()
    .nonnegative()
    .describe('Tokens the model generated. The field a per-token meter bills on.'),
  inputTokens: z.number().int().positive().optional(),
  totalTokens: z.number().int().positive().optional(),
}).openapi('GenerationUsage');

/**
 * Why the model stopped, normalized off the provider's raw `finish_reason`
 * (OpenAI `length`, Anthropic `max_tokens`, Google `MAX_TOKENS` all fold to
 * `length`). Optional: omitted when the provider reported nothing, and on
 * cache hits, where it is not stored and would be a guess.
 */
export const finishReasonSchema = z
  .enum(['stop', 'length', 'content_filter', 'other'])
  .describe(
    '`stop` = model finished on its own. `length` = truncated at the output ' +
      'token cap (`effortProfile.maxOutputTokens`) — consumers metering credits ' +
      'must settle this differently from `stop`. `content_filter` = withheld on ' +
      'provider safety grounds. `other` = anything else, including provider ' +
      'reasons this service does not model.',
  )
  .openapi('FinishReason');

/**
 * `POST /v1/generate` (202-style launch, answered 200).
 *
 * ⚠ TWO shapes behind one status. A fresh launch may carry `warnings`; an
 * IDEMPOTENT REPLAY returns the stored handle, which is the four required
 * fields and never `warnings`. Modelled as one schema with `warnings`
 * optional, because that is what a consumer can actually branch on.
 */
export const launchGenerationResponseSchema = z.object({
  requestId: z.string().uuid(),
  channel: z.string().describe('`request:<requestId>:generations` — the `/v1/events` channel.'),
  totalJobs: z.number().int(),
  estimatedCostUsd: z.number(),
  warnings: z.array(responseWarningSchema).optional(),
});

/** What one `includeContext` item retrieved. Ids only — never chunk text. */
export const retrievalTraceEntrySchema = z.object({
  key: z.string().describe('The `__context` key the chunks were rendered under.'),
  corpus: z.string(),
  chunkIds: z.array(z.string()).describe('In rank order; exactly the chunks the prompt got.'),
  legs: z.array(retrievalLegSchema),
  warnings: z.array(retrievalWarningSchema).optional(),
}).openapi('RetrievalTraceEntry');

/**
 * The body of `POST /v1/generate/sync` — and, field for field, the payload of
 * the terminal `done` frame on `/v1/generate/stream`. One projection, two
 * transports; they are kept in one schema so they cannot drift.
 *
 * `parsed` is written unconditionally by the handler but its value may be
 * `undefined`, which `JSON.stringify` DROPS — so on the wire the key is
 * absent, not null.
 *
 * `systemPromptApplied` is the system-prompt migration handle named by
 * `src/capabilities.ts`. It is returned UNCONDITIONALLY and was missing from
 * the published document; a consumer moving off the system-fold workaround
 * reads exactly this field.
 */
export const syncGenerationResponseSchema = z.object({
  text: z.string(),
  parsed: jsonValue
    .optional()
    .describe(
      'OPEN: the model output parsed against the CALLER\'s `responseSchema`, so ' +
        'its shape is the caller\'s to declare. Absent (never `null`) when the ' +
        'generation was plain text — `JSON.stringify` drops the `undefined`.',
    ),
  modelUsed: z.string(),
  provider: z.string(),
  costUsd: z.number(),
  usage: generationUsageSchema.optional(),
  finishReason: finishReasonSchema.optional(),
  traceId: z.string(),
  systemPromptApplied: z
    .boolean()
    .describe('Did the request carry a system prompt that this deployment applied as one?'),
  warnings: z.array(responseWarningSchema).optional(),
  retrievalTrace: z
    .array(retrievalTraceEntrySchema)
    .optional()
    .describe(
      'One entry per `includeContext` item, in request order: the chunk ids ' +
        'that grounded the prompt, the legs that ran, and any retrieval ' +
        'warnings. Present only when the request carried `includeContext`.',
    ),
}).openapi('SyncGenerationResult');

/**
 * One generation job row, exactly as `serializeJob` (`routes/generate.ts`)
 * emits it. All TEN keys are written unconditionally — `output` included,
 * which is why it is REQUIRED here. It was declared `z.unknown().nullable()`
 * and therefore published as OPTIONAL with the empty schema `{}`.
 */
export const generationJobSchema = z.object({
  unitKey: z.string(),
  unitType: z.string().nullable(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  // Two branches, one column (`generation_jobs.output`, sole writer
  // `workers/generation.worker.ts:writeTerminalStatus`):
  //   · the caller's STRUCTURED output when a `responseSchema` was supplied —
  //     `JSON.parse` of the model text, so it can be an array or a scalar, not
  //     only an object. That is why this is `jsonValue` and not a record.
  //   · `{ text, flags }` otherwise.
  // ⚠ `null` is NOT implied by a terminal status and a non-null value is not
  // implied by success: a `failed` row still carries `output` when the failure
  // was a validator BLOCKER, and `queued`/`running`/`cancelled` rows are null.
  output: z.union([
    z.object({ text: z.string(), flags: z.array(generationFlagSchema) }),
    jsonValue,
  ]),
  error: z.string().nullable(),
  estimatedCostUsd: z.number().nullable(),
  actualCostUsd: z.number().nullable(),
  registryEntryId: z.string().uuid().nullable(),
  traceId: z.string().uuid().nullable(),
  finishedAt: z.string().nullable(),
}).openapi('GenerationJob');

/** `GET /v1/generate/units/{unitKey}/latest`. */
export const latestUnitResponseSchema = z.object({ unit: generationJobSchema });

/** `GET /v1/generate/{requestId}`. */
export const generationRequestStateSchema = z.object({
  requestId: z.string(),
  status: z.enum(['queued', 'running', 'partial', 'completed', 'failed', 'cancelled']),
  totalJobs: z.number().int(),
  completedJobs: z.number().int(),
  failedJobs: z.number().int(),
  estimatedCostUsd: z.number(),
  actualCostUsd: z.number(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  units: z.array(generationJobSchema),
});

/**
 * `POST /v1/generate/{requestId}/cancel`.
 *
 * `lostJobs` counts jobs the cancel could not account for — they were already
 * off the queue and in flight. It was missing from the published document, and
 * it is the ONLY signal that a cancel was incomplete, so a consumer that bills
 * on cancellation has to read it.
 */
export const cancelGenerationResponseSchema = z.object({
  cancelled: z.boolean(),
  removedJobs: z.number().int(),
  alreadyCancelled: z
    .literal(true)
    .optional()
    .describe('Present only on an idempotent repeat of a cancel that already ran.'),
  lostJobs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Jobs already in flight when the cancel landed. Absent when zero.'),
});

/**
 * 504 `ProviderTimeout` on `/v1/generate/sync` and `/v1/route`.
 *
 * Our own provider timeout (`LLM_REQUEST_TIMEOUT_MS` deadline or the stream
 * stall backstop, in any pass) is the `ProviderTimeout` taxonomy class and
 * carries every field below; the call was NOT billed (decision).
 * The new fields are OPTIONAL because `/v1/generate/sync` still sends the
 * older two-field literal `{ error, message }` when a process SHUTDOWN cuts a
 * call — that path is billed, and says nothing about truncation.
 */
export const providerTimeoutBodySchema = z.object({
  error: z.literal('ProviderTimeout'),
  code: z.literal('ERR_PROVIDER_TIMEOUT').optional(),
  truncated: z
    .literal(true)
    .optional()
    .describe('The provider was cut off by the request timeout. The call was not billed.'),
  reason: z.literal('provider_timeout').optional(),
  traceId: z.string().optional().describe('The router trace of the cut call.'),
  message: z.string(),
});

/**
 * 502 `EmptyCompletion` on `/v1/generate/sync`: the provider answered with no
 * text on every attempt of the router's bounded retry ladder. Not billed, not
 * cached. Same class as the `/v1/generate/stream` error frame
 * `code: 'EmptyCompletion'`.
 */
export const emptyCompletionBodySchema = z.object({
  error: z.literal('EmptyCompletion'),
  code: z.literal('ERR_EMPTY_COMPLETION'),
  traceId: z.string().optional().describe('The router trace of the failed call.'),
  message: z.string(),
});

/**
 * `ProviderUnavailable` — the circuit breaker is open. Sent with a
 * `retry-after` header in SECONDS; `retryAfterMs` on the body is the same
 * budget in milliseconds, because the SSE transport has no headers to read.
 */
export const providerUnavailableBodySchema = z.object({
  error: z.literal('ProviderUnavailable'),
  code: z.literal('ERR_PROVIDER_UNAVAILABLE'),
  retryAfterMs: z.number().int().positive(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// SSE frames
// ---------------------------------------------------------------------------
// Both streaming routes write `data: <json>\n\n` frames after hijacking the
// reply, and open with the comment frame `: ok\n\n`. A comment frame is not
// JSON and carries no schema; only `data:` payloads are modelled here.

/** `/v1/generate/stream` — an incremental token batch. Zero of these on a cache hit. */
export const streamDeltaFrameSchema = z.object({
  type: z.literal('delta'),
  text: z.string(),
})
  .openapi('GenerateStreamDelta');

/** `/v1/generate/stream` — the terminal success frame. Same projection as `/sync`. */
export const streamDoneFrameSchema = syncGenerationResponseSchema
  .extend({ type: z.literal('done') })
  .openapi('GenerateStreamDone');

/**
 * `/v1/generate/stream` — the terminal failure frame.
 *
 * ⚠ THE FIELD NAMES SWAP BETWEEN TRANSPORTS. Here `code` is what the JSON body
 * calls `error` (the class discriminator), and `errorCode` is what the JSON
 * body calls `code` (the `ERR_*` string). A consumer sharing one error mapper
 * across both transports must translate.
 *
 * ⚠ A budget refusal (402) and an open breaker (503) NEVER appear as an HTTP
 * status on this route — the reply is hijacked at 200 before either can be
 * raised, so they arrive as this frame. Only classes marked `midStream` name
 * themselves; everything else collapses to `INTERNAL` / `generation failed`.
 */
export const streamErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  errorCode: z.string().optional(),
  retryAfterMs: z.number().int().positive().optional(),
  /** `ProviderTimeout` only: the provider was cut off; the call was NOT billed. */
  truncated: z.literal(true).optional(),
  /** `ProviderTimeout` only: `provider_timeout`. */
  reason: z.string().optional(),
  /** `ProviderTimeout` and `EmptyCompletion`: the router trace of the failed call. */
  traceId: z.string().optional(),
})
  .openapi('GenerateStreamError');

export const streamFrameSchema = z.discriminatedUnion('type', [
  streamDeltaFrameSchema,
  streamDoneFrameSchema,
  streamErrorFrameSchema,
]);

/**
 * `GET /v1/events/{channel}` — one forwarded `AppEvent`.
 *
 * The channel is scoped to a single `requestId`, and only events carrying that
 * `requestId` are forwarded, so the `trace.*` members of the union can never
 * appear here. There is no terminal frame: the stream simply ends. A `: ping`
 * comment frame every 15 s keeps intermediaries from reaping the connection.
 */
export const generationEventFrameSchema = z
  .object({
    type: z.string(),
    requestId: z.string(),
    org: z.string(),
    project: z.string().optional(),
  })
  .passthrough()
  .openapi('GenerationEvent');
