// /v1/admin/callbacks/* — admin endpoints for the callback-emit dead-letter
// queue. The contract doc specifies a manual replay flow when:
//   - a callback 401'd because of a secret-rotation race
//   - a callback dead-lettered after exhausting retries
//   - a consumer recovered from an outage and needs to replay missed events
//
// Auth: admin role required (gated by `requireAdmin` at the /v1 surface).

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { callbackDeliveries } from '../db/schema/index.js';
import { replayDelivery } from '../services/callbacks/emit.js';
import { and, desc, eq } from 'drizzle-orm';

const adminCallbacksRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  // -------------------------------------------------------------------------
  // POST /v1/admin/callbacks/:deliveryId/replay — re-fire a single delivery.
  //
  // Body (optional): `{ resign?: boolean }`. When `resign=true`, we recompute
  // timestamp + signature against the current `env.API_KEYS[<key>].callbackSecret`
  // and the current clock — the usual case after a secret rotation or after
  // the ±300s receiver skew window has expired. When `resign=false` (default),
  // we replay the exact stored bytes — useful for testing the receiver's
  // dedupe behaviour.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { deliveryId: string };
    Body: { resign?: boolean } | undefined;
  }>('/:deliveryId/replay', async (req, reply) => {
    const body = req.body ?? {};
    // Tenant isolation (audit finding [HIGH] IDOR): admin is a PER-TENANT
    // role — a delivery belonging to another org must be indistinguishable
    // from a missing one, and must not be re-fireable across tenants.
    const owned = await db
      .select({ org: callbackDeliveries.org })
      .from(callbackDeliveries)
      .where(eq(callbackDeliveries.id, req.params.deliveryId))
      .limit(1);
    if (!owned[0] || owned[0].org !== req.auth.org) {
      return reply.notFound(`delivery ${req.params.deliveryId} not found`);
    }
    const result = await replayDelivery(req.params.deliveryId, {
      resign: body.resign ?? true,
    });
    if (!result.ok) {
      if (result.reason === 'not-found') {
        return reply.notFound(`delivery ${req.params.deliveryId} not found`);
      }
      return reply.badRequest(result.reason);
    }
    return { deliveryId: req.params.deliveryId, status: result.status };
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/callbacks — list recent deliveries, optionally filtered by
  // status / source / source_id. Helper for ops dashboards.
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      status?: string;
      source?: 'generate' | 'ingest';
      sourceId?: string;
      limit?: number;
    };
  }>('/', async (req) => {
    const q = req.query;
    // Tenant isolation (audit finding [HIGH] IDOR): ALWAYS scope the listing
    // to the caller's org — delivery rows carry other tenants' callback
    // envelopes (generated output), endpoints, and response excerpts.
    const conditions = [eq(callbackDeliveries.org, req.auth.org)] as ReturnType<
      typeof eq
    >[];
    if (q.status) {
      conditions.push(
        eq(
          callbackDeliveries.status,
          q.status as typeof callbackDeliveries.$inferSelect.status,
        ),
      );
    }
    if (q.source) {
      conditions.push(eq(callbackDeliveries.source, q.source));
    }
    if (q.sourceId) {
      conditions.push(eq(callbackDeliveries.sourceId, q.sourceId));
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const rows = await db
      .select()
      .from(callbackDeliveries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(callbackDeliveries.createdAt))
      .limit(limit);
    return { deliveries: rows };
  });
};

export default adminCallbacksRoutes;
