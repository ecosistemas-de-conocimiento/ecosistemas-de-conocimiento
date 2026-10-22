// Zod schemas for the RAG-surface request bodies on /v1/embed and /v1/retrieve.
//
// Source of truth for what crosses the wire on the RAG endpoints. Ingest-side
// schemas (`/v1/ingest`) are owned by the ingest agent and may land in this
// file too or in `src/contract/ingest.ts` — keep both shapes additive.

import { z } from './zod.js';

import { isValidTextSearchConfig } from '../services/rag/language.js';

/**
 * A wire `language` field — a Postgres text-search config (`regconfig`) name
 * DIRECTLY: `'simple'`, `'spanish'`, `'english'`, … (Rodrigo's call: use the
 * Postgres names, not ISO locale codes). Validated against the installed
 * whitelist (`isValidTextSearchConfig`) so an unknown name can never reach
 * `::regconfig` — which would throw and brick ingest (the tsvector build) and
 * hybrid retrieve (the query parse). Stored on the corpus verbatim.
 */
export const textSearchConfigSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTextSearchConfig, {
    message:
      "language must be an installed Postgres text-search config name " +
      "(e.g. 'simple', 'spanish', 'english'), not an ISO locale code like 'es'",
  });

// ---------------------------------------------------------------------------
// Retrieve metadata `filter` — shared by /v1/retrieve and /v1/retrieve/multi.
// ---------------------------------------------------------------------------

/** The only operator the filter recognises. */
export const IN_OPERATOR = '$in';

/** Upper bound on the number of values in one `$in` set. */
export const MAX_IN_VALUES = 500;

/** True when `v` is an `{ "$in": ... }` operand rather than a containment value. */
export function isInOperand(v: unknown): v is { $in: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && IN_OPERATOR in v;
}

/** The operand of `{ key: { "$in": [...] } }`. */
const inOperandSchema = z
  .object({
    [IN_OPERATOR]: z
      .array(z.union([z.string().max(1000), z.number()]))
      .min(1)
      .max(MAX_IN_VALUES),
  })
  .strict();

/**
 * Optional opaque metadata constraint applied **before** ranking, on every
 * retrieval leg (plan/open-retrieve-metadata-filter.md §3/§4). The service
 * never interprets the keys (ADR-0001 project-agnostic). Per key, either:
 *
 *   - `"key": value` — jsonb containment (`@>`): the chunk's metadata must
 *     contain this key/value. The original behaviour.
 *   - `"key": { "$in": [v1, v2, …] }` — the chunk's `metadata.key` must equal
 *     one of the values. 1–500 values, each a string or a number.
 *
 * Keys combine with AND. Backward compatible: absent or `{}` ⇒ no clause.
 * Chunks whose `metadata IS NULL` are excluded by any non-empty filter. jsonb
 * is type-sensitive — `5` (number) does not match a stored `"5"`, in either
 * form. Any other object value (no `$in` key) is plain containment, exactly as
 * before; `$in` is the only operator.
 */
export const metadataFilterSchema = z
  .record(z.string(), z.unknown())
  .superRefine((filter, ctx) => {
    // Re-issue nested failures with the key in the message: the route joins
    // `issue.message`s only, so a bare message would not say WHICH key failed.
    for (const [key, value] of Object.entries(filter)) {
      if (isInOperand(value) && !inOperandSchema.safeParse(value).success) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `filter.${key}.$in: must be the operand's only key and hold a non-empty array of at most ${MAX_IN_VALUES} strings or numbers`,
        });
      }
    }
  })
  .openapi({
    description:
      'Metadata constraint applied before ranking. Per key: a value (jsonb containment) ' +
      `or { "$in": [...] } (1-${MAX_IN_VALUES} strings or numbers; matches when metadata[key] ` +
      'equals one of them). Keys combine with AND.',
  });

// ---------------------------------------------------------------------------
// POST /v1/retrieve — body.
// ---------------------------------------------------------------------------
// Matches `IncludeContextItem` minus the `name` recipe variant: retrieve only
// accepts an inline `{ corpus, query, topK?, mmr? }`.

export const retrieveRequestSchema = z
  .object({
    corpus: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().min(1).max(50).default(10),
    mmr: z.number().min(0).max(1).optional(),
    /**
     * Optional metadata constraint applied **before** ranking, on every leg.
     * Per key: a value ⇒ jsonb containment (`@>`); `{ "$in": [v1, …] }` ⇒
     * `metadata[key]` equals one of 1–500 strings/numbers. Keys AND together.
     * Absent or `{}` ⇒ no clause. NULL metadata never matches a non-empty
     * filter; jsonb is type-sensitive (`5` ≠ `"5"`). `$in` needs the
     * `metadataFilterIn` capability. See `metadataFilterSchema`.
     */
    filter: metadataFilterSchema.optional(),
    /**
     * Point-in-time constraint, ISO-8601. When present, only chunks whose
     * validity interval contains `asOf` are eligible — applied as a SQL
     * predicate on the candidate set, alongside `filter` and BEFORE any
     * ranking, so a superseded chunk can never displace a current one and can
     * never appear in the result.
     *
     * Chunks with no validity bounds (the default, and every chunk ingested
     * before migration 0012) are ALWAYS eligible: an unbounded interval
     * contains every instant. That is what keeps this additive — a corpus
     * that never sets validity behaves identically with and without `asOf`.
     *
     * Absent ⇒ no temporal predicate at all (today's behaviour).
     */
    asOf: z.string().datetime({ offset: true }).optional(),
    /**
     * Ranking mode.
     *   - `dense` (default): cosine top-K over the embedding index. Identical
     *     to the behaviour before this parameter existed.
     *   - `hybrid`: run a dense leg AND a lexical (`tsvector`/`ts_rank_cd`)
     *     leg over the same filtered candidate set, then fuse with Reciprocal
     *     Rank Fusion. Fixes exact-identifier queries — codes, numbered
     *     references, any short literal token — which dense embeddings
     *     systematically miss because those tokens carry almost no
     *     distributional signal.
     *
     * NOTE FOR CONSUMERS: in `hybrid` mode `score` is an RRF score (small,
     * typically 0.01–0.05), NOT a cosine similarity. Any consumer that
     * thresholds on `score` must read `denseScore` instead, which is still the
     * cosine value when the chunk was found by the dense leg. This is why
     * hybrid is opt-in rather than the default.
     */
    mode: z.enum(['dense', 'hybrid']).optional(),
    /**
     * RRF damping constant. Higher = flatter fusion (rank differences matter
     * less). 60 is the value from the original RRF paper and a good default;
     * exposed for eval sweeps, not for routine use. Ignored unless
     * `mode: 'hybrid'`.
     */
    rrfK: z.number().int().min(1).max(1000).optional(),
    /**
     * Opt into cross-encoder reranking. After retrieval (dense or hybrid+RRF),
     * a capped top-N pool is re-scored by a cross-encoder (self-hosted
     * `bge-reranker-v2-m3` behind the `RERANK_URL` seam) and re-ordered before
     * the final top-K slice, surfacing `rerankScore` on each chunk.
     *
     * NO-OP unless the SERVER has `RERANK_ENABLED=true` and a configured
     * `RERANK_URL`: on any environment where rerank isn't wired, `rerank: true`
     * degrades to the un-reranked order. FAILS SAFE to the fused order on any
     * rerank error/timeout — reranking is a relevance-polish rung, never a
     * correctness gate, so it must not turn a slow reranker into a failed
     * query. Neither is silent: the response carries a `RERANK_DEGRADED`
     * entry in `warnings` naming the reason, and `legs` omits `rerank`.
     *
     * Mutually exclusive with `mmr`: if both are set, rerank wins and `mmr` is
     * ignored (they optimise opposite things — relevance vs diversity — so
     * chaining them doubles cost for murky benefit).
     *
     * ⚠ CONSUMERS: when rerank is on, `score` is the cross-encoder score
     * (typically a 0–1 sigmoid), a different scale again from RRF and cosine.
     * Threshold on `rerankScore` (== `score` here), not on `denseScore`.
     */
    rerank: z.boolean().optional(),
    /**
     * Override the rerank model for this request (for A/B). Absent ⇒ the
     * server's `RERANK_MODEL`. Only USED when `rerank` is set, but always
     * CHECKED: under `RERANK_PROVIDER=deepinfra` a model outside the server's
     * rerank allowlist is a 400 even when `rerank` is absent or false
     * (fail-closed — a refused model is refused, not silently ignored).
     */
    rerankModel: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RetrieveRequestInput = z.infer<typeof retrieveRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/retrieve/multi — body.
// ---------------------------------------------------------------------------
// Multi-corpus retrieval with score fusion + an OPTIONAL cheap query-rewrite
// step. This is the project-agnostic MACHINERY behind a chat/RAG assistant's
// "search across everything relevant" turn:
//
//   1. (optional) rewrite an anaphoric follow-up into a standalone query using
//      conversation history + the cheapest LLM tier — CONTENT-agnostic: the
//      service ships zero prompt wording, the CONSUMER passes the entire rewrite
//      instruction (its locale, its phrasing) in `rewrite.instruction`.
//   2. fan out `/v1/retrieve` across every `corpora[]` name in parallel, scoped
//      to the caller's `(org, project)` — same tenant as single retrieve.
//   3. merge the per-corpus matches by `score`, dedupe by chunk, cap at `limit`,
//      and tag each chunk with the `corpus` it came from (for citations).
//
// A missing or erroring corpus never fails the whole request: it contributes
// zero chunks and is recorded in the `corpora` diagnostics of the response, so
// one down corpus can't kill a turn.

/** A conversation turn passed to the rewrite step. Ordered oldest → newest. */
export const chatTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().min(1),
  })
  .strict();
export type ChatTurnInput = z.infer<typeof chatTurnSchema>;

/**
 * The rewrite (query-condensation) directive. Optional on the request; when
 * present the service rewrites `query` into a standalone search query BEFORE
 * fan-out, and FAILS SAFE to the raw `query` on the first turn (no history) or
 * any error. `instruction` carries ALL natural language — the service adds none.
 */
export const retrieveRewriteSchema = z
  .object({
    /**
     * Consumer-owned system instruction for the rewrite (e.g. "rewrite the last
     * question as a standalone search query, resolving pronouns; answer with only
     * the query, in the same language"). The service passes this through verbatim
     * as the rewrite call's system message — locale and wording stay with the
     * consumer (ADR-0001 / content-agnostic).
     */
    instruction: z.string().min(1).max(4000),
    /**
     * Conversation turns (oldest → newest), EXCLUDING the current question. Only
     * the last few non-system turns are used. Absent/empty ⇒ nothing to resolve
     * ⇒ the raw `query` is used unchanged.
     */
    history: z.array(chatTurnSchema).max(50).optional(),
    /** Output token cap for the rewrite. Default 80 — a rewritten query is short. */
    maxTokens: z.number().int().min(1).max(400).optional(),
  })
  .strict();
export type RetrieveRewriteInput = z.infer<typeof retrieveRewriteSchema>;

export const retrieveMultiRequestSchema = z
  .object({
    /** Corpus names to fan out across, all under the caller's `(org, project)`. */
    corpora: z.array(z.string().min(1)).min(1).max(20),
    query: z.string().min(1),
    /** Per-corpus fetch depth. Default 10 — matches single `/v1/retrieve`. */
    topK: z.number().int().min(1).max(50).default(10),
    /** Final cap on the fused, deduped result. Absent ⇒ `topK`. */
    limit: z.number().int().min(1).max(100).optional(),
    /** Forwarded to every per-corpus retrieve — see `retrieveRequestSchema`. */
    mmr: z.number().min(0).max(1).optional(),
    filter: metadataFilterSchema.optional(),
    /**
     * Per-corpus metadata filter, keyed by a name in `corpora`. For a corpus
     * listed here, its entry REPLACES `filter` for that corpus only (no
     * merging — repeat any shared keys you still want). Corpora not listed
     * use `filter` as before. Same shape and validation as `filter`.
     *
     * Use case: a shared corpus searched unfiltered plus a per-user corpus
     * restricted to an allowed set, in ONE fused hybrid call:
     * `{ corpora: ['shared', 'drafts'],
     *    corpusFilters: { drafts: { docId: { $in: ['12', '34'] } } } }`.
     *
     * A key that is not in `corpora` is a 400: a typo would otherwise retrieve
     * that corpus UNFILTERED. Older servers reject this field (the schema is
     * strict) — require the `metadataFilterIn` capability before sending it.
     */
    corpusFilters: z.record(z.string().min(1), metadataFilterSchema).optional(),
    asOf: z.string().datetime({ offset: true }).optional(),
    mode: z.enum(['dense', 'hybrid']).optional(),
    rrfK: z.number().int().min(1).max(1000).optional(),
    /**
     * Opt into cross-encoder reranking, applied **once, AFTER cross-corpus
     * fusion** — not per corpus. The fan-out fuses every leg by score and
     * dedupes; the reranker then re-scores a capped top-N pool of those fused
     * candidates and re-orders before the final `limit`, surfacing
     * `rerankScore` on each returned chunk.
     *
     * FUSION CAVEAT (why this is a distinct design from single `/v1/retrieve`):
     * the pool the reranker sees is drawn from MULTIPLE corpora. That is fine —
     * a cross-encoder scores each (query, chunk-text) pair on its own, with no
     * dependence on which corpus the chunk came from — but it does mean the
     * reranker, not per-corpus score, decides the final head order across
     * corpora. `corpus` provenance is preserved on every returned chunk.
     *
     * NO-OP unless the SERVER has `RERANK_ENABLED=true` and a configured
     * `RERANK_URL`: where rerank isn't wired, `rerank: true` degrades to the
     * fused order. FAILS SAFE to the fused order on any rerank error/timeout —
     * never a 500. Either way the response says so: a `RERANK_DEGRADED`
     * warning, and no `rerank` in `legs`.
     *
     * Mutually exclusive with `mmr`: when rerank is active, `mmr` is NOT
     * forwarded to the per-corpus legs (rerank wins, mirroring single
     * `/v1/retrieve`). They optimise opposite things — relevance vs diversity.
     *
     * ⚠ CONSUMERS: when rerank is on, `score` is the cross-encoder score
     * (typically a 0–1 sigmoid), a different scale again from RRF and cosine.
     * Threshold on `rerankScore` (== `score` here), not on `denseScore`.
     */
    rerank: z.boolean().optional(),
    /**
     * Override the rerank model for this request (for A/B). Absent ⇒ the
     * server's `RERANK_MODEL`. Only USED when `rerank` is set, but always
     * CHECKED: under `RERANK_PROVIDER=deepinfra` a model outside the server's
     * rerank allowlist is a 400 even when `rerank` is absent or false
     * (fail-closed — a refused model is refused, not silently ignored).
     */
    rerankModel: z.string().min(1).max(200).optional(),
    /** Optional query-rewrite directive — see `retrieveRewriteSchema`. */
    rewrite: retrieveRewriteSchema.optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.corpusFilters === undefined) return;
    const requested = new Set(req.corpora);
    for (const name of Object.keys(req.corpusFilters)) {
      if (!requested.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['corpusFilters', name],
          message: `corpusFilters.${name}: not one of the requested corpora`,
        });
      }
    }
  });
export type RetrieveMultiRequestInput = z.infer<typeof retrieveMultiRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/embed — body.
// ---------------------------------------------------------------------------
// `model` defaults to `env.EMBEDDING_MODEL` (the open multilingual `baai/bge-m3`)
// at the route level. `input` is a string or array of strings; OpenRouter caps
// batch sizes around 2048.

export const embedRequestSchema = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string().min(1), z.array(z.string().min(1)).max(2048)]),
  })
  .strict();
export type EmbedRequestInput = z.infer<typeof embedRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/ingest — body. Decisions §13 (text-only) + §15 (id dedupe).
// ---------------------------------------------------------------------------
// Caps: ≤100 docs/batch, ≤1MB text per doc, ≤200 chars on the consumer id.
// The route hands the parsed shape directly to `IngestService.ingestBatch`.

/**
 * Chunking configuration a CONSUMER supplies for its own documents.
 *
 * This is the project-agnostic seam for structural chunking: ai-service owns
 * the splitter, the consumer owns the patterns, because only the consumer
 * knows what its documents look like. The service ships no named presets —
 * a preset would be this repo asserting a document convention it has no
 * business knowing (ADR-0001).
 *
 * Shape (all `pattern` values are JS regex SOURCE, applied with `gm` forced on
 * plus whatever `flags` adds, group 1 = the identifier):
 *
 *   {
 *     "sections":    [{ "key": "section", "pattern": "^\\s*Section\\s+(\\d+)\\b", "flags": "i" }],
 *     "subSections": [{ "key": "clause",  "pattern": "^\\s*([IVX]+)[.)]\\s" }],
 *     "maxChars": 4000,   // optional, default 4000
 *     "minChars": 80      // optional, default 80
 *   }
 *
 * `sections` is the only required key. Supplying a usable config selects the
 * structural splitter for the document(s) it applies to; omitting it leaves
 * the corpus's configured strategy in force. A config that fails validation,
 * or that matches no boundary in a given document, degrades to the corpus's
 * strategy WITH A WARNING rather than failing the ingest — misconfiguration
 * must not turn a batch into a poison-pill retry loop.
 *
 * Deliberately loose (`z.record`): the detailed validation lives in
 * `parseStructuralConfig`, which is also what the worker runs, so there is one
 * validator rather than two that can disagree. Rejecting here would also make
 * every future chunk-strategy option a breaking schema change.
 */
export const chunkConfigSchema = z.record(z.string(), z.unknown());
export type ChunkConfigInput = z.infer<typeof chunkConfigSchema>;

export const ingestDocumentSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(1_000_000),
    title: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /**
     * Temporal validity of this document as a half-open interval
     * `[validFrom, validTo)`, ISO-8601 datetimes. Omit a side for "unbounded";
     * omit both (the default, and what every existing consumer sends) for
     * "always valid" — byte-identical to pre-0012 behaviour.
     *
     * These are stamped onto every chunk at ingest so `POST /v1/retrieve` can
     * take an `asOf` and drop superseded content BEFORE ranking rather than
     * after. The service assigns no meaning to the interval beyond ordering:
     * a consumer decides what supersession means in its own domain.
     *
     * To retire a document without re-embedding it, use
     * `PATCH /v1/corpus/:corpus/documents/:externalId/validity`.
     */
    validFrom: z.string().datetime({ offset: true }).optional(),
    validTo: z.string().datetime({ offset: true }).optional(),
    /**
     * Per-DOCUMENT language — a Postgres text-search config name (`'spanish'`,
     * `'english'`, `'simple'`, …), validated against the installed whitelist (a
     * bad value is rejected here, not at `to_tsvector`). Stored on the document
     * row for a FUTURE per-chunk stemming path (per-chunk regconfig + query
     * fan-out). It does NOT drive the lexical `text_search` regconfig today —
     * that is a PER-CORPUS setting (see the corpus-level `language` field
     * below), which IS live: a corpus created with `language: 'spanish'` stems
     * its lexical leg in Spanish. Per-document language is deliberately
     * orthogonal to that. Purely additive and optional.
     */
    language: textSearchConfigSchema.optional(),
    /**
     * Per-DOCUMENT chunking configuration. Overrides the batch-level
     * `chunkConfig` for this document only, which is the granularity that
     * actually matters: one corpus routinely mixes documents whose addressable
     * unit is a numbered section with documents that are ordinary prose, and a
     * corpus-level setting cannot express that.
     *
     * Same shape as the batch-level field — see `chunkConfigSchema`.
     */
    chunkConfig: chunkConfigSchema.optional(),
  })
  .strict();

/**
 * `validFrom < validTo` is checked here rather than as a Zod `.refine`, which
 * would turn `ingestDocumentSchema` into a `ZodEffects` and complicate the
 * OpenAPI registration of every schema that embeds it. Returns an error string
 * or null.
 */
export function validateValidityInterval(d: {
  validFrom?: string;
  validTo?: string;
}): string | null {
  if (d.validFrom === undefined || d.validTo === undefined) return null;
  return Date.parse(d.validFrom) < Date.parse(d.validTo)
    ? null
    : 'validFrom must be strictly before validTo';
}
export type IngestDocumentInput = z.infer<typeof ingestDocumentSchema>;

export const ingestRequestSchema = z
  .object({
    corpus: z.string().min(1).max(200),
    documents: z.array(ingestDocumentSchema).min(1).max(100),
    embeddingModel: z.string().optional(),
    /**
     * CORPUS-LEVEL default language — a Postgres text-search config
     * (`regconfig`) name DIRECTLY: `'spanish'`, `'english'`, `'simple'`, …
     * (not an ISO locale code). Stored on the corpus verbatim. This DRIVES the
     * lexical leg's stemming: a corpus created with `language: 'spanish'`
     * builds and queries its `text_search` tsvector in Spanish. Applied only
     * when the corpus is FIRST created (corpora are auto-created on first
     * ingest; an existing corpus's stored config wins — reconfigure it via
     * `PATCH /v1/corpora/:name`). Omitted ⇒ `'simple'`. Additive and optional;
     * an unknown name is rejected at validation time, before any corpus is
     * created.
     */
    language: textSearchConfigSchema.optional(),
    /**
     * Webhook POSTed at terminal-per-doc + batch-progress + batch-completion
     * transitions, signed per the callback contract
     * (`plan/tecnología/ai-infra/callback-contract.md`). The exact set of
     * events fired:
     *   - `ingest.completed` — once per successfully ingested doc
     *   - `ingest.failed`    — once per doc that failed
     *   - `ingest.progress`  — every 10 docs OR every 30s on batches >5 docs
     * Captured on the `ingest_requests` row at enqueue time so the worker can
     * dispatch without re-reading the original HTTP request.
     */
    callbackUrl: z.string().url().optional(),
    /**
     * Batch-level chunking configuration — see `chunkConfigSchema`. Applies to
     * every document in this request that does not carry its own
     * `chunkConfig`. Absent ⇒ the corpus's configured strategy, i.e.
     * byte-identical to the behaviour before this field existed.
     */
    chunkConfig: chunkConfigSchema.optional(),
  })
  .strict();
export type IngestRequestInput = z.infer<typeof ingestRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/corpus/:name/alias — body.
// ---------------------------------------------------------------------------
// Create or repoint the alias `:name` to point at the existing corpus
// `target` (same `(org, project)` scope). No re-embedding — retrieval against
// the alias name returns the target's chunks. Admin only (matches DELETE).

export const corpusAliasRequestSchema = z
  .object({
    target: z.string().min(1).max(200),
  })
  .strict();
export type CorpusAliasRequestInput = z.infer<typeof corpusAliasRequestSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/corpus/:name/documents/:externalId/validity — body.
// ---------------------------------------------------------------------------
// Retire (or un-retire) an already-ingested document without re-embedding it.
// `null` clears a bound back to unbounded; omitting a field leaves the stored
// bound untouched. At least one of the two must be present, otherwise the
// request is a no-op and almost certainly a consumer bug.

export const documentValiditySchema = z
  .object({
    validFrom: z.string().datetime({ offset: true }).nullable().optional(),
    validTo: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type DocumentValidityInput = z.infer<typeof documentValiditySchema>;

// ---------------------------------------------------------------------------
// Corpus control plane — POST /v1/corpora + PATCH /v1/corpora/:name.
// ---------------------------------------------------------------------------
// Explicit corpus lifecycle: create a corpus with its config BEFORE any data
// lands (instead of "first ingest silently wins"), and reconfigure it after.
// Auto-create-on-ingest still works — this is an additive control surface, not
// a replacement. Every knob mirrors a `corpora` column; `embeddingModel` is
// validated against its known dimension at the route (model↔dim), and
// `language` is a Postgres text-search config name (see `textSearchConfigSchema`).

/** Fields shared by create + patch — all optional here; create adds a required `name`. */
const corpusConfigFields = {
  /**
   * Embedding model to stamp on the corpus. Validated against its known vector
   * dimension at create time (a model whose dimension can't fit the live
   * `chunks.embedding` column is rejected). Omit ⇒ the service default
   * (`env.EMBEDDING_MODEL`). Changing it after data has landed is refused
   * (would invalidate the stored vectors) — that path is the future
   * re-embed-on-model-change hook.
   */
  embeddingModel: z.string().min(1).max(200).optional(),
  /**
   * Lexical text-search config — a Postgres `regconfig` name directly
   * (`'spanish'`, `'english'`, `'simple'`, …). Drives stemming on the hybrid
   * retrieve leg. Omit on create ⇒ `'simple'`.
   */
  language: textSearchConfigSchema.optional(),
  /** Chunking strategy id. Omit on create ⇒ `'recursive-char'`. */
  chunkStrategy: z.string().min(1).max(64).optional(),
  /** Target chunk size (splitter units). Omit on create ⇒ 800. */
  chunkSize: z.number().int().min(1).max(100_000).optional(),
  /** Chunk overlap. Omit on create ⇒ 100. */
  chunkOverlap: z.number().int().min(0).max(100_000).optional(),
  /** Strategy-specific options (see `chunkConfigSchema`). */
  chunkConfig: chunkConfigSchema.optional(),
  /** Opaque consumer metadata stored on the corpus row. */
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const corpusCreateSchema = z
  .object({
    /** Corpus name, unique within the caller's `(org, project)`. */
    name: z.string().min(1).max(200),
    ...corpusConfigFields,
  })
  .strict();
export type CorpusCreateInput = z.infer<typeof corpusCreateSchema>;

// PATCH: every field optional; the route rejects an empty body (no-op). `name`
// is NOT patchable — it is the identity in the path.
export const corpusUpdateSchema = z.object(corpusConfigFields).strict();
export type CorpusUpdateInput = z.infer<typeof corpusUpdateSchema>;
