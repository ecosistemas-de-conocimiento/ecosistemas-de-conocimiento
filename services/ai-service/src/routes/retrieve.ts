// /v1/retrieve — cosine top-K (optionally MMR-reranked) over a project's
// corpus. Mirrors the registry/generate route style: Zod-validate the body,
// hand off to the service, map typed errors to HTTP responses.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { GENERATE_RATE_LIMIT_MAX, V1_RATE_LIMIT_WINDOW } from '../server-limits.js';
import { retrieveMultiRequestSchema, retrieveRequestSchema } from '../schemas/rag.js';
import { CorpusNotFoundError, RetrieveService } from '../services/rag/retrieve.js';
import { RetrieveMultiService } from '../services/rag/retrieve-multi.js';

const retrieveRoutes: FastifyPluginAsync = async (app) => {
  const service = new RetrieveService({ db, logger: app.log });
  const multiService = new RetrieveMultiService({ db, logger: app.log });

  app.post('/', async (req, reply) => {
    const parsed = retrieveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    try {
      const result = await service.retrieve(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
      });
      return result;
    } catch (err) {
      if (err instanceof CorpusNotFoundError) {
        // Cross-tenant access (corpus belongs to another org/project) lands
        // here too — the lookup filters by `{org, project, name}`, so a
        // missing row is indistinguishable from a foreign row by design.
        return reply.notFound(err.message);
      }
      throw err;
    }
  });

  // POST /v1/retrieve/multi — fan out across N corpora + fuse, with an optional
  // cheap query-rewrite step. A missing/erroring corpus never 404s the whole
  // call (it lands in the response's `corpora` diagnostics), so there is no
  // CorpusNotFoundError to map here. The tighter generate-tier rate limit
  // applies because the optional rewrite step can invoke the LLM.
  app.post(
    '/multi',
    {
      config: {
        rateLimit: { max: GENERATE_RATE_LIMIT_MAX, timeWindow: V1_RATE_LIMIT_WINDOW },
      },
    },
    async (req, reply) => {
      const parsed = retrieveMultiRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      return multiService.retrieveMulti(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
      });
    },
  );
};

export default retrieveRoutes;
