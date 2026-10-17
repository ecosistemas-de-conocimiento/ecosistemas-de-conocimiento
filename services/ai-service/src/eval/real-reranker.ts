// Real-reranker adapter for GATED eval — the rerank counterpart of
// `real-embedder.ts`.
//
// The default eval reranker is `fixtureReranker`, a term-overlap stub. It
// models exact-term sharpening and NOTHING else: no semantic matching, no
// paraphrase, no cross-lingual behaviour. So the existing rerank gate proves
// the rung is WIRED and safe, and says nothing whatsoever about what the real
// `bge-reranker-v2-m3` cross-encoder buys over the fused order. That number is
// the one the A2 "reordenamiento de resultados" decision rests on.
//
// This module swaps the REAL client in behind the same `Reranker` seam, so the
// same A/B runs against a real `rerank-service`.
//
// ⚠ GATED, for the same two reasons the real embedder is: it needs a running
// sibling (a ~6 GB image) and its output drifts with the served model, so a
// "before" number taken against one build is not comparable to an "after". The
// gate is `EVAL_REAL_RERANKER=1`.
//
// ⚠ AND THE GATE IS NOT THE TEST. A skipped test is indistinguishable from a
// passing one, so the eval beside this file does NOT skip when the gate is off:
// it starts a LOCAL stub HTTP server speaking the documented rerank wire shape
// and drives this exact code path — real `fetch`, real envelope, real parsing —
// against it. Setting `EVAL_REAL_RERANKER=1` with a reachable `RERANK_URL`
// swaps the address and changes nothing else.

import { env } from '../config/env.js';
import { callRerank, type Reranker } from '../services/ai/rerank/rerank-client.js';

/**
 * The real `Reranker` — the ordinary HTTP client, which reads `env.RERANK_URL`
 * at call time.
 *
 * Deliberately NOT a second `fetch`. `rerank-client.ts` documents itself as the
 * ONLY file in the tree that calls `fetch(env.RERANK_URL)`, so that cost,
 * errors and the wire shape have exactly one home; an eval that opened its own
 * transport would be measuring code no consumer runs.
 */
export const realReranker: Reranker = callRerank;

/** The model a real-reranker run asks for, unless a config overrides it. */
export const REAL_RERANK_MODEL: string = env.RERANK_MODEL;

/** Whether the gated real-reranker eval mode is enabled for this process. */
export function isRealRerankerEvalEnabled(): boolean {
  return process.env['EVAL_REAL_RERANKER'] === '1';
}

/**
 * Point the single rerank fetch seam at `url` for this process, returning the
 * previous value so a caller can restore it.
 *
 * This writes to the parsed `env` object, which is otherwise treated as
 * immutable, and that needs a justification rather than a shrug. `env` is built
 * once at module load from `process.env`; a test whose stub server binds an
 * EPHEMERAL port cannot know its address before that happens, and picking a
 * fixed port instead would be the bet this repo's `docker-pg.ts` already
 * documents losing (55432 turned out to be an unrelated product's live
 * Postgres). The alternative — a second `fetch` in the eval taking a URL
 * argument — would break the single-seam invariant above and test transport
 * code that production does not run. So: one narrow, restored write, here,
 * where it is visible.
 */
export function setEvalRerankUrl(url: string | undefined): string | undefined {
  const mutable = env as { RERANK_URL?: string | undefined };
  const previous = mutable.RERANK_URL;
  mutable.RERANK_URL = url;
  return previous;
}

/**
 * The rerank endpoint a gated run must talk to.
 *
 * Reads the ORDINARY `RERANK_URL`, not an eval-only variable: the whole point
 * of a gated real run is to exercise the address a deployment actually uses.
 */
export function realRerankUrl(): string | undefined {
  return env.RERANK_URL;
}
