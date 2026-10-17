> **Status.** Decision log for the M3 + M4 kickoff interview. Captured fast so the build could start; the user explicitly flagged they want a tradeoffs review after the work lands.
>
> Each section: **Decision**, **Alternatives considered**, **Tradeoffs / tech debt incurred**, **When to revisit**. Read `project-history.md` for the surrounding context.

# M3 + M4 kickoff decisions

## 1. Sequencing — M3 fully, then M4

**Decision.** Finish all 7 M3 steps (router/orchestrator/worker/routes/integration tests green) before starting M4 (RAG tables, ingest/embed/retrieve, real `context/fetch.ts`).

**Alternatives.**
- *Interleave* — ship M3 steps 1–5 + M4 schema + ingest in parallel, wire retrieval live inside step 6 instead of stubbing.
- *M3 only this session, M4 later* — defer all M4 design questions to another round.

**Tradeoffs.**
- Pro: matches the plan's exit gates; M4's retrieval gets a real call-site in M3 (the stub in `services/context/fetch.ts`) without ever blocking on it.
- Con: full M3+M4 ship slips later than interleaving would. If consumers need RAG before M3 settles, this ordering hurts.
- Con: the integration test in M3 doesn't exercise the retrieval path end-to-end, only the empty-context stub branch.

**When to revisit.** If a consumer requests RAG before M3 hits integration tests, lift M4 schema + embed out and run alongside.

---

## 2. Budget reservation target — new `budget_state` table

**Decision.** Add migration `0005_budget_state.sql`: a single-row-per-org table with `remaining_usd` (and `limit_usd`, `currency`, `updated_at`). Atomic `UPDATE budget_state SET remaining_usd = remaining_usd - $1 WHERE org = $2 AND remaining_usd >= $1 RETURNING remaining_usd` is the reserve primitive. Refund and adjust are the same shape.

**Alternatives.**
- *Aggregate from `llm_configs` + `usage_logs`.* No new table; compute remaining = `llm_configs.monthlyBudgetUsd − SUM(usage_logs.actualCostUsd)`. Race-prone (no atomic guard at the SQL level), but matches the data we already have.
- *Soft enforcement only in M3.* Check remaining at the request boundary, no worker-side atomic guard; add the table in a follow-up. Cheapest now; can over-spend under concurrent burst.

**Tradeoffs.**
- Pro: single hot row per org, but writes are short and `UPDATE ... RETURNING` doesn't hold a long lock.
- Con: budget state and historical accounting now live in two places — `budget_state` (live remaining) vs `usage_logs` (audit trail). A reconciliation job will eventually be needed.
- Con: monthly reset (rolling 30d? calendar month?) isn't specified — currently the budget is set once and decremented forever until someone manually adjusts it. **Tech debt:** no reset policy.
- Con: cross-org/cross-currency support is implicit (just `currency: 'USD'` everywhere); multi-currency would need rework.

**When to revisit.** When monthly budgets need automatic resets (cron); when a second currency lands; when one org outgrows a single-row hot path.

**Update.** Implemented. See `src/services/budget/reset.ts`; 4 reset cadences supported (`monthly_calendar`, `monthly_anniversary`, `weekly`, `never`); soft cap with throttled warnings (5 min window); per-org TZ via IANA; audit row per reset (`usage_logs.endpoint = 'budget-reset'`).

---

## 3. Job dependency execution — BullMQ `FlowProducer`

**Decision.** Use `bullmq`'s `FlowProducer` for `dependsOn`. Each parent (the dependent unit) is enqueued with its predecessors declared as children; BullMQ holds the parent until children resolve. Worker reads predecessor outputs from the `generation_jobs` table (BullMQ's `getChildrenValues` is bypassed — DB is source of truth).

**Alternatives.**
- *Manual: enqueue all, worker re-queues when predecessors not done.* Worker checks `generation_jobs WHERE unit_key IN (dependsOn) AND status != 'completed'`; if any pending, re-queue with backoff. More worker code; familiar.
- *Topological waves at orchestrator time.* Orchestrator computes waves; only enqueues wave N+1 after wave N's completion event. Simplest worker; orchestrator (or a watcher) has to listen on the event bus to release the next wave.

**Tradeoffs.**
- Pro: BullMQ owns the "wait for predecessor" semantics; worker code stays linear.
- Pro: dependency cycles surface as `FlowProducer` rejects rather than at worker runtime.
- Con: small API-surface bump — anyone reading the queue code must understand `Flow` (one layer of indirection above plain `Queue.addBulk`).
- Con: cancel semantics get awkward — cancelling a parent doesn't auto-cancel its children in all BullMQ versions; the cancel path must walk the DAG. Tested in M3.7.
- Con: BullMQ `Flow` job IDs and parent/child links live in Redis. If Redis is wiped, in-flight DAGs can't recover without re-enqueueing from the DB.

**When to revisit.** If `Flow` ever gets a bug we can't work around, fall back to manual re-queue (worker change only — orchestrator just calls `queue.addBulk` instead). Documented separately in `plan/m3-dag-tradeoffs.md` (TODO in task #8).

---

## 4. Validator-failure retry cap — hardcoded 1

**Decision.** When a validator emits a blocker flag, re-prompt the model once with the validation error summary appended ("Your previous output failed validation: <summary>. Try again."), then accept whatever comes back (mark the job `failed` if it still fails).

**Alternatives.**
- *Per-project config* — read `project_configs.metadata.validatorRetries` (default 1).
- *Per-call override too* — request body can set `validatorRetries` per `/v1/generate` call.

**Tradeoffs.**
- Pro: simple — one constant in the worker.
- Con: "noisy" unitTypes (free-form Spanish output, unstructured prose) eat more retries than they're worth; tighter ones get one shot when they could safely have three.
- Con: when a consumer hits a model that's chronically failing one validator, they can't dial retries up themselves — needs a config change in ai-service.

**When to revisit.** When a consumer reports a unitType that needs > 1 retry consistently; or when validator-failure rates show up in the trace logs as a meaningful tail. Documented in `plan/m3-validator-retry-followup.md` (TODO in task #8).

---

## 5. OpenRouter API key — `.env.local`

**Decision.** User maintains `OPENROUTER_API_KEY` in `.env.local`. `src/config/env.ts` already reads `OPENROUTER_API_KEY` (line 45); `dotenv`'s default loads `.env`, so we'll extend it to also load `.env.local` (overrides `.env`) — standard Next.js-style precedence. `.env.local` is `.gitignore`'d (or should be — verify).

**Alternatives.**
- *Ship a `fake` provider* — selectable via `LLM_PROVIDER=fake`. Returns deterministic responses for dev without a key.
- *Build adapter, no fake* — tests stub HTTP; you provide the key for live smoke.

**Tradeoffs.**
- Pro: user already has the key; no extra abstraction layer.
- Con: contributors without a key can't run integration tests against live OpenRouter. Tests work around this by mocking the HTTP layer.
- Con: no automated way to detect a missing/invalid key until first call — error surfaces at runtime, not at boot. **Tech debt:** consider a startup probe.

**When to revisit.** When a second contributor joins or when E2E smoke needs to run in CI.

---

## 6. Test DB — docker-compose for local, Coolify-managed in prod

**Decision.** Add a single `docker-compose.yml` at the monorepo root with `pgvector/pgvector:pg16` + `redis:7-alpine` services on `localhost:55432` / `localhost:56379` (the existing local-port pattern). `pnpm run db:up` / `db:down` scripts. Coolify in prod/stage provisions Postgres + Redis natively (already documented in README).

**Alternatives.**
- *You bring up infra yourself.* No compose file; document required ports.
- *Skip integration tests this session.* Unit tests only; integration as a follow-up.

**Tradeoffs.**
- Pro: anyone can `pnpm run db:up && pnpm test` and have it work.
- Pro: prod stays platform-clean (no Docker dependency on the host).
- Con: two infra surfaces to keep in sync (local compose vs. Coolify config). If extension flags or Postgres versions drift, behaviour differs.
- Con: integration tests now require Docker on the dev machine — slightly heavier dependency for new contributors.
- Con: ephemeral Redis means BullMQ state doesn't persist across `db:down`. Worth a note in README.

**When to revisit.** When ai-service grows a Postgres extension Coolify can't easily install, or when local-vs-prod parity issues surface.

---

## 7. Webhook signing on `callbackUrl` — deferred

**Decision.** Skip HMAC signing in M3. Webhooks fire unsigned. Document the follow-up in `plan/m3-webhook-signing-followup.md` (TODO in task #8): per-project secret in `project_configs.metadata.callbackSecret`, `X-AI-Service-Signature: sha256=<hmac>` header, body-stable canonicalisation.

**Alternatives.**
- *Sign now* — per-project secret, HMAC-SHA256. Tiny additive surface.
- *No callbacks in M3 at all* — consumers poll `GET /v1/generate/:requestId` or subscribe to SSE.

**Tradeoffs.**
- Pro: faster to ship.
- Con (security): consumers can't verify a callback is really from ai-service. Anyone who learns a `callbackUrl` can spoof a completion event. **Tech debt: real attack surface, especially if consumers wire callbacks into write actions.**
- Con: rolling out signing later means a contract break for early consumers (they have to start verifying).

**Mitigations to do anyway.** Document in the consumer-contract that callbacks are unsigned in v1 and consumers SHOULD treat the request body as a hint, not authoritative; pull the canonical result via `GET /v1/generate/:requestId` before acting.

**When to revisit.** Before any external (non-internal) consumer goes live.

---

## 8. Worker process — in-process with the API

**Decision.** BullMQ worker(s) start inside `src/index.ts` alongside the Fastify server. One Node process, one Docker image, one Coolify service.

**Alternatives.**
- *Separate entrypoint, same repo* — `src/worker.ts` second entrypoint; Coolify runs two services.
- *Configurable via env flag* — `RUN_API=true`, `RUN_WORKER=true`; one image, two roles.

**Tradeoffs.**
- Pro: matches the plan; one deploy unit; simpler ops.
- Pro: in-process event bus (`mitt`) works without Redis pub/sub for SSE delivery.
- Con: long LLM calls in workers can starve API request latency under load (event loop contention on JSON parsing, streaming, etc.).
- Con: every API deploy bounces in-flight workers. BullMQ handles re-queue, but timing windows can lose progress.
- Con (subtle): SSE relies on the in-process bus — if you ever split workers out, you need Redis pub/sub for cross-process events, or SSE breaks.

**Documented split trigger** (per plan §5 step 6 comment):
1. `/health` p95 regresses under load → workers are eating the event loop.
2. Deploy churn loses > N jobs/week (track via worker-restart audit).
3. Workers' CPU/RAM profile diverges from API's such that scaling them together is wasteful.

**When to revisit.** When any of the three triggers fires.

---

## 9. Embedding provider — OpenRouter passthrough

**Decision.** Embeddings call OpenRouter's embedding endpoint with the same `OPENROUTER_API_KEY`. Single vendor; single key.

**Alternatives.**
- *OpenAI direct.* Separate key; lower latency to OpenAI's network; broader model selection.
- *Voyage AI direct.* Best-in-class retrieval quality; separate vendor account.
- *Multi-provider behind an interface.* Define `EmbeddingProvider`, ship one impl, add others later.

**Tradeoffs.**
- Pro: one vendor account, one API key, unified billing/budget tracking.
- Pro: cost tracking already flows through `usage_logs` / `traces` for completions; embeddings ride the same pipe.
- Con: extra latency hop (OpenRouter → OpenAI). For high-volume ingest this adds real wall-clock time.
- Con: locked into whatever OpenRouter exposes. They've historically been faster at adding completion models than embedding ones.
- Con: when a Voyage / Cohere / bge model becomes clearly better, switching is a migration (re-embed everything) — not just a config flip. **Tech debt: choosing dim 1536 below makes some alternatives easier than others.**

**When to revisit.** When ingest latency or embedding cost shows up in the budget; when a model with materially better retrieval quality (eval-measured) becomes available.

**Implementation note.** Verified during M4 foundation work: OpenRouter does expose an OpenAI-compatible embeddings endpoint at `POST /api/v1/embeddings` (per their docs index, accessed via the M4 schema agent's webfetch). The adapter in `src/services/ai/embeddings/openrouter.ts` calls it directly with the same `OPENROUTER_API_KEY`, no provider-direct fallback needed at landing time. **Possible-revision watch:** if a future cost/latency probe shows OpenRouter's embeddings path is materially worse than OpenAI direct, the adapter has an inline TODO with the three-line swap to point at `https://api.openai.com/v1/embeddings` (using `OPENAI_API_KEY`); the schema/types/consumers above stay put. Flag for the user when M4 runs end-to-end.

**Pricing refresh note.** `MODEL_PRICING` in `src/services/ai/router/task-profiles.ts` and the `estimatedCostUsdPerCall` figures in `EFFORT_PROFILES` (`src/services/registry/resolve.ts`) were re-verified against OpenRouter's public `/api/v1/models` catalog. Material moves: `deepseek/deepseek-chat-v3.1` dropped from $0.27/$1.10 → $0.21/$0.79 per 1M; `deepseek/deepseek-r1` shifted from $0.55/$2.19 → $0.70/$2.50 per 1M; `moonshotai/kimi-k2-0905` and `openai/text-embedding-3-small` were unchanged. The refresh script `scripts/refresh-model-pricing.ts` (also wired as `pnpm run refresh-pricing`) prints an upstream diff but does NOT auto-edit — humans paste the new numbers in and re-bump the date comment. **Next refresh recommended Q3 2026** (or sooner if vendor pricing pages move materially).

---

## 10. Vector dimension — `vector(1536)` (text-embedding-3-small)

**Decision.** Bake `vector(1536)` into the `chunks.embedding` column in migration `0006`. Default embedding model: `openai/text-embedding-3-small` (1536-dim, ~$0.02 / 1M tokens). Stored per-`corpus` as `embeddingModel` so retrieval knows which model to use for the query embedding.

**Alternatives.**
- *3072 (text-embedding-3-large)* — higher quality, ~6× cost, larger index.
- *1024 (voyage-3 / cohere-embed-v3)* — strong quality, smaller index, but requires non-OpenAI provider.
- *Variable dim per corpus* — `vector` column without fixed dim, per-corpus partial indexes. Most flexible, heaviest infra.

**Tradeoffs.**
- Pro: industry default; cheap; works well enough for most consumer apps.
- Pro: one pgvector index covers the whole `chunks` table.
- Con: switching to 3072 or 1024 later means a new column + dual-write + backfill + index rebuild. **Tech debt: schema change costs more than env change.**
- Con: 1536-dim arrays in JSON serialisation are non-trivial (12KB+ per row in raw text). Use pgvector's binary format on the wire.
- Con: ivfflat vs hnsw index choice deferred to migration time (recommendation: hnsw for query latency, slower build; ivfflat for build-time, slower query). Documented inline in the migration.

**When to revisit.** When evals show another model clearly winning on the corpus you care about.

---

## 11. Chunking strategy — recursive character

**Decision.** Recursive character splitter. Split on paragraphs (`\n\n`), then sentences (`. `, `? `, `! `), then characters. Target ~800 tokens per chunk with ~100-token overlap (configurable but baked defaults to start).

**Alternatives.**
- *Fixed token-window* — hard cut at N tokens; no semantic awareness.
- *Semantic chunking* — sentence-transformer embeddings group by similarity; best quality, slow, more deps.
- *Per-corpus configurable* — `chunkStrategy` field on `corpora`; ingest reads it.

**Tradeoffs.**
- Pro: boring sensible default; ports cleanly if we move to LangChain / LlamaIndex.
- Pro: deterministic — same input → same chunks, useful for `id`-based dedupe.
- Con: "~800 tokens" uses a tokenizer estimate (chars/4); real token counts vary by model. Not catastrophic but worth measuring.
- Con: overlap of 100 tokens wastes some embedding spend on duplicated text. Acceptable for v1.
- Con: lossy on code, tables, structured docs — recursive char doesn't respect markdown headers / code fences. **Tech debt: a markdown-aware splitter is the obvious next step for technical corpora.**

**When to revisit.** When a consumer needs to ingest large code corpora or structured docs; when retrieval quality is measurably hurt by mid-sentence cuts.

---

## 12. Retrieval mode — vector + optional MMR

**Decision.** `POST /v1/retrieve` does cosine top-K via pgvector, with optional MMR (`λ` 0.5–0.7) for diversity. No filters, no hybrid (BM25 + vector), no score thresholds in v1.

**Alternatives.**
- *Vector + BM25 hybrid* — pgvector cosine + Postgres `tsvector` full-text; reciprocal rank fusion. Better recall on keyword-heavy queries.
- *Vector only, no MMR* — simplest possible; MMR is M4.5.

**Tradeoffs.**
- Pro: smallest viable retrieval surface; one index; reproducible.
- Pro: MMR is cheap to add on the result set (re-rank in Node, no DB change).
- Con: bad recall on exact-term queries ("find the doc that mentions ‘SKU-9831'"). Pure vector blurs exact matches.
- Con: no filtering by metadata (e.g., "only chunks from corpus X dated after Y"). Consumer has to post-filter.
- Con: no scoring threshold — if there are no relevant docs, top-K still returns the K least-irrelevant ones. Consumer must look at scores.

**When to revisit.** First retrieval-quality complaint about missed keyword matches → wire BM25 + RRF.

---

## 13. Ingest input format — JSON body, raw text only

**Decision.** `POST /v1/ingest` body: `{ corpus, documents: [{ id?, text, metadata? }] }`. Consumer pre-extracts text from PDFs/HTML/docx before posting. ai-service stays text-only.

**Alternatives.**
- *JSON or multipart file upload* — server-side parsing (pdf-parse, unified). Bigger surface, parser deps, attack surface (PDF bombs, malformed inputs).
- *JSON only + URL-fetch mode* — `{ url }` and the service fetches. SSRF risk; unbounded fetches.

**Tradeoffs.**
- Pro: zero parser deps; small service.
- Pro: no SSRF; no PDF-bomb attack surface.
- Con: every consumer reimplements PDF/HTML text extraction. **Tech debt: extraction logic duplicated across consumers; worth a shared client lib in M5.**
- Con: file uploads are a normal UX pattern; consumers wanting to expose ingest in their own UI must build an intermediate proxy.

**When to revisit.** When a second consumer's text-extraction is non-trivial enough to justify centralising; or when a consumer wants direct browser → ai-service upload.

---

## 14. Ingest processing — always async via BullMQ

**Decision.** `POST /v1/ingest` returns `{ ingestId, totalDocs }` immediately. Background worker chunks + embeds + writes `documents` and `chunks` rows. Status via `GET /v1/ingest/:ingestId`. New queue: `ingest`.

**Alternatives.**
- *Sync for small batches, async for large* — threshold-based (e.g., `<= 5 docs && total chars <= 50KB` inline). DX-nicer; magic numbers.
- *Always sync* — POST blocks until done. Simplest; doesn't survive large batches.

**Tradeoffs.**
- Pro: consistent contract — same call shape regardless of batch size.
- Pro: HTTP request times stay bounded; long ingests don't hit reverse-proxy timeouts.
- Con: small-batch DX gets worse — caller has to poll or subscribe to find out when a 1-doc ingest finished.
- Con: another `ingestId` lookup pattern (parallel to `requestId` for generation). Document carefully.
- Con: re-using the same BullMQ infra means ingest backpressure can starve generation throughput on a shared worker (in-process workers, decision #8). **Mitigation:** separate worker concurrency per queue.

**When to revisit.** When consumers complain about poll-for-one-doc; add a `sync=true` query param later (no contract break).

---

## 15. Ingest idempotency — consumer-supplied `id` is the dedupe key

**Decision.** Optional `documents[].id`. If present and `(corpus, id)` already exists in `documents`, delete its existing chunks + re-embed + re-insert (treats as an in-place update). If absent, generate a UUID — always inserts a new doc.

**Alternatives.**
- *Content hash dedupe* — SHA-256 of text; identical content = no insert. Mixes content with identity.
- *No dedupe* — every ingest creates new rows; consumer responsible for delete-before-ingest.

**Tradeoffs.**
- Pro: consumer owns identity; service doesn't guess.
- Pro: clean update semantics (re-ingest with same `id` replaces the doc).
- Pro: doc-level metadata changes (re-classifying without changing text) work naturally.
- Con: re-embedding on no-op text changes (metadata-only) wastes embedding spend. **Tech debt:** worth a `skipReembedIfUnchanged` flag later (content hash gated by `id` match).
- Con: consumers who forget to supply `id` accumulate dupes silently. Worth a per-corpus stat in the response payload.

**When to revisit.** When embedding spend on ingest becomes noticeable; or when a consumer wants explicit version-tracking on a doc.

---

## 16. Rendered prompt storage — render once at orchestrator

**Decision.** Orchestrator renders Handlebars template + variables once, stores the final prompt string on `generation_jobs.input.__renderedPrompt`. Worker uses it as-is on retries.

**Alternatives.**
- *Re-render each attempt* — store template + variables separately; render per attempt.

**Tradeoffs.**
- Pro: the prompt that produced any given output is sitting right there in the row — debugging and audit are trivial.
- Pro: reproducible — a retry can't mysteriously pick up a different prompt because the registry shifted mid-flight.
- Con: a registry-template fix can't help in-flight jobs; they're locked to the prompt rendered at enqueue time. Acceptable: cancel + re-issue if you really need the fix.
- Con: rendered prompts can be large (multi-KB) — `generation_jobs` rows balloon. Postgres jsonb compresses fine but worth measuring on a real workload.
- Con: leaks sensitive variable values into the DB row (e.g., if `input` contained PII, it's both in `input.fields` AND in `__renderedPrompt`). Same data, twice. Worth a note in the privacy doc.

**When to revisit.** When a consumer's input includes secrets we don't want to persist twice (encrypt-at-rest is the obvious answer, separate from this decision).

**Reversed (partial)** — surfaced while drafting the detailed Step 5 plan. Dependent units (those with `dependsOn`) cannot be fully rendered at orchestrator time because predecessor outputs literally don't exist yet. The decision becomes **two-phase**:
- **Leaf units (no `dependsOn`)**: render at orchestrator time, store the final string in `generation_jobs.input.__renderedPrompt`. Matches the original §16 spirit; reproducible-on-retry.
- **Dependent units**: store template at `generation_jobs.input.__promptTemplate` + partial vars at `generation_jobs.input.__promptVars`. The worker renders right before the LLM call (after merging predecessor outputs under the named slots) and writes the result back to `__renderedPrompt`. Audit-trail property preserved: one row eventually ends up with one `__renderedPrompt` reflecting exactly what produced its `output`. The retry-idempotence property is preserved because retries inside the worker reuse the already-set `__renderedPrompt`.
The single-phase alternative would be to forbid `dependsOn` — a contract regression we'd never want.

---

# Cross-cutting open items / known tech debt

These didn't fit a single decision row but came up in the interview:

- **No `organizations` table** — `org` is just an opaque string on every row. Budget, rate limits, etc. live in `llm_configs` / `budget_state` keyed by `org` string. Fine for now. A real "Org" entity (name, owner, billing email, etc.) will need a table later.
- **No multi-currency** — USD only. Documented in §2.
- **No CI configuration mentioned anywhere** — README says CI exists ("M1 ✅") but there's no `.github/` or `.gitlab-ci.yml` visible. **Tech debt to verify.**
- **API_KEYS env map.** Static JSON in env. Fine at small scale; will not scale past dozens of keys or any kind of key rotation. Documented for M5.
- **`registry_audit` only audits registry writes.** Generation, budget changes, and ingest are not audited. May want a broader audit story.
- **No rate limiting on the API surface itself** — only on the LLM provider side. The HTTP routes don't rate-limit; a consumer could hammer `/v1/generate` and burn budget fast.
- **No request-size limits enforced beyond Fastify defaults** — large `units` arrays could spike memory.

---

# How to use this doc

1. Skim sections you remember; read the **Tradeoffs** lines carefully.
2. Anything in **Tech debt** / **When to revisit** is a candidate for a follow-up ticket.
3. If you reverse a decision, update the section in place (don't delete) and add a `**Reversed YYYY-MM-DD:**` note to the bottom of that section.
