import rateLimitPlugin from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { env } from './config/env.js';
import { authPlugin } from './plugins/auth.js';
import adminCallbacksRoutes from './routes/admin-callbacks.js';
import budgetRoutes from './routes/budget.js';
import capabilitiesRoutes from './routes/capabilities.js';
import corporaRoutes from './routes/corpora.js';
import corpusRoutes from './routes/corpus.js';
import embedRoutes from './routes/embed.js';
import eventsRoutes from './routes/events.js';
import generateRoutes from './routes/generate.js';
import internalRoutes from './routes/internal.js';
import { healthRoutes } from './routes/health.js';
import ingestRoutes from './routes/ingest.js';
import openapiRoutes from './routes/openapi.js';
import openrouterCreditsRoutes from './routes/openrouter-credits.js';
import registryRoutes from './routes/registry.js';
import retrieveRoutes from './routes/retrieve.js';
import routeRoutes from './routes/route.js';
import tenantRoutes from './routes/tenant.js';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  V1_DEFAULT_RATE_LIMIT_MAX,
  V1_RATE_LIMIT_WINDOW,
} from './server-limits.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // The container runtime captures stdout; keep it JSON in prod, pretty is opt-in via tooling.
      redact: ['req.headers.authorization'],
    },
    trustProxy: true,
    disableRequestLogging: false,
    // Global request-body cap (see `server-limits.ts`). Per-route overrides
    // land on the route options below; this is the floor for anything that
    // doesn't declare its own `bodyLimit`.
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  await app.register(sensible);
  await app.register(authPlugin);

  // Health / readiness — unauthenticated.
  await app.register(healthRoutes);

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
      v1.addHook('preHandler', app.requireAuth);

      // Rate limiting for the whole /v1 surface. TWO registrations, because
      // there are two different jobs here and one hook cannot do both.
      //
      // 🔴 The bug this shape exists to prevent. There used to be ONE
      // registration, with `keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip`
      // and a comment claiming it limited "per API key". It never did.
      // `@fastify/rate-limit` installs its hook at `onRequest` unless told
      // otherwise; `requireAuth` (added above) is a `preHandler`, which runs
      // strictly later. So `req.auth` was always undefined and the key was
      // always `req.ip` — the "fallback" was the only path that ever ran.
      // Every consumer behind one egress address shared one bucket; in docker
      // compose that is an entire backend container, and one batch job could
      // refuse every other caller it shipped alongside.
      //
      // ⚠ This is about WHICH BUCKET, not how big. Both registrations use the
      // same numbers the single one used, and route-level `config.rateLimit`
      // overrides (POST /v1/generate{,/sync}, /v1/route, /v1/retrieve/multi)
      // are picked up by BOTH — the plugin reads them from the route's own
      // config, so the tighter generate cap still applies to each bucket.
      //
      // ⚠ This does NOT give per-tenant fairness. Consumers authenticate with
      // one API key each, and the ecosistemas backend uses a single
      // `AI_SERVICE_API_KEY` for every ecosistema it serves — so all of them
      // still land in one key bucket. Splitting a key per tenant is separate
      // work; do not read this as tenant isolation.
      const rateLimitNumbers = {
        max: V1_DEFAULT_RATE_LIMIT_MAX,
        timeWindow: V1_RATE_LIMIT_WINDOW,
        // The plugin `throw`s whatever this returns; Fastify reads
        // `statusCode` off the thrown value to pick the response code.
        // Returning a plain object would land as a 500 (no statusCode);
        // returning an Error with `statusCode` set gives us the 429 the
        // contract documents, with our custom body shape preserved by
        // `setErrorHandler` below. Shared by both registrations so a 429 looks
        // identical to a consumer whichever bucket refused it.
        errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number; statusCode: number }) => {
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
      };

      // 1. PRE-AUTH, per source address, at `onRequest`. Runs before any token
      //    is parsed, which is the point: it is the ceiling on anonymous
      //    floods and on credential guessing, both of which are refused by
      //    `requireAuth` yet still consume this bucket.
      //
      //    ⚠ `req.ip` honours `x-forwarded-for` because the Fastify instance
      //    above is built with `trustProxy: true`, which trusts EVERY hop. A
      //    caller reaching ai-service directly can therefore pick its own
      //    bucket by sending that header. Narrowing `trustProxy` to the known
      //    ingress is a separate change with its own blast radius.
      await v1.register(rateLimitPlugin, {
        ...rateLimitNumbers,
        hook: 'onRequest',
        keyGenerator: (req) => req.ip,
      });

      // 2. POST-AUTH, per API key, at `preHandler`. Fastify runs
      //    instance-level `preHandler` hooks (that is `requireAuth`, added at
      //    the top of this scope) before the route-level ones the plugin
      //    installs, so `req.auth` is populated by the time this key generator
      //    runs. That ordering is the entire fix — verified behaviourally in
      //    `src/routes/limits.test.ts`, not by reading this config.
      //
      //    What it buys: a key's allowance is now the key's, wherever the
      //    requests come from. One key spread over N addresses used to get N
      //    times the quota; it now gets one.
      //
      //    ⚠ What it does NOT buy: relief from a noisy neighbour on the SAME
      //    address. Both buckets carry the same numbers, and the per-IP bucket
      //    counts a superset of the traffic, so it is the one that bites first
      //    whenever two keys share an egress IP. Making per-key fairness bite
      //    there means loosening the per-IP ceiling — a deliberate numbers
      //    decision nobody has taken.
      await v1.register(rateLimitPlugin, {
        ...rateLimitNumbers,
        hook: 'preHandler',
        // `requireAuth` has already replied 401 for anything that fails to
        // authenticate, so this hook only ever sees a resolved `req.auth`. The
        // `??` is a crash guard, not a code path — unlike the version this
        // replaced, where it was the only path.
        keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip,
      });

      // Surface the typed fields above (`error`, `retryAfterMs`) on the JSON
      // response. Fastify's default error serializer drops anything that
      // isn't `statusCode`/`message`, so we re-shape 429s in place. Any other
      // error class is delegated to the default handler — the conditional
      // keeps existing 4xx/5xx mappings untouched.
      v1.setErrorHandler((error: unknown, _req, reply) => {
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
        throw error;
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
      // OPENROUTER_API_KEY lives in ai-service; consumers (a prototype admin page,
      // …) hit this instead of OpenRouter directly.
      await v1.register(openrouterCreditsRoutes, { prefix: '/openrouter/credits' });

      // Callback dead-letter admin (manual replay + list). Gated by
      // requireAdmin inside the plugin.
      await v1.register(adminCallbacksRoutes, { prefix: '/admin/callbacks' });

      // Test-only endpoints (e2e). Refuses to register in production via a
      // boot-time guard inside the plugin.
      if (process.env['NODE_ENV'] !== 'production') {
        await v1.register(internalRoutes, { prefix: '/internal' });
      }
    },
    { prefix: '/v1' },
  );

  return app;
}
