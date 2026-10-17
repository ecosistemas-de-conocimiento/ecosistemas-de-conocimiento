// THE ROUTE TABLE — one row per endpoint, and the only place a route is
// declared.
//
// Before this, `registry.ts` was 1256 lines of `registerPath` calls, each one
// RESTATING its response shape as a fresh inline `z.object({...})`. A restated
// shape is a second source of truth, and it drifted: measured on 970baae,
// eleven declarations did not match what the handler sends, and five routes
// were not in the document at all.
//
// So: no shape is written here. A row NAMES a schema from `src/contract/` —
// request and response — and `registry.ts` turns rows into paths. Prose
// (summary, description, per-status meaning) is the only thing a row owns,
// because prose is the one thing a schema cannot carry.
//
// ── What the builder adds, so a row does not restate it ────────────────────
//   · `auth: 'bearer' | 'admin'` ⇒ `security: [{ Bearer: [] }]` and a 401.
//   · `auth: 'admin'`            ⇒ a 403 as well.
//   · every AUTHENTICATED route  ⇒ a 429. The limiter is registered on the
//     whole `/v1` prefix, so a 429 is producible on every one of them; it was
//     declared on none. The three unauthenticated `/v1` routes
//     (`capabilities`, `openapi.json`, `docs`) are mounted OUTSIDE the limiter
//     and correctly get none.
//
// ⚠ A row's `path` must match the Fastify route exactly (`:param` rewritten as
// `{param}`, trailing slash dropped). `routes-vs-document.test.ts` compares
// the two sets and goes red on any difference, in either direction.

import { z } from '../contract/zod.js';
import * as R from '../contract/responses.js';
import { internalRoutesEnabled } from '../routes/internal-gate.js';
import * as C from './components.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ResponseRow {
  /** What this status MEANS here. Not what the schema already says. */
  readonly description: string;
  /** Omit for a genuinely empty body (499). */
  readonly schema?: z.ZodTypeAny;
  /** Defaults to `application/json`. */
  readonly contentType?: string;
  /**
   * 🔴 PLAIN OpenAPI, not Zod. `registry.ts` copies this object into the
   * response object VERBATIM — `@asteasolutions/zod-to-openapi` converts a
   * schema it finds under `content`, never one under `headers`. Handing it a
   * `z.number()` here published the Zod INTERNALS: 41 raw `def` / `_zod` /
   * `checks` keys reached `GET /v1/openapi.json` and every generated client.
   * Pinned by `no-zod-internals.test.ts`, which greps the SERVED document.
   */
  readonly headers?: Readonly<
    Record<string, { description: string; schema: Readonly<Record<string, unknown>> }>
  >;
}

export interface RouteRow {
  readonly method: HttpMethod;
  /** OpenAPI form: `/v1/corpora/{name}`. Must match the mounted Fastify route. */
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** `none` = mounted outside `requireAuth` AND outside the `/v1` limiter. */
  readonly auth: 'none' | 'bearer' | 'admin';
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  readonly body?: { readonly schema: z.ZodTypeAny; readonly required?: boolean };
  readonly responses: Readonly<Record<number, ResponseRow>>;
}

/**
 * Routes the server has and the document deliberately does not declare.
 *
 * None is an API surface: `@fastify/static` serving the vendored Swagger UI
 * bundle under `/v1/docs/`, and the three files of the logo-only holding page
 * at `/` (`src/routes/holding.ts`). Anything else added here needs a reason of
 * the same kind — "we did not get to it" is not one, because the whole point
 * of `routes-vs-document.test.ts` is that it cannot be silent.
 */
export const UNDOCUMENTED_ROUTES: readonly string[] = [
  'GET /v1/docs*',
  'GET /',
  'GET /holding.css',
  'GET /assets/brand-logo-color.svg',
];

// ---------------------------------------------------------------------------
// Reusable response rows
// ---------------------------------------------------------------------------

// Plain OpenAPI — see the `headers` note on `ResponseRow`.
const RETRY_AFTER_HEADER = {
  'retry-after': {
    description: 'Seconds to wait before retrying. Never `0`.',
    schema: { type: 'integer', minimum: 1 },
  },
} as const;

const json = (schema: z.ZodTypeAny, description: string): ResponseRow => ({
  description,
  schema,
});

/** `{ error, message }` — the flat taxonomy envelope. */
const flat = (description: string): ResponseRow => ({ description, schema: C.ErrorBody });

/** `{ statusCode, error, message }` — fastify-sensible. Every validation 400 is this. */
const problem = (description: string): ResponseRow => ({ description, schema: C.ProblemBody });

/** `{ error: { code, message } }` — the RAG control plane's envelope. */
const nested = (description: string): ResponseRow => ({ description, schema: C.NestedErrorBody });

/** `{ error, code, message }` — `CodedEnvelopeError.toBody()`. */
const coded = (description: string): ResponseRow => ({ description, schema: C.CodedErrorBody });

/**
 * TWO envelopes on ONE status.
 *
 * Not a modelling luxury. A route that `safeParse`s its body answers 400 from
 * two different producers: fastify-sensible when validation fails, and the
 * raising class's own `toBody()` when the handler throws. Declaring only the
 * first (what the table did before this pass) publishes a `statusCode` field
 * the taxonomy arm never sends and hides the `code` field it always does.
 *
 * ⚠ It comes out as `anyOf`, not `oneOf`, and that is the CORRECT operator
 * here: `oneOf` means "exactly one arm matches", and a real `ProblemBody` also
 * validates against the passthrough `ErrorBody` — two matches. `oneOf` would
 * declare bodies the service genuinely sends as invalid.
 */
const oneOfBodies = (description: string, ...schemas: z.ZodTypeAny[]): ResponseRow => ({
  description,
  schema: z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
});

/** Validation `{statusCode,…}` OR a `CodedEnvelopeError`'s `{error,code,…}`. */
const problemOrCoded = (description: string): ResponseRow =>
  oneOfBodies(description, C.ProblemBody, C.CodedErrorBody);

/** Validation `{statusCode,…}` OR a plain flat `{error,message}` (no `code`). */
const problemOrFlat = (description: string): ResponseRow =>
  oneOfBodies(description, C.ProblemBody, C.ErrorBody);

const UNAUTHORIZED: ResponseRow = {
  description:
    'Missing, unknown or expired bearer token. `error` is `unauthorized` or ' +
    '`api_key_expired`; the two are distinguished so a consumer can tell a ' +
    'rotation it has to act on from a token it never had.',
  schema: C.ErrorBody,
};

const FORBIDDEN_ADMIN: ResponseRow = problem('Admin role required.');

const RATE_LIMITED: ResponseRow = {
  description:
    'Rate limit exceeded. 100 requests/minute across `/v1`, 30/minute on the ' +
    'three `/v1/generate*` POSTs and `/v1/retrieve/multi`, bucketed by API key ' +
    '(never by IP — `trustProxy` makes that caller-controlled). `retryAfterMs` ' +
    'mirrors the `retry-after` header in milliseconds. The limiter FAILS OPEN: ' +
    'while its Redis store is unreachable nothing is counted and no 429 is ' +
    'sent, so absence of a 429 is not proof you are under the cap.',
  schema: C.RateLimitedBody,
  headers: RETRY_AFTER_HEADER,
};

const BUDGET_402: ResponseRow = {
  description:
    'The org budget could not be enforced, so the call was not made ' +
    '(fail-closed, ADR-0003 D5). `error` is `BudgetExceeded` (cap ran out — ' +
    'top up), `BudgetNotConfigured` (no budget row — provision a cap) or ' +
    "`BudgetMisconfigured` (the budget row is fine, but the resolved effort " +
    "profile's `estimatedCostUsdPerCall` is zero or non-finite, so no hold " +
    'could be placed — fix the effort profile).',
  schema: C.ErrorBody,
};

const PROVIDER_UNAVAILABLE_503: ResponseRow = {
  description:
    'The provider circuit breaker is OPEN — ai-service is refusing to call ' +
    'upstream rather than queueing behind a failing provider. Retry after the ' +
    'header says so; `retryAfterMs` carries the same budget in milliseconds ' +
    'because the SSE transport has no headers to read.',
  schema: C.ProviderUnavailableBody,
  headers: RETRY_AFTER_HEADER,
};

const CLIENT_CLOSED_499: ResponseRow = {
  description:
    'The client went away mid-generation and the work was abandoned. ' +
    'ZERO-BYTE BODY, and not an IANA status — the socket is usually already ' +
    'gone, so this is mostly visible in logs rather than to the caller.',
};

const TEXT_CHUNK_DESCRIPTION =
  "Passage text, GUARANTEED by ai-service to be at most the corpus's own " +
  'chunk-size contract in characters: `chunk_size` tokens x 4 chars/token ' +
  '(3200 for the default `chunk_size` of 800). The same bound the ingester ' +
  'splits on, so consumers do NOT need to re-trim defensively. A stored ' +
  'chunk that exceeds it (a legacy or hand-inserted row) is truncated to ' +
  'exactly the bound and logged server-side as an anomaly.';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const ROUTES: readonly RouteRow[] = [
  // ── Service ──────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/robots.txt',
    tag: 'Health',
    summary: 'Crawler policy. Disallows everything.',
    auth: 'none',
    responses: {
      200: { description: 'The policy.', schema: z.string(), contentType: 'text/plain' },
    },
  },
  {
    method: 'get',
    path: '/metrics',
    tag: 'Health',
    summary: 'Prometheus exposition format.',
    description:
      'Operator surface, not a consumer one. Unauthenticated and outside `/v1`, ' +
      'so reachability is a network-perimeter decision, not an API-key one.',
    auth: 'none',
    responses: {
      200: { description: 'Metrics.', schema: z.string(), contentType: 'text/plain' },
    },
  },
  {
    method: 'get',
    path: '/health',
    tag: 'Health',
    summary: 'Liveness probe. Touches no dependency.',
    auth: 'none',
    responses: { 200: json(R.healthLiveResponseSchema, 'The process is up.') },
  },
  {
    method: 'get',
    path: '/health/ready',
    tag: 'Health',
    summary: 'Readiness probe — pings Postgres and Redis.',
    description:
      'The 503 carries the SAME body as the 200, with `status: "degraded"` — it ' +
      'is not an error envelope. The endpoint is unauthenticated, so `checks` ' +
      'carries booleans only: the raw dependency errors name connection targets ' +
      'and driver internals and are logged server-side instead.',
    auth: 'none',
    responses: {
      200: json(R.healthReadyResponseSchema, 'Both dependencies answered.'),
      503: json(R.healthReadyResponseSchema, 'At least one dependency did not answer.'),
    },
  },
  {
    method: 'get',
    path: '/v1/openapi.json',
    tag: 'Health',
    summary: 'This document.',
    auth: 'none',
    responses: {
      200: { description: 'The OpenAPI 3.1 document.', schema: z.record(z.string(), z.unknown()) },
    },
  },
  {
    method: 'get',
    path: '/v1/docs',
    tag: 'Health',
    summary: 'Swagger UI viewer for this document.',
    description:
      'Served from the locally-vendored `swagger-ui-dist`, so the viewer works ' +
      'in an air-gapped deployment — no CDN call at runtime.',
    auth: 'none',
    responses: {
      200: { description: 'HTML shell.', schema: z.string(), contentType: 'text/html' },
    },
  },
  {
    method: 'get',
    path: '/v1/capabilities',
    tag: 'Health',
    summary: 'Named capabilities this deployment ships (ADR-0004).',
    description:
      'Consumers declare the capabilities they require and negotiate at boot, so a ' +
      'wrong promotion order fails at deploy time with an actionable message instead ' +
      'of silently degrading (service ahead of consumer) or throwing mid-user-action ' +
      '(consumer ahead of service). Compatibility is decided on capability NAMES only — ' +
      'the document deliberately carries no version or build id. Unauthenticated: a ' +
      'consumer must be able to tell a missing capability apart from a bad API key. ' +
      'Also outside the rate limiter, for the same reason.',
    auth: 'none',
    responses: { 200: json(R.capabilitiesResponseSchema, 'The capability map.') },
  },
  {
    method: 'get',
    path: '/v1',
    tag: 'Health',
    summary: 'Authenticated ping — which scope did this token resolve to?',
    description:
      'The cheapest way for a consumer to prove its bearer token is live and see ' +
      'the `(org, project)` every row it writes will be stamped with.',
    auth: 'bearer',
    responses: { 200: json(R.v1PingResponseSchema, 'The resolved scope.') },
  },

  // ── Generate ─────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/generate',
    tag: 'Generate',
    summary: 'Enqueue a batch of generation units.',
    description:
      'Returns as soon as the work is queued; follow it on `GET /v1/events/{channel}` ' +
      'using the `channel` in the response. Sending the same `clientRequestId` ' +
      'twice REPLAYS the stored handle — that reply carries the four required ' +
      'fields and never `warnings`, because the warning belonged to the original ' +
      'call.',
    auth: 'bearer',
    body: { schema: C.GenerateRequest, required: true },
    responses: {
      200: json(R.launchGenerationResponseSchema, 'Queued, or an idempotent replay.'),
      400: oneOfBodies(
        'THREE producers, and they do NOT share an envelope. (1) Request-body ' +
          'validation → `{statusCode, error, message}`. (2) `RenderError`, ' +
          '`SpecResolutionError`, `DependencyCycleError`, ' +
          '`CrossBatchDependencyError` → the flat `{error, message}`, NO ' +
          '`statusCode` and NO `code`. (3) `CallbackUrlBlockedError` → the flat ' +
          'envelope PLUS `code: "ERR_CALLBACK_URL_BLOCKED"`. Branch on the ' +
          'presence of `statusCode` first, then on `error`.',
        C.ProblemBody,
        C.ErrorBody,
        C.CodedErrorBody,
      ),
      402: BUDGET_402,
      409: flat('Idempotency conflict: same `clientRequestId`, different body.'),
      503: PROVIDER_UNAVAILABLE_503,
    },
  },
  {
    method: 'post',
    path: '/v1/generate/sync',
    tag: 'Generate',
    summary: 'One synchronous generation (no queue, no idempotency).',
    description:
      '30 requests/minute. `systemPromptApplied` says whether this deployment ' +
      'applied the request\'s system prompt AS a system prompt — it is the ' +
      'handle a consumer migrating off the system-fold workaround reads, and it ' +
      'is returned unconditionally.',
    auth: 'bearer',
    body: { schema: C.GenerateSyncRequest, required: true },
    responses: {
      200: json(R.syncGenerationResponseSchema, 'The generation.'),
      400: problemOrFlat(
        'Validation error → `{statusCode, error, message}`. Spec-resolution or ' +
          'render error (`SpecResolutionError`, `RenderError`) → the flat ' +
          '`{error, message}`, with no `statusCode`.',
      ),
      402: BUDGET_402,
      499: CLIENT_CLOSED_499,
      503: PROVIDER_UNAVAILABLE_503,
      504: {
        description:
          'The upstream provider exceeded the request timeout, in any pass ' +
          '(refine and extra samples included). NOT billed: `truncated: true`, ' +
          '`reason: provider_timeout`, `code: ERR_PROVIDER_TIMEOUT`. A process ' +
          'shutdown still answers the older two-field `{error, message}`.',
        schema: C.ProviderTimeoutBody,
      },
    },
  },
  {
    method: 'post',
    path: '/v1/generate/stream',
    tag: 'Generate',
    summary: 'One generation, streamed as Server-Sent Events.',
    description:
      'The reply is HIJACKED once the first byte is written, which changes what ' +
      'a failure looks like. Everything up to that point (validation, spec ' +
      'resolution, context fetch) can still answer with a normal status. After ' +
      'it, the status line is already `200` and every failure — INCLUDING a ' +
      'budget refusal that would be a 402 on `/sync`, and an open circuit ' +
      'breaker that would be a 503 — arrives as a terminal `error` FRAME.\n\n' +
      '**Framing.** `text/event-stream`. The stream opens with the comment ' +
      'frame `: ok`, then every payload is one `data: <json>` frame. Three ' +
      'frame types, discriminated on `type`:\n\n' +
      '- `delta` — an incremental text batch. ZERO of these on a cache hit.\n' +
      '- `done` — terminal success. Field-for-field the `/v1/generate/sync` ' +
      '200 body, plus `type`.\n' +
      '- `error` — terminal failure.\n\n' +
      '⚠ **The error field names swap between transports.** On this route ' +
      '`code` is what the JSON body calls `error` (the class discriminator) and ' +
      '`errorCode` is what the JSON body calls `code` (the `ERR_*` string). A ' +
      'consumer sharing one error mapper across `/sync` and `/stream` must ' +
      'translate. Only classes marked mid-stream-reachable name themselves; ' +
      'anything else collapses to `INTERNAL` / `generation failed`.',
    auth: 'bearer',
    body: { schema: C.GenerateSyncRequest, required: true },
    responses: {
      200: {
        description:
          'The stream. Frames are `delta`* then exactly one of `done` or `error`.',
        schema: R.streamFrameSchema,
        contentType: 'text/event-stream',
      },
      400: problemOrFlat(
        'Raised BEFORE the hijack, so it still has a status line. Validation → ' +
          '`{statusCode, error, message}`; `SpecResolutionError` / ' +
          '`RenderError` → the flat `{error, message}`, no `statusCode`.',
      ),
      402: BUDGET_402,
      499: CLIENT_CLOSED_499,
      503: PROVIDER_UNAVAILABLE_503,
    },
  },
  {
    method: 'get',
    path: '/v1/generate/{requestId}',
    tag: 'Generate',
    summary: 'Fetch a generation request snapshot + per-unit job rows.',
    auth: 'bearer',
    params: z.object({ requestId: z.string().uuid() }),
    responses: {
      200: json(R.generationRequestStateSchema, 'The snapshot.'),
      404: problem('Request not found — or owned by another tenant, which is the same answer.'),
    },
  },
  {
    method: 'get',
    path: '/v1/generate/units/{unitKey}/latest',
    tag: 'Generate',
    summary: 'Fetch the most recent job row for a unitKey in caller scope.',
    auth: 'bearer',
    params: z.object({ unitKey: z.string() }),
    responses: {
      200: json(R.latestUnitResponseSchema, 'The newest job row.'),
      404: problem('No job row for this unitKey in caller scope.'),
    },
  },
  {
    method: 'post',
    path: '/v1/generate/{requestId}/cancel',
    tag: 'Generate',
    summary: 'Cancel a generation request (idempotent).',
    description:
      '`lostJobs` is the only signal that a cancel was INCOMPLETE — those jobs ' +
      'were already off the queue and in flight, so they may still bill. A ' +
      'consumer that settles credits on cancellation has to read it. Absent ' +
      'when zero.',
    auth: 'bearer',
    params: z.object({ requestId: z.string().uuid() }),
    responses: {
      200: json(R.cancelGenerationResponseSchema, 'Cancelled, or already cancelled.'),
      404: problem('Request not found — or owned by another tenant.'),
    },
  },

  // ── Events ───────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/v1/events/{channel}',
    tag: 'Events',
    summary: 'Server-Sent Events stream for one generation request.',
    description:
      'Channel format: `request:<requestId>:generations`. Cross-tenant ' +
      'subscription is rejected with 403 BEFORE any byte hits the wire, which ' +
      'is why it can still be a status rather than a frame.\n\n' +
      '**Framing.** Opens with the comment frame `: ok`, then a `: ping` ' +
      'comment every 15 s to stop intermediaries reaping an idle connection. ' +
      'Payloads are `data: <json>`, each one generation event for THIS request. ' +
      'There is no terminal frame — the stream simply ends.',
    auth: 'bearer',
    params: z.object({ channel: z.string() }),
    responses: {
      200: {
        description: 'The event stream.',
        schema: C.GenerationEvent,
        contentType: 'text/event-stream',
      },
      400: problem('Channel does not parse as `request:<uuid>:generations`.'),
      403: problem('Channel not owned by caller scope.'),
    },
  },

  // ── Budget ───────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/v1/budget/{org}',
    tag: 'Budget',
    summary: 'Caller-scoped budget snapshot.',
    auth: 'bearer',
    params: z.object({ org: z.string() }),
    responses: {
      200: json(R.budgetSnapshotResponseSchema, 'The snapshot.'),
      403: problem('Cross-org read attempted. The path parameter can never widen tenancy.'),
    },
  },
  {
    method: 'put',
    path: '/v1/budget/{org}',
    tag: 'Budget',
    summary: 'Set the org spending cap. Admin only.',
    description:
      'Endpoint form of `scripts/set-budget.ts` — the only thing that lifts the ' +
      'fail-closed gate (an org with no budget row 402s on every generation). ' +
      'Idempotent. `remaining` is clamped down to the new cap but never raised ' +
      'unless `refill` is true. `{org}` must equal the caller\'s own scope; a ' +
      'mismatch is 403. 200 and 201 carry the SAME body — `created` is the only ' +
      'difference.',
    auth: 'admin',
    params: z.object({ org: z.string() }),
    body: { schema: C.SetBudgetRequest },
    responses: {
      200: json(R.setBudgetResponseSchema, 'Existing budget updated.'),
      201: json(R.setBudgetResponseSchema, 'Budget created.'),
      400: problem('Invalid body.'),
    },
  },

  // ── Tenant ───────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/v1/tenant/readiness',
    tag: 'Tenant',
    summary: 'Which of the three provisioning pieces is this tenant missing?',
    description:
      'Standing up a consumer needs an API key, a budget, and an active registry ' +
      'entry per unit type — and a missing one fails as 401, 402 and 400 ' +
      'respectively. This reports all three in plain language for the CALLER\'s own ' +
      'scope. Any authenticated role may call it (that is the point: the consumer ' +
      'hitting the error self-diagnoses). Pass `unitType` to check one unit type ' +
      'precisely instead of "any registered prompt at all".',
    auth: 'bearer',
    query: z.object({ unitType: z.string().optional() }),
    responses: { 200: json(R.tenantReadinessResponseSchema, 'The report.') },
  },
  {
    method: 'post',
    path: '/v1/tenant/provision',
    tag: 'Tenant',
    summary: 'Provision budget + registry entries for the calling tenant. Admin only.',
    description:
      'Idempotent. Reports a per-item status rather than failing the whole call, ' +
      'and always returns the manual step that CANNOT be automated: adding the ' +
      'consumer key to the API_KEYS environment variable and recreating the ' +
      'container. `org`/`project` come from the bearer token, never the body.',
    auth: 'admin',
    body: { schema: C.ProvisionTenantRequest },
    responses: {
      200: json(R.tenantProvisionResponseSchema, 'Per-item result plus a fresh readiness report.'),
      400: problem('Invalid body.'),
    },
  },

  // ── Admin ────────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/v1/openrouter/credits',
    tag: 'Admin',
    summary: 'Platform-wide OpenRouter account credits balance. Admin only.',
    description:
      'Passthrough to OpenRouter `/api/v1/credits`. Cached for 30 seconds ' +
      'in-process. Returns the operator\'s real provider spend; this is NOT ' +
      'something org/project users should ever see.',
    auth: 'admin',
    responses: {
      200: json(R.openRouterCreditsResponseSchema, 'The balance.'),
      503: flat(
        'OpenRouter unreachable (`openrouter_unreachable`) or no platform key ' +
          'configured (`openrouter_not_configured`).',
      ),
    },
  },
  {
    method: 'get',
    path: '/v1/admin/callbacks',
    tag: 'Admin',
    summary: 'List callback delivery attempts, newest first. Admin only.',
    description:
      'The dead-letter view for outbound callbacks. ⚠ Rows are whole ' +
      '`callback_deliveries` rows: `body` and `signature` are the signed ' +
      'callback envelope, i.e. generated output. That is why it is admin-gated. ' +
      '`limit` is clamped to 1–500 (default 50).',
    auth: 'admin',
    query: z.object({
      limit: z.number().int().optional(),
      status: z.string().optional(),
      org: z.string().optional(),
    }),
    responses: {
      200: json(R.callbackDeliveryListResponseSchema, 'The rows.'),
    },
  },
  {
    method: 'post',
    path: '/v1/admin/callbacks/{deliveryId}/replay',
    tag: 'Admin',
    summary: 'Re-attempt one callback delivery. Admin only.',
    auth: 'admin',
    params: z.object({ deliveryId: z.string() }),
    responses: {
      200: json(R.callbackReplayResponseSchema, 'The delivery status after the attempt.'),
      400: problem(
        'The row cannot be replayed: `no-api-key-on-row` or ' +
          '`no-secret-for-api-key`. The `message` is that bare token, not prose.',
      ),
      404: problem('Delivery not found, or owned by another org.'),
    },
  },

  // ── Internal ─────────────────────────────────────────────────────────────
  // CONDITIONAL. `server.ts` refuses to mount `/v1/internal/*` in production,
  // and this row used to be declared anyway — so a production document
  // published a path that deployment answers 404 on. Both sides now read
  // `internalRoutesEnabled`, so they cannot disagree. Every vitest config pins
  // `NODE_ENV=test`, which is why nothing caught it: see
  // `internal-route-gate.test.ts`, which forces `production` on both.
  ...(internalRoutesEnabled()
    ? ([
        {
          method: 'get',
          path: '/v1/internal/latest-trace',
          tag: 'Internal',
          summary: 'Most recent trace for a unitKey. NOT REGISTERED IN PRODUCTION.',
          description:
            '⚠ An end-to-end test seam, not a consumer surface. The plugin refuses to ' +
            'register when `NODE_ENV=production`, so this path is absent from a ' +
            'production deployment — and absent from ITS copy of this document too.',
          auth: 'bearer',
          query: z.object({ unitKey: z.string() }),
          responses: {
            200: json(R.latestTraceResponseSchema, 'The trace.'),
            400: problem('Missing `unitKey` query parameter.'),
            404: problem('No trace for this unitKey in scope.'),
          },
        },
      ] as const satisfies readonly RouteRow[])
    : []),

  // ── Registry ─────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/v1/registry/config',
    tag: 'Registry',
    summary: 'Caller-scoped project config.',
    auth: 'bearer',
    responses: {
      200: json(
        R.projectConfigResponseBodySchema,
        '`config` is `null` when the scope has never been configured — a real 200.',
      ),
    },
  },
  {
    method: 'put',
    path: '/v1/registry/config',
    tag: 'Registry',
    summary: 'Upsert (patch) the caller-scoped project config. Admin only.',
    auth: 'admin',
    body: { schema: C.ProjectConfigPatch, required: true },
    responses: {
      200: json(R.projectConfigResponseBodySchema, '`config` is never null here.'),
      400: problem('Validation error.'),
    },
  },
  {
    method: 'get',
    path: '/v1/registry/unit-types',
    tag: 'Registry',
    summary: 'Summary per unit type: active version + total versions.',
    auth: 'bearer',
    responses: { 200: json(R.unitTypesResponseSchema, 'One row per unit type.') },
  },
  {
    method: 'get',
    path: '/v1/registry/unit-types/{unitType}/versions',
    tag: 'Registry',
    summary: 'List all versions for a unit type (newest first).',
    auth: 'bearer',
    params: z.object({ unitType: z.string() }),
    responses: {
      200: json(R.registryVersionsResponseSchema, '`[]` for an unknown unit type — never a 404.'),
    },
  },
  {
    method: 'get',
    path: '/v1/registry/unit-types/{unitType}/versions/{version}',
    tag: 'Registry',
    summary: 'One version of a unit-type registry entry.',
    auth: 'bearer',
    params: z.object({ unitType: z.string(), version: z.string() }),
    responses: {
      200: json(R.registryEntryResponseBodySchema, 'The entry.'),
      404: problem('No such version for this unit type in caller scope.'),
    },
  },
  {
    method: 'post',
    path: '/v1/registry/unit-types/{unitType}/versions',
    tag: 'Registry',
    summary: 'Create a new version of a unit-type registry entry. Admin only.',
    auth: 'admin',
    params: z.object({ unitType: z.string() }),
    body: { schema: C.RegistryEntryCreate, required: true },
    responses: {
      201: json(R.registryEntryResponseBodySchema, 'Created.'),
      400: problemOrCoded(
        'Validation error → `{statusCode, error, message}`. The version already ' +
          'exists (a CONFLICT reported as 400) → `RegistryConflictError` / ' +
          '`ERR_REGISTRY_CONFLICT` in the coded flat envelope.',
      ),
    },
  },
  {
    method: 'post',
    path: '/v1/registry/unit-types/{unitType}/versions/{version}/activate',
    tag: 'Registry',
    summary: 'Atomically flip the active version for a unit type. Admin only.',
    auth: 'admin',
    params: z.object({ unitType: z.string(), version: z.string() }),
    responses: {
      200: json(R.registryEntryResponseBodySchema, 'The now-active entry.'),
      404: coded(
        '`RegistryNotFoundError` / `ERR_REGISTRY_NOT_FOUND` — no such version ' +
          'for this unit type in caller scope. Note this is NOT the ' +
          '`{statusCode, error, message}` envelope the sibling ' +
          '`GET …/versions/{version}` sends for the same condition: that route ' +
          'still answers through `reply.notFound`, this one lets the class ' +
          'through.',
      ),
    },
  },

  // ── Ingest ───────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/ingest',
    tag: 'Ingest',
    summary: 'Enqueue a text-only ingest batch.',
    description:
      'Text-only: the service does not parse PDFs or HTML. Documents are chunked, ' +
      'embedded and indexed asynchronously; poll `GET /v1/ingest/{ingestId}` or ' +
      'supply `callbackUrl`.\n\n' +
      '**Chunking.** By default a document is split by the corpus\'s configured ' +
      'strategy (`recursive-char`, a token window). Send `chunkConfig` — at the ' +
      'batch level, or per document, where the per-document value wins — to split ' +
      'at the document\'s OWN headings instead, so a retrieved chunk corresponds ' +
      'to one addressable, citable unit:\n\n' +
      '```json\n' +
      '{\n' +
      '  "sections": [{ "key": "section", "pattern": "^\\\\s*Section\\\\s+(\\\\d+)\\\\b", "flags": "i" }],\n' +
      '  "subSections": [{ "key": "clause", "pattern": "^\\\\s*([IVX]+)[.)]\\\\s" }]\n' +
      '}\n' +
      '```\n\n' +
      '`pattern` is JS regex source with `gm` forced on; capture group 1 is the ' +
      'identifier, stored on each chunk as `metadata[key]` (under your own ' +
      'document metadata, which always wins a key collision). `sections` is the ' +
      'only required field; `maxChars` (default 4000) and `minChars` (default 80) ' +
      'are optional. The service ships NO named presets — the patterns describe ' +
      'your documents, so you own them. An unusable config, or one that matches no ' +
      'boundary in a given document, falls back to the corpus strategy with a ' +
      'warning rather than failing the ingest.',
    auth: 'bearer',
    body: { schema: C.IngestRequest, required: true },
    responses: {
      202: json(R.ingestAcceptedResponseSchema, 'Accepted — work proceeds asynchronously.'),
      400: problemOrCoded(
        'Validation error → `{statusCode, error, message}`. Model↔dimension ' +
          'mismatch (`ERR_EMBEDDING_DIMENSION_MISMATCH`), a callback URL the ' +
          'SSRF guard rejected (`ERR_CALLBACK_URL_BLOCKED`), or a `callbackUrl` ' +
          'from an API key with no `callbackSecret` ' +
          '(`ERR_CALLBACK_SECRET_MISSING`) → the coded flat envelope.',
      ),
      413: problem('Body over the ingest body limit.'),
    },
  },
  {
    method: 'get',
    path: '/v1/ingest/{ingestId}',
    tag: 'Ingest',
    summary: 'Ingest status snapshot.',
    description:
      'An id that does not exist in the caller\'s org/project — including one ' +
      'that is not a UUID — answers 404 `IngestNotFoundError`. Once the batch ' +
      'is terminal the snapshot also carries `chunkCount` and per-document ' +
      '`documents[].chunkCount`, keyed by the same `docId` the callbacks carry.',
    auth: 'bearer',
    params: z.object({ ingestId: z.string() }),
    responses: {
      200: json(R.ingestStatusResponseSchema, 'The snapshot.'),
      404: coded('`IngestNotFoundError` / `ERR_INGEST_NOT_FOUND` — no such ingest in caller scope.'),
    },
  },

  // ── Retrieve ─────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/retrieve',
    tag: 'Retrieve',
    summary: 'Top-K retrieval over a corpus — dense, or hybrid dense+lexical (RRF).',
    description:
      'Cosine top-K over the corpus embedding index, with optional MMR rerank. ' +
      'Every parameter beyond `corpus` and `query` is additive: omitting all of ' +
      'them reproduces the original behaviour exactly.\n\n' +
      '- `filter` — jsonb-containment constraint on chunk metadata, applied ' +
      'before ranking.\n' +
      '- `asOf` — point-in-time constraint. Only chunks whose ' +
      '`[validFrom, validTo)` interval contains this instant are eligible. ' +
      'Chunks with no bounds are always eligible, so this is a no-op on a corpus ' +
      'that never sets validity. Use it together with the `validFrom`/`validTo` ' +
      'fields on ingest to keep superseded content out of the candidate set ' +
      'entirely, rather than filtering it at display time.\n' +
      '- `mode: "hybrid"` — additionally runs a Postgres full-text leg and fuses ' +
      'it with the dense leg via Reciprocal Rank Fusion. Fixes exact-identifier ' +
      'queries (codes, numbered references, other short literal tokens) that ' +
      'dense embeddings systematically miss. **In hybrid mode `score` is an RRF ' +
      'score, not a cosine similarity** — read `denseScore` if you threshold on it.\n' +
      '- `rerank: true` — re-score a capped top-N pool with a cross-encoder ' +
      '(self-hosted `bge-reranker-v2-m3`) after retrieval, then re-order before ' +
      'the final top-K, surfacing `rerankScore`. A NO-OP unless the server has ' +
      'rerank wired (`RERANK_ENABLED` + `RERANK_URL`), and it fails safe to the ' +
      'un-reranked order on any rerank error/timeout. Mutually exclusive with ' +
      '`mmr` (rerank wins). **When rerank is on, `score` is the cross-encoder ' +
      'score (0–1 sigmoid)** — threshold on `rerankScore`, not `denseScore`.\n' +
      '- `rerankModel` — per-request rerank model override. Only used when ' +
      '`rerank` is set, but always checked: when the server\'s rerank provider ' +
      'is `deepinfra`, a model outside its rerank allowlist is a **400**, even ' +
      'when `rerank` is absent or false.\n\n' +
      '`legs` names the retrieval legs that returned CANDIDATE rows, which is ' +
      'the only way to tell a degraded retrieve from a normal one: because the ' +
      'rerank rung fails safe, a response from a DOWN reranker is otherwise ' +
      'byte-identical to `rerank: false` minus `rerankScore`. It is not a list ' +
      'of the legs whose rows survived into `chunks`, and the unit differs by ' +
      'leg: `dense`, `lexical` and `sparse` count rows returned into the fusion ' +
      'POOL (before RRF and before the final top-K slice), while `rerank` counts ' +
      'rows in the RESPONSE. `topK: 1` on a hybrid retrieve whose lexical leg ' +
      'returned 50 rows that all lost the fusion still reports `[dense, ' +
      'lexical]` next to one dense chunk — a leg is alive when it produces ' +
      'candidates, and whether they win slots is ranking, not health. The two ' +
      'lexical ' +
      'legs are named apart there (`lexical` = Postgres full-text, `sparse` = ' +
      'learned-sparse bge-m3) even though both still fill `lexicalScore`. ' +
      'Read it as a SET — today a hybrid retrieve runs dense plus exactly ONE ' +
      'lexical leg, but the declared next change fuses all three, so never key ' +
      'on its length or index. Absent ⇒ the deployment predates the field; ' +
      'gate on the `retrievalLegs` capability, never on the field itself. ' +
      'This route only — `POST /v1/retrieve/multi` returns no `legs`.\n\n' +
      TEXT_CHUNK_DESCRIPTION,
    auth: 'bearer',
    body: { schema: C.RetrieveRequest, required: true },
    responses: {
      200: json(R.retrieveResponseSchema, 'The top-K passages.'),
      400: problem('Validation error, or a `rerankModel` outside the rerank allowlist.'),
      404: nested(
        '`CORPUS_NOT_FOUND`. Until `phase2/route-errors` this route caught the ' +
          'class and re-sent it through `reply.notFound`, so the SAME condition ' +
          'answered `{statusCode, error, message}` here and ' +
          '`{error:{code,message}}` on `/v1/corpora`. The catch is gone: one ' +
          'class, one envelope, and `@edc/ai-client` resolves it by the ' +
          'key `CORPUS_NOT_FOUND` on either route.',
      ),
    },
  },
  {
    method: 'post',
    path: '/v1/retrieve/multi',
    tag: 'Retrieve',
    summary: 'Fan out retrieval across N corpora, fuse across them, optional query rewrite.',
    description:
      'Runs `/v1/retrieve` against every `corpora[]` name in parallel (all under ' +
      'the caller\'s own `(org, project)`), merges the matches by `score`, dedupes ' +
      'by chunk, caps at `limit`, and tags each returned chunk with the `corpus` it ' +
      'came from. Every per-corpus knob (`mmr`, `mode`, `rrfK`, `filter`, `asOf`) is ' +
      'forwarded unchanged.\n\n' +
      '- A missing or erroring corpus never fails the whole call: it contributes no ' +
      'chunks and is recorded in the `corpora` diagnostics of the response. That is ' +
      'why this route has no 404.\n' +
      '- `rewrite` (optional) condenses an anaphoric follow-up into a standalone ' +
      'query using the supplied conversation `history` and the cheapest LLM tier ' +
      'BEFORE fan-out. The service ships no prompt wording — `rewrite.instruction` ' +
      'carries all of it (locale included). It fails safe to the raw `query` on the ' +
      'first turn or any error. `query` in the response is the query actually used, ' +
      'and `rewritten` says whether it changed.\n' +
      '- `rerank: true` (optional) re-scores a capped top-N pool with a cross-encoder ' +
      '(self-hosted `bge-reranker-v2-m3`) **once, AFTER cross-corpus fusion** — not ' +
      'per corpus — then re-orders before the final `limit`, surfacing `rerankScore`. ' +
      'The reranked pool spans multiple corpora, which is fine: a cross-encoder scores ' +
      'each (query, chunk) pair independently of its source, and `corpus` provenance is ' +
      'preserved. A NO-OP unless the server has rerank wired (`RERANK_ENABLED` + ' +
      '`RERANK_URL`), and it fails safe to the fused order on any rerank error/timeout. ' +
      'Mutually exclusive with `mmr` (rerank wins; `mmr` is not forwarded to the legs). ' +
      '**When rerank is on, `score` is the cross-encoder score (0–1 sigmoid)** — ' +
      'threshold on `rerankScore`, not `denseScore`.\n' +
      '- `rerankModel` — per-request rerank model override. Only used when ' +
      '`rerank` is set, but always checked: when the server\'s rerank provider ' +
      'is `deepinfra`, a model outside its rerank allowlist is a **400**, even ' +
      'when `rerank` is absent or false.\n' +
      '- **Cross-corpus fusion.** In `mode: \'hybrid\'` each corpus returns `score` ' +
      'as an RRF value built from RANKS INSIDE THAT CORPUS\'S OWN pool, and those are ' +
      'not comparable across corpora — a deeper corpus is penalised for its depth. ' +
      '(MEASURED on dev 2026-09-17: a 180-chunk corpus whose best chunk had the higher ' +
      'lexical scores lost every slot to a 10-chunk corpus, because all of the small ' +
      'corpus\'s hits sat at ranks 1–8 of a 10-deep pool.) So for hybrid over MORE THAN ' +
      'ONE corpus this route rebuilds the ranks over one global pool per leg and re-runs ' +
      'RRF; `score` is then that global RRF value, on the same scale as before. A ' +
      'single corpus, and `mode: \'dense\'` (where `score` is cosine and already ' +
      'comparable), keep the plain score sort unchanged. `fusion` in the response says ' +
      'which rule ran.\n' +
      '- **Fusion diagnostics.** `corpora[].matched` is what a corpus FOUND; ' +
      '`corpora[].contributed` is how many of its chunks won a slot in the final ' +
      '`chunks`. `matched: 8, contributed: 0` is a corpus that was indexed, queried and ' +
      'matched and still reached you with nothing — check it before concluding an ' +
      'attachment had no relevant text. The server also logs that case.\n' +
      '- This response carries NO `legs` field; that is `/v1/retrieve` only. So a ' +
      'rerank rung that failed safe here is still indistinguishable from ' +
      '`rerank: false`, and a dead leg inside any single corpus is still invisible.\n\n' +
      TEXT_CHUNK_DESCRIPTION,
    auth: 'bearer',
    body: { schema: C.RetrieveMultiRequest, required: true },
    responses: {
      200: json(R.retrieveMultiResponseSchema, 'Fused passages plus per-corpus diagnostics.'),
      400: problem('Validation error, or a `rerankModel` outside the rerank allowlist.'),
    },
  },

  // ── Route ────────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/route',
    tag: 'Route',
    summary: 'Classify a question onto exactly one caller-supplied candidate id.',
    description:
      'Single cheap LLM classification over a GENERIC candidate list. FAIL-SAFE: ' +
      'any error / ambiguity / invalid routeId returns `defaultRouteId` (else ' +
      '`candidates[0].id`) with an explanatory reason — never a 5xx on a routable ' +
      'request — except the provider TIMEOUT, which is a 504 `ProviderTimeout` ' +
      '(unbilled, `truncated: true`), never a fallback. ' +
      'The chosen `routeId` is always one of the supplied candidate ids. ' +
      'Because of that, **a degraded answer and a real one are both 200**. Tell them ' +
      'apart by `fallback` (`true` ⇒ default route, with `fallbackCause`), or by ' +
      '`reason` starting with `fallback:` on servers older than 2026-10-06. Every ' +
      'fallback is also logged and counted (`ai_route_fallback_total{cause}`). ' +
      'Override the router prompt/model/effort by registering the ' +
      '`capability-router` unit-type in the registry: a registered entry WINS over ' +
      'the built-in prompt, which is only the fallback used when no entry exists. ' +
      'Model precedence, highest first: request `modelOverride`, the registered ' +
      '`model`, its `effortProfiles[level].model`, `project_configs.defaultModel`, ' +
      '`project_configs.effortProfiles[level].model`, then the tier default ' +
      '(`openai/gpt-4o-mini` for `quick`, the router\'s default tier).',
    auth: 'bearer',
    body: { schema: C.RouteRequest, required: true },
    responses: {
      200: json(R.routeDecisionResponseSchema, 'The decision, real or fallback.'),
      400: problem('Validation error (malformed request body).'),
      499: CLIENT_CLOSED_499,
      504: {
        description:
          'The upstream provider exceeded the request timeout. NOT billed; ' +
          '`truncated: true`, `reason: provider_timeout`.',
        schema: C.ProviderTimeoutBody,
      },
    },
  },

  // ── Embed ────────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/embed',
    tag: 'Embed',
    summary: 'Direct embedding pass-through (no corpus write).',
    auth: 'bearer',
    body: { schema: C.EmbedRequest, required: true },
    responses: {
      200: json(R.embedResponseSchema, 'The vectors.'),
      400: problemOrFlat(
        'Validation error → `{statusCode, error, message}`. A taxonomy error ' +
          'raised by the embedding path → the flat `{error, message}`.',
      ),
      402: BUDGET_402,
    },
  },

  // ── Corpus control plane ─────────────────────────────────────────────────
  {
    method: 'post',
    path: '/v1/corpora',
    tag: 'Corpus',
    summary: 'Create a corpus with an explicit config (model, dim, language, chunking).',
    description:
      'App-role bearer token. Configure a corpus BEFORE any data lands, instead of ' +
      'letting the first ingest silently decide its config. `embeddingModel` is ' +
      'validated against its known vector dimension (a model that cannot fit the ' +
      'live vector column is a 400). `language` is a Postgres text-search config ' +
      'name directly (`spanish`/`english`/`simple`/…), not an ISO locale code. ' +
      'Scoped to the caller\'s (org, project); the name must be unique within it and ' +
      'must not collide with an alias name.',
    auth: 'bearer',
    body: { schema: C.CorpusCreateRequest, required: true },
    responses: {
      201: json(R.corpusIntrospectionSchema, 'Corpus created.'),
      400: problemOrCoded(
        'Validation error → `{statusCode, error, message}`. Model↔dimension ' +
          'mismatch → `EmbeddingDimensionMismatchError` / ' +
          '`ERR_EMBEDDING_DIMENSION_MISMATCH` in the coded flat envelope.',
      ),
      409: nested('`CORPUS_ALREADY_EXISTS`, or `CORPUS_NAME_IS_ALIAS`.'),
    },
  },
  {
    method: 'get',
    path: '/v1/corpora',
    tag: 'Corpus',
    summary: 'List the caller\'s corpora with document + chunk counts.',
    auth: 'bearer',
    responses: { 200: json(R.corpusListResponseSchema, '`[]` when the scope has none.') },
  },
  {
    method: 'get',
    path: '/v1/corpora/{name}',
    tag: 'Corpus',
    summary: 'Introspect one corpus (config + counts). Resolves an alias to its target.',
    description:
      'Returns the corpus config plus live document/chunk counts. If `{name}` is an ' +
      'ALIAS rather than a real corpus, the config + counts are the TARGET corpus\'s ' +
      'and an `alias` field records the pointer.',
    auth: 'bearer',
    params: z.object({ name: z.string() }),
    responses: {
      200: json(R.corpusIntrospectionSchema, 'The corpus.'),
      400: problem('Empty corpus name.'),
      404: nested('`CORPUS_NOT_FOUND`.'),
    },
  },
  {
    method: 'patch',
    path: '/v1/corpora/{name}',
    tag: 'Corpus',
    summary: 'Reconfigure a corpus (chunking, language, metadata; model only while empty).',
    description:
      'App-role bearer token. Only the fields present in the body change. ' +
      'Changing `language` RE-INDEXES the corpus: the stored lexical tsvectors ' +
      'are rebuilt with the new text-search config in the same transaction as ' +
      'the config write, so the index and the query side cannot drift apart. ' +
      'Vectors are untouched (no re-embedding, no token cost) and dense retrieval ' +
      'is unaffected. Sending the language it already has is a no-op. ' +
      '`embeddingModel` may change ONLY while the corpus is still empty — ' +
      'otherwise 409 `EMBEDDING_MODEL_LOCKED`, because re-embedding existing ' +
      'vectors is a separate, future operation.',
    auth: 'bearer',
    params: z.object({ name: z.string() }),
    body: { schema: C.CorpusUpdateRequest, required: true },
    responses: {
      200: json(R.corpusIntrospectionSchema, 'The reconfigured corpus.'),
      400: problemOrCoded(
        'Validation error or an empty patch → `{statusCode, error, message}`. ' +
          'Model↔dimension mismatch (`ERR_EMBEDDING_DIMENSION_MISMATCH`) or an ' +
          'unknown Postgres text-search config (`ERR_INVALID_TEXT_SEARCH_CONFIG`) ' +
          '→ the coded flat envelope.',
      ),
      404: nested('`CORPUS_NOT_FOUND`.'),
      409: nested(
        'TWO codes, not one. `EMBEDDING_MODEL_LOCKED` — a model change on a ' +
          'corpus that already has chunks. `CHUNK_SIZE_LOCKED` — lowering ' +
          '`chunkSize` on a corpus that already has chunks; the old and new ' +
          'sizes appear only inside `message`, never as fields.',
      ),
    },
  },
  {
    method: 'delete',
    path: '/v1/corpora/{name}',
    tag: 'Corpus',
    summary: 'Delete a whole corpus (chunks → documents → corpora).',
    description:
      'App-role bearer token, scoped to the caller\'s (org, project). Idempotent: ' +
      '200 with counts on the first delete, 404 thereafter. Shares the delete ' +
      'primitive with the legacy `DELETE /v1/corpus/{name}`.',
    auth: 'bearer',
    params: z.object({ name: z.string() }),
    responses: {
      200: json(R.deleteCorpusResponseSchema, 'Deleted, with row counts.'),
      400: problem('Empty corpus name.'),
      404: nested('`CORPUS_NOT_FOUND`.'),
    },
  },
  {
    method: 'delete',
    path: '/v1/corpus/{name}',
    tag: 'Corpus',
    summary: 'Delete a whole corpus (chunks → documents → corpora).',
    description:
      'App-role bearer token. Scoped to the caller\'s (org, project) — a corpus in ' +
      'another tenant is indistinguishable from a missing one (no cross-tenant ' +
      'delete). Idempotent: 200 with counts on the first delete, 404 thereafter.',
    auth: 'bearer',
    params: z.object({ name: z.string() }),
    responses: {
      200: json(R.deleteCorpusResponseSchema, 'Deleted, with row counts.'),
      400: problem('Empty corpus name.'),
      404: nested('`CORPUS_NOT_FOUND`.'),
    },
  },
  {
    method: 'post',
    path: '/v1/corpus/{name}/alias',
    tag: 'Corpus',
    summary: 'Create or repoint a corpus alias (a cheap, re-embed-free pointer).',
    description:
      'Admin role required. Makes the alias `{name}` resolve to the same chunks as ' +
      '`target` WITHOUT re-embedding — the `:latest`-pointer use-case. Retrieval ' +
      'against the alias name returns the target corpus\'s chunks. Idempotent: 201 ' +
      'on create, 200 on repoint (an atomic single-row swap of the target). Scoped ' +
      'to the caller\'s (org, project): the target must be in the same tenant, and an ' +
      'alias name cannot collide with a real corpus name. If the target corpus is ' +
      'later deleted, the alias is removed (FK cascade) and a retrieve via it 404s.',
    auth: 'admin',
    params: z.object({ name: z.string() }),
    body: { schema: C.CorpusAliasRequest, required: true },
    responses: {
      200: json(R.corpusAliasResponseSchema, 'Alias repointed at a new target.'),
      201: json(R.corpusAliasResponseSchema, 'Alias created.'),
      400: problem('Validation error, or alias target equals the alias name.'),
      404: nested('`TARGET_CORPUS_NOT_FOUND`.'),
      409: nested('`ALIAS_NAME_CONFLICT` — the alias name already names a real corpus.'),
    },
  },
  {
    method: 'patch',
    path: '/v1/corpus/{name}/documents/{externalId}/validity',
    tag: 'Corpus',
    summary: "Set or clear a document's temporal validity — no re-embedding.",
    description:
      'Rewrites the `[validFrom, validTo)` bounds on an ingested document and every ' +
      'chunk it owns, in one transaction, WITHOUT touching embeddings. This is how a ' +
      'consumer retires superseded content: supersession is normally discovered after ' +
      'ingest, and the alternative — re-POSTing the full text to `/v1/ingest` just to ' +
      'write two timestamps — would re-chunk and re-embed the whole document. That ' +
      'cost is what tempts a consumer to skip the step and leave stale content ' +
      'retrievable.\n\n' +
      '`null` CLEARS a bound (back to unbounded); OMITTING a field leaves the stored ' +
      'bound untouched — the distinction is what makes un-retiring expressible. At ' +
      'least one field must be present.\n\n' +
      'App role, scoped to the caller\'s (org, project) — same posture as the DELETE ' +
      'routes. Retrieval honours the bounds via the `asOf` parameter on `/v1/retrieve`.',
    auth: 'bearer',
    params: z.object({ name: z.string(), externalId: z.string() }),
    body: { schema: C.DocumentValidityRequest, required: true },
    responses: {
      200: json(R.setDocumentValidityResponseSchema, 'The bounds now stored.'),
      400: problemOrCoded(
        'Validation error or no bound supplied → `{statusCode, error, message}`. ' +
          'The resulting interval would be empty → ' +
          '`InvalidValidityIntervalError` / `ERR_INVALID_VALIDITY_INTERVAL` in ' +
          'the coded flat envelope.',
      ),
      404: nested('`CORPUS_NOT_FOUND` or `DOCUMENT_NOT_FOUND`.'),
    },
  },
  {
    method: 'delete',
    path: '/v1/corpus/{name}/documents/{externalId}',
    tag: 'Corpus',
    summary: 'Delete a single document (by consumer external id) + its chunks.',
    description:
      'App-role bearer token. Removes one document and its chunks, leaving the corpus ' +
      'and sibling documents intact — for the doc-removed-entirely case that ' +
      're-ingest (which only replaces a doc\'s chunks) cannot express. Scoped to the ' +
      'caller\'s (org, project); a document in another tenant is indistinguishable ' +
      'from a missing one (no cross-tenant delete).\n\n' +
      '⚠ `deleted` has TWO counters here, not the three on the corpus-level delete: ' +
      'removing a document never removes its corpus.',
    auth: 'bearer',
    params: z.object({ name: z.string(), externalId: z.string() }),
    responses: {
      200: json(R.deleteDocumentResponseSchema, 'Deleted, with row counts.'),
      400: problem('Missing corpus name or externalId.'),
      404: nested('`CORPUS_NOT_FOUND` or `DOCUMENT_NOT_FOUND`.'),
    },
  },
];

/**
 * The complete status → response map for one row, INCLUDING the cross-cutting
 * statuses a row never restates.
 *
 * This lives here, not in `registry.ts`, because two callers need the same
 * answer: the document builder, and `response-parse.integration.test.ts`,
 * which parses a real 401/403/429 body through the schema the document
 * publishes for it. Two copies of the fold would let the test pass against a
 * rule the document does not apply.
 *
 * A row that declares one of these itself WINS — the fold never overwrites.
 */
export function responsesFor(route: RouteRow): Record<number, ResponseRow> {
  const rows: Record<number, ResponseRow> = { ...route.responses };
  if (route.auth !== 'none') {
    rows[401] ??= UNAUTHORIZED;
    // The limiter is registered on the whole `/v1` prefix; the only routes it
    // does not cover are the unauthenticated ones, mounted outside it.
    rows[429] ??= RATE_LIMITED;
  }
  if (route.auth === 'admin') rows[403] ??= FORBIDDEN_ADMIN;
  return rows;
}
