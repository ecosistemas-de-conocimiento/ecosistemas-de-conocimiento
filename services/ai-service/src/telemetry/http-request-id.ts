// The `httpRequestId` seam.
//
// WHAT: Fastify mints a per-HTTP-request id (`req.id`) and prints it on every
// request log line. Downstream of the route — inside the router's trace row,
// inside the BullMQ job, inside the worker's logs — that id did not exist, so a
// support question ("what happened to request X?") could not be followed past
// the HTTP layer.
//
// 🔴 WHY NOT `requestId`. That name is TAKEN, and taken by something with a
// different lifetime: `generation_requests.id`, which is what the worker, the
// event bus (`request:<uuid>:generations`) and the wire
// (`LaunchGenerationResult.requestId`) all mean by "requestId". One HTTP call
// creates one such request row, but a retry, a callback replay or a status poll
// are further HTTP calls against the SAME generation request. Reusing the name
// would have produced a field that is sometimes one and sometimes the other,
// silently, in the same JSON object. Hence `httpRequestId` everywhere: the
// route span attribute (`ai.http_request_id`), the trace-row metadata, the
// orchestrator context and the job data.
//
// THE CONTRACT (lane C ⇄ lane A): lane A owns
// `src/services/generation/orchestrator.ts` and `src/workers/*`. It adds an
// OPTIONAL field named exactly `httpRequestId?: string` to `OrchestratorCtx`
// and `GenerationJobData`, and logs it from the workers. This lane PASSES
// `req.id` into that field from the routes, and owns the router's half
// (`RouteRequest.httpRequestId` → `traces.metadata.httpRequestId`).
//
// WHY THE CAST-FREE HELPER BELOW: `OrchestratorCtx` does not carry the field
// yet, and this lane must not edit lane A's files. TypeScript's excess-property
// check only fires on object *literals* passed directly to a parameter, so
// building the payload as a value of type `WithHttpRequestId<T>` first — an
// intersection, hence assignable to `T` — compiles cleanly against both the
// current types and the post-lane-A types. When lane A lands its field,
// `WithHttpRequestId<T>` is a no-op intersection and every call site keeps
// working unchanged; the helper can then be deleted in one commit.
//
// ⚠ On the `/generate` (async) path the value is still *carried* to the call
// and *dropped* by the callee until lane A lands. That is deliberate and
// visible: the id is already observable on the request log lines, on the
// `ai.http_request_id` span attribute (`src/telemetry/span.ts`), on the
// `x-request-id` response header, and — on the two synchronous routes, which
// go straight to the router — on the trace row's `metadata.httpRequestId`.

/** `T` widened with the optional correlation id. */
export type WithHttpRequestId<T> = T & { httpRequestId?: string };

/**
 * Attach `httpRequestId` to an already-typed payload without tripping the
 * excess-property check, and without a cast that would also silence a real
 * type error in the rest of the object.
 */
export function withHttpRequestId<T extends object>(
  payload: T,
  httpRequestId: string,
): WithHttpRequestId<T> {
  return { ...payload, httpRequestId };
}
