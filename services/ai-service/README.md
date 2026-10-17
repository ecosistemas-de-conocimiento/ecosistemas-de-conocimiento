# @edc/ai-service

The **AI + RAG engine** behind the knowledgebase. Documents go in, embedded and
chunked; questions come out answered, with citations, budget accounting and a
cost ledger. Spoken to over HTTP by `apps/backend`; never spoken to directly by
a browser.

It is deliberately **domain-agnostic**. It knows `org`, `project`, `corpus`,
`document`, `chunk` and `unit` — and nothing about what the product calls those
things. Organizations, chat sessions, uploads and 1–5-star ratings live in
`apps/backend` (Payload) and reach this service as opaque strings. That boundary
is enforced mechanically by `scripts/check-domain-vocabulary.mjs`, which runs as
part of `pnpm test`.

## Where it sits

```
apps/web  ──▶  apps/backend  ──▶  services/ai-service  ──▶  Postgres + pgvector
(SvelteKit)    (Next + Payload)   (this service)            Redis (BullMQ)
                     │                    │                 OpenRouter (LLM + embeddings)
                     │                    └──▶ rerank-service/  (optional, CPU sidecar)
                     │                    └──▶ bge-m3-service/  (optional, CPU sidecar)
                     └── uses @edc/ai-client, the typed client at packages/ai-client
```

Every request carries an `{org, project}` scope, resolved from the bearer token
— never from the request body. Every stored row is stamped with both, and
cross-scope reads return 404, not 403 ("it doesn't exist in your scope").

## Subsystems

| Area | Lives in | What it does |
| --- | --- | --- |
| HTTP surface | `src/routes/**`, `src/server.ts` | Fastify app, `/v1` bearer auth, per-key rate limiting, OpenAPI + Swagger UI |
| Ingestion | `src/services/rag/ingest.ts`, `chunk*.ts` | Document → chunks (structural + sliding-window strategies) → embeddings → pgvector |
| Retrieval | `src/services/rag/retrieve*.ts` | Dense (pgvector), lexical (`tsvector` or learned-sparse), RRF fusion, MMR diversification, multi-corpus fan-out |
| Reranking | `src/services/ai/rerank/**` | Optional cross-encoder rung after fusion. Fails **open** — any error falls back to the fused order |
| Generation | `src/services/generation/**`, `src/services/ai/router/**` | Model router, effort profiles, self-critique passes, output validators, response cache, streaming |
| Spec registry | `src/services/registry/`, `src/db/registry.ts`, `src/routes/registry.ts` | Per-`{org, project}` prompt + model + effort configuration, versioned and audited |
| Budget | `src/services/budget/**` | Fail-closed USD cap per org, atomic reserve/settle, lazy monthly reset, cost ledger |
| Queue + workers | `src/queue/**`, `src/workers/**` | BullMQ fan-out for async generate + ingest; workers run **in-process**, same image |
| Callbacks | `src/services/callbacks/emit.ts` | HMAC-signed terminal webhooks, with a dead-letter table and admin replay |
| Eval | `src/eval/**`, `scripts/run-retrieval-eval.ts` | Retrieval quality harness (recall@k, nDCG) over a domain-free golden set |

## Stack

TypeScript · Node 26 (pinned by `.nvmrc`) · [Fastify](https://fastify.dev) ·
Postgres + [`pgvector`](https://github.com/pgvector/pgvector) via
[Drizzle](https://orm.drizzle.team) · Redis + [BullMQ](https://bullmq.io) ·
Zod for config and payload validation. Two optional Python CPU sidecars
(`rerank-service/`, `bge-m3-service/`) serve open-weight models; both are off by
default.

## API surface

Versioned under `/v1`, bearer-token auth. Full contract: `GET /v1/openapi.json`,
browsable at `GET /v1/docs`.

**Unauthenticated**
- `GET /health`, `GET /health/ready` — liveness / readiness (pings Postgres + Redis).
- `GET /v1/capabilities` — named capabilities this build ships, so a consumer can
  tell "the service lacks X" from "my key is wrong".
- `GET /v1/openapi.json`, `GET /v1/docs`.

**RAG**
- `POST /v1/ingest` — queue a document for chunk + embed. `GET /v1/ingest/{ingestId}` for status.
- `POST /v1/retrieve` — single-corpus retrieval. `POST /v1/retrieve/multi` — multi-corpus, with optional query condensation.
- `POST /v1/embed` — direct embedding passthrough.
- `GET|POST /v1/corpora`, `GET|PATCH|DELETE /v1/corpora/{name}` — corpus control plane.
- `POST /v1/corpus/{name}/alias`, `PATCH /v1/corpus/{name}/documents/{externalId}/validity`,
  `DELETE /v1/corpus/{name}`, `DELETE /v1/corpus/{name}/documents/{externalId}`.

**Generation**
- `POST /v1/generate` — async batch fan-out on the queue. `GET /v1/events/{channel}` streams progress over SSE.
- `POST /v1/generate/sync` — one synchronous generation.
- `POST /v1/generate/stream` — one generation, tokens streamed over SSE.
- `GET /v1/generate/{requestId}`, `GET /v1/generate/units/{unitKey}/latest`, `POST /v1/generate/{requestId}/cancel`.
- `POST /v1/route` — cheap single-shot classification onto a caller-supplied candidate list. Fail-safe: never 5xx on a routable request.

**Admin / operations**
- `GET|PUT /v1/budget/{org}` — the only thing that lifts the fail-closed budget gate.
- `GET /v1/tenant/readiness` (any role) · `POST /v1/tenant/provision` (admin).
- `GET|PUT /v1/registry/config`, `GET/POST /v1/registry/unit-types/...` — reads open to any role, writes admin-only, every mutation audited in the same transaction.
- `GET /v1/openrouter/credits` — admin passthrough, so no other service needs the OpenRouter key.
- `/v1/admin/callbacks` — dead-letter list + manual replay.

## Local development

Run from the **repo root** — this is a pnpm workspace, and the lockfile lives
there.

```bash
pnpm install                                   # once, at the root
cp services/ai-service/.env.example services/ai-service/.env

pnpm infra:up                                  # root docker-compose: pgvector + redis
pnpm --filter @edc/ai-service db:migrate       # applies ./drizzle (enables pgvector)
pnpm --filter @edc/ai-service test             # unit suite, no DB required
pnpm dev:ai                                    # http://localhost:3000/health
```

Other useful scripts (all via `pnpm --filter @edc/ai-service <script>`):

| Script | What |
| --- | --- |
| `typecheck` / `lint` | `tsc --noEmit` / eslint + the domain-vocabulary guard |
| `test:integration` | HTTP + DB suite; needs Postgres and Redis up |
| `db:generate` | Regenerate Drizzle migrations from `src/db/schema` |
| `set-budget -- --org demo --limit 25` | Provision an org's USD cap (see below) |
| `eval:retrieval` | Retrieval quality harness |
| `refresh-pricing` | Print the upstream model-price diff for `MODEL_PRICING` |

Postgres must have the `vector` extension available — migration `0000` runs
`CREATE EXTENSION vector`. The `pgvector/pgvector:pg16` image ships it.

**There is no mock mode.** `MOCK_LLM`, `MOCK_EMBEDDINGS` and `MOCK_LLM_STREAM`
were removed, and setting any of them refuses boot. For local demos and e2e,
run the TEST-ONLY fake provider and point the service at it:

```bash
FAKE_PROVIDER_PORT=4010 node test-support/fake-provider/server.mjs &
export CHAT_COMPLETIONS_URL=http://127.0.0.1:4010/api/v1/chat/completions
export EMBEDDINGS_URL=http://127.0.0.1:4010/api/v1/embeddings
export OPENROUTER_API_KEY=fake-provider-test-key
```

Every answer then starts with `[FAKE-PROVIDER TEST DATA]`. The unit suite runs
without Postgres, Redis or a network.

**Boot schema gate.** The container runs `scripts/schema-gate.mjs precheck`
before migrating and `stamp` after: it refuses to boot when an already-applied
migration's bytes changed. Appended migrations are allowed. Back up the
database before deploying a release that adds migrations.

## Three things a new tenant needs

A tenant that is missing one of these fails in three unrelated-looking ways:

| Missing | Symptom |
| --- | --- |
| API key in `API_KEYS` | `401` |
| Active registry entry for the `unitType` | `400 no active registry entry for unitType 'X'` |
| Budget row | `402 BudgetNotConfigured` |

`GET /v1/tenant/readiness` checks all three for the caller's own scope and
returns each with a concrete fix. `POST /v1/tenant/provision` (admin) creates
the budget and registry entries in one idempotent call.

**API keys cannot be provisioned over HTTP.** They live in the `API_KEYS` env
map, parsed once at boot, so a new key means an environment edit plus a restart.
`/v1/tenant/provision` says so in its `manualSteps`.

Budgets are **fail-closed**: an org with no `budget_state` row cannot spend at
all. Lift the gate with `PUT /v1/budget/{org}` or `scripts/set-budget.ts`.

## System prompts

Every generation surface accepts a real system prompt, delivered as a
`{ role: 'system' }` message ahead of the rendered user prompt. Optional and
opt-in: send nothing and the request that reaches the model is byte-identical to
what it was before this existed.

Precedence, highest first:

1. `unit.systemPrompt` — per unit. **Literal**, never Handlebars-rendered.
2. `unit.specOverride.metaPromptTemplate` — per unit, inline spec. Rendered.
3. `systemPromptOverride` — request/batch level. **Literal**.
4. `registry_entries.meta_prompt_template` — registry default for the unitType. Rendered.
5. nothing ⇒ no `system` message is sent at all.

Most specific wins, and anything on the request beats anything in the registry.
Only the two `…Template` fields are rendered; the request-level fields pass
through byte-for-byte so an embedded JSON schema or brace-heavy contract
survives Handlebars strict mode.

`/v1/generate/sync` responses (and the `/v1/generate/stream` `done` frame) carry
`systemPromptApplied: boolean`. Assert `=== true` after migrating off a
hand-folded system prompt: a deployment that predates this omits the field, so
the check fails loudly instead of the model silently losing its instructions.

Rationale: `plan/system-prompt-and-tenant-provisioning-decisions.md`.

## Optional retrieval sidecars

Both are **off by default** and both fail safe — a dead sidecar degrades
retrieval quality, it never fails a query.

- **`rerank-service/`** — `bge-reranker-v2-m3` cross-encoder on CPU. Turn on with
  `RERANK_ENABLED=true` + `RERANK_URL`. Re-scores the top-N pool after RRF fusion.
- **`bge-m3-service/`** — `bge-m3` dense + **learned-sparse** embeddings on CPU.
  Turn on with `SPARSE_ENABLED=true` + `SPARSE_EMBED_URL`. Sparse then replaces
  the Postgres `tsvector` leg in hybrid fusion. Needed because OpenRouter's
  OpenAI-compatible `/embeddings` returns dense vectors only — there is no wire
  field for sparse weights.

Each wants **≥4GB RAM** and bakes its weights into the image at build time. Run
them as separate containers; see their own READMEs for the footprint numbers.

## Deploy

`Dockerfile` builds the production image. **Its build context is the repo root**
(the pnpm lockfile lives there) — see the header comment in the file. The
container runs migrations then boots the HTTP server plus the in-process BullMQ
workers:

```
node dist/db/migrate.js && node dist/index.js
```

Postgres (with `vector`) and Redis are external. `.github/workflows/` here holds
ready-to-move CI definitions — GitHub only reads workflows from the repository
root, so they are inert until copied there.

## Layout

```
src/
  config/env.ts        Zod-validated environment (see .env.example)
  capabilities.ts      the capability document served at /v1/capabilities
  db/                  Drizzle client, schema, migration runner, registry DAO
  queue/               ioredis connection + BullMQ queue names
  workers/             in-process generate + ingest workers
  plugins/auth.ts      bearer token -> {org, project, role}
  routes/              one file per /v1 surface
  schemas/             Zod request/response schemas (the runtime gate)
  openapi/registry.ts  OpenAPI 3.1 document, generated from those schemas
  services/
    rag/               chunking, ingest, retrieval, corpus CRUD, condensation
    ai/                model router, adapters, embeddings, rerank, validators
    generation/        orchestrator, estimate, system-prompt resolution
    registry/          spec resolution (the precedence chain)
    budget/            enforcer, reset, provisioning
    callbacks/         signed webhook emission + dead-letter
  eval/                retrieval eval harness + domain-free fixtures
drizzle/               SQL migrations + meta
rerank-service/        optional CPU reranker sidecar (Python)
bge-m3-service/        optional CPU dense+sparse embedder sidecar (Python)
plan/                  design decisions and ADRs, kept as historical record
```
