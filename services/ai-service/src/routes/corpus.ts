// /v1/corpus/:name — corpus lifecycle endpoints for a single corpus.
//
// Today: `DELETE /v1/corpus/:name` (whole corpus) and
// `DELETE /v1/corpus/:name/documents/:externalId` (single document). The
// consuming app leans on these to clean up its own corpora/documents on
// re-seed and on live delete (RAG hygiene).
// The orphan-cleanup janitor (Sa-2, deferred) will share the underlying
// service so cleanup stays consistent across the manual and automated paths.
//
// Auth: the two tenant-scoped DELETE routes are APP-ROLE (the standard
// per-project bearer token inherited from `requireAuth` at the /v1 parent),
// symmetric with `ingest`/`retrieve`. Rationale: forcing a consumer to hold an
// admin credential just to prune its own corpus violates least-privilege (an
// admin key can wipe ANY tenant's corpus). Isolation is enforced by SCOPE, not
// role: the same `(org, project)` from the caller's `req.auth` scopes the
// lookup, so there is no cross-tenant delete. The corpora row is matched by
// `(org, project, name)`; a corpus owned by a different org or project is
// indistinguishable from a missing one at this surface (same no-info-leak
// posture as `/v1/retrieve`). The `POST /:name/alias` lifecycle op below stays
// admin-only via a per-route `requireAdmin` preHandler.
//
// Idempotency choice: the FIRST delete on a populated corpus returns 200 with
// non-zero counts. The FIRST delete on a name that never existed (or has
// already been deleted) returns 404 with `{ error: { code: 'CORPUS_NOT_FOUND' } }`.
// A re-issue of the now-deleted corpus is therefore a 404 too — that's the
// honest answer to "does this corpus exist?" and it makes the contract simple
// to reason about: 200 means "deleted, here are the counts", 404 means "there
// was nothing to delete". Consumers that want idempotent at-most-once delete
// semantics can treat 404 as a successful no-op.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { corpusAliasRequestSchema, documentValiditySchema } from '../schemas/rag.js';
import {
  AliasNameConflictError,
  CorpusAliasService,
  TargetCorpusNotFoundError,
} from '../services/rag/corpus-alias.js';
import { CorpusDeleteService } from '../services/rag/corpus-delete.js';
import { DocumentDeleteService } from '../services/rag/document-delete.js';
import {
  CorpusNotFoundError as ValidityCorpusNotFoundError,
  DocumentNotFoundError,
  DocumentValidityService,
  InvalidValidityIntervalError,
} from '../services/rag/document-validity.js';

const corpusRoutes: FastifyPluginAsync = async (app) => {
  // No plugin-wide admin gate: the DELETE routes below are app-role, scoped to
  // the caller's `(org, project)` (see file header). `requireAuth` already ran
  // at the /v1 parent, so `req.auth` is populated for every route here. The
  // alias POST re-adds `requireAdmin` on its own route.

  const service = new CorpusDeleteService({ db });
  const documentService = new DocumentDeleteService({ db });
  const aliasService = new CorpusAliasService({ db });
  const validityService = new DocumentValidityService({ db });

  // PATCH /:name/documents/:externalId/validity — retire or un-retire an
  // ingested document WITHOUT re-embedding it. App-role and `(org, project)`
  // scoped, exactly like the DELETE routes: a consumer must be able to keep
  // its own corpus temporally honest using its own credential. Making this
  // admin-only would push consumers toward the "just leave the stale document
  // retrievable" path, which is the failure this whole feature exists to
  // prevent.
  app.patch<{ Params: { name: string; externalId: string } }>(
    '/:name/documents/:externalId/validity',
    async (req, reply) => {
      const { name, externalId } = req.params;
      if (!name || name.length === 0) return reply.badRequest('corpus name is required');
      if (!externalId || externalId.length === 0) {
        return reply.badRequest('document externalId is required');
      }
      const parsed = documentValiditySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      if (parsed.data.validFrom === undefined && parsed.data.validTo === undefined) {
        return reply.badRequest('at least one of validFrom / validTo must be provided');
      }
      try {
        const result = await validityService.setValidity(
          {
            corpus: name,
            externalId,
            ...(parsed.data.validFrom !== undefined ? { validFrom: parsed.data.validFrom } : {}),
            ...(parsed.data.validTo !== undefined ? { validTo: parsed.data.validTo } : {}),
          },
          { org: req.auth.org, project: req.auth.project },
        );
        req.log.info(
          {
            org: req.auth.org,
            project: req.auth.project,
            corpus: name,
            externalId,
            chunksUpdated: result.chunksUpdated,
            validFrom: result.validFrom,
            validTo: result.validTo,
          },
          'document validity updated',
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ValidityCorpusNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'CORPUS_NOT_FOUND', message: err.message } });
        }
        if (err instanceof DocumentNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'DOCUMENT_NOT_FOUND', message: err.message } });
        }
        if (err instanceof InvalidValidityIntervalError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/:name',
    async (req, reply) => {
      const name = req.params.name;
      if (!name || name.length === 0) {
        return reply.badRequest('corpus name is required');
      }
      const result = await service.deleteCorpus(name, {
        org: req.auth.org,
        project: req.auth.project,
      });
      if (!result.matched) {
        return reply.code(404).send({
          error: { code: 'CORPUS_NOT_FOUND', message: `corpus '${name}' not found` },
        });
      }
      req.log.info(
        {
          org: req.auth.org,
          project: req.auth.project,
          corpus: name,
          deleted: result.deleted,
        },
        'corpus deleted',
      );
      return { deleted: result.deleted };
    },
  );

  // Delete a SINGLE document (by consumer external id) + its chunks, leaving the
  // corpus and sibling documents intact. Covers the doc-removed-entirely case
  // that re-ingest can't express (re-ingest of a stable external id replaces a
  // doc's chunks; it has no way to say "this doc no longer exists"). Same
  // scoping + idempotency posture as the corpus delete above: 200 with counts
  // on a real delete, 404 when the corpus or the document doesn't exist.
  app.delete<{ Params: { name: string; externalId: string } }>(
    '/:name/documents/:externalId',
    async (req, reply) => {
      const { name, externalId } = req.params;
      if (!name || name.length === 0) {
        return reply.badRequest('corpus name is required');
      }
      if (!externalId || externalId.length === 0) {
        return reply.badRequest('document externalId is required');
      }
      const result = await documentService.deleteDocument(name, externalId, {
        org: req.auth.org,
        project: req.auth.project,
      });
      if (result.notFound === 'corpus') {
        return reply.code(404).send({
          error: { code: 'CORPUS_NOT_FOUND', message: `corpus '${name}' not found` },
        });
      }
      if (result.notFound === 'document') {
        return reply.code(404).send({
          error: {
            code: 'DOCUMENT_NOT_FOUND',
            message: `document '${externalId}' not found in corpus '${name}'`,
          },
        });
      }
      req.log.info(
        {
          org: req.auth.org,
          project: req.auth.project,
          corpus: name,
          externalId,
          deleted: result.deleted,
        },
        'document deleted',
      );
      return { deleted: result.deleted };
    },
  );

  // Create or repoint a corpus ALIAS — a cheap, re-embed-free rolling pointer
  // (the `:latest` use-case). `POST /v1/corpus/:name/alias` with body
  // `{ target: "<existing-corpus-name>" }` makes `:name` resolve to the same
  // chunks as `target` for retrieval, without re-embedding. Idempotent:
  //   - 201 the first time (alias created),
  //   - 200 on a repoint (target swapped, atomic single-row UPDATE).
  // Scoped to the caller's (org, project): the target must live in the same
  // tenant (404 TARGET_CORPUS_NOT_FOUND otherwise) and an alias name may not
  // collide with a real corpus name (409 ALIAS_NAME_CONFLICT). Admin only
  // (per-route `requireAdmin` preHandler) — repointing a shared `:latest`
  // pointer is a privileged lifecycle op, distinct from a tenant pruning its
  // own rows. See src/services/rag/corpus-alias.ts for the target-delete
  // semantics (FK cascade → dangling alias 404s on retrieve).
  app.post<{ Params: { name: string } }>(
    '/:name/alias',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
    const name = req.params.name;
    if (!name || name.length === 0) {
      return reply.badRequest('alias name is required');
    }
    const parsed = corpusAliasRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    if (parsed.data.target === name) {
      return reply.badRequest('alias target must differ from the alias name');
    }
    try {
      const result = await aliasService.setAlias(name, parsed.data.target, {
        org: req.auth.org,
        project: req.auth.project,
      });
      req.log.info(
        {
          org: req.auth.org,
          project: req.auth.project,
          alias: result.alias,
          target: result.target,
          created: result.created,
        },
        'corpus alias set',
      );
      return reply.code(result.created ? 201 : 200).send({
        alias: result.alias,
        target: result.target,
        targetCorpusId: result.targetCorpusId,
        created: result.created,
      });
    } catch (err) {
      if (err instanceof TargetCorpusNotFoundError) {
        return reply.code(404).send({
          error: {
            code: 'TARGET_CORPUS_NOT_FOUND',
            message: `target corpus '${parsed.data.target}' not found`,
          },
        });
      }
      if (err instanceof AliasNameConflictError) {
        return reply.code(409).send({
          error: {
            code: 'ALIAS_NAME_CONFLICT',
            message: `'${name}' already names a corpus; alias names cannot collide with corpora`,
          },
        });
      }
      throw err;
    }
  });
};

export default corpusRoutes;
