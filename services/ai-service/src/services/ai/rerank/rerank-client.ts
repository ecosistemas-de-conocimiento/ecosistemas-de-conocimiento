// Rerank client — the cross-encoder re-scoring seam.
//
// INVARIANT (companion to the embeddings adapter at
// `src/services/ai/embeddings/openrouter.ts`): this is the ONLY file in the
// tree that calls `fetch(env.RERANK_URL)`. Anything that needs a rerank must
// route through here so there is a single seam for cost/trace/error handling.
//
// WHY ITS OWN ENDPOINT (not OpenRouter): the chosen model
// `baai/bge-reranker-v2-m3` (Apache-2.0, multilingual, pairs with `bge-m3`) is
// NOT served on OpenRouter. So the call goes to a SIBLING self-hosted reranker
// service (`rerank-service/` in this repo) whose `RERANK_URL` is config-driven:
// managed/self-hosted is a pure env flip with no code change, exactly like the
// embeddings `EMBEDDINGS_URL` seam.
//
// WIRE SHAPE: the industry-standard Cohere/Voyage/Jina rerank shape (a
// DIFFERENT shape from `/embeddings`, which is why this is its own client and
// not the embeddings adapter):
//   POST { model, query, documents: string[], top_n? }
//   200  { model, results: [{ index, relevance_score }] }   // index into `documents`
//
// See `plan/retrieval-upgrade-decisions.md`.

import { env } from '../../../config/env.js';

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
     * Estimated USD cost of this rerank. 0 for the self-hosted sibling (no
     * per-call token bill — the gate is CPU/latency, not spend) and 0 for the
     * offline stub. A managed backend would surface a real number here so it can
     * flow through the budget ledger like other billable calls.
     */
    estimatedCostUsd: number;
  };
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
export class RerankNotConfiguredError extends Error {
  constructor() {
    super('Rerank requested but RERANK_URL is not configured.');
    this.name = 'RerankNotConfiguredError';
  }
}

interface RerankApiResponse {
  // Cohere-style: `results: [{ index, relevance_score }]`. We also tolerate a
  // couple of common field aliases so a self-hosted variant that names the
  // score differently still parses.
  results?: Array<{ index?: number; relevance_score?: number; relevanceScore?: number; score?: number }>;
  model?: string;
  error?: { message?: string; code?: string | number };
}

/**
 * POST to the configured reranker endpoint. Returns one `{ index, relevanceScore }`
 * per scored candidate. Throws `RerankHttpError` on non-OK HTTP or an error
 * envelope, and `RerankNotConfiguredError` if `RERANK_URL` is unset.
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

  // Degenerate inputs: nothing to score. Avoid a network round-trip.
  if (args.documents.length === 0) {
    return { results: [], model: args.model, usage: { estimatedCostUsd: 0 } };
  }

  const body = {
    model: args.model,
    query: args.query,
    documents: args.documents,
    ...(args.topN !== undefined ? { top_n: args.topN } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: args.signal,
  });

  const text = await res.text();
  let parsed: RerankApiResponse;
  try {
    parsed = text ? (JSON.parse(text) as RerankApiResponse) : {};
  } catch {
    throw new RerankHttpError({
      status: res.status,
      message: `Rerank returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  if (!res.ok || parsed.error) {
    const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
    const code = parsed?.error?.code;
    throw new RerankHttpError({
      status: res.status,
      code,
      message: `Rerank error (${code ?? res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  const raw = parsed.results ?? [];
  const results = raw
    .map((r) => {
      const index = r.index;
      const scoreCandidate = r.relevance_score ?? r.relevanceScore ?? r.score;
      if (typeof index !== 'number' || typeof scoreCandidate !== 'number') return undefined;
      return { index, relevanceScore: scoreCandidate };
    })
    .filter((r): r is { index: number; relevanceScore: number } => r !== undefined);

  return {
    results,
    model: parsed.model ?? args.model,
    // Self-hosted sibling has no per-call bill; a managed backend would compute
    // a real cost here from `usage` and route it through the budget ledger.
    usage: { estimatedCostUsd: 0 },
  };
}
