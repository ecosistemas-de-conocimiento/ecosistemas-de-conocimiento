import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const apiKeyEntry = z.object({
  org: z.string().min(1),
  project: z.string().min(1),
  /**
   * Role gates write endpoints. Defaults to `'app'` so existing entries (which
   * never had a role field) keep working — they get read-only access.
   */
  role: z.enum(['app', 'admin']).default('app'),
  /**
   * Per-consumer HMAC secret used to sign async callbacks (see
   * `plan/m3-webhook-signing-followup.md`). When absent, ai-service
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

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // JSON map of apiKey -> { org, project, role? }
  API_KEYS: z
    .string()
    .default('{}')
    .transform((raw, ctx) => {
      try {
        return z.record(apiKeyEntry).parse(JSON.parse(raw));
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'API_KEYS must be a JSON object of apiKey -> {org, project, role?}',
        });
        return z.NEVER;
      }
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
  EMBEDDING_MODEL: z.string().default('baai/bge-m3'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),

  /**
   * Rerank seam — a cross-encoder re-scoring rung that runs AFTER RRF fusion,
   * over a capped top-N pool, before the final `slice(topK)`. Config-driven and
   * OFF by default, exactly like the embeddings seam, so retrieval behaviour is
   * byte-identical until a consumer opts in (per-request `rerank: true`).
   *
   * Design + rationale: `plan/retrieval-upgrade-decisions.md`.
   *
   * `RERANK_ENABLED` — master switch. When false (default), the service NEVER
   * calls the reranker even if a request sets `rerank: true` — the request field
   * degrades to a no-op. This is the deploy-safety gate: ai-service can ship the
   * seam dark, then flip it on per environment once `RERANK_URL` has a home.
   *
   * `RERANK_URL` — the Cohere-style `POST /rerank` endpoint of the SIBLING
   * self-hosted reranker service (see `rerank-service/`). NOT OpenRouter: the
   * chosen model `baai/bge-reranker-v2-m3` is not served there. Prod self-host =
   * repoint this at the self-hosted box, no code change. Absent ⇒ rerank stays a
   * no-op even if `RERANK_ENABLED=true` (nothing to call).
   *
   * `RERANK_MODEL` — default rerank model id, overridable per-request via
   * `rerankModel`. `baai/bge-reranker-v2-m3`: open (Apache-2.0), multilingual,
   * pairs with the `bge-m3` embedder, CPU-viable at our N (20–50) and volume.
   *
   * `RERANK_TIMEOUT_MS` — per-request wall-clock cap on the reranker call. On
   * timeout (or ANY rerank error) the service FALLS BACK to the fused order and
   * never fails the query — reranking is a relevance-polish rung, not a
   * correctness gate. Default 5s.
   */
  RERANK_ENABLED: z
    .enum(['true', 'false', '0', '1'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  RERANK_URL: z.string().url().optional(),
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
   * call). Managed/self-hosted is a pure env flip, like `EMBEDDINGS_URL`.
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
   * Inactivity/stall backstop on a streaming provider call: if no delta (or any
   * SSE frame) arrives for this many ms, abort the stream. A stalled stream is
   * the more realistic hang than a slow-but-progressing one, so this default
   * (45s) is much tighter than the total cap above. Only applies to the
   * streaming adapter's read loop. Set to 0 to disable.
   */
  LLM_STREAM_STALL_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(45_000),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = (() => {
  const parsed = envSchema.safeParse(process.env);
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
  return parsed.data;
})();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

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
}

/**
 * Startup probe: log a warning for any `role: 'app'` API key entry that lacks
 * a `callbackSecret`. Per the callback contract, an app-role key consuming the
 * async endpoints (`/v1/generate`, `/v1/ingest`) cannot receive signed
 * callbacks without this secret — emission is recorded but unsigned, and the
 * receiver will reject. We log instead of crashing so existing deployments
 * (and tests) continue to boot.
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
