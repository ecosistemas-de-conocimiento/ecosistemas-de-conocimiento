// /v1/corpora — the corpus CONTROL PLANE.
//
//   POST   /v1/corpora        create a corpus with an explicit config
//   GET    /v1/corpora        list the caller's corpora (+ doc/chunk counts)
//   GET    /v1/corpora/:name  introspect one (config + counts; resolves aliases)
//   PATCH  /v1/corpora/:name  reconfigure
//   DELETE /v1/corpora/:name  delete (chunks → documents → corpora cascade)
//
// This is the explicit alternative to "corpus auto-creates on first ingest, and
// whoever writes first silently decides its config". Auto-create-on-ingest is
// UNCHANGED — this surface is additive, so existing consumers are unaffected.
//
// Auth: APP-ROLE, scoped to the caller's `(org, project)` from `req.auth`
// (never the body) — symmetric with `/v1/ingest`, `/v1/retrieve` and the
// existing `DELETE /v1/corpus/:name`. A consumer manages its OWN corpora with
// its own key; making this admin-only would force an admin credential (which
// can touch ANY tenant) just to configure one's own corpus — a least-privilege
// violation. Cross-tenant isolation is enforced by SCOPE: a corpus in another
// tenant is indistinguishable from a missing one.
//
// The singular `/v1/corpus/:name` routes (whole-corpus DELETE, single-document
// DELETE, alias POST, document-validity PATCH) are left in place for backward
// compatibility. DELETE exists at BOTH `/v1/corpus/:name` and
// `/v1/corpora/:name`; both are app-role and share `CorpusDeleteService`.

import type { FastifyPluginAsync } from 'fastify';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { corpusCreateSchema, corpusUpdateSchema } from '../contract/rag.js';
import { CorpusService } from '../services/rag/corpus-crud.js';
import { CorpusDeleteService } from '../services/rag/corpus-delete.js';

const corporaRoutes: FastifyPluginAsync = async (app) => {
  const service = new CorpusService({ db });
  const deleteService = new CorpusDeleteService({ db });

  // POST /v1/corpora — create.
  app.post('/', async (req, reply) => {
    const parsed = corpusCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    // No `catch`. Every error `createCorpus` raises is a taxonomy class that
    // declares its own status and body, and the ONE /v1 error handler sends
    // it. `EmbeddingDimensionMismatchError` used to be caught here and
    // re-sent via `reply.badRequest`, which replaced the discriminator with
    // fastify-sensible's generic `error: 'Bad Request'` — same 400, but no
    // `error`/`code` for a consumer to branch on. See the `changed vs 970baae`
    // block in `src/errors/wire-golden.test.ts`.
    const corpus = await service.createCorpus(
      parsed.data,
      { org: req.auth.org, project: req.auth.project },
      { embeddingModel: env.EMBEDDING_MODEL, embeddingDim: env.EMBEDDING_DIM },
    );
    req.log.info(
      { org: req.auth.org, project: req.auth.project, corpus: corpus.name },
      'corpus created',
    );
    return reply.code(201).send(corpus);
  });

  // GET /v1/corpora — list.
  app.get('/', async (req) => {
    const corpora = await service.listCorpora({
      org: req.auth.org,
      project: req.auth.project,
    });
    return { corpora };
  });

  // GET /v1/corpora/:name — introspect (resolves an alias to its target).
  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const name = req.params.name;
    if (!name || name.length === 0) return reply.badRequest('corpus name is required');
    const corpus = await service.getCorpus(name, {
      org: req.auth.org,
      project: req.auth.project,
    });
    if (!corpus) {
      return reply
        .code(404)
        .send({ error: { code: 'CORPUS_NOT_FOUND', message: `corpus '${name}' not found` } });
    }
    return corpus;
  });

  // PATCH /v1/corpora/:name — reconfigure.
  app.patch<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const name = req.params.name;
    if (!name || name.length === 0) return reply.badRequest('corpus name is required');
    const parsed = corpusUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.badRequest('patch body must contain at least one field to change');
    }
    // No `catch` — see POST above. `InvalidTextSearchConfigError` and
    // `EmbeddingDimensionMismatchError` used to be flattened here;
    // `CorpusNotFoundError`, `EmbeddingModelChangeNotAllowedError` and
    // `ChunkSizeShrinkNotAllowedError` were already answered by the /v1
    // handler and are unchanged.
    const corpus = await service.updateCorpus(
      name,
      parsed.data,
      { org: req.auth.org, project: req.auth.project },
      { embeddingDim: env.EMBEDDING_DIM },
    );
    req.log.info(
      { org: req.auth.org, project: req.auth.project, corpus: name },
      'corpus reconfigured',
    );
    return corpus;
  });

  // DELETE /v1/corpora/:name — delete (shares CorpusDeleteService with the
  // legacy /v1/corpus/:name route). 200 + counts on the first delete, 404
  // thereafter (idempotent at-most-once for consumers that treat 404 as a no-op).
  app.delete<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const name = req.params.name;
    if (!name || name.length === 0) return reply.badRequest('corpus name is required');
    const result = await deleteService.deleteCorpus(name, {
      org: req.auth.org,
      project: req.auth.project,
    });
    if (!result.matched) {
      return reply
        .code(404)
        .send({ error: { code: 'CORPUS_NOT_FOUND', message: `corpus '${name}' not found` } });
    }
    req.log.info(
      { org: req.auth.org, project: req.auth.project, corpus: name, deleted: result.deleted },
      'corpus deleted',
    );
    return { deleted: result.deleted };
  });
};

export default corporaRoutes;
