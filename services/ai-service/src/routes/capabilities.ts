// GET /v1/capabilities — the capability document (ADR-0004).
//
// Mounted OUTSIDE the `requireAuth` block, alongside `/v1/openapi.json`, for
// three reasons:
//   1. It is a contract document, not tenant data. `/v1/openapi.json` already
//      describes this whole surface publicly; the capability names leak
//      strictly less than the spec does.
//   2. A consumer must be able to tell "ai-service lacks capability X" apart
//      from "my API key is wrong". Behind auth, a misconfigured key would
//      surface as a capability failure and send the operator down the wrong
//      path — the opposite of the actionable error this ADR is about.
//   3. The check runs at boot, before any tenant context exists.
//
// `no-store` is deliberate: a cached answer from a proxy could report the
// capabilities of a PREVIOUS deployment, which is precisely the stale-state
// mistake the negotiation exists to catch.

import type { FastifyPluginAsync } from 'fastify';

import { getCapabilityDocument } from '../capabilities.js';

const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/capabilities', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getCapabilityDocument();
  });
};

export default capabilitiesRoutes;
