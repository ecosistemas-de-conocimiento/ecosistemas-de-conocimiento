> **Status — 2026-05-16.** Timeline narrative of `ai-service`, from M1 scaffold
> through M5 typed client, plus the tech-debt sweep and the prototype rewire that
> made it the consuming app's first real customer. Read this if you are new to
> the repo and want one document that explains how the codebase got here.

# `ai-service` — project history

## M1 — Scaffold (prior session)

The first session bootstrapped a project-agnostic AI/RAG service from an
empty directory. Stack: TypeScript on Node 22, [Fastify](https://fastify.dev)
for HTTP, [Drizzle ORM](https://orm.drizzle.team) on Postgres (with
`pgvector` reserved for M4), [BullMQ](https://bullmq.io) on Redis, Zod for
config + payload validation. Layout landed under `src/` (`config/`, `db/`,
`queue/`, `plugins/`, `routes/`, `server.ts`, `index.ts`) and a `Dockerfile`
suitable for Coolify deployment.

Only two endpoints existed: `GET /health` (liveness) and `GET /health/ready`
(readiness probe pinging Postgres + Redis). Per-project bearer-token auth
landed in `src/plugins/auth.ts` so that any future `/v1/*` route would
already see `{org, project}` as opaque scoping tags. CI was seeded but
minimal. See the milestone list at the bottom of `README.md`.

## M2 — Datastore schema (prior session)

The seven core tables were ported forward from a prototype's Payload AI
collections, deliberately decontextualised: a column survived only if the
service itself reads or writes it. Domain concepts (story, dimension,
scope) were collapsed into opaque `unit_key` / `unit_type` / `depends_on` /
`input` / `metadata` / `spec_override` jsonb fields. Every row is stamped
with `{org, project}` and cross-project references are rejected hard.

The schema rolled out across migrations `drizzle/0000_init_extensions.sql`
(enables `pgvector`), `0001_m2_datastore.sql` (`traces`, `usage_logs`,
`llm_configs`, `generation_requests`, `generation_jobs`), and
`0002_registry.sql` + `0003_registry_groups_and_deps.sql` + `0004_registry_audit_and_audit_columns.sql`
(the `project_configs` + `registry_entries` + `registry_audit` triplet,
pulled forward from M3's plan so that the registry-write surface could ship
in parallel with the M3 router work). The spec-delivery model is *registry-with-inline-fallback*
("model C" — unit `specOverride` → request override → active registry entry
→ `project_configs` defaults → typed error).

## M3 — Router, orchestrator, worker, routes (2026-05-15 session)

The M3 session ported a prototype's in-process AI machinery into `ai-service`,
redesigned around the new opaque-unit contract. A kickoff interview produced
**16 baked-in decisions** captured in `plan/m3-m4-decisions.md` — most
load-bearing among them: (§2) introduce a `budget_state` table for atomic
reservations; (§3) use BullMQ `FlowProducer` for `dependsOn` execution;
(§4) hardcode validator-retry cap at 1; (§7) defer HMAC webhook signing;
(§8) workers run in-process with the API; (§16, since amended) render
prompts once at orchestrator time. The amendment to §16 — two-phase
rendering, where dependent units render at worker time after predecessor
outputs merge — was negotiated mid-build and noted inline in
`m3-m4-decisions.md` §16's "Reversed 2026-05-15" footer.

### How the build was actually executed

The detailed Step 5 plan broke router +
orchestrator + cancel into a 14-row sequencing table; the actual build ran
as parallel subagent waves of **5 + 8 + 3 + 2** units. Wave 1 laid down
skeletons (types, renderer, validators dispatcher, registry resolver). Wave
2 was the big one — router, adapters, orchestrator, queue, idempotency,
estimate, cancel, events bus. Wave 3 finished HTTP routes and worker. Wave
4 polished integration tests. The router pipeline ports 1:1 from a prototype
(`src/services/ai/router/router.ts`) — what changed was what *feeds* it
(a pre-resolved spec from `src/services/registry/resolve.ts`) and *how*
it persists (Drizzle, not Payload).

### Routes shipped

`POST /v1/generate` + `POST /v1/generate/sync` + `GET /v1/generate/:requestId` +
`GET /v1/generate/units/:unitKey/latest` + `POST /v1/generate/:requestId/cancel` +
`GET /v1/events/:channel` (SSE) + `GET /v1/budget/:org` + the registry
endpoints that the parallel subagent had landed earlier. See
`src/routes/generate.ts`, `events.ts`, `budget.ts`, `registry.ts`. Migration
`drizzle/0005_budget_state.sql` added the single-row-per-org atomic-reserve
target; `src/services/budget/enforcer.ts` carries the `reserve`/`refund`/`adjust`
math. The FlowProducer DAG tradeoffs are documented separately in
`plan/m3-dag-tradeoffs.md`.

## M4 — RAG (2026-05-15 session)

Once M3's integration suite went green, the same session continued into M4
without resetting context. Schema in `drizzle/0006_rag.sql`: `corpora`,
`documents`, `chunks` (with `embedding vector(1536)` baked in for
`openai/text-embedding-3-small`). Decisions captured in
`plan/m3-m4-decisions.md` §§9–15.

The embeddings adapter lives at `src/services/ai/embeddings/openrouter.ts`
and calls OpenRouter's OpenAI-compatible `POST /api/v1/embeddings` endpoint
with the same `OPENROUTER_API_KEY` — verified to be live during the M4
foundation work (see the §9 implementation note). Chunking is recursive
character (paragraphs → sentences → characters, ~800-token target with
~100-token overlap; `src/services/rag/chunk.ts`). Retrieval is cosine
top-K via pgvector with optional MMR re-rank (λ 0.5–0.7; no filters, no
hybrid in v1; `src/services/rag/retrieve.ts`). Ingest is JSON-body text-only —
consumers extract from PDFs/HTML/docx themselves before posting
(`POST /v1/ingest`; `src/routes/ingest.ts` + `src/workers/ingest.worker.ts`)
— and runs always-async through a dedicated `ingest` BullMQ queue.
Dedupe is consumer-supplied: optional `documents[].id`; if present and the
`(corpus, id)` already exists, chunks are deleted and re-embedded in place.

Three new routes: `POST /v1/ingest`, `GET /v1/ingest/:ingestId`,
`POST /v1/embed`, `POST /v1/retrieve`. The orchestrator's `includeContext`
call site that M3 had wired as a no-op stub became live in M4.

## M5 — OpenAPI + typed client (2026-05-16 session)

M5 added a versioned OpenAPI 3.1 document plus a workspace typed
client at the repo-root `packages/ai-client` (`@edc/ai-client@0.1.0`). Decisions in
`plan/m5-decisions.md`. The spec is derived from the existing Zod schemas
via `@asteasolutions/zod-to-openapi@^7.3.4` (pinned at 7.x because 8.x
requires Zod 4 and `ai-service` still ships Zod 3). Today the doc covers
**18 paths × 14 schemas across 8 tags**; the registry lives at
`src/openapi/registry.ts` and is served at `GET /v1/openapi.json` plus a
Swagger UI at `GET /v1/docs`.

The client (`packages/ai-client/src/`) is hand-written rather than
generated: `AIClient` aggregates sub-API namespaces (`generate`, `registry`,
`ingest`, `retrieve`, `embed`, `budget`, `events`), `AdminAPI` carries the
admin-only `openrouter.getCredits()` surface, the SSE helper is a
~30-line `ReadableStream` parser with no `eventsource` dependency, and 9
typed error classes (`BudgetExceededError`, `IdempotencyConflictError`,
`SpecResolutionError`, `DependencyCycleError`, `CrossBatchDependencyError`,
`CorpusNotFoundError`, `AuthError`, `ForbiddenError`, `NotFoundError`)
hang off a base `AIServiceError`. A `toCredits(usd, rate)` helper rounds
USD spend up into integer credits. Production runtime deps on the client:
none. See `packages/ai-client/README.md`.

## Tech-debt sweep (2026-05-16 session)

After M5 landed, a focused sweep took down the cross-cutting items that
the M3/M4 decision doc had been collecting:

- **OPENROUTER_API_KEY startup probe** (`src/config/env.ts`) — fatal in
  production, warn-only in dev. Closes the §5 tech-debt line in
  `m3-m4-decisions.md` ("error surfaces at runtime, not at boot").
- **CI workflow** — `.github/workflows/test.yml` now runs lint + typecheck
  + unit tests on push/PR, plus an `integration` job that brings up
  `pgvector/pgvector:pg16` and `redis:7-alpine` service containers,
  runs migrations, and executes `pnpm run test:integration`. Closes the
  M3/M4 "no CI configuration mentioned anywhere" item.
- **Model pricing refreshed** against the live OpenRouter `/api/v1/models`
  catalog on 2026-05-16 (`src/services/ai/router/task-profiles.ts` +
  `src/services/registry/resolve.ts`'s `EFFORT_PROFILES`). Material
  moves: `deepseek/deepseek-chat-v3.1` $0.27/$1.10 → $0.21/$0.79 per 1M;
  `deepseek/deepseek-r1` $0.55/$2.19 → $0.70/$2.50 per 1M; `kimi-k2-0905`
  and `text-embedding-3-small` unchanged. New helper at
  `scripts/refresh-model-pricing.ts` (also wired as `pnpm run refresh-pricing`)
  prints the upstream diff for humans to paste in. Inline comment says
  next refresh Q3 2026.
- **Embed route budget integration** — `POST /v1/embed` now reserves
  against `budget_state`, adjusts on actual usage, and refunds on failure;
  previously it was the one LLM-spending surface that bypassed the
  enforcer.
- **Budget-reset implementation** (migration `drizzle/0007_budget_reset.sql`).
  Per-org cadence (`monthly_calendar`, `monthly_anniversary`, `weekly`,
  `never`); soft cap with throttled warnings on a 5-minute window;
  per-org IANA timezone; every reset writes a `usage_logs` audit row
  with `endpoint = 'budget-reset'`. See `src/services/budget/reset.ts`
  and the design rationale in `plan/budget-reset-followup.md`. Closes
  the §2 "no reset policy" tech debt.
- **Rate limiting** — `@fastify/rate-limit` plugin; 100/min global,
  30/min on `/v1/generate*`. Closes the M3/M4 "no rate limiting on the
  API surface" item.
- **Request-size limits** — `bodyLimit` 1MB global, 10MB on `/v1/ingest`
  (`src/server-limits.ts`). Closes the M3/M4 "no request-size limits"
  item.
- **Swagger UI vendored locally** (`@fastify/static` serves the
  swagger-ui-dist files instead of jsdelivr) so air-gapped Coolify
  deployments load `/v1/docs` without internet egress. Closes the
  open item in `m5-decisions.md` cross-cutting list.
- **Embedding usage-field fallback** — OpenRouter's embeddings response
  doesn't always populate `usage.total_tokens`; the adapter now falls
  back to `chars/4` so cost tracking never silently records `$0`.
- **`GET /v1/openrouter/credits`** — an admin-only passthrough to
  OpenRouter's account credits endpoint, surfaced as
  `client.admin.getOpenRouterCredits()` in the typed client
  (`src/routes/openrouter-credits.ts`).

## Prototype rewire (2026-05-16 session)

With `ai-service` M5-complete, a prototype became its first HTTP consumer, following
a rewire plan kept in the prototype repo. Net effect on the prototype backend:

- **20 files deleted, ~5,100 LOC of in-process AI machinery gone** —
  the entire `src/services/ai/router/` directory (router, adapters,
  cache, self-critique, task-profiles, trace-writer, budget-enforcer),
  both AI worker files, the queue layer (it was AI's only consumer),
  the `registry-stub-prompts.ts` + DIMENSION_REGISTRY golden tests,
  and the in-process `AIClient` implementation.
- **7 files added, ~975 LOC** — `HttpAIClient` (prototype-side adapter that
  wraps `@edc/ai-client`), `StubAIClient` (offline `AI_SERVICE_ENABLED=false`
  mode), `MockAIClient` (test recorder), `scope-expander.ts` (a prototype
  `GenerationRequest` → wire-contract `Unit[]`), `local-audit.ts`
  (slim `generationRequests` writes), `seed-ai-service-registry.ts`
  (pushes the DIMENSION_REGISTRY snapshot to ai-service via the admin
  client; idempotent).
- **5 files rewritten** — `orchestrator.ts` becomes a thin scope-expander
  + delegate; `cancel.ts` proxies to the client; `estimate.ts` retains
  the dependency-graph cost model as a UI preview only (authority moves
  to ai-service's enqueue-response `estimatedCostUsd`); the
  `/api/generate/*` Next routes thin out; the brainstorm-requirements
  endpoint now calls `aiClient.generate.sync({ unit })` with no queue.

The brainstorm-requirements prompt was registered as a `unitType` in
`ai-service`'s registry via the seed script, and the credits page now
routes through `ai-service` rather than reading a prototype's old `LlmConfigs`.

## What's NOT yet done

A backlog of follow-up items lives in `plan/open-items.md`. Highlights:
the brainstorm meta-prompt template currently registered in
`ai-service`'s registry is a `{{userPrompt}}` placeholder — the real
Spanish meta-prompt still lives in prototype code and needs to be centralised;
A prototype's `AiCompanionTraces` / `AiUsageLogs` / `LlmConfigs` Payload
collections are unused after the rewire but still resident in the
database; a prototype doesn't yet have a CI workflow analogous to `ai-service`'s
new one; the validator-retry-cap escalation tiers
(`m3-validator-retry-followup.md`) and HMAC webhook signing
(`m3-webhook-signing-followup.md`) remain on the shelf; multi-currency,
a real `Organizations` table, API-key rotation, and live-smoke-of-the-Coolify-deploy
round out the list. See `plan/open-items.md` for the full set and per-item
detail.

## Post-M5 — Capability router + shared text-to-SQL (2026-06-09)

Promoted two pieces of a prototype's bespoke backend into project-agnostic platform
capabilities so chat (PoC tester) and a prototype can consume them. Reference:
A prototype's `endpoints/router.ts` (capability router) and `endpoints/askThread.ts`
`tryXlsxSql()` (text-to-SQL + read-only guard).

- **`POST /v1/route`** — a generic, fail-safe capability router (peer of
  `/v1/generate`, `/v1/retrieve`). Caller supplies the candidate surfaces at
  call time (`{id, description, schema?}[]`); one cheap structured-output
  classification returns `{routeId, reason}`. Reuses the sync-generate plumbing
  (`resolveSpec` → `renderPrompt` → `createOpenRouter().route`) with the cheap
  `quick` tier, budget reservation, bearer scope, and the model registry. NEVER
  500s on a routable request — errors/ambiguity/hallucinated ids degrade to
  `defaultRouteId` (else `candidates[0].id`). The fail-safe + id re-validation
  lives in a pure module (`src/services/routing/decide.ts`). Added to the
  OpenAPI spec + Swagger UI under the new `Route` tag.

- **Shared text-to-SQL** — `client.textToSql(...)` generates a read-only
  `SELECT` via `/v1/generate/sync` (the `text-to-sql` unit-type) and validates
  it with the **pure** `guardReadOnlySelect` / `isReadOnlySelect` exported from
  `@edc/ai-client` (`packages/ai-client/src/sql-guard.ts`) — products
  validate with no extra round-trip. Execution stays product-local; ai-service
  never runs SQL.

- **Registry unit-types** projects can register to override defaults:
  `capability-router` (router prompt/model) and `text-to-sql` (SQL-gen
  prompt/model). Built-in generic English prompts are the floor.

- **`@edc/ai-client` 0.2.0 → 0.3.0** — added `route`, `textToSql`, the
  pure guard, the two sub-APIs, and types; existing methods unchanged; zero prod
  deps preserved; packed tgz rebuilt. No DB migration (registry *data*, not
  schema). Full design in `plan/capability-router-and-text-to-sql.md`.
