// ONE predicate for "does this deployment expose `/v1/internal/*`?".
//
// It used to be written twice and only half of it was true. `server.ts`
// refused to register the plugin when `NODE_ENV=production`, and the OpenAPI
// route table declared `GET /v1/internal/latest-trace` UNCONDITIONALLY — so a
// production deployment published a path it answers 404 on, and
// `routes-vs-document.test.ts` could never notice, because every vitest config
// pins `NODE_ENV=test` and the gate never runs the production way under test.
//
// Both callers now read this function, so the document and the server cannot
// disagree about the same deployment.
//
// ⚠ The two call sites read the value from different places on purpose:
// `server.ts` passes `config.NODE_ENV` (live, per `loadConfig()`), while the
// route table has no config in scope and reads `process.env` at module
// evaluation. `openapi/internal-route-gate.test.ts` builds BOTH under a forced
// `production` and asserts they agree.

export type InternalGateEnv = string | undefined;

/** `/v1/internal/*` is a test seam. Everything except production gets it. */
export function internalRoutesEnabled(
  nodeEnv: InternalGateEnv = process.env['NODE_ENV'],
): boolean {
  return nodeEnv !== 'production';
}
