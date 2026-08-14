// Sparse (learned-lexical) embedding client — the bge-m3 sparse seam.
//
// INVARIANT (companion to the dense embeddings adapter at
// `./openrouter.ts` and the rerank client at `../rerank/rerank-client.ts`):
// this is the ONLY file in the tree that calls `fetch(env.SPARSE_EMBED_URL)`.
// Anything that needs a sparse vector routes through here, so there is a single
// seam for wire-shape/error handling and a single injectable stub for tests.
//
// WHY ITS OWN ENDPOINT (not OpenRouter): OpenRouter's `/embeddings` endpoint is
// OpenAI-compatible and returns DENSE vectors ONLY (`data[].embedding` is a
// float array; there is no wire field for a sparse/lexical vector). bge-m3
// additionally emits a learned SPARSE vector (`lexical_weights`) and a colbert
// vector, but ONLY when served through FlagEmbedding with `return_sparse=True`.
// So sparse vectors require a SIBLING self-hosted bge-m3 service (see
// `bge-m3-service/`), whose URL is config-driven exactly like `EMBEDDINGS_URL`
// and `RERANK_URL`: managed vs self-hosted is a pure env flip, no code change.
// This is CPU-scale work, not GPU (semantic/lexical embedding is CPU).
//
// WIRE SHAPE (bge-m3-service `POST /embed`):
//   POST { model, input: string[] }
//   200  { model,
//          dense:  number[][],                        // one dense vector per input
//          sparse: [ { indices: number[], values: number[] } ]  // one sparse vector per input
//        }
// `indices` are the model's 0-based token ids; `values` the learned weights.
// The pgvector `sparsevec` literal built from these shifts indices to 1-based
// (see `toSparsevecLiteral`).

import { env } from '../../../config/env.js';

/**
 * A single learned-sparse vector: parallel `indices` / `values` arrays. The
 * server returns token ids in `indices` (0-based) and their learned weights in
 * `values`. Order is not guaranteed and may contain zero-weight or duplicate
 * ids; `toSparsevecLiteral` normalises both.
 */
export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface SparseEmbedResult {
  /** Echo of the model the sibling actually served. */
  model: string;
  /** One dense vector per input, in submission order. */
  dense: number[][];
  /** One sparse vector per input, in submission order. */
  sparse: SparseVector[];
}

export interface SparseEmbedArgs {
  /** Sparse model id, e.g. `baai/bge-m3`. */
  model: string;
  /** A single string or an array of strings. One (dense, sparse) pair per input. */
  input: string | string[];
  /** Abort signal — the caller wires a per-request timeout onto this. */
  signal?: AbortSignal;
}

/**
 * The injectable sparse-embedder seam — mirrors the `Embedder`/`Reranker`
 * injectables so eval + tests pass an offline deterministic stub and make ZERO
 * network calls. Injecting one into `RetrieveService`/the ingest worker also
 * FORCES sparse availability, bypassing the `SPARSE_ENABLED` + `SPARSE_EMBED_URL`
 * production gate — same convention as the reranker injection.
 */
export type SparseEmbedder = (args: SparseEmbedArgs) => Promise<SparseEmbedResult>;

/** Typed error, matching `OpenRouterEmbeddingHttpError` / `RerankHttpError`. */
export class SparseEmbedHttpError extends Error {
  public readonly status: number;
  public readonly code: string | number | undefined;
  public readonly bodySnippet: string;
  constructor(opts: { status: number; code?: string | number; message: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = 'SparseEmbedHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
  }
}

/** Thrown when a sparse embed is requested but no `SPARSE_EMBED_URL` is configured. */
export class SparseEmbedNotConfiguredError extends Error {
  constructor() {
    super('Sparse embed requested but SPARSE_EMBED_URL is not configured.');
    this.name = 'SparseEmbedNotConfiguredError';
  }
}

interface SparseEmbedApiResponse {
  model?: string;
  dense?: number[][];
  sparse?: Array<{ indices?: number[]; values?: number[] }>;
  error?: { message?: string; code?: string | number };
}

/**
 * Build a pgvector `sparsevec` text literal `{i1:v1,i2:v2,...}/dim` from a
 * {@link SparseVector}.
 *
 * pgvector `sparsevec` rules this enforces:
 *   - indices are **1-based** — a model token id `t` (0-based) is stored at
 *     sparsevec index `t + 1`;
 *   - indices are **ascending** and **unique** — on a duplicate id the LAST
 *     weight wins (matches how a dict-shaped `lexical_weights` would collapse);
 *   - **zero-weight** entries are dropped (they contribute nothing to the inner
 *     product and only bloat the literal);
 *   - an all-zero / empty vector renders as `{}/dim` — a valid sparsevec whose
 *     inner product with anything is 0, so such a chunk simply never surfaces on
 *     the sparse leg (the dense leg still covers it).
 *
 * `dim` MUST equal the `chunks.sparse_embedding` column width (`env.SPARSE_DIM`).
 * A token id outside `[0, dim)` is dropped defensively rather than allowed to
 * throw at the `::sparsevec` cast.
 */
export function toSparsevecLiteral(vec: SparseVector, dim: number): string {
  const byIndex = new Map<number, number>();
  const n = Math.min(vec.indices.length, vec.values.length);
  for (let i = 0; i < n; i++) {
    const id = vec.indices[i]!;
    const w = vec.values[i]!;
    if (!Number.isFinite(id) || !Number.isFinite(w) || w === 0) continue;
    if (id < 0 || id >= dim) continue; // out of range for this column width
    byIndex.set(id + 1, w); // shift 0-based token id → 1-based sparsevec index
  }
  if (byIndex.size === 0) return `{}/${dim}`;
  const parts = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, w]) => `${idx}:${w}`);
  return `{${parts.join(',')}}/${dim}`;
}

/**
 * POST to the configured sparse-embed sibling. Returns one dense + one sparse
 * vector per input, in submission order. Throws `SparseEmbedHttpError` on
 * non-OK HTTP or an error envelope, and `SparseEmbedNotConfiguredError` if
 * `SPARSE_EMBED_URL` is unset.
 *
 * Like the rerank client, this throws on failure BY DESIGN — the callers decide
 * the fallback (the retrieve path degrades hybrid→the tsvector/dense legs; the
 * ingest path lets the sparse write fail loudly so a broken sibling is visible
 * rather than silently producing a half-indexed corpus).
 */
export async function callSparseEmbed(args: SparseEmbedArgs): Promise<SparseEmbedResult> {
  const url = env.SPARSE_EMBED_URL;
  if (!url) throw new SparseEmbedNotConfiguredError();

  const inputs = Array.isArray(args.input) ? args.input : [args.input];
  // Degenerate input: nothing to embed. Avoid a network round-trip.
  if (inputs.length === 0) {
    return { model: args.model, dense: [], sparse: [] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.model, input: inputs }),
    signal: args.signal,
  });

  const text = await res.text();
  let parsed: SparseEmbedApiResponse;
  try {
    parsed = text ? (JSON.parse(text) as SparseEmbedApiResponse) : {};
  } catch {
    throw new SparseEmbedHttpError({
      status: res.status,
      message: `Sparse embed returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  if (!res.ok || parsed.error) {
    const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
    const code = parsed?.error?.code;
    throw new SparseEmbedHttpError({
      status: res.status,
      code,
      message: `Sparse embed error (${code ?? res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  const dense = Array.isArray(parsed.dense) ? parsed.dense : [];
  const sparse: SparseVector[] = (parsed.sparse ?? []).map((s) => ({
    indices: Array.isArray(s.indices) ? s.indices : [],
    values: Array.isArray(s.values) ? s.values : [],
  }));

  return { model: parsed.model ?? args.model, dense, sparse };
}
