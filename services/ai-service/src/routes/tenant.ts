// /v1/tenant/* — provisioning + readiness for the calling tenant.
//
//   GET  /v1/tenant/readiness  — any authenticated role. Answers "what am I
//        missing?" in plain words. Deliberately NOT admin-gated: the whole
//        point is that the consumer hitting the 401/400/402 can self-diagnose
//        without waiting on an operator. It reports only the caller's own
//        scope, and only facts that scope can already read elsewhere
//        (`GET /v1/budget/:org`, `GET /v1/registry/unit-types`).
//
//   POST /v1/tenant/provision  — admin only, same gate as the registry write
//        endpoints. Sets up budget + registry entries in one idempotent call.
//
// Both derive `{org, project}` from `req.auth` — never from the body. See
// `src/services/tenant/provision.ts` for the tenancy invariant note.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { provisionTenantRequestSchema } from '../contract/tenant.js';
import {
  getTenantReadiness,
  provisionTenant,
} from '../services/tenant/provision.js';

const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { unitType?: string } }>('/readiness', async (req) => {
    return getTenantReadiness(db, {
      org: req.auth.org,
      project: req.auth.project,
      role: req.auth.role,
      unitType: req.query?.unitType,
    });
  });

  app.post('/provision', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = provisionTenantRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return provisionTenant(
      db,
      {
        org: req.auth.org,
        project: req.auth.project,
        role: req.auth.role,
        actorKeyId: req.auth.apiKeyId,
      },
      parsed.data,
    );
  });
};

export default tenantRoutes;
