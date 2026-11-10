// ⚠ A DEPLOYED `dev` CAN ALSO RUN `NODE_ENV=production`.
//
// The consequence to know before you debug on a deployed box: setting
// `CALLBACK_ALLOW_PRIVATE` on the DEV deployment hard-fails boot, exactly as it
// would on prod. That is BY DESIGN — the guard keys off `NODE_ENV`, not off the
// environment's name, so it cannot be fooled by a box that calls itself dev.
//
// The old in-service mock switches (`MOCK_LLM`, `MOCK_EMBEDDINGS`,
// `MOCK_LLM_STREAM`) were REMOVED, not gated: the shipped service
// can no longer produce fake model output at all. Setting one now refuses boot
// in EVERY environment (`REMOVED_MOCK_FLAGS`), because a consumer still setting
// it expects zero-cost fake output and would otherwise get real, billed calls.
// Tests point the service at `test-support/fake-provider/` instead.

import { createHash } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { pino } from 'pino';
import { z } from 'zod';

loadDotenv();

export const apiKeyEntry = z.object({
  org: z.string().min(1),
  project: z.string().min(1),
  /**
   * Role gates write endpoints. Defaults to `'app'` so existing entries (which
   * never had a role field) keep working — they get read-only access.
   */
  role: z.enum(['app', 'admin']).default('app'),
  /**
   * Per-consumer HMAC secret used to sign async callbacks (see
   * `plan/tecnología/ai-infra/callback-contract.md`). When absent, ai-service
   * still records terminal callbacks in `callback_deliveries` but cannot sign
   * them — see `src/services/callbacks/emit.ts` for the actual behaviour.
   *
   * Min length 32 chars: the contract recommends a 64-hex-char secret, but
   * we enforce a softer 32-char floor so accidentally-short rotations during
   * development still validate.
   */
  callbackSecret: z.string().min(32).optional(),
  /**
   * Previous callback secrets, accepted by the verifier during rotation
   * (contract §"Secret management"). The emitter always signs with the active
   * `callbackSecret`; this field is reserved for the receive-side verify
   * window and validated for shape only here.
   */
  previousCallbackSecrets: z.array(z.string().min(32)).optional(),
  /**
   * Optional expiry, ISO-8601 with an explicit offset or `Z`
   * (`2026-12-31T00:00:00Z`). ADDITIVE: entries without it never expire, which
   * is every entry that exists today — do not make this required.
   *
   * Enforced at auth time in `src/plugins/auth.ts`: a request bearing an
   * expired key gets `401 { error: 'api_key_expired' }`, a code distinct from
   * the generic `unauthorized` so a consumer can tell "rotate me" apart from
   * "wrong token". Also surfaced at boot by `warnOnExpiringApiKeys`.
   */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Optional short human label for the key ("app-prod-2026q3"). Purely for
   * operators: it rides on `req.auth.kid` and appears in boot/expiry warnings
   * so a log line can name a key without printing the token.
   *
   * NOT written to `registry_audit.actor_key_id`. That column is documented
   * (schema comment + `src/plugins/auth.ts`) as the SHA-256-derived
   * `apiKeyId`, and existing rows carry that derivation; writing a free-text
   * label into the same column would change its meaning for every reader and
   * for `registry_entries.updated_by`, which is a migration, not a
   * pass-through. Logs only.
   */
  kid: z.string().min(1).max(64).optional(),
  /**
   * Optional org delegation. When set, a request bearing this key may send
   * `X-AI-Org: <suffix>` (suffix `^[a-z0-9-]{1,48}$`) and then acts as org
   * `delegateOrgPrefix + suffix` instead of `org`. `project`, `role` and the
   * key id still come from this entry. Without the header the key acts as
   * its own `org`. A key without this field that sends the header gets 403.
   *
   * Lets one consumer key serve many sub-tenants, each with its own budget,
   * usage rows and corpora, because every downstream path reads the org from
   * `req.auth`. Enforced in `src/plugins/auth.ts`.
   *
   * Must end in `-`, at most 32 chars, so a prefix cannot run into an
   * unrelated org name (`acme` would also cover `acmecorp`). Another key's own
   * `org` MAY start with this prefix (owner decision 2026-10-16): a dedicated
   * key per sub-org shares that org with the delegating key, which can already
   * act as it by design. ADDITIVE: absent on every existing entry.
   */
  delegateOrgPrefix: z
    .string()
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*-$/, 'delegateOrgPrefix must match ^[a-z0-9][a-z0-9-]*-$')
    .optional(),
});

export type ApiKeyEntry = z.infer<typeof apiKeyEntry>;

/**
 * bge-m3's learned-sparse vocabulary size (XLM-RoBERTa vocab) AND the fixed
 * width of the `chunks.sparse_embedding` `sparsevec(N)` column (hardcoded
 * `sparsevec(250002)` in `db/schema` + the migration). It is a CONSISTENCY
 * constant, not a free dial: `SPARSE_DIM` must equal it, or every sparsevec
 * literal casts to the wrong dimension and fails at the DB (ingest UPDATE and
 * hybrid retrieve). Re-cutting the column to a different width requires a
 * migration (owned in drizzle/), which would update this constant in lockstep.
 * The boot guard in the `env` IIFE below enforces the match — fail fast at boot
 * instead of at the first sparse operation.
 */
const SPARSE_VOCAB_DIM = 250002;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Proxy hops between the internet and this service. Fastify reads `req.ip`
  // that many entries from the RIGHT of `X-Forwarded-For`. Default 1: the one
  // Traefik ingress Coolify puts in front of the container. Raise it only when
  // another proxy (e.g. a CDN) sits in front of the ingress. Never `true`: that
  // trusts every hop, so `req.ip` becomes the caller-written leftmost entry.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

  DATABASE_URL: z.string().url(),
  // Optional DIRECT (non-pooled) Postgres URL, used ONLY by the migration path
  // (`createMigrationClient`, `scripts/schema-gate.mjs`, `drizzle.config.ts`).
  // Same convention as Prisma's `directUrl` and Supabase's direct connection:
  // when `DATABASE_URL` points at PgBouncer in transaction mode, migrations
  // want a real session (advisory locks, multi-statement DDL, startup
  // parameters). Unset ⇒ migrations use `DATABASE_URL`, exactly as before.
  DATABASE_URL_DIRECT: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  // JSON map of apiKey -> { org, project, role? }
  //
  // Tokens are normalised (trimmed) here and a boot that would have needed the
  // normalisation is REFUSED — see `normaliseApiKeys` for why a silently fixed
  // key is the same footgun one step later.
  API_KEYS: z
    .string()
    .default('{}')
    .transform((raw, ctx) => {
      let entries: Record<string, ApiKeyEntry>;
      try {
        entries = z.record(z.string(), apiKeyEntry).parse(JSON.parse(raw));
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'API_KEYS must be a JSON object of apiKey -> {org, project, role?}',
        });
        return z.NEVER;
      }
      const { keys, problems } = normaliseApiKeys(entries);
      if (problems.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'API_KEYS holds token(s) that no request could ever match. ' +
            'Refusing to start; fix the env var and redeploy. ' +
            problems.join(' | '),
        });
        return z.NEVER;
      }
      return keys;
    }),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  /**
   * Embeddings seam — all three are config-driven so the model + hosting can be
   * swapped with NO code or schema change (coordination doc §9.3: dev calls the
   * model via a managed endpoint; prod later self-hosts the SAME open weights →
   * identical vectors → no re-embed).
   *
   * `EMBEDDINGS_URL` — the OpenAI-compatible `/embeddings` endpoint. Defaults to
   * OpenRouter, which serves the open multilingual model below on the existing
   * `OPENROUTER_API_KEY`; point it at a self-hosted box in prod without touching
   * code.
   *
   * `EMBEDDING_MODEL` — default embedding model for auto-created corpora and the
   * `/v1/embed` passthrough. `baai/bge-m3`: open (Apache/MIT), self-hostable,
   * multilingual, 1024-dim — verified empirically against `EMBEDDINGS_URL`.
   * `intfloat/multilingual-e5-large` is a drop-in alternative (also 1024-dim) if
   * a later quality pass prefers it — a pure env flip, no migration.
   *
   * `EMBEDDING_DIM` — vector length the model emits. MUST match the live
   * `chunks.embedding` SQL type `vector(N)`; changing it requires a migration
   * (pgvector fixes dimension at DDL time), so this is a consistency knob, not a
   * free dial.
   */
  EMBEDDINGS_URL: z.string().url().default('https://openrouter.ai/api/v1/embeddings'),
  /**
   * `EMBEDDINGS_API_KEY` — optional Bearer token for `EMBEDDINGS_URL`. When set
   * (non-empty), embedding calls send it INSTEAD of `OPENROUTER_API_KEY`, so a
   * self-hosted or third-party embeddings host never receives the OpenRouter
   * key. Unset or empty ⇒ unchanged behaviour (`OPENROUTER_API_KEY`, then
   * `OPENAI_API_KEY`).
   */
  EMBEDDINGS_API_KEY: z.string().optional(),
  /**
   * Hosted fallback for embeddings — OPTIONAL, off when unset.
   *
   * `EMBEDDINGS_FALLBACK_URL` — a second OpenAI-compatible `/embeddings`
   * endpoint serving the SAME model as `EMBEDDINGS_URL` (e.g. OpenRouter's
   * `baai/bge-m3` behind a self-hosted bge-m3 primary). When the primary fails
   * with a network error, a timeout, HTTP 5xx or 429, the call is retried here
   * and the primary is skipped for `EMBEDDINGS_FALLBACK_COOLDOWN_S`. Other
   * statuses (400/401/403…) never fall back, so config bugs surface. Unset ⇒
   * behaviour is byte-identical to before this knob existed.
   *
   * `EMBEDDINGS_FALLBACK_API_KEY` — Bearer token for the fallback. Unset/empty ⇒
   * `OPENROUTER_API_KEY`, then `OPENAI_API_KEY`. `EMBEDDINGS_API_KEY` is NEVER
   * sent to the fallback, and this key is never sent to the primary.
   *
   * `EMBEDDINGS_PRIMARY_TIMEOUT_MS` — wall-clock cap on a primary call, applied
   * ONLY when a fallback is configured (without one the primary call keeps its
   * old shape: bounded by the caller's signal alone), so a dead primary costs
   * one short wait instead of stalling ingest.
   */
  EMBEDDINGS_FALLBACK_URL: z.string().url().optional(),
  EMBEDDINGS_FALLBACK_API_KEY: z.string().optional(),
  EMBEDDINGS_FALLBACK_COOLDOWN_S: z.coerce.number().int().nonnegative().default(60),
  EMBEDDINGS_PRIMARY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * The OpenAI-compatible `/chat/completions` endpoint both chat paths (plain
   * and streaming) call. Defaults to OpenRouter. The companion of
   * `EMBEDDINGS_URL`; tests and consumer e2e point both at the TEST-ONLY fake
   * provider (`test-support/fake-provider/`), never shipped in the image.
   */
  CHAT_COMPLETIONS_URL: z.string().url().default('https://openrouter.ai/api/v1/chat/completions'),
  EMBEDDING_MODEL: z.string().default('baai/bge-m3'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),

  /**
   * Rerank seam — a cross-encoder re-scoring rung that runs AFTER RRF fusion,
   * over a capped top-N pool, before the final `slice(topK)`. Config-driven and
   * OFF by default, exactly like the embeddings seam, so retrieval behaviour is
   * byte-identical until a consumer opts in (per-request `rerank: true`).
   *
   * Design + rationale: `plan/tecnología/ai-infra/reranker-and-eval-plan.md`.
   *
   * `RERANK_ENABLED` — master switch. When false (default), the service NEVER
   * calls the reranker even if a request sets `rerank: true` — the request field
   * degrades to a no-op. This is the deploy-safety gate: ai-service can ship the
   * seam dark, then flip it on per environment once `RERANK_URL` has a home.
   *
   * `RERANK_URL` — the rerank endpoint. Passed to `fetch` VERBATIM, so the
   * endpoint segment is required. Points either at the SIBLING self-hosted
   * service (see `rerank-service/`) or at a hosted rerank API; managed vs
   * self-hosted is an env flip, not a code change. Absent ⇒ rerank stays a
   * no-op even if `RERANK_ENABLED=true` (nothing to call).
   *   ⚠ CORRECTION: an older comment here said flatly "NOT
   *   OpenRouter". OpenRouter DOES have a rerank API, `/api/v1/rerank` (QUOTED
   *   from the ZDR research, not verified by this lane), and it speaks the
   *   Cohere shape — so it is a `RERANK_PROVIDER=rerank-api` URL needing no
   *   adapter. What is true is only that the DEFAULT MODEL is not served
   *   there. That is a model question, not an API one.
   *   ⚠ UNDER `RERANK_PROVIDER=deepinfra` THIS IS THE API BASE, not a full
   *   endpoint (`https://api.deepinfra.com`). That provider carries the model
   *   as a path segment, and the adapter appends it from `RERANK_MODEL` so the
   *   model knob keeps working. A full `/v1/inference/...` URL is REFUSED at
   *   boot rather than silently 404ing every call.
   *
   * `RERANK_MODEL` — default rerank model id, overridable per-request via
   * `rerankModel`. `baai/bge-reranker-v2-m3`: open (Apache-2.0), multilingual,
   * pairs with the `bge-m3` embedder, CPU-viable at our N (20–50) and volume.
   *
   * `RERANK_TIMEOUT_MS` — per-request wall-clock cap on the reranker call. On
   * timeout (or ANY rerank error) the service FALLS BACK to the fused order and
   * never fails the query — reranking is a relevance-polish rung, not a
   * correctness gate. Default 5s.
   *
   * `RERANK_PROVIDER` — which WIRE SHAPE `RERANK_URL` speaks. `RERANK_URL` on
   * its own only says WHERE to POST; it does not say what body the other end
   * parses, and hosted rerankers do not agree on one:
   *   - `rerank-api` (default) — `POST {model, query, documents, top_n?}` ⇒
   *     `{results: [{index, relevance_score}]}`. Cohere `/v2/rerank`, Jina
   *     `/v1/rerank`, Voyage and our own sibling `rerank-service/` all speak it.
   *     The value names that shared REQUEST FORMAT, not a vendor.
   *     `cohere` is the legacy spelling of the same value (ruling:
   *     it read as "Cohere the vendor"). It stays accepted so deployed envs
   *     keep booting, and is normalised to `rerank-api` at parse time — no
   *     code past this schema ever sees `cohere`.
   *   - `deepinfra` — `POST {queries, documents}` ⇒ `{scores: number[]}`,
   *     positional, no `index`, no `top_n`, model in the URL path.
   * Adding a provider is a new adapter in `rerank-client.ts`, never a branch in
   * the transport. See that file for the full contract.
   *
   * `RERANK_API_KEY` — bearer credential for `RERANK_URL`. Sent as
   * `Authorization: Bearer <key>` on every rerank call when set, and OMITTED
   * when unset, because the self-hosted sibling needs no credential and a
   * `Bearer undefined` header would be worse than none.
   *
   * 🔴 WHY THIS IS NOT OPTIONAL FOR A HOSTED PROVIDER: the rerank rung FAILS
   * SAFE. A 401 is swallowed into the fused order, and the response is then
   * byte-identical to `rerank: false` minus `rerankScore` — an unauthenticated
   * reranker is INVISIBLE in the output. So a provider whose adapter declares
   * `requiresApiKey` REFUSES to boot without this key (all environments, not
   * just production) rather than shipping a deployment that silently never
   * reranks. `rerank-api` does not declare it: that value covers the self-hosted
   * sibling, where no credential is the normal case.
   */
  RERANK_ENABLED: z
    .enum(['true', 'false', '0', '1'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  RERANK_URL: z.string().url().optional(),
  RERANK_PROVIDER: z
    .enum(['rerank-api', 'cohere', 'deepinfra'])
    .default('rerank-api')
    .transform((v) => (v === 'cohere' ? 'rerank-api' : v)),
  RERANK_API_KEY: z.string().optional(),
  RERANK_MODEL: z.string().default('baai/bge-reranker-v2-m3'),
  RERANK_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),

  /**
   * Learned-sparse retrieval seam — bge-m3's sparse (lexical) vectors as an
   * OPT-IN ALTERNATIVE to the Postgres `tsvector` lexical leg in the hybrid RRF
   * fusion. Config-driven and OFF by default, exactly like the rerank seam, so
   * retrieval + ingest are byte-identical until a consumer's deployment opts in.
   * The `tsvector` leg stays the DEFAULT lexical leg; sparse REPLACES it in the
   * fusion only when this gate is on.
   *
   * WHY A SIBLING SERVICE (not OpenRouter): OpenRouter's `/embeddings` endpoint
   * is OpenAI-compatible and returns DENSE vectors ONLY — there is no wire field
   * for bge-m3's sparse (`lexical_weights`) or colbert output. Getting sparse
   * vectors therefore requires a self-hosted bge-m3 service running
   * FlagEmbedding with `return_sparse=True` (see `bge-m3-service/`), the same
   * CPU-sibling pattern as `rerank-service/`. This is CPU-scale, not GPU.
   *
   * `SPARSE_ENABLED` — master switch. When false (default), the service NEVER
   * calls the sparse embedder: ingest writes no `chunks.sparse_embedding`, and a
   * `mode: 'hybrid'` retrieve uses the `tsvector` leg exactly as today. Deploy
   * the seam dark, then flip per environment once `SPARSE_EMBED_URL` has a home.
   *
   * `SPARSE_EMBED_URL` — the `POST /embed` endpoint of the SIBLING bge-m3
   * service. Absent ⇒ sparse stays off even if `SPARSE_ENABLED=true` (nothing to
   * call). Managed/self-hosted is an env flip, like `EMBEDDINGS_URL`. The
   * text sent here is PII-SCRUBBED first (egress seam 5 in
   * `src/services/ai/pii-egress.ts`), so a managed URL receives placeholders,
   * not raw CURP/RFC/email/phone/address.
   *
   * `SPARSE_EMBED_MODEL` — sparse model id the sibling serves. `baai/bge-m3`
   * produces dense + sparse from one forward pass; kept separate from a corpus's
   * dense `embeddingModel` so the two seams stay independent.
   *
   * `SPARSE_DIM` — the sparse vocabulary size, and the `chunks.sparse_embedding`
   * `sparsevec(N)` column width. 250002 = bge-m3's XLM-RoBERTa vocab. Changing
   * it requires a column re-cut migration (pgvector fixes sparsevec dim at DDL
   * time), so this is a consistency knob matched to the model, not a free dial.
   *
   * `SPARSE_TIMEOUT_MS` — per-request wall-clock cap on the sparse embedder call.
   */
  SPARSE_ENABLED: z
    .enum(['true', 'false', '0', '1'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SPARSE_EMBED_URL: z.string().url().optional(),
  SPARSE_EMBED_MODEL: z.string().default('baai/bge-m3'),
  SPARSE_DIM: z.coerce.number().int().positive().default(SPARSE_VOCAB_DIM),
  SPARSE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10_000),

  /**
   * Which lexical leg a `mode: 'hybrid'` retrieve fuses with the dense leg,
   * when the sparse leg above is NOT active (an active sparse leg still
   * replaces whatever this selects).
   *
   * `tsvector` (DEFAULT, unchanged behaviour) — Postgres full-text search over
   * `chunks.text_search` with the corpus's `language` config.
   * `trigram` — pg_trgm `word_similarity(query, chunks.text)` via the `<%`
   * operator (extension from `drizzle/0005_pg_trgm.sql`; no trigram index).
   * Matches near-spellings and inflections without a language stemmer.
   * `none` — no lexical leg: hybrid is RRF over the dense leg alone.
   *
   * WHY `trigram` exists — quoted from EDC's 2026-10-16 eval (39 queries,
   * 253 chunks, no trigram index; optimistic): dense + tsvector `spanish`
   * dropped single-doc MRR from 0.95 to 0.50; dense + whole-query trigram kept
   * 0.95 and lifted overall MRR to 0.81 against 0.79 for dense-only.
   *
   * `TRIGRAM_THRESHOLD` — `pg_trgm.word_similarity_threshold` for the `<%`
   * filter, set per query with `SET LOCAL`. Lower = more candidates and a
   * slower scan. The 0.3 default is NOT tuned against any eval (pg_trgm's own
   * default, 0.6, is tuned for short strings, not whole questions).
   */
  HYBRID_LEXICAL_LEG: z.enum(['tsvector', 'trigram', 'none']).default('tsvector'),
  TRIGRAM_THRESHOLD: z.coerce.number().gt(0).max(1).default(0.3),

  /**
   * PII NER model server (§9.4 / §9.1's third adapter) — the OPTIONAL `person`
   * detector behind the PII minimiser.
   *
   * WHAT IS ALREADY ON WITHOUT ANY OF THESE: the five OFFLINE RULE detectors
   * (CURP, RFC, email, phone, MX addresses) run at every egress seam
   * unconditionally — see `src/services/ai/pii-egress.ts`. These five vars add
   * the one thing rules cannot do: a person's NAME in running Spanish is not a
   * pattern, so it takes a sequence model.
   *
   * 🔴 THESE ARE INERT TODAY, on purpose. Nothing installs `nerDetector` into
   * the egress policy yet, because §5 open item 7 leaves the MODEL UNCHOSEN
   * (size, language coverage and licence all open). They are declared here
   * anyway — and this is the whole reason this block exists — because
   * `ner-client.ts` used to read them through bare `process.env`, which put them
   * outside this schema, outside `.env.example`, and made a TYPO in any of them
   * SILENT. An undeclared var cannot be misspelled loudly.
   *
   * 🔴 PII IS THE ONE CAPABILITY THAT FAILS CLOSED (§9.1's table): rerank
   * degrades to the fused order, sparse falls back to the tsvector leg, and a
   * failed PII detector REFUSES THE CALL. So a deployment that installs the NER
   * detector with `PII_NER_URL` unset does not quietly ship every name to the
   * provider — every request 503s until it is fixed.
   *
   * `PII_NER_URL` — `POST /ner` of the sibling `pii-service/`. Passed to `fetch`
   * VERBATIM, so the endpoint segment is required, exactly like `RERANK_URL`.
   * Absent ⇒ the adapter is NOT CONFIGURED and refuses when called.
   *
   * `PII_NER_MODEL` — model id. 🔴 NO DEFAULT, deliberately: §5 open item 7 is
   * open, and baking a guess here would put an unmade decision into the image.
   *
   * `PII_NER_BATCH_LIMIT` — inputs per request. The caller splits above it.
   *
   * `PII_NER_TIMEOUT_MS` — per-request wall clock. ⚠ NEVER write a literal 0: it
   * passes `.nonnegative()` and installs NO abort timer, so a hung model server
   * hangs the caller — the same §10-item-8 footgun `RERANK_TIMEOUT_MS` carries.
   * Blank is safe; the empty-string rule below restores the default and warns.
   *
   * `PII_NER_MIN_SCORE` — drop entities scoring below this. ⚠ A LOWER number is
   * the SAFER one here, the opposite of a relevance threshold: a missed name
   * leaks PII, while a false positive only costs prose quality.
   */
  PII_NER_URL: z.string().url().optional(),
  PII_NER_MODEL: z.string().optional(),
  PII_NER_BATCH_LIMIT: z.coerce.number().int().positive().default(16),
  PII_NER_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
  PII_NER_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),

  /**
   * Per-call wall-clock cap on the OPTIONAL query-condensation (rewrite) step
   * that runs in front of `/v1/retrieve/multi`. The rewrite is a throwaway
   * relevance-polish call, never the answer, so it must NEVER block retrieval:
   * on timeout (or ANY error) `condenseQuery` FAILS SAFE to the raw question and
   * the query proceeds un-rewritten — exactly like the rerank rung above. This
   * is a much tighter bound than `LLM_REQUEST_TIMEOUT_MS` on purpose: the router
   * honours the abort signal we hand it, but its own backstop is measured in
   * minutes, so a stalled rewrite would otherwise hold the whole retrieve open.
   * Default 5s. Set to 0 to disable the bound (the router's backstop still
   * applies).
   */
  CONDENSE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),

  /**
   * Wall-clock backstop on a single LLM provider call (the whole
   * `router.route` generation, including refine/sample passes share the same
   * deadline). This is INDEPENDENT of — and combines with — the client-
   * disconnect AbortSignal: whichever fires first aborts the upstream fetch via
   * the same partial-billing/refund path. Default 120s is generous so it never
   * kills a legitimate long completion; it only catches a provider that stalls
   * or holds the socket open without honouring TCP close. Set to 0 to disable.
   */
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(120_000),

  /**
   * The same wall-clock backstop, for the ASYNC generation worker only
   * (`src/workers/generation.worker.ts`). An async unit has no HTTP client
   * waiting on it, so a `deep` unit may legitimately need longer than a sync
   * call. Unset ⇒ inherits `LLM_REQUEST_TIMEOUT_MS` (resolved in the `env` IIFE
   * below), so nothing changes by default. An explicit value must be a
   * positive integer — there is no "0 disables" here.
   *
   * The worker lock window (`workerRuntimeOptions`, src/queue/queues.ts) is
   * derived from the LONGER of the two deadlines, so raising this one also
   * raises the lock and a long unit cannot outlive it.
   */
  LLM_ASYNC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  /**
   * ── WORKER LOCK WINDOW (own region — keep edits here, not folded into the
   *    timeout block above; another lane is editing this file this cycle) ──
   *
   * BullMQ holds a per-job lock and renews it on a timer. When the renewal
   * misses (a blocked event loop, a paused container), the stalled checker
   * hands the SAME job to a second worker. `lockDuration` is the tolerance for
   * that miss, NOT a deadline: a job that runs longer is fine as long as its
   * process keeps renewing.
   *
   * Leave this UNSET and `workerRuntimeOptions()` (src/queue/queues.ts) derives
   * the window as `max(2 x max(LLM_REQUEST_TIMEOUT_MS,
   * LLM_ASYNC_REQUEST_TIMEOUT_MS), 60000)` — two full LLM
   * timeouts covers the worst in-band case (initial call plus one validator
   * retry). Set it only when a deployment's real job duration is not a function
   * of the LLM timeout (an ingest-heavy pod embedding very large documents is
   * the case we expect); it then overrides the derivation outright, floor
   * included.
   */
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().positive().optional(),

  /**
   * Inactivity/stall backstop on a streaming provider call: if no model output
   * (a text or reasoning delta) arrives for this many ms, abort the stream.
   * Keepalive comments and empty chunks do NOT reset it. A stalled stream is
   * the more realistic hang than a slow-but-progressing one, so this default
   * (45s) is much tighter than the total cap above. Only applies to the
   * streaming adapter's read loop. Set to 0 to disable.
   */
  LLM_STREAM_STALL_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(45_000),

  /**
   * Callback SSRF guard — local/docker-network escape hatch. OFF by default.
   *
   * ai-service POSTs signed callbacks to a consumer-supplied `callbackUrl`
   * (`POST /v1/generate`, `POST /v1/ingest`) or to `project_configs.callback_url`.
   * `assertSafeCallbackUrl` (services/callbacks/url-guard.ts) refuses any target
   * that resolves into loopback / RFC1918 / link-local / IPv6-ULA space, so a
   * tenant key cannot turn the service into an SSRF pivot inside the private
   * network.
   *
   * That default is correct everywhere the service is DEPLOYED, and wrong on a
   * developer's machine: the local compose stack addresses every consumer by
   * SERVICE NAME on a bridge network, so every callback target resolves to
   * 172.16/12 (or 10/8) and the whole async surface becomes undeliverable.
   * Setting this to `1`/`true` re-allows exactly those local ranges —
   * loopback, RFC1918 and IPv6 ULA, plus their IPv4-mapped forms.
   *
   * What it does NOT relax, at any value:
   *   - link-local `169.254.0.0/16` (the cloud metadata endpoint lives there)
   *     and IPv6 `fe80::/10`;
   *   - `0.0.0.0/8` and the IPv6 unspecified address;
   *   - the scheme allowlist (https everywhere; http only outside production).
   * No container is ever reachable at those, so relaxing them would buy a
   * developer nothing and hand an attacker the instance-credentials endpoint.
   *
   * 🔴 Set it ONLY in local compose config (`.env.docker`). Leave it unset in
   * dev/stage/prod — a deployed consumer's callback target is a public
   * hostname. Boot logs a warning whenever it is on (see `warnIfCallbackGuardRelaxed`).
   */
  CALLBACK_ALLOW_PRIVATE: z
    .enum(['true', 'false', '0', '1'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * How long a SIGTERM'd process lets its in-flight jobs finish before it
   * aborts them.
   *
   * On the signal the workers stop taking new jobs immediately. Whatever is
   * already running gets this window to complete on its own. Past it, each
   * survivor is aborted through the same AbortController the `/cancel` fast
   * path uses, so it ends as a NAMED terminal job (`shutdown`, distinct from
   * the reaper's `worker_lost`) with its partial cost billed, its parent rolled
   * up and its callback fired — rather than being killed mid-flight and left at
   * `running` for the reaper to find minutes later.
   *
   * 🔴 THE PLATFORM'S STOP GRACE MUST EXCEED THIS. Docker (and Coolify on top
   * of it) waits 10 SECONDS after SIGTERM and then SIGKILLs — shorter than this
   * default, and a SIGKILL is precisely the ungraceful death this window
   * exists to avoid. An image cannot raise its own stop timeout; it is set by
   * whoever runs the container (`docker run --stop-timeout`,
   * `stop_grace_period` in compose, the platform's setting). Either raise it
   * there to comfortably more than this value, or lower this value to fit.
   * See the `STOPSIGNAL` block in the Dockerfile.
   *
   * CAPPED AT 5 MINUTES so that note stays enforceable. The cap is not a
   * property of the shutdown code — it is the largest window we are willing to
   * ask any platform to wait, and nothing above it can be honoured: Docker's
   * own default stop timeout is 10s, compose's `stop_grace_period` is 10s
   * (see docker-compose.yml), and Coolify inherits Docker's. A value the
   * platform will not wait for is not a longer grace, it is a SIGKILL at the
   * platform's number with this file claiming otherwise. Zod refuses it at
   * boot, where the operator is still looking, instead of letting the next
   * redeploy discover it as a truncated shutdown.
   */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
});

/** The parsed schema, with `LLM_ASYNC_REQUEST_TIMEOUT_MS`'s inherited default resolved. */
export type Env = Omit<z.infer<typeof envSchema>, 'LLM_ASYNC_REQUEST_TIMEOUT_MS'> & {
  LLM_ASYNC_REQUEST_TIMEOUT_MS: number;
};

// ── EMPTY STRING IS NOT A VALUE ─────────────────────────────────────────────
//
// A deploy platform hands a variable that was cleared in the UI to the process
// as `""`, not as "absent". Zod sees a present value and parses it, so `""`
// takes two different wrong turns depending on the var:
//
//   · a numeric knob with `z.coerce` — `Number('') === 0`. Every
//     `.nonnegative()` timeout in this file therefore ACCEPTS an empty string
//     and silently becomes 0. `RERANK_TIMEOUT_MS=` is not "use the 5s default",
//     it is "time out immediately, forever", and nothing logs.
//     (`.positive()` knobs like `PORT` fail the parse instead, which at least
//     exits — but exits with `Invalid input` and no clue that the var was blank.)
//
//   · a REQUIRED var — `DATABASE_URL=` fails the url check and exits 1, but
//     the message is a generic `Invalid url` inside a `fieldErrors` dump. The
//     one fact an operator needs — "you set it to nothing" — is not in it.
//
// The rule this layer imposes, and its two halves:
//   1. numeric/boolean var that ACCEPTS being unset ⇒ `""` means unset. The
//      schema default applies and ONE warning names the var, so the fallback
//      is visible in the boot log rather than inferred later from behaviour.
//   2. required var (no default, not optional) ⇒ `""` REFUSES the boot, naming
//      the var, through the same fatal path as any other invalid config.
//
// 🔴 STRING vars are DELIBERATELY UNTOUCHED. `EMBEDDING_MODEL=` and
// `OPENROUTER_API_KEY=` keep parsing to `''` exactly as they do today —
// `validateProductionReadiness` already reads the empty key as missing, and
// widening this layer to strings would change what several call sites see.
// This is a fix for the silent-coercion class only. Do not generalise it
// without re-reading every `env.<STRING_VAR>` read site.

/**
 * Does this field accept being absent — i.e. does it carry a `.default()` or a
 * `.optional()`?
 *
 * Probed rather than declared. A hand-maintained list of "vars with defaults"
 * is a second copy of the schema and rots the first time a default is added;
 * asking the field itself cannot drift.
 */
function acceptsUnset(field: z.ZodType): boolean {
  return field.safeParse(undefined).success;
}

/**
 * Is this field a NUMERIC or BOOLEAN knob (as opposed to a string/enum/url)?
 *
 * Probed by parsing `'1'` and looking at the OUTPUT type: the coercing numeric
 * fields yield `1`, the `z.enum(['true','false','0','1']).transform(...)` flags
 * yield `true`, and every string, url, enum and the `API_KEYS` JSON transform
 * either yields a string or rejects. That keeps the classification tied to what
 * the field actually does with a value instead of to how it was spelled.
 */
function isScalarKnob(field: z.ZodType): boolean {
  const probe = field.safeParse('1');
  return probe.success && (typeof probe.data === 'number' || typeof probe.data === 'boolean');
}

/** The two classes, computed once from the schema at module load. */
const ENV_FIELDS = envSchema.shape as Record<string, z.ZodType>;
const EMPTY_MEANS_UNSET: readonly string[] = Object.keys(ENV_FIELDS).filter(
  (k) => acceptsUnset(ENV_FIELDS[k]!) && isScalarKnob(ENV_FIELDS[k]!),
);
const REQUIRED_VARS: readonly string[] = Object.keys(ENV_FIELDS).filter(
  (k) => !acceptsUnset(ENV_FIELDS[k]!),
);

export interface EnvPreprocessResult {
  /** The source, with empty scalar knobs deleted so their default applies. */
  values: Record<string, unknown>;
  /** One line per numeric/boolean var that was blank and fell back. */
  warnings: string[];
  /** One line per REQUIRED var that was blank. Non-empty ⇒ refuse the boot. */
  fatals: string[];
}

/**
 * Apply the empty-string rule to a raw environment.
 *
 * Pure and exported so the two classes can be tested without booting a process
 * or stubbing `process.exit`. `env` below is the only production caller.
 */
export function preprocessEnv(
  source: Record<string, string | undefined>,
): EnvPreprocessResult {
  const values: Record<string, unknown> = { ...source };
  const warnings: string[] = [];
  const fatals: string[] = [];

  for (const name of REQUIRED_VARS) {
    if (source[name] === '') {
      fatals.push(
        `${name} is set but EMPTY. It is required and has no default — an empty ` +
          `string is not a value. Set it in the deploy environment, or unset it ` +
          `entirely if you expected a fallback (there is none).`,
      );
    }
  }

  for (const name of EMPTY_MEANS_UNSET) {
    if (source[name] !== '') continue;
    delete values[name];
    warnings.push(
      `${name} is set but EMPTY; reading it as UNSET and using the built-in ` +
        `default. An empty numeric var would otherwise coerce to 0.`,
    );
  }

  return { values, warnings, fatals };
}

export const env: Env = (() => {
  // 🔴 BEFORE `safeParse`, on purpose. The required-var check has to run while
  // the ORIGINAL string is still visible: once Zod has turned `DATABASE_URL=''`
  // into an `Invalid url` issue, "it was blank" is no longer recoverable from
  // the error, and that is the whole message an operator needs.
  const { values, warnings, fatals } = preprocessEnv(process.env);
  if (fatals.length > 0) {
    console.error(
      'FATAL: environment variable(s) set to an empty string:\n  ' + fatals.join('\n  '),
    );
    process.exit(1);
  }
  for (const w of warnings) console.warn(w);

  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  // Boot guard (MED #3): `SPARSE_DIM` is pinned to the `chunks.sparse_embedding`
  // column width, which is a hardcoded `sparsevec(250002)`. Overriding it
  // without a matching column re-cut migration would make every sparse literal
  // cast to the wrong dimension and fail the DB query at runtime (ingest UPDATE
  // and hybrid retrieve). Refuse to boot on a mismatch instead of surfacing it
  // at the first sparse op — this fires regardless of `SPARSE_ENABLED` because a
  // wrong value is always a misconfiguration for the fixed-width column.
  if (parsed.data.SPARSE_DIM !== SPARSE_VOCAB_DIM) {
    console.error(
      `FATAL: SPARSE_DIM=${parsed.data.SPARSE_DIM} does not match the ` +
        `chunks.sparse_embedding column width (${SPARSE_VOCAB_DIM}, bge-m3 XLM-RoBERTa vocab). ` +
        `This knob MUST equal the fixed sparsevec column dimension — changing it requires a ` +
        `column re-cut migration. Unset SPARSE_DIM (it defaults to ${SPARSE_VOCAB_DIM}) or ` +
        `restore it to ${SPARSE_VOCAB_DIM}.`,
    );
    process.exit(1);
  }
  return {
    ...parsed.data,
    LLM_ASYNC_REQUEST_TIMEOUT_MS:
      parsed.data.LLM_ASYNC_REQUEST_TIMEOUT_MS ?? parsed.data.LLM_REQUEST_TIMEOUT_MS,
  };
})();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * The PARSED `RERANK_PROVIDER` values, as a type — after the `cohere` alias is
 * normalised away, so it is `'rerank-api' | 'deepinfra'`. Anything keyed on it
 * (the adapter table, test fixture tables) needs one entry per wire, not one
 * per spelling.
 */
export type RerankProviderName = typeof env.RERANK_PROVIDER;

/**
 * Rerank providers that are HOSTED, and therefore cannot work without a
 * credential.
 *
 * Lives here rather than beside the wire adapters in `rerank-client.ts` for one
 * structural reason: `rerank-client.ts` imports THIS module, so the dependency
 * only runs one way. Putting the policy there and reading it here would make
 * the config module import the whole rerank stack to answer a boot question.
 *
 * `rerank-api` is absent deliberately — that value also covers the unauthenticated
 * self-hosted sibling `rerank-service/`, which is the common case locally, and
 * demanding a fake credential for it would be worse than the 401 a
 * misconfigured hosted Cohere/Jina deployment gets.
 */
const RERANK_PROVIDERS_REQUIRING_API_KEY: ReadonlySet<string> = new Set<RerankProviderName>([
  'deepinfra',
]);

/** Whether `provider` refuses to work without `RERANK_API_KEY`. */
export function rerankProviderRequiresApiKey(provider: RerankProviderName): boolean {
  return RERANK_PROVIDERS_REQUIRING_API_KEY.has(provider);
}

/**
 * The rerank models this service may send traffic to under `deepinfra`. A CODE
 * constant, not env, on purpose (ruling R3/R9): dev and demo-1 share
 * one env, so an env allowlist is one edit away from being whatever the last
 * person typed. Fail-closed — a model not listed here is refused at boot (when
 * the rung is live), per request (400), and in `callRerank` before any network.
 *
 * CRITERION TO ADD A MODEL: its DeepInfra model page carries the "Zero
 * retention" badge, AND a live call to it returned 200. Google and Anthropic
 * models VOID DeepInfra's no-training and no-sharing terms ("except when using
 * Google or Anthropic models" — quoted from DeepInfra's data-privacy docs,
 * see the aiinfra rerank-pii-egress handoff §10.3), so they never
 * qualify, badge or not.
 */
export const DEEPINFRA_RERANK_MODELS: ReadonlySet<string> = new Set(['Qwen/Qwen3-Reranker-0.6B']);

/**
 * Why `model` may not be used as a rerank model on `provider`, or `undefined`
 * when it may. The allowlist covers ONLY `deepinfra`. `rerank-api` is the
 * Cohere-style wire, not a place: it serves the self-hosted sibling
 * `rerank-service/` (nothing leaves the perimeter) AND any hosted Cohere, Jina
 * or Voyage endpoint a `RERANK_URL` points at (see `rerankApiAdapter` in
 * `rerank-client.ts`). A hosted `rerank-api` URL therefore sends the pool to a
 * third party with NO model check here — a known gap, tracked in the vault at
 * plan/tecnología/prompts/open/HANDOFF-aiinfra-backlog-run.md
 * (not in this repo).
 */
export function rerankModelRefusal(provider: RerankProviderName, model: string): string | undefined {
  if (provider !== 'deepinfra') return undefined;
  if (DEEPINFRA_RERANK_MODELS.has(model)) return undefined;
  return (
    `rerank model "${model}" is not in the DeepInfra allowlist ` +
    `(${[...DEEPINFRA_RERANK_MODELS].join(', ')}).`
  );
}

/**
 * Boot probe for the rerank ENDPOINT — that `RERANK_URL` and `RERANK_MODEL`
 * together can actually address a model on the configured provider.
 *
 * Separate from the credential probe because these are different deployment
 * mistakes with different fixes, and the fail-safe hides both identically. Two
 * cases, both MEASURED against the live DeepInfra API:
 *
 *   - `RERANK_URL` given as a full `/v1/inference/...` URL under `deepinfra`.
 *     The adapter appends the model to the base, so a full URL yields
 *     `.../v1/inference/X/v1/inference/Y` and 404s every call.
 *   - `RERANK_MODEL` not in `DEEPINFRA_RERANK_MODELS` under `deepinfra`. This
 *     used to match only this repo's self-hosted default
 *     `baai/bge-reranker-v2-m3`, which DeepInfra does NOT host (both spellings
 *     return 404 `{"detail":{"error":"Model is not available"}}`, while
 *     `Qwen/Qwen3-Reranker-0.6B` returns 200). The allowlist subsumes that case
 *     and also refuses a model that WOULD answer but voids the data terms.
 *
 * Fatal only when the rung is LIVE, matching `validateRerankCredential`.
 */
export function validateRerankEndpoint(): void {
  if (env.RERANK_PROVIDER !== 'deepinfra') return;

  const live = env.RERANK_ENABLED && Boolean(env.RERANK_URL);
  const problems: string[] = [];

  if (env.RERANK_URL && /\/v1\/inference\//.test(env.RERANK_URL)) {
    problems.push(
      'RERANK_URL must be the DeepInfra API BASE (e.g. https://api.deepinfra.com) — ' +
        'the model path is appended from RERANK_MODEL. A full inference URL 404s every call.',
    );
  }
  const modelRefusal = rerankModelRefusal(env.RERANK_PROVIDER, env.RERANK_MODEL);
  if (modelRefusal) {
    problems.push(
      `RERANK_MODEL: ${modelRefusal} A model outside it either 404s (DeepInfra does not host ` +
        'it) or voids the no-training/no-sharing terms. Add a model in code, not env.',
    );
  }
  if (problems.length === 0) return;

  const detail = problems.join(' ');
  if (live) {
    console.error(
      `FATAL: rerank endpoint is unusable. ${detail} Refusing to start — the rung fails safe, so a ` +
        'broken endpoint would silently return the un-reranked order.',
    );
    process.exit(1);
  }
  console.warn(
    `${detail} The rung is currently dark, so this is not fatal yet — it becomes a boot failure ` +
      'the moment rerank is switched on.',
  );
}

/**
 * Boot probe for the rerank credential.
 *
 * 🔴 WHY THIS IS FATAL RATHER THAN A WARN, AND FATAL IN EVERY ENVIRONMENT:
 * the rerank rung FAILS SAFE. An unauthenticated hosted reranker 401s, the 401
 * is swallowed into the fused order, and the resulting response is
 * byte-identical to `rerank: false` minus `rerankScore`. There is no output a
 * consumer could read to notice. So the deployment that would silently never
 * rerank must not be allowed to start — and since `dev` is where that
 * configuration gets written and copied to stage, warning there and exiting
 * only in production would let the broken shape through the one environment
 * that could have caught it.
 *
 * SCOPE: fatal ONLY when the rung is actually live (`RERANK_ENABLED` and a
 * `RERANK_URL`). A dark seam with a half-written provider config is a
 * half-finished deploy, not a lie about retrieval quality, so that warns.
 */
export function validateRerankCredential(): void {
  const provider = env.RERANK_PROVIDER;
  if (!rerankProviderRequiresApiKey(provider)) return;
  if (env.RERANK_API_KEY?.trim()) return;

  const live = env.RERANK_ENABLED && Boolean(env.RERANK_URL);
  const detail =
    `RERANK_PROVIDER=${provider} requires a credential and RERANK_API_KEY is missing or empty. ` +
    'A hosted reranker without one 401s on every call, and the rerank rung fails safe, ' +
    'so retrieval would silently return the un-reranked order forever.';

  if (live) {
    console.error(
      `FATAL: ${detail} Refusing to start — set RERANK_API_KEY, or set RERANK_PROVIDER to one that needs no key.`,
    );
    process.exit(1);
  }
  console.warn(
    `${detail} The rung is currently dark (RERANK_ENABLED/RERANK_URL), so this is not fatal yet — ` +
      'it becomes a boot failure the moment rerank is switched on.',
  );
}

/**
 * Startup probe for production-only required configuration.
 *
 * Decisions §5 flagged a tech-debt item: missing/invalid `OPENROUTER_API_KEY`
 * surfaces at first LLM call, not at boot. This probe shifts that failure left
 * so a misconfigured production deploy refuses to listen instead of accepting
 * traffic and then 500ing hours later on the first generate call.
 *
 * Behaviour:
 *   - production + missing/empty key  -> fatal error, process.exit(1).
 *   - dev/test    + missing/empty key -> console.warn only (some test setups
 *     mock the HTTP layer and intentionally run without a real key).
 *   - any env     + wrong prefix       -> console.warn only (a fake key like
 *     `sk-or-test` is a legitimate local-testing pattern).
 *
 * Call from `src/index.ts` BEFORE `buildServer()` so the HTTP listener never
 * binds on a broken prod config.
 */
export function validateProductionReadiness(): void {
  // 🔴 FIRST, above every early return below. The OPENROUTER_API_KEY branch
  // RETURNS on a missing key (legitimate in dev/test), so anything sequenced
  // after it is skipped in exactly the environments that run without one — a
  // gate that silently does not fire is worse than no gate.
  refuseRemovedMockFlags();
  validateRerankCredential();
  validateRerankEndpoint();

  const key = env.OPENROUTER_API_KEY?.trim() ?? '';

  if (!key) {
    if (env.NODE_ENV === 'production') {
      console.error(
        'FATAL: OPENROUTER_API_KEY is missing or empty in production. ' +
          'Refusing to start — set the key in the deploy environment and retry.',
      );
      process.exit(1);
    }
    console.warn(
      'OPENROUTER_API_KEY is not set. LLM calls will fail at runtime. ' +
        'This is fine for unit tests that mock HTTP; set the key in .env.local for live calls.',
    );
    return;
  }

  if (!key.startsWith('sk-or-v1-')) {
    console.warn(
      'OPENROUTER_API_KEY does not start with the expected `sk-or-v1-` prefix. ' +
        'This may be intentional (e.g. a fake key for local testing) but live OpenRouter calls will fail.',
    );
  }

  validateProductionSafetyFlags();
}

/**
 * Names of the environment switches that are development affordances only, and
 * that must never be present in a production deploy.
 *
 * Each entry pairs the variable with what it disarms, so the fatal message can
 * say why the boot was refused rather than only which name was found.
 */
const PRODUCTION_FORBIDDEN_FLAGS: ReadonlyArray<{ name: string; effect: string }> = [
  {
    name: 'CALLBACK_ALLOW_PRIVATE',
    effect:
      'disables the callback SSRF guard, letting any tenant key aim a signed callback ' +
      'at loopback/private/ULA addresses on the internal network',
  },
];

/**
 * Is this raw `process.env` value an "on" setting?
 *
 * Deliberately wider than the readers themselves. `CALLBACK_ALLOW_PRIVATE`
 * accepts `true|false|0|1` through the Zod schema, and a removed mock flag has
 * no reader left at all. Neither has any legitimate production use, so the
 * mere PRESENCE of a non-off value is the defect we refuse to boot on — that
 * also keeps the guard correct if a read site ever widens what it accepts.
 */
function isFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === '') return false;
  // `n` is spelled out here alongside `no` because a bare `N` is a common way
  // to write "off" and would otherwise read as ON. Its counterpart `y` needs no
  // entry: anything not in this list is already ON, which is the safe default.
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no' && v !== 'n';
}

/**
 * The in-service mock switches removed. They no longer do
 * anything, so a deploy or CI job still setting one is misconfigured in a
 * dangerous direction: it expects free fake output and would get real, billed
 * provider calls. Refused in EVERY environment, not only production.
 */
export const REMOVED_MOCK_FLAGS: readonly string[] = ['MOCK_LLM', 'MOCK_EMBEDDINGS', 'MOCK_LLM_STREAM'];

/**
 * Startup probe: refuse to boot while a removed mock switch is still set.
 * Runs in every environment. Tests and consumer e2e use the TEST-ONLY fake
 * provider instead (`test-support/fake-provider/README.md`).
 */
export function refuseRemovedMockFlags(): void {
  const offenders = REMOVED_MOCK_FLAGS.filter((name) => isFlagOn(process.env[name]));
  if (offenders.length === 0) return;
  console.error(
    `FATAL: ${offenders.join(', ')} ${offenders.length === 1 ? 'was' : 'were'} removed on 2026-10-02 ` +
      'and no longer fake anything — with it set, model calls would be REAL and billed. ' +
      'Unset it. For tests, run the fake provider (test-support/fake-provider/ in the ' +
      'ai-service repo) and point CHAT_COMPLETIONS_URL and EMBEDDINGS_URL at it.',
  );
  process.exit(1);
}

/**
 * Startup probe: refuse to boot a production process that carries a
 * development-only safety switch.
 *
 * ⚠ This reads `process.env` DIRECTLY rather than the parsed `env` object,
 * so a new flag only has to be added to `PRODUCTION_FORBIDDEN_FLAGS`, not to
 * the schema.
 *
 * Behaviour:
 *   - production + any flag on -> fatal error naming every offending variable,
 *     `process.exit(1)`.
 *   - dev/test    + any flag on -> silent here; `warnIfCallbackGuardRelaxed`
 *     still warns for the SSRF switch.
 */
export function validateProductionSafetyFlags(): void {
  if (env.NODE_ENV !== 'production') return;

  const offenders = PRODUCTION_FORBIDDEN_FLAGS.filter((f) => isFlagOn(process.env[f.name]));
  if (offenders.length === 0) return;

  console.error(
    'FATAL: development-only environment flags are set in production. ' +
      'Refusing to start — unset them in the deploy environment and retry. ' +
      `Offending: ${offenders.map((f) => `${f.name} (${f.effect})`).join('; ')}`,
  );
  process.exit(1);
}

/**
 * Startup probe: shout when the callback SSRF guard has been relaxed.
 *
 * `CALLBACK_ALLOW_PRIVATE=1` is a local-development affordance (see the field
 * doc above). If it ever appears in a deployed environment, any tenant key can
 * aim a signed callback at a sibling service on the internal network, so the
 * fact has to be visible in the boot log rather than only in a Coolify env
 * panel. We warn instead of refusing to boot: the switch is legitimate in the
 * local stack, which runs the same image.
 *
 * In production this warning is unreachable: `validateProductionSafetyFlags`
 * (called from `validateProductionReadiness`, which `src/index.ts` runs first)
 * has already exited 1 on the same variable.
 */
export function warnIfCallbackGuardRelaxed(): void {
  if (!env.CALLBACK_ALLOW_PRIVATE) return;
  console.warn(
    'CALLBACK_ALLOW_PRIVATE is ON: callback URLs resolving to loopback/private/ULA ' +
      'addresses are ALLOWED. This is intended for the local docker stack only — ' +
      'unset it in every deployed environment. Link-local/metadata targets stay blocked.',
  );
}

/**
 * Startup probe: log a warning for any `role: 'app'` API key entry that lacks
 * a `callbackSecret`. Such a key cannot receive signed callbacks.
 *
 * This stays a WARN, not a boot failure (decision D4=A in
 * PLAN-live-ingest): several app keys never send `callbackUrl` and
 * need no secret. The enforcement is at request time instead —
 * `POST /v1/ingest` with a `callbackUrl` from such a key answers 400
 * `CallbackSecretMissingError` (`assertCallbackSecretFor` in
 * `services/callbacks/emit.ts`).
 */
export function validateCallbackSecrets(): void {
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(env.API_KEYS)) {
    if (entry.role === 'app' && !entry.callbackSecret) {
      // Don't leak the raw key — surface a short fingerprint instead.
      const fingerprint = `${key.slice(0, 6)}…${key.slice(-4)}`;
      missing.push(`${fingerprint} (org=${entry.org}, project=${entry.project})`);
    }
  }
  if (missing.length > 0) {
    console.warn(
      'API_KEYS: the following app-role entries have no `callbackSecret`. ' +
        'Async callbacks for these keys will fail signature verification on the consumer side. ' +
        'Add a 32+-char `callbackSecret` per entry. ' +
        `Affected: ${missing.join(', ')}`,
    );
  }
}

/**
 * Operator-facing label for an API key. `kid` when the entry carries one, else
 * the same SHA-256-derived id that `src/plugins/auth.ts` puts on
 * `req.auth.apiKeyId` and into `registry_audit.actor_key_id`.
 *
 * The derivation is duplicated here rather than imported from
 * `plugins/auth.ts` on purpose: that module imports THIS one, and closing the
 * cycle for a one-line hash is not worth it. Keep the two in sync — both are
 * SHA-256(key) hex, first 16 chars.
 *
 * NEVER returns the raw token.
 */
export function apiKeyLabel(rawKey: string, entry: ApiKeyEntry): string {
  return entry.kid ?? createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

/**
 * Trims every configured API-key token, and REFUSES the boot when the trim
 * would have changed anything.
 *
 * The asymmetry this closes: `src/plugins/auth.ts` trims the PRESENTED bearer
 * token (`extractBearer`) and then matches it against these configured keys.
 * The configured side was never normalised, so an entry carrying a stray
 * leading or trailing space could not be matched by ANY request. The operator
 * saw a plain `401 unauthorized` — which reads as "the consumer has the wrong
 * credential" — when the real defect was a malformed env var. Cheap to
 * introduce (a copy-paste out of a secrets panel, a trailing newline in a CI
 * variable) and expensive to diagnose, because every observable signal points
 * at the consumer.
 *
 * Why refuse rather than accept the trimmed key silently: the deployed env var
 * would still hold a token that nobody can copy out correctly, so the next
 * operator to read it re-creates the mismatch somewhere the trim does not
 * reach (a consumer's own config, a runbook, a rotation). A silently "fixed"
 * key is the same footgun one step later. Refusing forces the fix at the
 * source, and the refusal is fatal in EVERY environment — a token that cannot
 * match is a defect in dev exactly as much as in prod, and boot is the only
 * moment an operator is looking.
 *
 * Two distinct problems, reported separately because the fixes differ:
 *   - PADDED    — a token that does not equal its own trim. Fix: strip the
 *     whitespace (or the empty string, which no bearer header can present).
 *   - COLLIDING — two entries that are different strings but trim to the SAME
 *     token, so one would silently shadow the other's org/project scope. A
 *     request would authenticate into a tenant the operator did not intend.
 *     Unreachable while PADDED stays fatal (a collision needs at least one
 *     padded key), but checked and messaged on its own so the guard survives
 *     the padded refusal ever being softened to a warning.
 *
 * Messages name the entry's `kid` or its derived 16-hex id via
 * {@link apiKeyLabel}, NEVER the token — a boot log is not a secret store, and
 * a malformed key is still a live credential somewhere.
 *
 * Returns the normalised map so that trimming, not merely the check, is the
 * real data path: if the refusal is ever relaxed, the keys `requireAuth`
 * matches against are already the trimmed ones.
 */
export function normaliseApiKeys(entries: Record<string, ApiKeyEntry>): {
  keys: Record<string, ApiKeyEntry>;
  problems: string[];
} {
  const problems: string[] = [];
  const keys: Record<string, ApiKeyEntry> = {};
  /** trimmed token -> label of the first entry that claimed it. */
  const claimed = new Map<string, string>();

  for (const [rawKey, entry] of Object.entries(entries)) {
    const label = apiKeyLabel(rawKey, entry);
    const trimmed = rawKey.trim();

    if (trimmed !== rawKey) {
      problems.push(
        `key ${label} (org=${entry.org}, project=${entry.project}) has leading/trailing ` +
          'whitespace in its token; the presented bearer token is trimmed, so no request ' +
          'could ever match this entry. Strip the whitespace in API_KEYS.',
      );
    }
    if (trimmed.length === 0) {
      problems.push(
        `key ${label} (org=${entry.org}, project=${entry.project}) is empty once trimmed; ` +
          'a bearer header cannot present an empty token. Remove the entry.',
      );
      continue;
    }

    const owner = claimed.get(trimmed);
    if (owner !== undefined) {
      problems.push(
        `keys ${owner} and ${label} are the same token once trimmed, so one silently ` +
          "shadows the other's org/project scope. Remove one of them.",
      );
      continue;
    }
    claimed.set(trimmed, label);
    keys[trimmed] = entry;
  }

  return { keys, problems };
}

/**
 * Has this entry's optional `expiresAt` passed?
 *
 * Entries without `expiresAt` never expire — that is every entry configured
 * before this field existed, so the answer for them must stay `false`.
 * An unparseable date is treated as NOT expired: the Zod schema already
 * rejects malformed values at boot, so reaching here with one means the object
 * bypassed validation, and failing open on a shape error is the same posture
 * the rest of `requireAuth` takes (the scope check below it is the real gate).
 */
export function isApiKeyExpired(entry: ApiKeyEntry, now: Date = new Date()): boolean {
  if (!entry.expiresAt) return false;
  const expiry = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}

/** How far ahead an expiry is called out at boot. */
export const API_KEY_EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Startup probe: one pino `warn` per API key that has already expired or that
 * expires within {@link API_KEY_EXPIRY_WARN_WINDOW_MS}.
 *
 * Warn, never crash — an expired key must not take the whole service down for
 * every other tenant; it is rejected per-request in `requireAuth` instead.
 * Lines name `kid`/`apiKeyId` and the org/project scope, never the token.
 */
export function warnOnExpiringApiKeys(now: Date = new Date(), log = bootLogger()): void {
  for (const [rawKey, entry] of Object.entries(env.API_KEYS)) {
    if (!entry.expiresAt) continue;
    const expiry = Date.parse(entry.expiresAt);
    if (Number.isNaN(expiry)) continue;
    const msLeft = expiry - now.getTime();
    if (msLeft > API_KEY_EXPIRY_WARN_WINDOW_MS) continue;
    const keyId = apiKeyLabel(rawKey, entry);
    log.warn(
      {
        keyId,
        org: entry.org,
        project: entry.project,
        expiresAt: entry.expiresAt,
        expired: msLeft <= 0,
      },
      msLeft <= 0
        ? `API_KEYS: key ${keyId} EXPIRED at ${entry.expiresAt} — requests bearing it are rejected with 401 api_key_expired. Rotate or remove the entry.`
        : `API_KEYS: key ${keyId} expires at ${entry.expiresAt} (within 7 days). Add the replacement entry now; see .env.example for the rotation recipe.`,
    );
  }
}

/** Lazily-built boot logger, so importing this module starts no transport. */
function bootLogger() {
  return pino({ name: 'boot', level: env.LOG_LEVEL });
}
