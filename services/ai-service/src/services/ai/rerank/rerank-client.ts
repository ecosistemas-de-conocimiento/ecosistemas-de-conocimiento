// Rerank client — the cross-encoder re-scoring seam.
//
// INVARIANT (companion to the embeddings adapter at
// `src/services/ai/embeddings/openrouter.ts`): this is the ONLY file in the
// tree that calls `fetch(env.RERANK_URL)`. Anything that needs a rerank must
// route through here so there is a single seam for cost/trace/error handling.
//
// WHY ITS OWN ENDPOINT: the default model `baai/bge-reranker-v2-m3`
// (Apache-2.0, multilingual, pairs with `bge-m3`) is not served on OpenRouter,
// so the call goes either to a SIBLING self-hosted reranker service
// (`rerank-service/` in this repo) or to a hosted rerank API, whichever
// `RERANK_URL` names: managed/self-hosted is a pure env flip with no code
// change, exactly like the embeddings `EMBEDDINGS_URL` seam.
//
// ⚠ CORRECTION to an older comment here, which said flatly that
// OpenRouter has no rerank API. It does — `/api/v1/rerank` (QUOTED from the ZDR
// research in `plan/tecnología/prompts/open/`, not verified against the vendor). It speaks the Cohere shape, so it needs NO adapter: it is a
// `RERANK_PROVIDER=rerank-api` URL plus a key. What is true is narrower — the
// DEFAULT MODEL is not on OpenRouter, which is a model question, not an API
// one. Do not repeat the flat claim; it misleads whoever sizes the next
// provider.
//
// TWO THINGS AN ENV FLIP NEEDS THAT `RERANK_URL` ALONE DOES NOT CARRY:
//
//   1. A CREDENTIAL. Every hosted reranker is authenticated; the self-hosted
//      sibling is not. `RERANK_API_KEY` is sent as `Authorization: Bearer <key>`
//      when set and the header is OMITTED when unset — see `authHeaders`.
//
//   2. A WIRE SHAPE. Hosted rerankers do not agree on one. `RERANK_PROVIDER`
//      picks the adapter; the transport below is shared and vendor-free.
//
// 🔴 WHY BOTH ARE LOAD-BEARING RATHER THAN NICE-TO-HAVE: the rerank rung fails
// safe (the fallback lives in `RetrieveService`, see the NOTE on `callRerank`).
// A 401, or a 200 the client cannot parse, both collapse into "fall back to the
// fused order" — and that response is byte-identical to `rerank: false` minus
// `rerankScore`. A misconfigured reranker is therefore INVISIBLE in the output.
// `legs` containing `rerank` is the only signal that distinguishes a working
// reranker from a dead one — and ONLY on `/v1/retrieve`; `/v1/retrieve/multi`
// returns no `legs` at all, where `rerankScore` on a chunk is the sole proof.
//
// So there are THREE refusals here, not one, because the wrong credential and
// the wrong wire shape fail in the same invisible way:
//   - a provider that needs a key and has none   -> refuse before `fetch`
//   - a non-200, an error envelope, or non-JSON  -> `RerankHttpError`
//   - a 200 that parses to ZERO usable results   -> `RerankEmptyResultError`
// The third is the one a credential slot alone does not cover: pointing
// `RERANK_PROVIDER` at the wrong wire returns 200, with valid JSON and no error
// envelope, and without that guard it is reported as a successful rerank that
// simply had nothing to say.
//
// ADDING A PROVIDER is a new entry in `RERANK_ADAPTERS` plus a value on the
// `RERANK_PROVIDER` enum in `src/config/env.ts`. It is never a branch inside
// `callRerank`: the transport, the error taxonomy and the auth header stay
// shared, so a new vendor cannot quietly change how failures are reported.
//
// See `plan/retrieval-upgrade-decisions.md`.

import {
  env,
  rerankModelRefusal,
  rerankProviderRequiresApiKey,
  type RerankProviderName,
} from '../../../config/env.js';
import { AiServiceError } from '../../../errors/base.js';
import { recordEgressScrub } from '../../../metrics/pii.js';
import type { PiiKind } from '../pii/index.js';
import { minimiseEgressReport } from '../pii-egress.js';

/**
 * The injectable rerank seam — mirrors the `Embedder` injectable on
 * `RetrieveService`, so eval + tests can pass an offline deterministic stub and
 * make ZERO network calls.
 *
 * Contract:
 *   - `documents` are opaque chunk texts, in candidate order.
 *   - the returned `results` carry the ORIGINAL index into `documents` plus a
 *     `relevanceScore` (a cross-encoder score, typically a 0–1 sigmoid — a
 *     different scale again from cosine and from RRF).
 *   - the caller decides ordering/slicing; a reranker MAY return fewer than
 *     `documents.length` results (e.g. when `topN` is honored server-side), and
 *     MAY return them in any order — the caller maps by `index`.
 */
export type Reranker = (args: RerankArgs) => Promise<RerankResult>;

export interface RerankArgs {
  /** Rerank model id, e.g. `baai/bge-reranker-v2-m3`. */
  model: string;
  /** The user query. */
  query: string;
  /** Candidate chunk texts, in candidate order. */
  documents: string[];
  /** Return only the best `topN` (== the caller's final topK). Optional. */
  topN?: number;
  /** Abort signal — the caller wires a per-request timeout onto this. */
  signal?: AbortSignal;
}

export interface RerankResult {
  /** One entry per scored candidate; `index` points back into `documents`. */
  results: Array<{ index: number; relevanceScore: number }>;
  /** Echo of the model the service actually used. */
  model: string;
  usage: {
    /**
     * Estimated USD cost of this rerank, so a billable backend can flow through
     * the budget ledger like any other paid call. 0 for the self-hosted sibling
     * (no per-call bill — the gate there is CPU/latency, not spend) and 0 for
     * the offline stub. A hosted adapter reports whatever its response carries;
     * an adapter with no cost field on the wire reports 0, which means
     * "unbilled OR unreported" and must not be read as "free".
     */
    estimatedCostUsd: number;
  };
  /**
   * What the PII minimiser did to the payload before it left. Counts only, never
   * text. Present exactly when the scrub ran — so its ABSENCE on a result that
   * reached the wire is the signal a bypass would leave. Absent on the
   * empty-pool shortcut (nothing was sent) and on injected test rerankers.
   */
  egress?: { redactions: number; counts: Readonly<Record<PiiKind, number>> };
}

/** Typed error, matching the embeddings adapter's `OpenRouterEmbeddingHttpError` shape. */
export class RerankHttpError extends Error {
  public readonly status: number;
  public readonly code: string | number | undefined;
  public readonly bodySnippet: string;
  constructor(opts: { status: number; code?: string | number; message: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = 'RerankHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
  }
}

/** Thrown when a rerank is requested but no `RERANK_URL` is configured. */
export class RerankNotConfiguredError extends AiServiceError {
  readonly code = 'ERR_RERANK_NOT_CONFIGURED';
  readonly status = 503;
  /** A deployment fault; the caller gets a generic 500, pino gets the detail. */
  override readonly expose = false;
  constructor() {
    super('Rerank requested but RERANK_URL is not configured.');
    this.name = 'RerankNotConfiguredError';
  }
}

/**
 * Thrown when the configured provider needs a credential and `RERANK_API_KEY`
 * is missing or blank.
 *
 * SEPARATE from `RerankNotConfiguredError` on purpose: "no reranker is wired"
 * and "a reranker is wired and we cannot authenticate to it" are different
 * deployment defects with different fixes, and collapsing them would send
 * whoever reads the log looking at `RERANK_URL`, which is set and correct.
 *
 * This is raised BEFORE the network call, not after a 401, so the failure does
 * not depend on the provider bothering to answer 401 rather than 200-with-junk.
 */
export class RerankCredentialMissingError extends AiServiceError {
  readonly code = 'ERR_RERANK_CREDENTIAL_MISSING';
  readonly status = 503;
  /** A deployment fault; the caller gets a generic 500, pino gets the detail. */
  override readonly expose = false;
  constructor(provider: string) {
    super(
      `Rerank provider \`${provider}\` requires a credential but RERANK_API_KEY is unset or blank. ` +
        'Set RERANK_API_KEY in the deploy environment, or switch RERANK_PROVIDER to a provider that needs none.',
    );
    this.name = 'RerankCredentialMissingError';
  }
}

/**
 * Thrown when the reranker answered 200 but the configured adapter parsed ZERO
 * usable results out of a NON-EMPTY candidate pool.
 *
 * 🔴 WHY THIS IS AN ERROR AND NOT AN EMPTY RESULT. This is the failure a
 * credential slot alone does not cover, and it is worse than a 401 because it
 * does not look like a failure at the transport at all: status 200, valid JSON,
 * no error envelope. Left alone it returns `{ results: [] }`,
 * `RetrieveService` backfills the whole of `topK` from the fused order, and the
 * response is byte-identical to `rerank: false` minus `rerankScore`. A response
 * that parses to nothing is indistinguishable from reranking being off.
 *
 * MEASURED, before this guard existed: feeding a DeepInfra body
 * (`{scores: [0.9, 0.1]}`) to the `cohere` (now `rerank-api`) adapter returned
 * `{results: [], model: 'm', usage: {estimatedCostUsd: 0}}` — a SUCCESS.
 *
 * WHAT IT ACTUALLY MEANS: almost always `RERANK_PROVIDER` does not match the
 * wire `RERANK_URL` speaks. A reranker asked to score N documents with
 * `top_n >= 1` has no legitimate reason to return none. Partial junk is still
 * tolerated — malformed rows are dropped as before — so this fires only on
 * TOTAL loss, which is the signature of a wire mismatch, not a fussy backend.
 */
export class RerankEmptyResultError extends Error {
  /** Candidates that were sent and came back unscored. */
  public readonly poolSize: number;
  public readonly provider: string;
  public readonly bodySnippet: string;
  constructor(opts: { provider: string; poolSize: number; bodySnippet: string }) {
    super(
      `Rerank returned 200 but the \`${opts.provider}\` adapter parsed 0 usable results ` +
        `from ${opts.poolSize} candidates. This is normally RERANK_PROVIDER not matching the ` +
        `wire shape RERANK_URL actually speaks. Body: ${opts.bodySnippet}`,
    );
    this.name = 'RerankEmptyResultError';
    this.provider = opts.provider;
    this.poolSize = opts.poolSize;
    this.bodySnippet = opts.bodySnippet;
  }
}

/**
 * Thrown when `RERANK_URL` cannot be turned into an endpoint for the configured
 * provider — today, a full DeepInfra inference URL where the API base is wanted.
 *
 * A deployment fault, raised before `fetch`, for the same reason the credential
 * refusal is: the alternative is a 404 that the fail-safe swallows into the
 * fused order, leaving a response indistinguishable from rerank being off.
 */
export class RerankEndpointError extends AiServiceError {
  readonly code = 'ERR_RERANK_ENDPOINT_INVALID';
  readonly status = 503;
  override readonly expose = false;
  constructor(message: string) {
    super(message);
    this.name = 'RerankEndpointError';
  }
}

/**
 * Wire shapes `RERANK_URL` may speak.
 *
 * ALIASED from the env enum rather than re-listed, so the two cannot drift.
 * Together with the `Record<RerankProvider, RerankAdapter>` below this makes
 * the compiler the gate: add a value to `RERANK_PROVIDER` in `env.ts` and the
 * build fails until an adapter exists for it, instead of the service accepting
 * the new value at boot and falling over on the first rerank.
 */
export type RerankProvider = RerankProviderName;

/** What every adapter parses the wire down to, before the shared transport wraps it. */
interface AdapterResult {
  results: Array<{ index: number; relevanceScore: number }>;
  /** The model the backend says it used, or `undefined` to echo the request. */
  model?: string;
  /** USD this call cost, when the wire reports it. Omit when it does not. */
  estimatedCostUsd?: number;
}

/**
 * A provider adapter owns exactly two things — the request body and the
 * response parse — and nothing else. Auth, timeouts, HTTP status handling,
 * JSON-parse failures and the error taxonomy are the transport's, shared by
 * every provider, so no vendor can fork how a failure is reported.
 */
interface RerankAdapter {
  /**
   * Turn the configured `RERANK_URL` into the URL this call actually POSTs to.
   *
   * Most providers put the model in the BODY, so the configured URL is already
   * the endpoint and this is identity. DeepInfra puts it in the PATH, so its
   * adapter composes the endpoint per call — which is what keeps `RERANK_MODEL`
   * and the per-request `rerankModel` override meaningful there instead of
   * inert. Throws `RerankEndpointError` if the configured URL cannot be used.
   */
  buildUrl(configuredUrl: string, args: RerankArgs): string;
  buildBody(args: RerankArgs): unknown;
  parse(payload: unknown, args: RerankArgs): AdapterResult;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * The Cohere-style rerank shape, and the repo's default.
 *
 *   POST { model, query, documents: string[], top_n? }
 *   200  { model, results: [{ index, relevance_score }] }   // index into `documents`
 *
 * Cohere `/v2/rerank`, Jina `/v1/rerank` and Voyage all speak it byte-for-byte,
 * and our sibling `rerank-service/app.py` was written to match this client. So
 * this value is not "Cohere the vendor" — it is the de-facto industry-standard
 * rerank wire. Hence the name `rerank-api`; the legacy env spelling `cohere`
 * is normalised to it in `env.ts`, so this table never sees `cohere`.
 *
 * `env.ts` does NOT list this provider as needing a credential, because it also
 * covers the unauthenticated self-hosted sibling. Pointing it at hosted Cohere
 * or Jina works — set `RERANK_API_KEY` and the bearer header goes out — but a
 * MISSING key there 401s rather than refusing up front. That asymmetry is
 * deliberate: the alternative is making the local sibling, which is the common
 * case, require a fake credential.
 */
const rerankApiAdapter: RerankAdapter = {
  // The model travels in the body, so the configured URL IS the endpoint and is
  // passed to `fetch` verbatim — the long-standing contract for `RERANK_URL`.
  buildUrl: (configuredUrl) => configuredUrl,

  buildBody(args) {
    return {
      model: args.model,
      query: args.query,
      documents: args.documents,
      ...(args.topN !== undefined ? { top_n: args.topN } : {}),
    };
  },

  parse(payload, _args) {
    const body = asRecord(payload);
    // We tolerate a couple of common field aliases so a self-hosted variant
    // that names the score differently still parses.
    const raw = Array.isArray(body['results']) ? (body['results'] as unknown[]) : [];
    const results = raw
      .map((entry) => {
        const r = asRecord(entry);
        const index = r['index'];
        const score = r['relevance_score'] ?? r['relevanceScore'] ?? r['score'];
        if (typeof index !== 'number' || typeof score !== 'number') return undefined;
        return { index, relevanceScore: score };
      })
      .filter((r): r is { index: number; relevanceScore: number } => r !== undefined);

    return {
      results,
      model: typeof body['model'] === 'string' ? body['model'] : undefined,
      // No per-call bill on the sibling; hosted Cohere/Jina report their spend
      // in headers this client does not read, so 0 here means "unreported".
    };
  },
};

/**
 * DeepInfra's reranker inference API — the worked example of a provider that
 * does NOT fit the shape above, which is the whole reason it is here.
 *
 *   POST { queries: string[], documents: string[] }
 *   200  { scores: number[], input_tokens, inference_status: { cost, ... } }
 *
 * Wire shape MEASURED against the LIVE API, not read from docs:
 * a real call to `Qwen/Qwen3-Reranker-0.6B` with `queries` repeated per document
 * returned `{request_id, inference_status:{runtime_ms, cost, tokens_input},
 * scores, input_tokens}` — scores `[0.9994, 0.0000029]` correctly separating a
 * relevant Spanish passage from an irrelevant one, `cost` 1.74e-06 USD for 174
 * input tokens. A deliberately wrong key returned 401 on the same call, so the
 * success was not a server that ignores credentials. Note there is NO `model`
 * field on the response, which is why this adapter echoes the requested id.
 *
 * THREE DIFFERENCES the adapter absorbs, none of which the transport sees:
 *
 *   - `queries` is PARALLEL to `documents`, not a single query broadcast over
 *     them: one (query, document) pair per position. For our one-query-many-
 *     documents call we therefore repeat the query `documents.length` times.
 *     Sending a 1-element `queries` would be relying on a broadcast rule their
 *     example does not state.
 *   - `scores` is POSITIONAL — there is no `index` field. `scores[i]` is the
 *     score for `documents[i]`, so the index comes from the array position and
 *     a short or long `scores` array is a protocol violation, not a partial
 *     result.
 *   - there is NO `top_n`. DeepInfra scores everything it is sent; `args.topN`
 *     is deliberately ignored here and `RetrieveService` does the slicing. That
 *     costs nothing extra — the pool is already capped before it reaches us.
 *
 * THE MODEL LIVES IN THE URL PATH (`/v1/inference/<org>/<model>`). Rather than
 * let the deployed URL decide it silently, `buildUrl` composes the path from
 * `args.model` — so `RERANK_MODEL` and the per-request `rerankModel` override
 * work here exactly as they do for every other provider. `RERANK_URL` is
 * therefore the API BASE under this provider, and only under this provider.
 *
 * ⚠ MEASURED: DeepInfra does NOT host `baai/bge-reranker-v2-m3`,
 * this repo's default — `/v1/inference/BAAI/bge-reranker-v2-m3` and the
 * lower-case spelling both return 404 `{"detail":{"error":"Model is not
 * available"}}`. `Qwen/Qwen3-Reranker-0.6B` returns 200. So a deployment that
 * switches provider without also setting `RERANK_MODEL` 404s every call, which
 * is why `validateRerankEndpoint` refuses that combination at boot.
 */
const deepinfraAdapter: RerankAdapter = {
  /**
   * `RERANK_URL` is the API BASE here (`https://api.deepinfra.com`), not a full
   * endpoint, because the model is a PATH segment:
   * `POST {base}/v1/inference/{org}/{model}`.
   *
   * WHY COMPOSE RATHER THAN CONFIGURE THE FULL PATH: pinning the whole URL in
   * env makes `RERANK_MODEL` and the per-request `rerankModel` override dead
   * letters under this provider — the deployed URL would silently decide the
   * model, and a caller asking for a different one would be ignored without a
   * word. Composing keeps one model knob that means the same thing everywhere.
   *
   * A full inference URL in `RERANK_URL` is REFUSED rather than silently
   * accepted: appending to it yields a 404, and this client's whole problem is
   * that a failed rerank is invisible.
   */
  buildUrl(configuredUrl, args) {
    if (/\/v1\/inference\//.test(configuredUrl)) {
      throw new RerankEndpointError(
        `RERANK_URL must be the DeepInfra API BASE (e.g. https://api.deepinfra.com) when ` +
          `RERANK_PROVIDER=deepinfra — the model is appended from RERANK_MODEL. ` +
          `Got a full inference URL: ${configuredUrl}`,
      );
    }
    return `${configuredUrl.replace(/\/+$/, '')}/v1/inference/${args.model}`;
  },

  buildBody(args) {
    return {
      // One query per document — see the PARALLEL note above.
      queries: args.documents.map(() => args.query),
      documents: args.documents,
    };
  },

  parse(payload, args) {
    const body = asRecord(payload);
    const scores = body['scores'];
    if (!Array.isArray(scores)) {
      throw new RerankHttpError({
        status: 200,
        message: 'DeepInfra rerank returned no `scores` array.',
      });
    }
    if (scores.length !== args.documents.length) {
      // Positional scoring makes a length mismatch unrecoverable: we cannot
      // tell WHICH documents the scores belong to. Fail rather than silently
      // mis-attribute relevance to the wrong chunks.
      throw new RerankHttpError({
        status: 200,
        message:
          `DeepInfra rerank returned ${scores.length} scores for ${args.documents.length} documents; ` +
          'scores are positional, so a length mismatch cannot be mapped.',
      });
    }

    const results = scores
      .map((score, index) => (typeof score === 'number' ? { index, relevanceScore: score } : undefined))
      .filter((r): r is { index: number; relevanceScore: number } => r !== undefined);

    const cost = asRecord(body['inference_status'])['cost'];

    return {
      results,
      // No model echo on the wire — the URL path is the model. Echo the request.
      model: args.model,
      estimatedCostUsd: typeof cost === 'number' ? cost : undefined,
    };
  },
};

const RERANK_ADAPTERS: Record<RerankProvider, RerankAdapter> = {
  'rerank-api': rerankApiAdapter,
  deepinfra: deepinfraAdapter,
};

/**
 * The outbound credential header, or `{}` when no key is configured.
 *
 * `Bearer` is the scheme for every rerank API we have looked at — Cohere, Jina,
 * Voyage and DeepInfra all take `Authorization: Bearer <token>` — so this is
 * shared rather than per-adapter. A provider that needs a different scheme is
 * the point at which this grows a per-adapter hook, and not before.
 *
 * OMITTED rather than sent empty when unset: the self-hosted sibling wants no
 * credential at all, and `Authorization: Bearer ` (or worse, `Bearer undefined`)
 * is a header a strict server rejects outright where absence would have passed.
 */
function authHeaders(): Record<string, string> {
  const key = env.RERANK_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * POST to the configured reranker endpoint. Returns one `{ index, relevanceScore }`
 * per scored candidate. Throws `RerankHttpError` on non-OK HTTP or an error
 * envelope, `RerankNotConfiguredError` if `RERANK_URL` is unset,
 * `RerankCredentialMissingError` if the provider needs a key and none is set, and
 * `RerankEndpointError` if the model is outside the provider's allowlist.
 *
 * NOTE: this throws on failure BY DESIGN — the FAIL-SAFE (fall back to the fused
 * order, never 500) lives one layer up in `RetrieveService`, where the fused
 * candidate list is still in hand. Keeping the fallback there rather than here
 * means the client stays a thin, honest transport and tests can assert the
 * error path explicitly.
 */
export async function callRerank(args: RerankArgs): Promise<RerankResult> {
  const url = env.RERANK_URL;
  if (!url) throw new RerankNotConfiguredError();

  const provider = env.RERANK_PROVIDER;
  const adapter = RERANK_ADAPTERS[provider];
  const auth = authHeaders();

  // Before the degenerate-input shortcut: a deployment missing its credential
  // is broken whether or not this particular call had documents to score, and
  // an empty pool must not be the reason a misconfiguration goes unreported.
  if (rerankProviderRequiresApiKey(provider) && !('Authorization' in auth)) {
    throw new RerankCredentialMissingError(provider);
  }

  // The model allowlist (`DEEPINFRA_RERANK_MODELS`), enforced HERE as well as at
  // boot and at the route, because this is the one place every rerank passes.
  // Before the scrub and before any network: a refused model must not reach
  // `buildUrl`, where under `deepinfra` it becomes a URL PATH segment — so this
  // is also what stops a crafted `rerankModel` from steering the request path.
  const modelRefusal = rerankModelRefusal(provider, args.model);
  if (modelRefusal) throw new RerankEndpointError(modelRefusal);

  // Degenerate inputs: nothing to score. Avoid a network round-trip.
  if (args.documents.length === 0) {
    return { results: [], model: args.model, usage: { estimatedCostUsd: 0 } };
  }

  // 🔴 EGRESS SEAM 4 (§9.4 named three; this is the fourth, and it is the
  // LARGEST). A rerank ships the whole candidate POOL, and the pool is sized by
  // `RetrieveService`: `min(topK * RERANK_POOL_MULTIPLIER, RERANK_POOL_CAP)` —
  // today `min(topK * 4, 50)` at `retrieve.ts:548`, so a DEFAULT `topK` of 10
  // (`contract/rag.ts:39`) sends 40 passages and any `topK >= 13` saturates at
  // 50. The formula is quoted rather than a figure on purpose: an earlier draft
  // of this comment said "~48", which matched no constant in the tree and had no
  // source. More raw text leaves here than at any other seam, to a provider
  // chosen for cost rather than for a data posture.
  //
  // It was not in §9.4 because when that list was written the rerank rung was
  // dead: `RERANK_ENABLED=true` with the URL pointed at a stopped container
  // meant nothing was on the wire to scrub. The DeepInfra cutover
  // made the bypass operative rather than theoretical, which is why the wiring
  // lands with the cutover's lane and not with the PII provider decision.
  //
  // ONLY `query` and `documents` are scrubbed, and that is deliberate: `model`
  // is a URL PATH SEGMENT under `deepinfra` (`buildUrl` composes
  // `/v1/inference/<model>`), so passing it through the minimiser would let a
  // detector rewrite an endpoint into a 404 — a failure this file's own fail-safe
  // would then swallow into the fused order. A model id is a configured
  // identifier, never user text, so it carries no PII to lose.
  //
  // INDEX SAFETY: `minimiseEgressReport` returns the SAME SHAPE, so `safe.documents`
  // has the same length and order as `args.documents`. Every adapter maps its
  // results back by position, and `RetrieveService` maps those positions onto
  // the ORIGINAL unscrubbed chunks — so the caller still returns real text to
  // the user. What changes is only what crosses the perimeter.
  //
  // FAILS CLOSED, and nothing here may catch it: a `PiiMinimisationFailedError`
  // propagates out of `callRerank`, `RetrieveService` falls back to the fused
  // order, and `legs` loses `rerank`. That is a visible, correct degradation.
  // Wrapping this in a try/catch that reranks the raw text instead would be the
  // exact silent no-op the capability may not have.
  const report = await minimiseEgressReport(
    { query: args.query, documents: args.documents },
    args.signal,
  );
  const scrubbed = report.payload;
  const safeArgs: RerankArgs = { ...args, query: scrubbed.query, documents: scrubbed.documents };

  const endpoint = adapter.buildUrl(url, safeArgs);

  // Counted HERE — after the scrub and the URL, immediately before the wire — so
  // the counter means "a scrubbed payload was sent", not "a scrub was attempted".
  recordEgressScrub('rerank', report.counts);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(adapter.buildBody(safeArgs)),
    signal: args.signal,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new RerankHttpError({
      status: res.status,
      message: `Rerank returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  // Truthiness, not key presence: a `{ error: null }` body is a SUCCESS that
  // named its empty error slot, and treating it as a failure would fail-safe a
  // perfectly good rerank into the fused order — the exact silent loss this
  // file exists to prevent.
  const errorSlot = asRecord(parsed)['error'];
  if (!res.ok || errorSlot) {
    const envelope = asRecord(errorSlot);
    const message = envelope['message'];
    const code = envelope['code'];
    const msg = typeof message === 'string' ? message : `HTTP ${res.status}`;
    throw new RerankHttpError({
      status: res.status,
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
      message: `Rerank error (${code ?? res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  const out = adapter.parse(parsed, safeArgs);

  // The silent-loss gate. `args.documents` is non-empty here (the degenerate
  // case returned above), so zero parsed results means the adapter understood
  // nothing the backend said — a wire mismatch wearing a 200.
  if (out.results.length === 0) {
    throw new RerankEmptyResultError({
      provider,
      poolSize: args.documents.length,
      bodySnippet: text.slice(0, 200),
    });
  }

  return {
    results: out.results,
    model: out.model ?? args.model,
    usage: { estimatedCostUsd: out.estimatedCostUsd ?? 0 },
    egress: { redactions: report.redactions, counts: report.counts },
  };
}
