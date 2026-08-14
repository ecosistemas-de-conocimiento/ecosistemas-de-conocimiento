// Real-embedder adapter for GATED eval.
//
// The default eval embedder is the offline FNV-1a bag-of-words stub
// (`fixture-embedder.ts`), which by design drops numerals/identifiers and
// models no synonymy — it measures retrieval *structure* (chunking, fusion,
// lexical matching), NOT real `bge-m3` semantic quality. This adapter swaps in
// the REAL embedder behind the same `Embedder` seam so a run measures actual
// multilingual embedding quality.
//
// ⚠ COST + REPRODUCIBILITY: this makes real network calls and costs real money
// per run. It is therefore GATED — never wired into `pnpm test` / CI, only run
// behind an explicit env gate (`EVAL_REAL_EMBEDDER=1`) AND Rodrigo's explicit
// per-run OK (conserve-tokens rule). See the plan §2.5.
//
// It is a thin pass-through over the existing embeddings seam
// (`callOpenRouterEmbedding` → `env.EMBEDDINGS_URL`), so dev uses the managed
// endpoint and prod self-host is a pure env flip — same weights, same vectors,
// no re-embed. The model the query is embedded with is the CORPUS's
// `embeddingModel`, which the harness sets to `REAL_EMBEDDING_MODEL` for a real
// run so ingest + query stay in lockstep.

import { env } from '../config/env.js';
import { callOpenRouterEmbedding } from '../services/ai/embeddings/openrouter.js';
import type { Embedder } from '../services/rag/retrieve.js';

/** The real `Embedder` — `bge-m3` (or whatever `EMBEDDING_MODEL` points at) via the embeddings seam. */
export const realEmbedder: Embedder = callOpenRouterEmbedding;

/** The model a real-embedder harness stamps onto its corpus so query + index agree. */
export const REAL_EMBEDDING_MODEL: string = env.EMBEDDING_MODEL;

/** Whether the gated real-embedder eval mode is enabled for this process. */
export function isRealEmbedderEvalEnabled(): boolean {
  return process.env['EVAL_REAL_EMBEDDER'] === '1';
}
