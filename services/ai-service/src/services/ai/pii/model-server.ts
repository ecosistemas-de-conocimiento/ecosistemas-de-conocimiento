// The model-server interface from §9.1 — "one interface, three adapters".
//
// WHAT §9.1 OBSERVED. `rerank-service`, `bge-m3-service` and the future NER
// server are the same shape: a stateless HTTP call to a self-hosted encoder at
// a URL from env (D8). Today the first two are hand-written clients with
// parallel structure and NO shared contract — `Reranker`
// (`src/services/ai/rerank/rerank-client.ts`) and `SparseEmbedder`
// (`src/services/ai/embeddings/sparse-embed.ts`). Both already declare the
// right EXTERNAL shape (a function type, an `args.signal`, a `NotConfigured`
// error, sole ownership of the `fetch`); what they lack is a name for it.
//
// 🔧 WHY THE INTERFACE IS DECLARED HERE AND NOT IN A SHARED HOME. Lane D owns
// exactly two directories, `src/services/ai/pii/` and `pii-service/`, so
// rerank-client.ts and sparse-embed.ts are not this lane's to refactor. The NER
// adapter is written TO the §9.1 shape so the seam is real on at least one
// adapter; UNIFYING the other two — moving this interface up and re-pointing
// `Reranker` / `SparseEmbedder` at it — is a later lane's work, and it is a
// pure refactor with no wire change.
//
// ⚠ WHEN THAT LANE HAPPENS, IT DOES NOT GET A NEW PACKAGE. §9.6 item 5: "No new
// transport package. One seam per capability, in the capability's own
// directory." The interface moves somewhere shared; the three ADAPTERS stay in
// `src/services/ai/{rerank,embeddings,pii}`, because a caller reaching for a
// reranker should not have to learn a transport package first.
//
// ⚠ AND IT DOES NOT FORK A SECOND BREAKER. §9.1: `createProviderResilience`
// (`src/services/ai/router/resilience.ts:314-360`) already takes a named
// provider and runs an arbitrary `fn(signal)`, which is what a model server
// needs. Its blocker is that `isTransientProviderError` (`:221-254`) branches on
// `OpenRouterHttpError` / `OpenRouterAbortError` BY IDENTITY, so a 503 from a
// model server is classified not-transient and never retried. The fix is an
// injectable `isTransient` predicate, ~20 lines. `NerHttpError` below carries
// `status` and `retryAfterMs` so it is ready for whichever way that lands.

/** What a model server reports about itself. */
export interface ModelServerHealth {
  /** Did `/health` answer 200 with a ready model? */
  ready: boolean;
  /** The model the server says it is actually serving. */
  model?: string;
}

/**
 * §9.1's five names. Retry, breaker, timeout composition, batch splitting and
 * error mapping live INSIDE an implementation, not at this interface — that
 * asymmetry is what makes it a deep module rather than a renamed `fetch`.
 */
export interface ModelServerAdapter<Args, Result> {
  /** The model id this adapter asks the server for. */
  readonly modelName: string;
  /** Most inputs the server accepts in one request. The caller splits above it. */
  readonly batchLimit: number;
  /** Per-request wall-clock budget in milliseconds. `0` means no timer. */
  readonly timeoutMs: number;
  /** Do the work. Throws on failure; the fail-safe policy lives at the caller. */
  call(args: Args, signal?: AbortSignal): Promise<Result>;
  /** Probe readiness. Never throws for "not ready" — that is `{ ready: false }`. */
  health(signal?: AbortSignal): Promise<ModelServerHealth>;
}
