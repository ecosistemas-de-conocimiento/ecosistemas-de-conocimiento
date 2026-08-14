// /v1/openrouter/credits — admin-only passthrough to OpenRouter's account
// credits endpoint.
//
// Why this lives in ai-service (not the consumer):
//   - The OPENROUTER_API_KEY is platform infra, owned by ai-service. Letting
//     consumers (a prototype admin pages, …) hit OpenRouter directly forces every
//     consumer to hold the key, which violates the "one process holds the
//     LLM provider credentials" invariant that the OpenRouter HTTP adapter
//     comment (`adapters/openrouter.ts`) codifies.
//   - Caching lives here too (see `services/ai/openrouter-credits.ts`).
//
// Auth: admin role on the bearer token (enforced via `app.requireAdmin`).

import type { FastifyPluginAsync } from 'fastify';

import {
  fetchOpenRouterCredits,
  OpenRouterCreditsError,
} from '../services/ai/openrouter-credits.js';

const openrouterCreditsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAdmin }, async (req, reply) => {
    try {
      return await fetchOpenRouterCredits();
    } catch (err) {
      if (err instanceof OpenRouterCreditsError) {
        req.log.error(
          { status: err.status, body: err.bodySnippet },
          'openrouter credits passthrough failed (upstream non-2xx)',
        );
        return reply
          .code(503)
          .send({ error: 'openrouter_unreachable', message: err.message });
      }
      if (err instanceof Error && /OpenRouter API key missing/i.test(err.message)) {
        req.log.error({ err }, 'openrouter credits passthrough — key not configured');
        return reply
          .code(503)
          .send({ error: 'openrouter_not_configured', message: err.message });
      }
      req.log.error({ err }, 'openrouter credits passthrough — unexpected error');
      return reply
        .code(503)
        .send({ error: 'openrouter_unreachable', message: 'OpenRouter request failed' });
    }
  });
};

export default openrouterCreditsRoutes;
