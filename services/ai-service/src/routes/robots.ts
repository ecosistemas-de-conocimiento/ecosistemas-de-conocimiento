// `GET /robots.txt` + the `X-Robots-Tag` response header.
//
// WHERE THIS IS MOUNTED, AND WHY IT MATTERS
// -----------------------------------------
// Registered on the ROOT instance in `server.ts`, deliberately outside the
// `/v1` encapsulation block. Three consequences, all of them the point:
//
//   1. NO AUTH. `requireAuth` is a `preHandler` added inside the `/v1` child
//      context (`server.ts`), so it never runs for a root-level route. A
//      crawler must be able to read the policy without a bearer token —
//      a 401 on `robots.txt` is functionally a missing robots.txt.
//   2. NO RATE LIMITING. `@fastify/rate-limit` is likewise registered INSIDE
//      the `/v1` context, so its `onRequest` hook is scoped to `/v1` and its
//      children. A crawler hammering `/robots.txt` therefore cannot exhaust
//      the 100/min bucket that a real consumer's API key depends on — and,
//      because the limiter keys on `req.auth.apiKeyId` with an IP fallback, it
//      could not attribute the hit to a tenant even if it did run.
//   3. NO METERING / NO BUDGET. Nothing global meters a request in this
//      service. Usage rows and budget reservations are written only by the
//      generation orchestrator, the generation/ingest workers and the embed
//      route — each explicitly, from an authenticated `{org, project}` scope.
//      A route with no auth context touches none of that and cannot spend a
//      tenant's budget.
//
// Keep this route at the root. Moving it under `/v1` would silently acquire
// all three of the behaviours above.

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { X_ROBOTS_TAG_NOINDEX, robotsTxtFor, shouldNoindex } from '../robots.js';

const robotsPlugin: FastifyPluginAsync = async (app) => {
  // `X-Robots-Tag` on every response. This service serves JSON, not HTML, so
  // there is no `<meta name="robots">` to emit — the header is the only layer
  // that can reach a JSON body, an OpenAPI document or the Swagger UI assets.
  //
  // `onRequest` (not `onSend`) so the header is staged before any handler runs,
  // including the error and 404 paths. Note the one gap by design: `/v1/events`
  // calls `reply.hijack()` and writes to `reply.raw`, which bypasses Fastify's
  // header map — an SSE stream carries no `X-Robots-Tag`. That surface is
  // auth-gated and unreachable to a crawler, so it is left alone rather than
  // reaching into `reply.raw` from a global hook.
  app.addHook('onRequest', async (req, reply) => {
    if (shouldNoindex(hostnameOf(req.hostname, req.headers.host))) {
      reply.header('X-Robots-Tag', X_ROBOTS_TAG_NOINDEX);
    }
  });

  app.get('/robots.txt', async (req, reply) => {
    // Real `text/plain`. A 200 carrying anything else — an HTML fallback, a
    // JSON error envelope — is worse than a 404: the crawler is handed a page
    // instead of a rule.
    return reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(robotsTxtFor(hostnameOf(req.hostname, req.headers.host)));
  });
};

/** Prefers Fastify's parsed hostname; falls back to the raw `Host` header. */
function hostnameOf(hostname: string | undefined, hostHeader: string | undefined): string {
  return hostname ?? hostHeader ?? '';
}

// `fp` so the `onRequest` hook lands on the ROOT context and covers every
// route registered after it — a plain (encapsulated) plugin would scope the
// hook to this plugin's own routes and leave `/v1` responses bare.
export default fp(robotsPlugin, { name: 'robots' });
