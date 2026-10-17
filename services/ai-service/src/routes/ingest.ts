// /v1/ingest/* — async ingest HTTP surface (decisions §13–§15).
//
// POST /              → enqueue a batch, return 202 + handle.
// GET  /:ingestId     → status snapshot; 404 `IngestNotFoundError` for an id
//                       that does not exist in the caller's org/project.
//
// The body is parsed by `ingestRequestSchema` (≤100 docs, ≤1MB text per doc,
// id ≤200 chars). The route never trusts org/project from the body — both
// come from `req.auth`.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { isAiServiceError } from '../errors/base.js';
import { IngestService } from '../services/rag/ingest.js';
import { ingestRequestSchema } from '../contract/rag.js';
import { INGEST_BODY_LIMIT_BYTES } from '../server-limits.js';

const ingestRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // POST /v1/ingest — enqueue a batch.
  //
  // 10 MiB body cap (vs. the global 1 MiB) so a single call can carry the
  // schema-permitted 100 documents × ~1 MB text without 413s. The rate limit
  // inherits the /v1 default (100/min/key) — embed work is cheap relative to
  // generate, but we still bound burst rate.
  // -------------------------------------------------------------------------
  app.post('/', { bodyLimit: INGEST_BODY_LIMIT_BYTES }, async (req, reply) => {
    const parsed = ingestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const service = new IngestService({ db, queue: app.runtime.queues.ingest });
    try {
      const result = await service.ingestBatch(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
        apiKeyId: req.auth.apiKeyId,
      });
      reply.code(202);
      return result;
    } catch (err) {
      // The two consumer faults this route used to catch —
      // `EmbeddingDimensionMismatchError` and the SSRF guard's
      // `CallbackUrlBlockedError` — are rethrown now. Both already declared
      // the same 400 the route was re-deciding; the difference is that the
      // /v1 handler sends the class's own body, so the discriminator and the
      // `ERR_` code survive to the caller instead of being replaced by
      // fastify-sensible's generic `error: 'Bad Request'`.
      //
      // The `catch` stays only for the LOG LEVEL: a consumer's own 400 is not
      // an ai-service fault, and logging it at `error` buries the real 5xx.
      if (!isAiServiceError(err)) req.log.error({ err }, 'ingest enqueue failed');
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/ingest/:ingestId — status from the `ingest_requests` row.
  //
  // An unknown id throws `IngestNotFoundError` (404) through the /v1 error
  // handler. Consumers' reconcilers poll here, so "never existed" must not
  // look like "still processing" (plan finding A11).
  // -------------------------------------------------------------------------
  app.get<{ Params: { ingestId: string } }>('/:ingestId', async (req) => {
    const service = new IngestService({ db, queue: app.runtime.queues.ingest });
    return service.getIngestStatus(req.params.ingestId, {
      org: req.auth.org,
      project: req.auth.project,
    });
  });
};

export default ingestRoutes;
