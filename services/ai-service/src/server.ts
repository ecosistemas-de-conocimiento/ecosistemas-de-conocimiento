import rateLimitPlugin from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';

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

      // Rate-limit the entire /v1 surface per API key (falls back to IP for
      // unauthenticated pre-handler failures). Routes that need a tighter cap
      // (e.g. POST /v1/generate{,/sync}) override via `config.rateLimit`.
      await v1.register(rateLimitPlugin, {
        max: V1_DEFAULT_RATE_LIMIT_MAX,
        timeWindow: V1_RATE_LIMIT_WINDOW,
        keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip,
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
