// /v1/events/:channel — Server-Sent Events stream over the in-process bus.
//
// Channel format: `request:<requestId>:generations`. The handler validates
// the format, asserts the caller owns the underlying `generation_requests`
// row (cross-tenant + missing both surface as 403 BEFORE any byte is
// written — no existence-leak via the SSE stream), then `reply.hijack()`s the
// connection and forwards bus events whose `requestId` matches.
//
// A 15s `: ping\n\n` heartbeat keeps the socket alive through idle reverse
// proxies. Cleanup on `reply.raw.on('close')` clears the interval, unsubscribes
// from the bus, and ends the underlying socket.

import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { generationRequests } from '../db/schema/index.js';
import { getEventBus } from '../services/events/bus.js';
import type { AppEvent } from '../services/events/types.js';

const CHANNEL_RE = /^request:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):generations$/i;

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { channel: string } }>('/:channel', async (req, reply) => {
    const match = CHANNEL_RE.exec(req.params.channel);
    if (!match) {
      return reply.badRequest(
        `invalid channel '${req.params.channel}' — expected 'request:<uuid>:generations'`,
      );
    }
    const requestId = match[1]!;

    // Existence + cross-tenant check BEFORE any byte hits the wire.
    const rows = await db
      .select({ id: generationRequests.id })
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.id, requestId),
          eq(generationRequests.org, req.auth.org),
          eq(generationRequests.project, req.auth.project),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return reply.forbidden(`access to channel '${req.params.channel}' denied`);
    }

    // SSE headers, then take over the underlying socket.
    // 🔴 `x-request-id` GOES ON `reply.raw`. The `onRequest` hook in
    // `server.ts` sets it through `reply.header(...)`, which only reaches the
    // wire via Fastify's serializer — and `reply.hijack()` below skips that, so
    // this route answered with no correlation id at all. A long-lived SSE
    // stream is precisely where a consumer needs one.
    reply.raw.setHeader('x-request-id', req.id);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.write(': ok\n\n');

    const bus = getEventBus();
    let closed = false;

    const onEvent = (event: AppEvent): void => {
      if (closed) return;
      // Only forward events whose `requestId` matches the subscribed channel.
      // Some event variants (`trace.*`) don't carry a requestId; skip those.
      const eventRequestId = (event as { requestId?: string }).requestId;
      if (eventRequestId !== requestId) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        cleanup();
      }
    };

    const unsubscribe = bus.onAny(onEvent);

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 15_000);
    // Don't hold the event loop open just for a long-lived SSE socket; the
    // connection itself anchors lifetime via `reply.raw.on('close')`.
    heartbeat.unref?.();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };

    // Lifetime hangs off the CONNECTION (`reply.raw`), not the request stream.
    // `req.raw`'s `'close'` reports the request BODY being consumed; for this
    // body-less GET it happens to coincide with the hang-up, but the same
    // listener on POST /v1/route fired mid-call and turned every call into a
    // 499 (ai-reality-audit). One rule for every route: see
    // generate.ts. The `req.raw` `'error'` (ECONNRESET on a reset socket) stays
    // as a second trigger; `cleanup` is idempotent.
    reply.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
};

export default eventsRoutes;
