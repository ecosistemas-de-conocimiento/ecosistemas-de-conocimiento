import rateLimitPlugin from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginCallback,
  type FastifyRequest,
} from 'fastify';
import metricsPluginModule, { type IMetricsPluginOptions } from 'fastify-metrics';
import { Redis } from 'ioredis';

import { loadConfig, type Config } from './config/config.js';
import { createRuntime, type Runtime } from './runtime.js';
import { isDatabaseUnavailableError } from './db/unavailable.js';
import { isAiServiceError } from './errors/base.js';
import { getFastifyOtelPlugin } from './telemetry/otel.js';
import { authPlugin, deriveApiKeyId } from './plugins/auth.js';
import adminCallbacksRoutes from './routes/admin-callbacks.js';
import budgetRoutes from './routes/budget.js';
import capabilitiesRoutes from './routes/capabilities.js';
import corporaRoutes from './routes/corpora.js';
import corpusRoutes from './routes/corpus.js';
import embedRoutes from './routes/embed.js';
import eventsRoutes from './routes/events.js';
import generateRoutes from './routes/generate.js';
import internalRoutes from './routes/internal.js';
import { internalRoutesEnabled } from './routes/internal-gate.js';
import { LOG_SAFE_OPTIONS } from './errors/log-safe.js';
import { healthRoutes } from './routes/health.js';
import { holdingRoutes } from './routes/holding.js';
import ingestRoutes from './routes/ingest.js';
import metricsRoutes from './routes/metrics.js';
import openapiRoutes from './routes/openapi.js';
import openrouterCreditsRoutes from './routes/openrouter-credits.js';
import registryRoutes from './routes/registry.js';
import retrieveRoutes from './routes/retrieve.js';
import robotsRoutes from './routes/robots.js';
import routeRoutes from './routes/route.js';
import tenantRoutes from './routes/tenant.js';
import { client as promClient, FASTIFY_METRICS_METRICS } from './metrics/registry.js';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  V1_DEFAULT_RATE_LIMIT_MAX,
  V1_RATE_LIMIT_WINDOW,
} from './server-limits.js';

// The /v1 rate-limit store switch used to be a bare `process.env` read here,
// with a comment deferring it to phase 2. It is now `config.rateLimitRedisStore`
// — see `src/config/config.ts`, which carries both the reasoning and the
// `RATE_LIMIT_REDIS` escape hatch.

/**
 * Bucket key for the /v1 rate limiter. Two populations, two namespaces, one
 * limiter.
 *
 *   `k:<apiKeyId>`      a request presenting a CONFIGURED key. Bucketed by the
 *                       key and never by an address: `req.ip` comes from
 *                       `X-Forwarded-For`, and a miscounted `TRUSTED_PROXY_HOPS`
 *                       makes it caller-chosen, so an IP bucket is one header
 *                       away from being a fresh bucket per request. Pinned by `routes/rate-limit-key.test.ts`.
 *
 *   `ip:<socket peer>`  everything else — missing, malformed, unknown or
 *                       expired credentials. These are the requests that end
 *                       in a 401, and until the hook ordering below was fixed
 *                       they were not counted at all.
 *
 * 🔴 THE SECOND CASE READS `req.socket.remoteAddress`, NOT `req.ip`. The point
 * of counting a rejection is to bound what an unauthenticated caller can
 * spend, and a bucket keyed on a header the caller writes bounds nothing:
 * `curl -H 'X-Forwarded-For: <random>'` mints a fresh one every request. The
 * raw socket peer is the only address in the request the caller cannot choose
 * — the same reasoning `routes/metrics.ts` uses for its allowlist.
 *
 * ⚠ THE TRADE, EXPLICITLY. Behind Traefik the socket peer is the ingress
 * container for EVERY internet request, so all unauthenticated /v1 traffic
 * shares ONE bucket of `V1_DEFAULT_RATE_LIMIT_MAX` per window. That is
 * deliberate: this is a cap on total rejection cost, not a per-caller fairness
 * device. It cannot lock a valid key out — a configured key is counted in the
 * `k:` namespace, which no volume of rejections touches. What it does do is
 * answer a consumer that deploys a stale token with 429s after the first
 * hundred instead of an endless supply of 401s; the fix for both is the same
 * fix.
 *
 * ⚠ TAKES THE `Config` VALUE, NOT THE `env` SINGLETON. The key set has to be
 * the one THIS server was built with — `buildServer(runtime)` is handed a
 * `runtime.config`, and a test (or a second server in one process) can hand it
 * a different `API_KEYS` than the module-scope `env` parsed at import.
 *
 * Bearer parsing is duplicated from `plugins/auth.ts` rather than shared,
 * because the limiter must NOT depend on `req.auth` — that dependency is
 * exactly what forced the broken hook order. If the two ever disagree the
 * consequence is a MIS-BUCKETED request, not an auth bypass: `requireAuth`
 * remains the only thing that decides who is authenticated.
 */
export function v1RateLimitKey(config: Config, req: FastifyRequest): string {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  const presented = token?.trim();
  // `Object.hasOwn`, not a bare index: a bare lookup resolves prototype names
  // (`__proto__`, `constructor`, ...) and would file those under `k:`. Same
  // guard, same reason, as `requireAuth`.
  if (scheme?.toLowerCase() === 'bearer' && presented && Object.hasOwn(config.API_KEYS, presented)) {
    return `k:${deriveApiKeyId(presented)}`;
  }
  return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
}

/**
 * A DEDICATED ioredis client for the rate limiter — NOT `redisConnection` from
 * `src/queue/connection.ts`.
 *
 * Exported only so `routes/server-config-wiring.test.ts` can read the target it
 * dialled off `client.options` — the client itself is held in `buildServer`'s
 * closure and is not part of the app's surface. It reads `config.REDIS_URL`,
 * not `env.REDIS_URL`, for the same reason `v1RateLimitKey` takes a `Config`.
 *
 * Two different jobs with incompatible settings. BullMQ's connection must have
 * `maxRetriesPerRequest: null` because it issues blocking commands that may sit
 * for minutes; a rate-limit check is on the hot path of every request and must
 * fail fast rather than hold the request open. `@fastify/rate-limit`'s own
 * README asks for a short `connectTimeout` and `maxRetriesPerRequest: 1` for
 * exactly that reason. Sharing one client would force one of the two to take
 * the other's timeouts.
 *
 * 🔴 `lazyConnect: true` for the same CI reason spelled out at length in
 * `src/queue/connection.ts`: constructing this at import time against a
 * refused port makes ioredis reconnect forever and print through
 * `console.error`, and a retry still in flight at vitest teardown kills a
 * fully green run with `EnvironmentTeardownError`. Nothing here needs a socket
 * until the first request arrives.
 *
 * 🔴 THE OUTAGE BUDGET IS BOUNDED HERE. Measured against a closed port, the
 * stock settings put every /v1 request at 4.0 s before the store gave up.
 * `commandTimeout` is what actually caps that — `connectTimeout` only bounds
 * the socket handshake, and `maxRetriesPerRequest` counts retries, not
 * wall-clock. 500 ms is ~3 orders of magnitude above a healthy `INCR` on the
 * same network, and a command that does time out FAILS OPEN (`skipOnError`
 * below) rather than failing the request.
 */
export function createRateLimitRedis(log: FastifyBaseLogger, config: Config): Redis {
  const client = new Redis(config.REDIS_URL, {
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    // Distinct from the BullMQ client's keys so a `FLUSHDB` on one concern is
    // legible in `redis-cli --scan`.
    keyPrefix: 'ai-service:ratelimit:',
    // Bounded and QUIET. ioredis' default backoff is `min(times * 50, 2000)`
    // and it never stops, so a Redis that stays down produced an unbounded
    // reconnect loop writing straight to stderr, outside pino, unfiltered by
    // LOG_LEVEL and unparseable by the log shipper. The `error` listener below
    // moves that reporting into the app logger — and having ANY `error`
    // listener attached is also what stops ioredis printing it itself.
    //
    // 🔴 THE 1 s CAP IS A LATENCY BUDGET, NOT A POLITENESS SETTING, and it is
    // the one number here that was measured wrong first. `enableOfflineQueue`
    // (ioredis' default, and not safe to turn off: with `lazyConnect` it
    // rejects the FIRST command even against a healthy Redis) parks a command
    // until the next reconnect ATTEMPT, so the backoff delay IS the request's
    // wait. A 5 s cap therefore made a long outage cost 5 s per request —
    // worse than the 4.0 s bug this whole change set out to fix, and it showed
    // up as `rate-limit-fail-open.test.ts` intermittently hitting vitest's 5 s
    // timeout, on 3 runs in 5. At 1 s a request waits ~1 s at worst, and a
    // Redis restart is still picked up within a second. That test now asserts
    // the wall-clock bound directly, so this number cannot drift back up
    // quietly.
    retryStrategy: (times) => Math.min(times * 100, 1_000),
    showFriendlyErrorStack: false,
  });

  // ONE line per state change, not one per attempt. `reachable` is the whole
  // state machine: an operator gets "rate-limit Redis unreachable" when it goes
  // and "rate-limit Redis reconnected" when it comes back, and nothing in
  // between however long the outage lasts.
  let reachable = true;
  client.on('error', (err: Error) => {
    if (!reachable) return;
    reachable = false;
    log.warn(
      { err },
      'rate-limit Redis unreachable — /v1 rate limiting is FAILING OPEN until it returns',
    );
  });
  client.on('ready', () => {
    if (reachable) return;
    reachable = true;
    log.info('rate-limit Redis reconnected — /v1 rate limiting is enforced again');
  });
  return client;
}

/**
 * 🔴 CJS/ESM INTEROP, AND IT DIVERGES BETWEEN THE SUITE AND THE IMAGE.
 * `fastify-metrics` is published CommonJS-only (no `exports` map, no ESM
 * build). Under real node ESM — which is what `dist/` runs — `import x from
 * 'fastify-metrics'` binds `module.exports`, i.e. `{ default: fn }`, NOT the
 * function; measured: `typeof x === 'object'`, keys `['default']`. Vitest's
 * transform interops that away, so the plain import passed every test and
 * would have failed at container boot with "plugin must be a function". The
 * unwrap below is correct under both.
 */
const metricsPlugin = ((metricsPluginModule as { default?: unknown }).default ??
  metricsPluginModule) as FastifyPluginCallback<Partial<IMetricsPluginOptions>>;

/**
 * Build the HTTP app.
 *
 * 🔴 THE DEFAULT IS COMPUTED PER CALL, NOT CAPTURED AT IMPORT. Two suites set
 * `RATE_LIMIT_REDIS` in a `beforeAll` and then call `buildServer()`
 * (`routes/rate-limit-shared-store.integration.test.ts`,
 * `routes/rate-limit-fail-open.test.ts`), so `loadConfig()` has to run at call
 * time to see what they set. Production calls this once, with the runtime
 * `src/index.ts` already built.
 *
 * Every configuration read in this function goes through `runtime.config` —
 * the `env` singleton is deliberately not imported here, so a caller that
 * hands in a runtime gets a server built entirely from THAT value.
 */
export async function buildServer(injectedRuntime?: Runtime): Promise<FastifyInstance> {
  // 🔴 WHO CLOSES THE RUNTIME. A `Runtime` owns a Redis client, BullMQ queues
  // and a FlowProducer; `runtime.close()` is what releases them. Before this
  // branch, `buildServer()` with no argument built one and NOTHING ever closed
  // it — `app.close()` closed only the rate-limit client. Measured against a
  // refused Redis port with `mockQueues` off: two Socket handles survived
  // `app.close()` and the process exited 1 on the FlowProducer's ECONNREFUSED.
  // Nothing in production hit it (`src/index.ts` passes and closes its own
  // runtime, and every no-arg caller is a test under `NODE_ENV=test`, where
  // the queues are in-memory), but it is a loaded footgun, so:
  //
  //   created here  → `app.close()` closes it, because nobody else can.
  //   INJECTED      → left alone. It is the caller's value, it may outlive this
  //                   server, and one integration file builds several servers
  //                   on ONE runtime; closing it with the first would break
  //                   the rest.
  const ownsRuntime = injectedRuntime === undefined;
  const runtime: Runtime = injectedRuntime ?? createRuntime(loadConfig());
  const config: Config = runtime.config;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Coolify captures stdout; keep it JSON in prod, pretty is opt-in via tooling.
      // Redaction plus the `err` serializer that keeps row text out of the log.
      ...LOG_SAFE_OPTIONS,
    },
    // Trust exactly `TRUSTED_PROXY_HOPS` hops (default 1: the Traefik ingress).
    // `true` trusted every hop, so `req.ip` was the LEFTMOST `X-Forwarded-For`
    // entry — whatever the caller wrote. With a count, `req.ip` is the address
    // the outermost trusted proxy appended. Pinned by `routes/trust-proxy.test.ts`.
    trustProxy: config.TRUSTED_PROXY_HOPS,
    disableRequestLogging: false,
    // Global request-body cap (see `server-limits.ts`). Per-route overrides
    // land on the route options below; this is the floor for anything that
    // doesn't declare its own `bodyLimit`.
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  // `@fastify/otel` — registered only when `startTelemetry()` actually started
  // the SDK (i.e. `OTEL_EXPORTER_OTLP_ENDPOINT` is set); `null` otherwise, so a
  // telemetry-off boot registers no instrumentation and loads no OpenTelemetry
  // SDK. To be precise about what "no SDK" does and does not mean: a
  // telemetry-off boot still loads `@opentelemetry/api`, because
  // `telemetry/span.ts` imports it statically to reach the no-op tracer. That
  // package is the API surface only — no exporter, no processor, no patching,
  // no socket. Counted in a child process, not read off the imports:
  // `@opentelemetry/api` is the ONLY `@opentelemetry/*` package a
  // telemetry-off boot loads; with the endpoint set, `sdk-node`, the OTLP
  // exporter and both instrumentations join it. `telemetry/otel.test.ts` pins
  // both halves. The official plugin is used deliberately: the contrib
  // `@opentelemetry/instrumentation-fastify` package is archived.
  const otelPlugin = getFastifyOtelPlugin();
  if (otelPlugin) {
    await app.register(otelPlugin);
  }

  // Prometheus instrumentation. Registered BEFORE any route, so the
  // `onRequest`/`onResponse` pair it installs covers every one of them;
  // `routes/metrics.ts` serves what it collects.
  //
  // `promClient` is passed EXPLICITLY. Left to itself the plugin resolves its
  // own client — and prefers `@platformatic/prom-client` if anything in the
  // tree happens to install it — which would put the route histogram and the
  // process defaults on a DIFFERENT default registry from the one every
  // counter in `src/metrics/*` uses and `GET /metrics` serves. Two registries
  // is not an error, it is silently missing metrics. See the header of
  // `src/metrics/registry.ts`.
  //
  // `endpoint: null` because the route is ours: the plugin's built-in one is
  // unauthenticated and unconditional, and the access rules (loopback-only, or
  // a `METRICS_TOKEN` bearer) live in `routes/metrics.ts`.
  //
  // `defaultMetrics.enabled: false` — `metrics/registry.ts` already installed
  // the process collectors on import, and installing them twice throws on the
  // duplicate metric name.
  //
  // 🔴 `buildServer()` RUNS ONCE IN PRODUCTION AND HUNDREDS OF TIMES IN THE
  // SUITE. The plugin constructs its route histogram with `new Histogram(...)`
  // unconditionally, and a prometheus registry THROWS on a duplicate metric
  // name — so the second `buildServer()` in any one test file would blow up on
  // a line that has nothing to do with what that file tests. Dropping the
  // previous instance first makes registration idempotent. On the production
  // path this removes nothing: there is no previous instance.
  for (const name of FASTIFY_METRICS_METRICS) promClient.register.removeSingleMetric(name);

  await app.register(metricsPlugin, {
    promClient,
    endpoint: null,
    defaultMetrics: { enabled: false },
    routeMetrics: {
      // Histogram only. The summary measures the same latency a second time,
      // computes its percentiles in-process (so they cannot be aggregated
      // across replicas, unlike histogram buckets), and doubles the series
      // count of the busiest metric in the service.
      enabled: { histogram: true, summary: false },
      // 2XX/4XX/5XX instead of one series per exact code: keeps the label
      // cardinality of the busiest metric flat.
      groupStatusCodes: true,
      // 🔴 `false`, AND THE PLUGIN'S DEFAULT (`true`) MEASURES ALMOST NOTHING
      // HERE. Measured on this tree: with `registeredRoutesOnly: true` the
      // histogram contained `/health` and `/robots.txt` and NOTHING ELSE —
      // every route under `/v1` was missing, i.e. the entire API. The option
      // filters requests against a whitelist the plugin builds from its own
      // `onRoute` hook, and that hook does not observe routes registered
      // inside an encapsulated child context, which is exactly how the `/v1`
      // block is mounted. A metric that silently covers 2 of ~40 routes is
      // worse than no metric: the graph looks healthy because the traffic is
      // not in it.
      //
      // Turning it off does NOT open the cardinality hole it exists to close.
      // The route LABEL is `routeOptions.url`, which a request that matched no
      // route does not have, so every 404 — every scanner probing
      // /wp-login.php — collapses into the single `route="__unknown__"`
      // series rather than minting one per probed URL.
      registeredRoutesOnly: false,
    },
  });

  await app.register(sensible);

  // 🔴 THE COMPOSITION SEAM. Every route that needs a queue or the Redis client
  // reads it off `app.runtime` — no route imports a module-scope singleton, and
  // `buildServer(runtime)` is the one place the choice is made. `decorate`
  // (not `decorateRequest`) because the value is per-process, not per-request.
  app.decorate('runtime', runtime);
  if (ownsRuntime) {
    app.addHook('onClose', async () => {
      await runtime.close();
    });
  }

  await app.register(authPlugin);

  // Echo Fastify's per-request id back to the caller. This is the cheap half of
  // the correlation story: the same value appears on every request log line,
  // on the `ai.request_id` span attribute, and — once lane A lands its
  // `requestId?: string` field — on the queued job and the worker's logs. A
  // consumer reporting a failure can now quote one id that finds all of them.
  //
  // ⚠ THIS HOOK DOES NOT COVER A HIJACKED RESPONSE. `reply.header(...)` is only
  // written by Fastify's own serializer, and `reply.hijack()` bypasses it — so
  // `POST /v1/generate/stream` and `GET /v1/events/:channel` set the header on
  // `reply.raw` themselves, right before their SSE headers. Add a third
  // hijacking route and it needs the same line.
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  // Shared rate-limit counters. Held here (not module scope) so a test can
  // build and close servers without leaking clients, and closed with the app.
  const rateLimitRedis = config.rateLimitRedisStore ? createRateLimitRedis(app.log, config) : null;
  if (rateLimitRedis) {
    app.addHook('onClose', async () => {
      await rateLimitRedis.quit().catch(() => undefined);
    });
  }

  // Crawler policy. Registered FIRST and at the root so its `onRequest` hook
  // covers every route below it, and so `GET /robots.txt` sits outside both
  // `requireAuth` and the `/v1` rate limiter — a crawler must never need a key
  // to read the policy, nor be able to spend a tenant's bucket by asking for
  // it. See `src/routes/robots.ts` for the full reasoning.
  await app.register(robotsRoutes);

  // Health / readiness — unauthenticated.
  await app.register(healthRoutes);

  // Holding page at `/` — unauthenticated, three explicit routes only.
  // See `src/routes/holding.ts`.
  await app.register(holdingRoutes);

  // Prometheus scrape endpoint. At the ROOT, so it is outside `requireAuth`
  // and outside the /v1 rate limiter — a scraper cannot spend a tenant's
  // bucket. It carries its own access rules; see `routes/metrics.ts`.
  await app.register(metricsRoutes);

  // OpenAPI spec + docs viewer — namespaced under /v1 for parallelism with
  // the rest of the API surface, but explicitly *outside* the `requireAuth`
  // block so consumers can browse the contract without a key. The spec
  // itself documents the bearer-token requirement on `/v1/*` routes.
  await app.register(openapiRoutes, { prefix: '/v1' });

  // Capability document (ADR-0004) — also outside `requireAuth`, so a consumer
  // can negotiate at boot and tell "missing capability" apart from "bad key".
  // See `src/routes/capabilities.ts` for the full reasoning.
  await app.register(capabilitiesRoutes, { prefix: '/v1' });

  // Versioned API. Everything under /v1 requires a per-project bearer token.
  // Routes land here in milestones 3–4 (generate, events, generate/sync, budget, ingest, ...).
  await app.register(
    async (v1) => {
      // ── ORDERING INVARIANT: LIMITER FIRST, AUTH SECOND. ──────────────────
      // Both of these run at the `onRequest` stage, and a hook that replies
      // short-circuits every hook after it. So whichever runs first decides
      // what the other one ever sees:
      //
      //   auth first     a 401 never reaches the limiter. Rejections are
      //                  UNLIMITED — free to the caller, one full API-key
      //                  lookup each to this service, on a surface anyone can
      //                  reach without a credential. MEASURED over 200
      //                  injects with an unknown key: 200 × 401, ZERO 429.
      //   limiter first  every request is counted, including the ones about
      //                  to be rejected. This is the order built below, and
      //                  `routes/rate-limit-rejected.test.ts` pins it.
      //
      // 🔴 REGISTRATION ORDER DOES NOT PRODUCE THAT — the obvious fix, and it
      // is inert. `@fastify/rate-limit` (10.3.0, index.js ~line 142) attaches
      // through `onRoute`, PUSHING its check onto each route's own
      // `routeOptions.onRequest` array. Fastify runs every INSTANCE-level
      // `onRequest` hook before any ROUTE-level one, so an instance hook wins
      // over the limiter no matter which was registered first. Swapping the
      // two lines below changes nothing measurable; it was tried, and the
      // tally stayed 200 × 401.
      //
      // So `requireAuth` is appended to the SAME route-level array, by an
      // `onRoute` hook registered AFTER the plugin's — route-level hooks run
      // in array order, and the arrays are filled in `onRoute` registration
      // order. That is the whole mechanism: [limiter, requireAuth], per route.
      //
      // The other half of the contract is `v1RateLimitKey`: an authenticated
      // request must bucket by API KEY, never by `req.ip`, which
      // a miscounted `TRUSTED_PROXY_HOPS` makes attacker-controlled per request
      // (`routes/rate-limit-key.test.ts` pins that). The old keyGenerator read
      // `req.auth`, which is what made auth-before-limiter look mandatory;
      // deriving the bucket from the Authorization header instead removes the
      // dependency entirely, so the limiter can safely run first.
      //
      // Rate-limits the whole /v1 surface. Routes that need a tighter cap
      // (e.g. POST /v1/generate{,/sync}) override via `config.rateLimit`;
      // those inherit this `keyGenerator`.
      await v1.register(rateLimitPlugin, {
        max: V1_DEFAULT_RATE_LIMIT_MAX,
        timeWindow: V1_RATE_LIMIT_WINDOW,
        keyGenerator: (req) => v1RateLimitKey(config, req),
        // 🔴 WITHOUT THIS, EACH REPLICA COUNTS ALONE. The default store is a
        // per-process LRU, so the documented "100 requests per minute" became
        // 100 × (number of containers) the moment ai-service scaled past one
        // replica — the cap silently loosened with every deploy that added
        // capacity. Pointing the plugin at a shared Redis makes the bucket the
        // tenant's, not the container's.
        // `redis: null` is not a valid option value, so the whole key is
        // spread in conditionally; absent ⇒ the in-process store, which is what
        // the unit suite runs on.
        ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
        // 🔴 FAIL OPEN, NOT CLOSED. `@fastify/rate-limit` defaults
        // `skipOnError` to FALSE, which RETHROWS a store error — so with the
        // shared Redis store above, a Redis outage did not degrade rate
        // limiting, it took down the WHOLE /v1 API. Measured against a closed
        // port: every request, on every route, answered 500 "Reached the max
        // retries per request limit" after 4.0 s. Redis is not in the critical
        // path of answering a request and must not be able to put itself
        // there. The trade this makes is explicit and much cheaper: while the
        // store is unreachable the limiter is SKIPPED (no counting, no
        // `x-ratelimit-*` headers, no 429s) — a caller could exceed the
        // documented cap for the length of the outage, which the `warn` in
        // `createRateLimitRedis` puts in the log for exactly that reason.
        skipOnError: true,
        // The plugin `throw`s whatever this returns; Fastify reads
        // `statusCode` off the thrown value to pick the response code.
        // Returning a plain object would land as a 500 (no statusCode);
        // returning an Error with `statusCode` set gives us the 429 the
        // contract documents, with our custom body shape preserved by
        // `setErrorHandler` below.
        errorResponseBuilder: (_req, ctx) => {
          const err = new Error(
            `Rate limit exceeded. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`,
          ) as Error & {
            statusCode: number;
            error: string;
            retryAfterMs: number;
          };
          err.statusCode = ctx.statusCode;
          err.error = 'RateLimitExceeded';
          err.retryAfterMs = ctx.ttl;
          return err;
        },
      });

      // Auth, appended to each route's own `onRequest` array — see the
      // ordering invariant above the limiter registration. This `onRoute` hook
      // MUST stay below that `register` call: it is what puts `requireAuth`
      // after the limiter's check rather than before it.
      //
      // NOT `preHandler`, which would be a stage too late: `preHandler` runs
      // after body parsing, so an unauthenticated caller would get a megabyte
      // of JSON parsed on their behalf before being told to go away.
      // `requireAuth` only reads headers, so `onRequest` is safe for it.
      v1.addHook('onRoute', (routeOptions) => {
        const existing = routeOptions.onRequest;
        const before = Array.isArray(existing) ? existing : existing ? [existing] : [];
        routeOptions.onRequest = [...before, app.requireAuth];
      });

      // The ONE error handler for /v1.
      //
      // Five arms, in order:
      //  1. Rate limits. The plugin throws a plain Error carrying `error` and
      //     `retryAfterMs`, and Fastify's default serializer drops anything
      //     that isn't `statusCode`/`message`, so 429s are re-shaped here.
      //  2. Taxonomy, `expose = true` (`src/errors/base.ts`): the class already
      //     declares its status, headers and body, so a route can just `throw`
      //     and every route answers it identically. This is the arm that closes
      //     the old hole — before it, a typed error no route remembered to
      //     catch became a bare Fastify 500.
      //  3. Taxonomy, `expose = false`: REDACTED HERE, never rethrown.
      //  4. Errors that are exposed BY DESIGN and carry a 4xx: Fastify's own
      //     `FST_ERR_VALIDATION` and fastify-sensible's typed 4xx. Logged at a
      //     level that matches the status, then handed to Fastify's default
      //     handler, whose flat envelope IS their declared contract.
      //  5. Everything else — a genuinely unknown throw: a pg driver error, a
      //     TypeError, an upstream client's own Error. REDACTED HERE, for the
      //     same reason as arm 3.
      v1.setErrorHandler((error: unknown, req, reply) => {
        const e = error as
          | (Error & { statusCode?: number; error?: string; retryAfterMs?: number })
          | undefined;
        if (e?.statusCode === 429) {
          return reply.code(429).send({
            error: e.error ?? 'RateLimitExceeded',
            message: e.message,
            retryAfterMs: e.retryAfterMs ?? 0,
          });
        }
        if (isAiServiceError(error)) {
          if (error.expose) {
            reply.code(error.status);
            for (const [name, value] of Object.entries(error.headers ?? {})) {
              reply.header(name, value);
            }
            return reply.send(error.toBody());
          }
          // `expose = false` — a deployment fault, or a class carrying an
          // upstream body snippet. This arm MUST answer itself.
          //
          // ⚠ Rethrowing here does NOT redact: Fastify 5's default handler
          // (`lib/error-handler.js`, `setErrorHeaders`) reads `error.status`
          // BEFORE `error.statusCode`, and every taxonomy class declares
          // `status`. The rethrow therefore published the class's own status
          // AND put `error.message` + `error.code` straight on the body —
          // exactly the leak `expose = false` exists to prevent (measured on
          // `SparseEmbedNotConfiguredError`: 503 + the full message).
          //
          // So: the detail goes to pino only, and the caller gets the same
          // generic 500 envelope Fastify produces for an unknown Error.
          req.log.error(
            {
              err: error,
              errorCode: error.code,
              org: (req.auth as { org?: string } | undefined)?.org,
              project: (req.auth as { project?: string } | undefined)?.project,
            },
            'internal error on /v1 (redacted from the response)',
          );
          return reply
            .code(500)
            .send({ statusCode: 500, error: 'Internal Server Error', message: 'internal error' });
        }
        // The database (or the pooler in front of it) is unreachable. That is
        // a transient outage, not a bug in the request, so answer 503 and say
        // when to retry. The body stays generic, like the 500 below; the
        // readiness endpoint already reports "database down" in public, so
        // the status line leaks nothing new. See `isDatabaseUnavailableError`.
        if (isDatabaseUnavailableError(error)) {
          req.log.error(
            {
              err: error,
              org: (req.auth as { org?: string } | undefined)?.org,
              project: (req.auth as { project?: string } | undefined)?.project,
              httpRequestId: req.id,
            },
            'database unavailable on /v1',
          );
          return reply.code(503).header('retry-after', '1').send({
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'database unavailable',
          });
        }
        // Not ours. The LOG LEVEL is decided the same way for both remaining
        // arms: a caller's own 4xx is not an ai-service fault, and logging it
        // at `error` buried the real 5xx lines (36 error lines for one suite's
        // worth of 4xx requests).
        const status = e?.statusCode ?? 500;
        const level = status >= 500 ? 'error' : status === 400 ? 'info' : 'warn';
        req.log[level](
          {
            err: error,
            org: (req.auth as { org?: string } | undefined)?.org,
            project: (req.auth as { project?: string } | undefined)?.project,
            httpRequestId: req.id,
          },
          'unhandled error on /v1',
        );
        if (status < 500) {
          // Exposed by design — `FST_ERR_VALIDATION` (400) and every
          // fastify-sensible `reply.badRequest()` / `reply.notFound()`. Their
          // message is written by us for the caller, and consumers parse the
          // flat `{statusCode, error, message}` envelope Fastify emits for
          // them. Rethrow so that envelope is what goes out, unchanged.
          throw error;
        }
        // ⚠ An unknown 5xx must NOT be rethrown. Fastify 5's
        // `fallbackErrorHandler` puts `error.message` AND `error.code` straight
        // on the body, so a `node-postgres` failure published its SQLSTATE and
        // the driver's message (schema names, constraint names, sometimes a
        // fragment of the failing row) to whoever made the request. That is the
        // same leak arm 3 exists to prevent, reached by a different door.
        //
        // The operator already has everything from the `error`-level line
        // above; the caller gets the generic envelope and nothing else.
        return reply
          .code(500)
          .send({ statusCode: 500, error: 'Internal Server Error', message: 'internal error' });
      });

      // Authenticated ping — confirms the bearer token resolved to a scope.
      // Real routes (generate, events, generate/sync, budget, ingest, ...) land here.
      v1.get('/', async (req) => ({
        v1: true,
        org: req.auth.org,
        project: req.auth.project,
      }));

      // Registry read + (admin-gated) write endpoints.
      await v1.register(registryRoutes, { prefix: '/registry' });

      // M3.6 — generation + events + budget routes.
      await v1.register(generateRoutes, { prefix: '/generate' });
      await v1.register(eventsRoutes, { prefix: '/events' });
      await v1.register(budgetRoutes, { prefix: '/budget' });

      // Tenant provisioning (admin) + readiness self-diagnosis (any role).
      // Turns the three unrelated-looking "this tenant was never provisioned"
      // failures — 401 / "no active registry entry" / 402 BudgetNotConfigured —
      // into one answer.
      await v1.register(tenantRoutes, { prefix: '/tenant' });

      // M4 — RAG: ingest + direct embed + retrieve.
      await v1.register(ingestRoutes, { prefix: '/ingest' });
      await v1.register(embedRoutes, { prefix: '/embed' });
      await v1.register(retrieveRoutes, { prefix: '/retrieve' });

      // Capability router — single cheap classification onto a caller-supplied
      // candidate list. Project-agnostic; fail-safe (never 5xx on a routable
      // request). Override prompt/model via the `capability-router` unit-type.
      await v1.register(routeRoutes, { prefix: '/route' });

      // Corpus lifecycle. `/corpora` is the CONTROL PLANE (create/list/get/
      // patch/delete); the singular `/corpus/:name` keeps the legacy
      // whole-corpus + single-document DELETE, alias POST, and validity PATCH.
      await v1.register(corporaRoutes, { prefix: '/corpora' });
      await v1.register(corpusRoutes, { prefix: '/corpus' });

      // Admin passthrough: OpenRouter account credits. Single platform-wide
      // OPENROUTER_API_KEY lives in ai-service; consumers hit this instead of OpenRouter directly.
      await v1.register(openrouterCreditsRoutes, { prefix: '/openrouter/credits' });

      // Callback dead-letter admin (manual replay + list). Gated by
      // requireAdmin inside the plugin.
      await v1.register(adminCallbacksRoutes, { prefix: '/admin/callbacks' });

      // Test-only endpoints (e2e). `internalRoutesEnabled` is the SAME
      // predicate `openapi/route-table.ts` uses to decide whether to declare
      // the path, so the document and the server cannot disagree.
      if (internalRoutesEnabled(config.NODE_ENV)) {
        await v1.register(internalRoutes, { prefix: '/internal' });
      }
    },
    { prefix: '/v1' },
  );

  return app;
}
