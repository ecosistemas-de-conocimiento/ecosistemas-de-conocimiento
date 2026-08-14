> **Status.** Decision log for M5 — OpenAPI spec + typed
> client package. Same format as `m3-m4-decisions.md`: each section is
> **Decision**, **Alternatives considered**, **Tradeoffs / tech debt
> incurred**, **When to revisit**. Read the M5 README line in the root
> README first; this doc explains the choices behind the build.

# M5 — OpenAPI + typed client decisions

## 1. Client package layout — workspace package `packages/ai-client`

**Decision.** Declare the client as its own workspace package
(`packages/*` in the workspace manifest). Land the typed client at the
repo-root `packages/ai-client` (`@edc/ai-client`), versioned independently
(`0.1.0`). Consumers depend on it through the workspace (`workspace:*`)
until a publish target exists.

**Alternatives.**
- *Separate repo* (a standalone `ai-client` repo). One git origin per artefact;
  CI/release decoupled from the service.
- *Inline under `ai-service/src/client/`*. No separate package boundary —
  consumers depth-import `ai-service`'s TS sources directly.

**Tradeoffs.**
- Pro: contract changes land in one PR — server + client move together,
  no skewed releases.
- Pro: zero CI wiring for v1; `pnpm install` at the repo root sets up
  both projects.
- Pro: tsconfig isolation (the client builds emit `.d.ts` + `.js`;
  ai-service stays no-emit) is straightforward via separate tsconfig.json.
- Con: `private: false` at the package level might be misread as
  "publish me" once we have a registry. **Tech debt:** decide a publish
  story before adding a second consumer.
- Con: workspace install pulls dev deps for the package even into
  ai-service's `node_modules`. Acceptable today (tiny package, three dev
  deps), watch as the package grows.
- Con: a separate repo would let the client's release cycle out-pace the
  service's. Today they move together — no incentive to split.

**When to revisit.** When a second org / external team wants to consume
the client and the publish-to-npm story matures; or when the workspace
install footprint becomes noticeable.

---

## 2. OpenAPI library — `@asteasolutions/zod-to-openapi@^7.3.4`

**Decision.** Use `@asteasolutions/zod-to-openapi` to derive the OpenAPI
3.1 document from the existing Zod schemas (`src/schemas/*`). Register
schemas with `.openapi('Name', ...)`, declare paths via
`registry.registerPath(...)`, generate once at first access and cache the
result in module scope. Pinned at `^7.3.4` because `8.x` requires Zod 4 —
ai-service still ships Zod 3 (`^3.24.1`).

**Alternatives.**
- *Hand-written OpenAPI YAML / JSON.* Maximum control; zero generation
  step; can document things Zod can't (`text/event-stream`, custom
  examples, vendor extensions) cleanly.
- *`zod-openapi` (different package).* Similar surface, smaller user
  base; we'd have evaluated either if `@asteasolutions/...` didn't fit.
- *`@fastify/swagger` + `@fastify/swagger-ui`.* Plug into Fastify route
  options directly; route handlers declare their schemas inline. Tight
  Fastify coupling; needs JSON Schema (not Zod) at the route boundary.
- *`tsoa` / `nestia`.* Decorator-based, code-first. Tight framework
  coupling we don't need.

**Tradeoffs.**
- Pro: the Zod schemas are already the runtime gate. One source of
  truth; zero drift between validator and spec.
- Pro: the library outputs OpenAPI 3.1 natively (we don't ship the older
  3.0 form).
- Pro: light dep — pure-TS, no native bindings.
- Con: pinned at `7.x` until we move to Zod 4. **Tech debt:** when we
  bump Zod, bump zod-to-openapi at the same time and re-run the openapi
  unit test.
- Con: the library represents some Zod features awkwardly (`z.record`
  becomes `additionalProperties`; unions inline rather than as named
  components unless explicitly registered). For ai-service's surface
  this is fine — the route bodies are mostly object types.
- Con: response shapes for routes that hand back DB rows (e.g.
  `GET /v1/generate/:requestId`) are documented as the permissive
  `OpaqueObject`. The typed client carries the precise TS types. Anyone
  consuming the OpenAPI spec without using the client gets less than the
  full type contract.

**When to revisit.** When ai-service migrates to Zod 4 (move to v8.x);
when an external consumer asks for a codegen target we can't represent
in the current spec (e.g. they want every response body strictly typed
in the spec, not just on the client).

---

## 3. Typed client — hand-written, not codegen

**Decision.** The TS types and sub-API classes in
`packages/ai-client/src/` are hand-written. The OpenAPI document is for
docs + external/non-TS consumers; the in-TS client doesn't re-parse it.

**Alternatives.**
- *`openapi-typescript` + `openapi-fetch`.* Generate types from
  `/v1/openapi.json` at build time; fetch wrapper does the rest.
- *`orval`, `openapi-codegen`, etc.* Full client generation (axios /
  fetch / svelte query / ...). Heavyweight, opinionated.
- *Import server-side TS types directly.* Circular workspace dep — the
  client would have to live inside `ai-service`'s build graph. Rejected.

**Tradeoffs.**
- Pro: client API is curated — sub-API class methods read like a SDK
  (`client.generate.enqueue(...)`), not like `openapi-fetch`'s
  `client.POST('/v1/generate', ...)`.
- Pro: error mapping (`mapBudgetExceeded`, `mapIdempotencyConflict`,
  etc.) is a hand-written switch on the response body's `error`
  discriminator — codegen tools don't generate typed error classes the
  way we want them.
- Pro: zero runtime/build deps on the client side; the package's
  `dependencies` is empty.
- Con: hand-written types drift if no-one updates them. **Mitigation:**
  the openapi unit test in ai-service catches schema additions at the
  wire level; client tests catch error mapping; the contract still
  lives in Zod on the server. **Tech debt:** in M6 (or when the second
  consumer lands), wire a CI check that fails when
  `/v1/openapi.json` paths/components diverge from
  `packages/ai-client/src/types.ts` by some heuristic. Today: manual
  vigilance.
- Con: two changes per contract evolution (Zod schema + client type).

**When to revisit.** When the client surface stabilises (M6+) and
keeping the hand-written types in sync becomes manual toil; then add a
codegen step *for types only*, keep the curated runtime surface.

---

## 4. SSE handling — `node:fetch` + body-stream parser, no `eventsource`

**Decision.** `events(channel)` calls `http.raw(...)` with an
`Accept: text/event-stream` header, then reads `res.body` as a
`ReadableStream<Uint8Array>` and parses the SSE frame format inline
(~30 lines). Heartbeat lines (`: ping`) are filtered as comments.
Caller subscribes via `stream.on('event.type', handler)` /
`stream.onAny(handler)`; `stream.close()` aborts the underlying request.

**Alternatives.**
- *`eventsource` npm package.* The standard EventSource API in Node.
  Doesn't natively support custom headers on Node < 22 without polyfill
  shims; brings dependencies we don't want; the SSE wire format is
  trivially small to parse ourselves.
- *Use the browser's native `EventSource`.* Same custom-headers
  limitation in the browser path (no `Authorization` header support);
  we'd have to fake it via a query-param token, which we *do not* want
  to do because tokens land in proxy logs.
- *Use `fetch-event-source` (Microsoft's package).* Solves the headers
  problem but adds a dep and a slightly different event model.

**Tradeoffs.**
- Pro: zero runtime deps stays intact.
- Pro: bearer token rides as a request header — never in a URL.
- Pro: the parser handles cross-chunk frame boundaries (one test
  asserts a split-payload frame still parses).
- Con: the parser is hand-rolled — if the server ever emits a feature
  we don't handle (`event:` named events, `id:` resume cursors, `retry:`
  backoff hints), the client silently ignores it. ai-service today only
  emits `data:` and `: ping` so this is fine; documented.
- Con: no auto-reconnect on transient disconnect. Consumers who need
  reliable long-running streams should poll `client.generate.get(...)`
  alongside or wrap `events(...)` in their own reconnect loop. **Tech
  debt:** add reconnection logic if a real consumer hits this pattern.

**When to revisit.** When ai-service starts emitting named events or
resume cursors; when consumer feedback shows reconnects are a common
need; when a polyfill becomes necessary for an environment we want to
support.

---

## 5. Zero runtime deps on the client

**Decision.** `packages/ai-client/package.json` declares `dependencies: {}`.
The package uses only the platform `fetch` and `TextDecoder` (Node 18+
or any modern browser). Dev deps are `typescript`, `vitest`, and
`@types/node`.

**Alternatives.**
- *Depend on `node-fetch` for older Node support.* We require Node 20+
  in `engines` to dodge this.
- *Depend on a logger / retry / etc.* Saves consumers from writing
  their own wrappers.

**Tradeoffs.**
- Pro: install footprint is one file (`dist/index.js` + dts).
  Consumer's `package-lock.json` doesn't grow.
- Pro: no transitive vuln surface. Consumers in restrictive
  environments (no internal mirror for a given dep) install cleanly.
- Pro: easier to vendor or inline into a target repo if needed.
- Con: every cross-cutting concern (logging, retry, request hooks) is
  the consumer's problem. We accept that — the consumer's app already
  has these.
- Con: requires Node 20+ for `fetch` and `ReadableStream`. **Tech
  debt:** when a consumer needs Node 18 support, accept `node-fetch`
  as a peerDependency, not a hard dep.

**When to revisit.** When a real consumer reports the missing surface
(retry policy, structured logging hook) is more than they want to
write themselves.

---

# Cross-cutting open items / known tech debt

- **No CLI for the spec.** A `pnpm run openapi:dump > openapi.json` script
  would let CI snapshot the doc and diff it across PRs. Today only the
  unit test asserts shape; no diff-on-PR.
- **`/docs` loads Swagger UI from jsdelivr.** Air-gapped deployments
  can't fetch it. Either inline a single-file Swagger UI build (~3MB)
  or wire a self-host fallback. Acceptable today.
- **`OpaqueObject` placeholder for `GET /v1/generate/:requestId`
  response.** The spec under-documents the response; the typed client
  carries the precise type. Tighten when an external (non-TS) consumer
  arrives.
- **No request-signing.** Bearer-token-only auth; the client doesn't
  sign requests. Consumers operating on hostile networks should TLS-pin
  themselves. Out of scope for v1.
- **No retry layer.** Network blips throw; the consumer retries.
  Reasonable for app-driven LLM calls (idempotency carries them); less
  so for ingest. Watchlist.
- **The credit helper assumes a 1:1 USD-to-rate model.** Multi-currency
  or tiered rate cards (e.g. "first $100 at 1000 credits/USD, then
  900") needs a real ledger primitive. Out of scope for M5.
