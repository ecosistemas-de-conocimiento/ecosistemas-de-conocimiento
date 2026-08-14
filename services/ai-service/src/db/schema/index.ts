// Drizzle schema — single file on purpose.
//
// drizzle-kit (0.30.x) loads this module through esbuild-register, which does
// not remap `.js`-extension relative imports to their `.ts` source — so the
// schema can't be split into `./enums.js`, `./traces.js`, … and still be read
// by `drizzle-kit generate`. Keep everything here; section it instead.
//
// ── Project-agnostic rule (ADR-0001) ─────────────────────────────────────────
// The AI service never interprets a consuming app's domain. So a column exists
// here ONLY if the service itself reads it: scoping tags, status, token/cost
// accounting, queue/retry bookkeeping, effort knobs, the prompt-registry
// version. Anything that's the consumer's vocabulary — what a "unit" is, how it
// groups, prior-context flags, presentational labels — lives in opaque `text`
// keys or `jsonb` blobs (`input`, `output`, `metadata`, …) that the service
// stores, ferries and aggregates by, but does not look inside.
//
// Provenance: derived from a prototype's Payload AI collections — `AiCompanionTraces`,
// `AiUsageLogs`, `LlmConfigs`, `GenerationRequests` — `GenerationJob` (a
// transient BullMQ payload in a prototype), and `DimensionSpec` / `TASK_PROFILES`
// (pulled forward from M3's "registry" into `registry_entries` +
// `project_configs`). The
// Prototype-specific pieces (story / dimension / scopeType / surface / tone /
// traceType / the dimensions list / includeContext shapes) are gone from the
// column set; they ride along inside `unit_key` / `unit_type` / `metadata` /
// `input` / `spec_override` instead.
//
// Spec-delivery model = **C, registry with inline fallback** (see the consumer
// contract doc): a consumer may register per-`unitType` `registry_entries`
// (prompt template + version, model/effort profiles, response schema, checks)
// so `/v1/generate` units stay thin; a per-call inline spec on the request/unit
// overrides the registered one; `generation_jobs.registry_entry_id` records
// which entry actually applied (null ⇒ generated from an inline spec). Entries
// inherit project-level defaults from `project_configs`. A batch's units run in
// parallel by default but may declare `depends_on` (other unitKeys in the same
// batch) and the orchestrator orders them, feeding predecessors' outputs in.
// Checks are either builtins (code in the service, named) or inline rules the
// consumer supplies (data the service interprets generically).
//
// Every row is stamped `org` (always) + `project` (nullable, but NOT NULL on
// `registry_entries`, which are inherently project-scoped) — opaque scoping
// tags, never joined on; they drive cost/budget attribution, trace/usage
// observability, registry isolation, and RAG-corpus isolation only.
//
// Milestone 4 adds the RAG tables: corpora, documents, chunks (with a `vector`
// column).

import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Shared column factories
// ---------------------------------------------------------------------------
// Drizzle column builders are stateful, so reusable columns must be produced
// fresh per table — hence factory functions rather than shared instances.

/** `{org, project}` opaque scoping tags — see ADR-0001. */
const scopingColumns = () => ({
  org: text('org').notNull(),
  project: text('project'),
});

const idColumn = () => uuid('id').primaryKey().defaultRandom();

const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Money-ish: token-fractional USD costs — 6 dp is plenty, 12 digits total. */
const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });

/** Opaque consumer payload the service stores but never interprets. */
const metadataColumn = () => jsonb('metadata');

/**
 * pgvector column factory — Drizzle has no first-class pgvector support yet, so
 * we declare a `customType` whose driver representation is the standard pgvector
 * text encoding `[v1,v2,...]`. The dimension is fixed at the SQL-type level
 * (`vector(N)`) so we don't try to push a runtime-variable length through the
 * type system. See `chunks.embedding` (1024-dim, matches the default open
 * multilingual model `baai/bge-m3`; migration 0013 re-cut it from 1536).
 */
const vectorColumn = (name: string, dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return JSON.parse(value) as number[];
    },
  })(name);

/**
 * `tsvector` column factory. Drizzle has no native tsvector type. We never
 * read or write this column through the query builder — the ingest worker
 * fills it with a raw `to_tsvector(<config>::regconfig, text)` statement and
 * the hybrid retrieve matches against it in raw SQL — so the TS-side
 * representation is just an opaque string. Declaring it here keeps the Drizzle
 * schema a faithful mirror of the database (otherwise `drizzle-kit generate`
 * would propose dropping the column).
 */
const tsvectorColumn = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return 'tsvector';
    },
  })(name);

/**
 * pgvector `sparsevec` column factory — the learned-sparse (bge-m3) lexical leg
 * (see `chunks.sparse_embedding`, migration 0001). Like `vectorColumn`, Drizzle
 * has no first-class support, so we declare a `customType` whose driver
 * representation is pgvector's sparsevec text encoding `{i1:v1,i2:v2,...}/DIM`
 * (1-based indices, ascending). The DIM is fixed at the SQL-type level
 * (`sparsevec(N)`), matching `env.SPARSE_DIM` (bge-m3 vocab = 250002).
 *
 * We never read or write this column through the query builder — the ingest
 * worker fills it with a raw parameterised UPDATE and the hybrid retrieve
 * matches against it in raw SQL (the sparse literal is built in
 * `src/services/ai/embeddings/sparse-embed.ts`), exactly like `text_search`.
 * Declaring it here keeps the Drizzle schema a faithful mirror of the database
 * so `drizzle-kit generate` does not propose dropping the column. The HNSW ANN
 * index (`sparsevec_ip_ops`) lives in the migration SQL, not here — same as the
 * dense `embedding` HNSW index (Drizzle does not model `USING hnsw`).
 */
const sparsevecColumn = (name: string, dim: number) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return `sparsevec(${dim})`;
    },
  })(name);

// ---------------------------------------------------------------------------
// Enums (structural only — things the service branches on)
// ---------------------------------------------------------------------------

export const effortLevel = pgEnum('effort_level', ['quick', 'standard', 'deep', 'maximum']);

export const traceStatus = pgEnum('trace_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'aborted',
]);

export const usageStatus = pgEnum('usage_status', ['completed', 'aborted', 'failed']);

export const llmProvider = pgEnum('llm_provider', [
  'openrouter',
  'openai',
  'anthropic',
  'azure_openai',
  'google',
  'local',
]);

export const budgetEnforcement = pgEnum('budget_enforcement', ['soft', 'hard']);

export const generationRequestStatus = pgEnum('generation_request_status', [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
  'cancelled',
]);

export const generationJobStatus = pgEnum('generation_job_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// llm_configs — BYOK provider credentials + per-org limits/budgets
// ---------------------------------------------------------------------------
// From a prototype's `llmConfigs`. Org-scoped, so `project` is intentionally absent.
// The API key arrives and leaves the service encrypted (AES-256-GCM in the app
// layer); the DB only ever holds ciphertext — hence `apiKeyEncrypted`.
// Resolution/redaction is the router's job, not the schema's.

export const llmConfigs = pgTable(
  'llm_configs',
  {
    id: idColumn(),
    org: text('org').notNull(),

    provider: llmProvider('provider').notNull(),
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    baseUrl: text('base_url'),
    defaultModel: text('default_model'),

    maxTokensPerRequest: integer('max_tokens_per_request').notNull().default(4096),
    requestsPerMinute: integer('requests_per_minute').notNull().default(60),
    tokensPerDay: integer('tokens_per_day').notNull().default(1_000_000),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 20, scale: 9 })
      .notNull()
      .default('100'),
    budgetEnforcement: budgetEnforcement('budget_enforcement').notNull().default('soft'),

    isActive: boolean('is_active').notNull().default(true),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgProviderIdx: index('llm_configs_org_provider_idx').on(t.org, t.provider),
    activeIdx: index('llm_configs_active_idx').on(t.isActive),
  }),
);

// ---------------------------------------------------------------------------
// project_configs — project-level AI defaults that registry entries inherit
// ---------------------------------------------------------------------------
// One row per `(org, project)`. The registry is "entries, but grouped": each
// `registry_entries` row is independent, but a field it leaves unset falls back
// here (default model, default effort + profiles, common context rules), and
// the consumer's default webhook for async results lives here too (a request
// may override it). The router reads `effort_profiles` / `context_rules`;
// `metadata` is opaque.

export const projectConfigs = pgTable(
  'project_configs',
  {
    id: idColumn(),
    org: text('org').notNull(),
    project: text('project').notNull(),

    defaultModel: text('default_model'),
    defaultEffort: effortLevel('default_effort'),
    effortProfiles: jsonb('effort_profiles'), // map effort_level → profile; entry-level overrides win
    contextRules: jsonb('context_rules'), // e.g. corpora to always retrieve from, default k — partly read by the router
    callbackUrl: text('callback_url'), // default async-results webhook; a request's callbackUrl overrides

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Opaque actor ref — the `actor_key_id` of the last writer; null on initial inserts. */
    updatedBy: text('updated_by'),
  },
  (t) => ({
    orgProjectUnique: uniqueIndex('project_configs_org_project_idx').on(t.org, t.project),
  }),
);

// ---------------------------------------------------------------------------
// registry_entries — the per-(org, project, unitType) generation spec
// ---------------------------------------------------------------------------
// What a consumer registers so its `/v1/generate` units can be thin
// (`unitType` + `input` vars) instead of carrying the whole prompt + schema
// inline on every call. Pulled forward from M3's registry (a prototype's
// `DimensionSpec` / `TASK_PROFILES`). The *shape* is project-agnostic; the
// *contents* are the consuming project's. Unset fields fall back to
// `project_configs`.
//
// Versioned: every `(org, project, unitType, version)` is its own row; exactly
// one is `isActive` per `(org, project, unitType)` — the one `/v1/generate`
// resolves against (a per-call inline `spec_override` beats it; model C).
// `version` is free-form text (a semver, a date, a git sha — the consumer's
// choice); "current" is the `isActive` flag, not an ordering.
//
// `validators` is a list of checks to run on the output. An entry is either a
// builtin's name (`"json-schema"`, `"gherkin-syntax"`, …) or an inline rule the
// consumer supplies (`{ "type": "json-schema", "schema": {…} }`, `{ "type":
// "regex", "pattern": "…" }`, …) — builtins are code in the service; inline
// rules are data the service interprets generically. `prompt_template` is just
// text: with placeholders it's a template the service renders from `input`,
// without them it's a finished prompt. `model` / `effortProfiles` are read by
// the router; `responseSchema` is enforced against the output (null ⇒
// unstructured); `renderer` / `contentKind` are opaque hints handed back.

export const registryEntries = pgTable(
  'registry_entries',
  {
    id: idColumn(),
    org: text('org').notNull(),
    project: text('project').notNull(), // registry entries are inherently project-scoped

    unitType: text('unit_type').notNull(),
    version: text('version').notNull().default('1'),
    isActive: boolean('is_active').notNull().default(true),

    promptTemplate: text('prompt_template').notNull(),
    metaPromptTemplate: text('meta_prompt_template'),

    model: text('model'), // default model for this unit type; null ⇒ fall back to effort profile / llm_config
    defaultEffort: effortLevel('default_effort'),
    effortProfiles: jsonb('effort_profiles'), // map effort_level → profile; read by the router

    responseSchema: jsonb('response_schema'), // JSON Schema the output must validate against; null ⇒ unstructured
    validators: jsonb('validators').notNull().default(sql`'[]'::jsonb`), // [ "builtin-name" | { type, ...inline rule } ]
    renderer: text('renderer'), // opaque passthrough hint
    contentKind: text('content_kind'), // opaque passthrough hint

    createdBy: text('created_by'), // opaque user ref
    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgProjectIdx: index('registry_entries_org_project_idx').on(t.org, t.project),
    unitTypeIdx: index('registry_entries_unit_type_idx').on(t.org, t.project, t.unitType),
    versionUnique: uniqueIndex('registry_entries_version_idx').on(
      t.org,
      t.project,
      t.unitType,
      t.version,
    ),
    activeUnique: uniqueIndex('registry_entries_active_idx')
      .on(t.org, t.project, t.unitType)
      .where(sql`${t.isActive}`),
  }),
);

// ---------------------------------------------------------------------------
// generation_requests — one row per batch submitted to /v1/generate
// ---------------------------------------------------------------------------
// From a prototype's `generationRequests`. The consumer has already expanded any
// project-wide scope into a flat batch of opaque units before calling, so there
// is no `scope`/`story`/`dimensions` here — only what the orchestrator needs:
// the effort knobs and overrides, the rollup counters, the cost totals.
// `clientRequestId` is a consumer-supplied correlation/idempotency key.

export const generationRequests = pgTable(
  'generation_requests',
  {
    id: idColumn(),
    ...scopingColumns(),

    requestedBy: text('requested_by'), // opaque user ref — attribution only
    clientRequestId: text('client_request_id'), // opaque correlation / idempotency key

    status: generationRequestStatus('status').notNull().default('queued'),
    totalJobs: integer('total_jobs').notNull().default(0),
    completedJobs: integer('completed_jobs').notNull().default(0),
    failedJobs: integer('failed_jobs').notNull().default(0),

    effort: effortLevel('effort').notNull().default('standard'),
    effortOverrides: jsonb('effort_overrides'), // opaque: per-unit effort map
    promptOverride: text('prompt_override'),
    metaPromptOverride: text('meta_prompt_override'),
    modelOverride: text('model_override'),
    includeContext: jsonb('include_context'), // consumer's context flags — app-supplied blobs + "service, also retrieve X" instructions
    callbackUrl: text('callback_url'), // webhook POSTed when this request finishes; overrides project_configs.callbackUrl
    /**
     * Captured at enqueue time so the callback emitter can look up the
     * `API_KEYS[<key>].callbackSecret` without re-deriving from request
     * headers (which are gone by the time a terminal transition fires from
     * the worker). See `src/services/callbacks/emit.ts`.
     */
    apiKeyId: text('api_key_id'),

    estimatedCostUsd: usd('estimated_cost_usd').notNull().default('0'),
    actualCostUsd: usd('actual_cost_usd').notNull().default('0'),

    metadata: metadataColumn(),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgIdx: index('generation_requests_org_idx').on(t.org),
    projectIdx: index('generation_requests_project_idx').on(t.project),
    statusIdx: index('generation_requests_status_idx').on(t.status),
    clientRequestIdx: uniqueIndex('generation_requests_client_request_idx')
      .on(t.org, t.clientRequestId)
      .where(sql`${t.clientRequestId} is not null`),
  }),
);

// ---------------------------------------------------------------------------
// generation_jobs — one row per generation unit in a batch
// ---------------------------------------------------------------------------
// Persisted form of a prototype's transient `GenerationJob`. A "unit" is opaque: the
// consumer gives it a `unitKey` (its own id for the thing being generated) and
// an optional `unitType` (a grouping tag — what a prototype called a dimension — used
// only for per-type cost rollup). `input`/`output` are the request/result
// blobs the service ferries to/from the model. `queueJobId` links to BullMQ;
// `traceId` is a soft link to the LLM call.

export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: idColumn(),
    generationRequestId: uuid('generation_request_id')
      .notNull()
      .references(() => generationRequests.id, { onDelete: 'cascade' }),
    ...scopingColumns(),

    unitKey: text('unit_key').notNull(), // opaque: consumer's id for this unit
    unitType: text('unit_type'), // opaque: grouping tag for cost rollup + registry lookup
    dependsOn: jsonb('depends_on'), // opaque: array of unitKeys (same request) that must finish first; their outputs are fed into this unit
    input: jsonb('input'), // opaque: what to generate (prompt inputs + context)
    output: jsonb('output'), // opaque: the generated result

    registryEntryId: uuid('registry_entry_id'), // resolved registry_entries.id; null ⇒ generated from an inline spec
    specOverride: jsonb('spec_override'), // opaque: per-unit inline spec (prompt/schema/validators) — beats the registry lookup (model C)

    status: generationJobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),

    effort: effortLevel('effort').notNull(),
    priority: integer('priority').notNull().default(5),

    traceId: uuid('trace_id'),
    queueJobId: text('queue_job_id'),

    estimatedCostUsd: usd('estimated_cost_usd'),
    actualCostUsd: usd('actual_cost_usd'),

    metadata: metadataColumn(),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
  },
  (t) => ({
    requestIdx: index('generation_jobs_request_idx').on(t.generationRequestId),
    orgIdx: index('generation_jobs_org_idx').on(t.org),
    statusIdx: index('generation_jobs_status_idx').on(t.status),
    queueJobIdx: index('generation_jobs_queue_job_idx').on(t.queueJobId),
    registryEntryIdx: index('generation_jobs_registry_entry_idx').on(t.registryEntryId),
    unitKeyIdx: uniqueIndex('generation_jobs_request_unit_idx').on(t.generationRequestId, t.unitKey),
  }),
);

// ---------------------------------------------------------------------------
// traces — one row per LLM call
// ---------------------------------------------------------------------------
// From a prototype's `aiCompanionTraces`, stripped to what the service owns: status,
// model/provider, token+cost+duration accounting, effort + the resolved effort
// profile, the prompt-registry version, and soft links to the request/job/
// parent trace. `label` is a single opaque grouping tag (what a prototype spread over
// `surface`/`traceType`). Append-only in spirit — the links are plain uuids,
// not FKs, so a trace can be flushed before (or without) its parents existing.

export const traces = pgTable(
  'traces',
  {
    id: idColumn(),
    ...scopingColumns(),

    generationRequestId: uuid('generation_request_id'),
    generationJobId: uuid('generation_job_id'),
    registryEntryId: uuid('registry_entry_id'), // which registry entry's spec drove this call; null ⇒ inline spec
    parentTraceId: uuid('parent_trace_id'),

    actorUserId: text('actor_user_id'), // opaque user ref
    label: text('label'), // opaque grouping tag

    status: traceStatus('status').notNull().default('queued'),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'), // version from the service's prompt registry

    inputPayload: jsonb('input_payload'),
    outputPayload: jsonb('output_payload'),
    tokenUsage: jsonb('token_usage'),
    durationMs: integer('duration_ms'),

    effort: effortLevel('effort'),
    effortProfileUsed: jsonb('effort_profile_used'),
    estimatedCostUsd: usd('estimated_cost_usd'),
    actualCostUsd: usd('actual_cost_usd'),
    costBreakdown: jsonb('cost_breakdown'),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgIdx: index('traces_org_idx').on(t.org),
    projectIdx: index('traces_project_idx').on(t.project),
    labelIdx: index('traces_label_idx').on(t.label),
    parentIdx: index('traces_parent_idx').on(t.parentTraceId),
    generationRequestIdx: index('traces_generation_request_idx').on(t.generationRequestId),
    generationJobIdx: index('traces_generation_job_idx').on(t.generationJobId),
    registryEntryIdx: index('traces_registry_entry_idx').on(t.registryEntryId),
  }),
);

// ---------------------------------------------------------------------------
// usage_logs — append-only billing/usage ledger
// ---------------------------------------------------------------------------
// From a prototype's `aiUsageLogs` (create-only). One row per provider call charged.
// Soft links to the trace / request / job it belongs to. Nothing updates or
// deletes these — aggregate over them for `GET /v1/budget/:org`.

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: idColumn(),
    ...scopingColumns(),

    userId: text('user_id'), // opaque user ref — attribution only
    generationRequestId: uuid('generation_request_id'),
    generationJobId: uuid('generation_job_id'),
    traceId: uuid('trace_id'),

    provider: text('provider'),
    model: text('model'),
    endpoint: text('endpoint'), // which service endpoint incurred it, e.g. '/v1/generate/sync'

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: usd('estimated_cost_usd'),
    actualCostUsd: usd('actual_cost_usd'),
    status: usageStatus('status').notNull().default('completed'),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgIdx: index('usage_logs_org_idx').on(t.org),
    projectIdx: index('usage_logs_project_idx').on(t.project),
    createdAtIdx: index('usage_logs_created_at_idx').on(t.createdAt),
    traceIdx: index('usage_logs_trace_idx').on(t.traceId),
    generationRequestIdx: index('usage_logs_generation_request_idx').on(t.generationRequestId),
  }),
);

// ---------------------------------------------------------------------------
// registry_audit — append-only audit log of registry writes
// ---------------------------------------------------------------------------
// One row per mutating registry action (`config.update`,
// `unit_type.version.create`, `unit_type.version.activate`, …). `action` is
// free-form text (NOT a pgEnum) — the action vocabulary will grow.
//
// `actor_key_id` is a stable, opaque derivation of the bearer API key used by
// the writer: SHA-256 of the raw key, hex-encoded, first 16 chars (see
// `src/plugins/auth.ts` — single source of truth). It is NOT reversible into
// the key; it's only stable across requests using the same key.
//
// `before`/`after` snapshots are jsonb (nullable — some actions don't target a
// single row, and inserts have no `before`). Append-only by convention; nothing
// updates or deletes these rows.

export const registryAudit = pgTable(
  'registry_audit',
  {
    id: idColumn(),
    org: text('org').notNull(),
    project: text('project').notNull(),

    /** SHA-256(key) first 16 hex chars — see `src/plugins/auth.ts`. */
    actorKeyId: text('actor_key_id').notNull(),

    /** e.g. 'config.update', 'unit_type.version.create', 'unit_type.version.activate'. */
    action: text('action').notNull(),
    /** e.g. 'project_configs', 'registry_entries'. */
    targetTable: text('target_table').notNull(),
    /** Nullable — some actions don't target a single row. */
    targetId: uuid('target_id'),

    before: jsonb('before'),
    after: jsonb('after'),

    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgProjectCreatedIdx: index('registry_audit_org_project_created_idx').on(
      t.org,
      t.project,
      t.createdAt.desc(),
    ),
    actorCreatedIdx: index('registry_audit_actor_created_idx').on(
      t.actorKeyId,
      t.createdAt.desc(),
    ),
  }),
);

// ---------------------------------------------------------------------------
// budget_state — single-row-per-org live remaining budget
// ---------------------------------------------------------------------------
// One mutable row per `org`; the atomic `UPDATE … RETURNING` on
// `remaining_usd` is the reserve primitive (see
// `src/services/budget/enforcer.ts` and `plan/m3-m4-decisions.md` §2).
// `usage_logs` remains the append-only audit trail for spend; this table is
// only the live counter the router decrements/refunds/trues-up. A future
// reconciliation job will rebuild `remaining_usd` from `usage_logs` when
// monthly resets land. `org` is opaque (no `organizations` table — see the
// cross-cutting note in decisions doc); `project` is intentionally absent
// because budget is org-scoped, not project-scoped.

export const budgetState = pgTable(
  'budget_state',
  {
    id: idColumn(),
    org: text('org').notNull().unique(),
    // Mirrors llm_configs.monthlyBudgetUsd default (100 USD) and scale (20,9 —
    // 9 fractional digits to track sub-cent LLM costs; widened from (12,2) in
    // 0008 after a dev smoke showed $0.00000765 calls truncating
    // to $0 on this counter).
    limitUsd: numeric('limit_usd', { precision: 20, scale: 9 }).notNull().default('100'),
    remainingUsd: numeric('remaining_usd', { precision: 20, scale: 9 }).notNull().default('100'),
    currency: text('currency').notNull().default('USD'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // ── 0007_budget_reset — see plan/budget-reset-followup.md ──────────────
    // `reset_cadence` enum-like values: 'monthly_calendar' (1st of UTC
    // month), 'monthly_anniversary' (per `reset_anchor_day`), 'weekly'
    // (every Monday 00:00 UTC), 'never' (disable). `reset_anchor_day` is
    // 1–28 to dodge Feb edge cases. `reset_tz` is an IANA tz; defaults to
    // 'UTC'. `last_reset_at` is null on initial bootstrap (no reset yet);
    // `next_reset_at` is computed at row creation + on each reset.
    // `soft_cap_pct` is the percent-spent threshold above which the reserve
    // still succeeds but the response carries a warning;
    // `soft_cap_warned_at` throttles the warning (enforcer details).
    resetCadence: text('reset_cadence').notNull().default('monthly_anniversary'),
    resetAnchorDay: integer('reset_anchor_day').notNull().default(1),
    resetTz: text('reset_tz').notNull().default('UTC'),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true }),
    nextResetAt: timestamp('next_reset_at', { withTimezone: true }),
    softCapPct: numeric('soft_cap_pct', { precision: 5, scale: 2 }).notNull().default('90'),
    softCapWarnedAt: timestamp('soft_cap_warned_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('budget_state_org_idx').on(t.org),
  }),
);

// ---------------------------------------------------------------------------
// corpora — RAG: a named, project-scoped collection of documents+chunks
// ---------------------------------------------------------------------------
// One row per `(org, project, name)` triple. Each corpus declares the
// embedding model + dimension its chunks were embedded with (`embedding_model`
// / `embedding_dim`; default now the open multilingual `baai/bge-m3` @ 1024-dim,
// config-driven via `env.EMBEDDING_MODEL` / `env.EMBEDDING_DIM`; migration 0013)
// and the chunking strategy used at ingest time (`chunk_strategy` / `chunk_size`
// / `chunk_overlap`; §11 — recursive-character, ~800 tokens, 100 overlap). The
// dimension is repeated here for forward-compat (per-corpus partial indexes once
// we support multi-dim), but the live `chunks.embedding` SQL type is hard-bound
// to `vector(1024)` — switching dim is a schema migration, not a config flip.
// `metadata` is the consumer's opaque blob.

export const corpora = pgTable(
  'corpora',
  {
    id: idColumn(),
    org: text('org').notNull(),
    project: text('project').notNull(),
    name: text('name').notNull(),

    embeddingModel: text('embedding_model')
      .notNull()
      .default('baai/bge-m3'),
    embeddingDim: integer('embedding_dim').notNull().default(1024),
    chunkStrategy: text('chunk_strategy').notNull().default('recursive-char'),
    chunkSize: integer('chunk_size').notNull().default(800),
    chunkOverlap: integer('chunk_overlap').notNull().default(100),
    /**
     * Options for chunk strategies that need more than `(size, overlap)`.
     * Read by `resolveChunker` (src/services/rag/chunk-strategy.ts); shape is
     * validated per-strategy there, not here. Null ⇒ strategy defaults.
     */
    chunkConfig: jsonb('chunk_config'),
    /**
     * Postgres text-search regconfig used to build `chunks.text_search` and to
     * parse queries on the lexical leg of a hybrid retrieve. Stored as text,
     * cast to `regconfig` as a BOUND parameter at query time.
     *
     * Set directly on the wire: consumers send a Postgres text-search config
     * NAME on ingest / corpus-create (`language: 'spanish'`), validated against
     * the installed whitelist (src/services/rag/language.ts) so an unknown name
     * can never reach `::regconfig`. Stored verbatim; the default is `'simple'`.
     *
     * This IS live and per-corpus: a corpus stored as `'spanish'` builds AND
     * queries its lexical leg with Spanish stemming (index and query read the
     * SAME corpus row, so they always align — the cross-language zero-rows
     * footgun cannot recur). The dense multilingual model carries the rest of
     * the semantic/cross-language matching. `'simple'` is the neutral,
     * no-stemming default for content-agnostic corpora.
     */
    textSearchConfig: text('text_search_config').notNull().default('simple'),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => ({
    nameUnique: uniqueIndex('corpora_org_project_name_idx').on(t.org, t.project, t.name),
  }),
);

// ---------------------------------------------------------------------------
// corpus_aliases — RAG: a named pointer to an existing corpus (no chunks)
// ---------------------------------------------------------------------------
// A cheap, re-embed-free `:latest`-style rolling pointer. One row per
// `(org, project, alias_name)`; `target_corpus_id` references the `corpora`
// row whose chunks the alias resolves to. Retrieval against an alias name
// looks the alias up first and substitutes the target's corpus id — so an
// alias returns the target's chunks WITHOUT any re-embedding.
//
// Why a separate table (not a `corpora.target_corpus_id` column): an alias has
// no embedding/chunk config of its own and no `documents`/`chunks` of its own;
// modelling it as a corpus row would force those columns to be meaningless on
// alias rows and would let the cascade-delete + ingest paths accidentally
// treat an alias like a real corpus. A dedicated table keeps the two concepts
// cleanly separated and makes "is this name an alias?" a single lookup.
//
// Repoint is a single-row UPDATE of `target_corpus_id` (atomic + cheap). When
// the target corpus is deleted, this row is removed by the FK's ON DELETE
// CASCADE — a retrieve via the now-dangling alias then 404s (CORPUS_NOT_FOUND),
// the honest "there is nothing here" answer (documented in the route).
//
// Cross-tenant isolation: both the alias row and its target are stamped
// `(org, project)`; the alias service refuses a target outside the caller's
// scope. `name` shares the corpus namespace within a scope — the alias service
// refuses to create an alias whose name collides with a real corpus (and the
// ingest path is unaffected: ingest only ever touches `corpora`).

export const corpusAliases = pgTable(
  'corpus_aliases',
  {
    id: idColumn(),
    org: text('org').notNull(),
    project: text('project').notNull(),
    /** The alias name consumers retrieve against (e.g. `policies:latest`). */
    name: text('name').notNull(),
    /** The corpus this alias currently resolves to. */
    targetCorpusId: uuid('target_corpus_id')
      .notNull()
      .references(() => corpora.id, { onDelete: 'cascade' }),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => ({
    nameUnique: uniqueIndex('corpus_aliases_org_project_name_idx').on(t.org, t.project, t.name),
    targetIdx: index('corpus_aliases_target_idx').on(t.targetCorpusId),
  }),
);

// ---------------------------------------------------------------------------
// documents — RAG: a single ingested source doc inside a corpus
// ---------------------------------------------------------------------------
// Dedupe key is the consumer-supplied `external_id` (decisions §15): when
// present, `(corpus_id, external_id)` collides ⇒ delete-and-replace the doc's
// chunks. Absent ⇒ always insert new. `ingest_id` soft-links to the BullMQ
// batch that produced the row (§14, ingest is async). `text` is the raw
// extracted text from the consumer's POST body — service is text-only (§13).

export const documents = pgTable(
  'documents',
  {
    id: idColumn(),
    corpusId: uuid('corpus_id')
      .notNull()
      .references(() => corpora.id, { onDelete: 'cascade' }),
    org: text('org').notNull(),
    project: text('project').notNull(),

    externalId: text('external_id'),
    text: text('text').notNull(),
    title: text('title'),
    sourceUrl: text('source_url'),

    /**
     * Temporal validity, half-open `[valid_from, valid_to)`. NULL on a side
     * means unbounded there; both NULL (the default, and every pre-0012 row)
     * means "always valid". Mirrored onto every chunk of this document at
     * ingest so the retrieval filter never needs a join.
     */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),

    /**
     * Per-document Postgres text-search config name (`'spanish'`, `'english'`,
     * `'simple'`, …), validated against the installed whitelist at ingest.
     * STORED for a FUTURE per-chunk stemming path (per-chunk regconfig + query
     * fan-out, or a BGE-M3 learned-sparse leg) — it is a code change on data
     * already present, not another migration. It is deliberately orthogonal to
     * the lexical regconfig, which is a PER-CORPUS setting
     * (`corpora.text_search_config`) and is already live; per-DOCUMENT language
     * does not drive stemming today. NULL = unspecified.
     */
    language: text('language'),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),

    ingestId: uuid('ingest_id'),
  },
  (t) => ({
    orgProjectIdx: index('documents_org_project_idx').on(t.org, t.project),
    corpusIdx: index('documents_corpus_idx').on(t.corpusId),
    externalIdUnique: uniqueIndex('documents_corpus_external_id_idx')
      .on(t.corpusId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  }),
);

// ---------------------------------------------------------------------------
// chunks — RAG: a single splittable + embeddable piece of a document
// ---------------------------------------------------------------------------
// One row per chunk produced by the recursive-character splitter (§11);
// `ordinal` is the 0-based position inside the parent doc, so the prompt
// builder can reassemble a contiguous run. `embedding` is a pgvector(1024)
// column (§10). The vector ANN index lives in the migration SQL (Drizzle does
// not model `USING hnsw` directly); see `drizzle/0006_rag.sql` — HNSW with
// cosine ops, falling back to ivfflat if HNSW isn't compiled into the pgvector
// build (documented in the migration comment).

export const chunks = pgTable(
  'chunks',
  {
    id: idColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    corpusId: uuid('corpus_id')
      .notNull()
      .references(() => corpora.id, { onDelete: 'cascade' }),
    org: text('org').notNull(),
    project: text('project').notNull(),

    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tokens: integer('tokens'),
    embedding: vectorColumn('embedding', 1024),

    /**
     * Lexical index of `text`, built with the parent corpus's
     * `text_search_config`. Written by the ingest worker in a follow-up
     * statement (see `src/workers/ingest.worker.ts`) rather than a GENERATED
     * column, because the configuration is per-corpus and a generated column
     * would have to hard-code one. NULL on any chunk ingested before migration
     * 0012 — a NULL tsvector matches no tsquery, so hybrid retrieval over an
     * un-backfilled corpus degrades to dense-only instead of going wrong.
     */
    textSearch: tsvectorColumn('text_search'),

    /**
     * Learned-sparse (bge-m3) lexical vector — the OPT-IN alternative to
     * `text_search` in the hybrid RRF fusion (migration 0001). Written by the
     * ingest worker ONLY when `SPARSE_ENABLED=true`; NULL otherwise (and on
     * every corpus ingested with the gate off). A NULL sparsevec is filtered out
     * of the sparse leg's candidate set (`WHERE sparse_embedding IS NOT NULL`),
     * so an un-populated corpus degrades to the `tsvector` leg exactly the way
     * an un-backfilled `text_search` degrades to dense-only. Dimension =
     * `env.SPARSE_DIM` (250002, bge-m3 vocab); indices are 1-based token ids.
     */
    sparseEmbedding: sparsevecColumn('sparse_embedding', 250002),

    /** Denormalised from the parent document — see `documents.validFrom`. */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    corpusOrdinalIdx: index('chunks_corpus_ordinal_idx').on(t.corpusId, t.ordinal),
    documentIdx: index('chunks_document_idx').on(t.documentId),
    // GIN index over the lexical vector — the index the BM25-ish leg of a
    // hybrid retrieve rides on. Migration: drizzle/0012_retrieval_upgrade.sql.
    textSearchGinIdx: index('chunks_text_search_gin_idx').using('gin', t.textSearch),
    // Partial: only rows that actually carry a validity bound are indexed, so
    // this stays small on corpora that never use the feature.
    validityIdx: index('chunks_corpus_validity_idx')
      .on(t.corpusId, t.validFrom, t.validTo)
      .where(sql`${t.validFrom} is not null or ${t.validTo} is not null`),
    // GIN index accelerating the optional `metadata @> $filter` containment
    // predicate on POST /v1/retrieve (plan/open-retrieve-metadata-filter.md §6).
    // `jsonb_path_ops` is the containment-only opclass — smaller + faster for
    // `@>`, the only operator the filter contract uses. Migration:
    // drizzle/0010_chunks_metadata_gin.sql.
    metadataGinIdx: index('chunks_metadata_gin_idx').using(
      'gin',
      sql`${t.metadata} jsonb_path_ops`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// ingest_requests — one row per `POST /v1/ingest` batch
// ---------------------------------------------------------------------------
// Before the callback contract landed, the only persistent trace of an ingest
// batch was the `documents.ingest_id` FK and the BullMQ jobs themselves. The
// emit-side callback wiring needs a stable row to capture `apiKeyId` +
// `callbackUrl` + `corpus` at enqueue time so the worker can look them up
// later when emitting `ingest.completed` / `ingest.failed` / `ingest.progress`
// per the contract. The row also doubles as the source of `totalDocs` for the
// progress-event throttle (every 10 docs or 30s on batches >5).
//
// Status fields (`completed_docs` / `failed_docs`) are atomic counters
// incremented from the worker; `status` flips to a terminal state when
// completed+failed >= total.

export const ingestRequestStatus = pgEnum('ingest_request_status', [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
]);

export const ingestRequests = pgTable(
  'ingest_requests',
  {
    id: idColumn(),
    ...scopingColumns(),

    /** SHA-256(key) first 16 hex chars — see `src/plugins/auth.ts`. */
    apiKeyId: text('api_key_id'),

    /** Corpus name (denormalised) at enqueue time — the worker resolves to id via `corpusId`. */
    corpus: text('corpus').notNull(),
    corpusId: uuid('corpus_id'),

    status: ingestRequestStatus('status').notNull().default('queued'),
    totalDocs: integer('total_docs').notNull().default(0),
    completedDocs: integer('completed_docs').notNull().default(0),
    failedDocs: integer('failed_docs').notNull().default(0),

    /** Webhook POSTed at terminal transitions. */
    callbackUrl: text('callback_url'),

    /**
     * `last_progress_*` are progress-throttle bookkeeping for `ingest.progress`
     * events. The worker atomically updates these when it decides to fire a
     * progress callback so the throttle survives worker restarts.
     */
    lastProgressEmittedAt: timestamp('last_progress_emitted_at', { withTimezone: true }),
    lastProgressDocs: integer('last_progress_docs').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    metadata: metadataColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => ({
    orgIdx: index('ingest_requests_org_idx').on(t.org),
    projectIdx: index('ingest_requests_project_idx').on(t.project),
    statusIdx: index('ingest_requests_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// callback_deliveries — one row per attempt to POST a callback to a consumer
// ---------------------------------------------------------------------------
// Generalised over the two async sources (`generate`, `ingest`). See the
// contract doc §"observability". Retry schedule t+0/+5s/+30s/+2m/+10m then
// dead-letter is encoded in the emitter (`src/services/callbacks/emit.ts`);
// here we just persist the audit trail.
//
// A 4xx (other than 401) is a permanent rejection; 401 stops retries with a
// dedicated `auth_failed` status so operator alerting can split it from a
// generic 4xx; 2xx is `delivered`. 5xx / network → `pending` with
// `next_attempt_at` set per the schedule; `dead_letter` after exhaustion.

export const callbackDeliveryStatus = pgEnum('callback_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'auth_failed',
  'dead_letter',
]);

export const callbackDeliverySource = pgEnum('callback_delivery_source', [
  'generate',
  'ingest',
]);

export const callbackDeliveries = pgTable(
  'callback_deliveries',
  {
    id: idColumn(),
    ...scopingColumns(),

    /** Which async surface produced this callback. */
    source: callbackDeliverySource('source').notNull(),
    /** `generation_requests.id` or `ingest_requests.id` (opaque text — no FK so we don't cascade-delete the audit row). */
    sourceId: text('source_id').notNull(),
    /** `unitKey` (generate) / `docId` (ingest); null for batch-level events. */
    itemKey: text('item_key'),
    /** Event name per the contract doc (`unit.completed`, `ingest.failed`, …). */
    event: text('event').notNull(),

    /** Destination URL — captured here so a replay can re-POST without re-reading the request row. */
    url: text('url').notNull(),
    /** Which API-key fingerprint signed this delivery. */
    apiKeyId: text('api_key_id'),

    /** Exact bytes we signed + sent. Replays MUST resend the same bytes so the HMAC stays valid (signing is over `${ts}.${body}`). */
    body: text('body').notNull(),
    /** Unix-seconds timestamp baked into the signature header. */
    signedAtUnix: integer('signed_at_unix').notNull(),
    /** Hex HMAC of `${signedAtUnix}.${body}`. */
    signature: text('signature').notNull(),

    status: callbackDeliveryStatus('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    /** When the next retry should fire; null when terminal (delivered / dead_letter / auth_failed / permanent failed). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

    responseStatus: integer('response_status'),
    /** Truncated to ~1024 chars in the emitter so a verbose error body doesn't bloat the table. */
    responseBodyExcerpt: text('response_body_excerpt'),
    /** Network / fetch-level error message when the request didn't get a status (DNS, ECONNREFUSED, …). */
    lastError: text('last_error'),

    /** Stamp of the most recent attempt, for ops. */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => ({
    sourceIdx: index('callback_deliveries_source_idx').on(t.source, t.sourceId),
    statusIdx: index('callback_deliveries_status_idx').on(t.status),
    nextAttemptIdx: index('callback_deliveries_next_attempt_idx').on(t.nextAttemptAt),
    orgIdx: index('callback_deliveries_org_idx').on(t.org),
  }),
);
