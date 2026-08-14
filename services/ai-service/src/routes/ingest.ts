// /v1/ingest/* — async ingest HTTP surface (decisions §13–§15).
//
// POST /              → enqueue a batch, return 202 + handle.
// GET  /:ingestId     → status snapshot computed from `documents` rows.
//
// The body is parsed by `ingestRequestSchema` (≤100 docs, ≤1MB text per doc,
// id ≤200 chars). The route never trusts org/project from the body — both
// come from `req.auth`.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { getIngestQueue } from '../queue/queues.js';
import { EmbeddingDimensionMismatchError } from '../services/rag/embedding-models.js';
import { IngestService } from '../services/rag/ingest.js';
import { ingestRequestSchema } from '../schemas/rag.js';
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
    const service = new IngestService({ db, queue: getIngestQueue() });
    try {
      const result = await service.ingestBatch(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
        apiKeyId: req.auth.apiKeyId,
      });
      reply.code(202);
      return result;
    } catch (err) {
      // A corpus asked for an embedding model whose dimension can't fit the
      // live vector column is a consumer configuration error, not a server
      // fault — surface it as a legible 400 rather than a 500 + retry storm.
      if (err instanceof EmbeddingDimensionMismatchError) {
        return reply.badRequest(err.message);
      }
      req.log.error({ err }, 'ingest enqueue failed');
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/ingest/:ingestId — status from `documents` row counts.
  // -------------------------------------------------------------------------
  app.get<{ Params: { ingestId: string } }>('/:ingestId', async (req) => {
    const service = new IngestService({ db, queue: getIngestQueue() });
    return service.getIngestStatus(req.params.ingestId, {
      org: req.auth.org,
      project: req.auth.project,
    });
  });
};

export default ingestRoutes;
