// /v1/retrieve — cosine top-K (optionally MMR-reranked) over a project's
// corpus. Mirrors the registry/generate route style: Zod-validate the body,
// hand off to the service, map typed errors to HTTP responses.

import type { FastifyPluginAsync } from 'fastify';

import { env, rerankModelRefusal } from '../config/env.js';
import { db } from '../db/client.js';
import { GENERATE_RATE_LIMIT_MAX, V1_RATE_LIMIT_WINDOW } from '../server-limits.js';
import { retrieveMultiRequestSchema, retrieveRequestSchema } from '../contract/rag.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { RetrieveService } from '../services/rag/retrieve.js';
import { RetrieveMultiService } from '../services/rag/retrieve-multi.js';

/**
 * A per-request `rerankModel` outside the rerank allowlist (`DEEPINFRA_RERANK_MODELS`
 * in `config/env.ts`) is a 400, not a silent fallback: the rung fails safe, so
 * letting it through would degrade quietly — or, for a model DeepInfra proxies to
 * Google/Anthropic, send the pool under terms that void no-training/no-sharing.
 * `callRerank` repeats the check before any network call; this one makes the
 * refusal visible to the caller.
 */
function refusedRerankModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  return rerankModelRefusal(env.RERANK_PROVIDER, model);
}

const retrieveRoutes: FastifyPluginAsync = async (app) => {
  // Both routes meter the query embed and the rerank against the org cap
  // (AIS-7). A refused reserve throws the budget classes, which the /v1 error
  // handler answers with the same 402 body `/v1/generate/sync` sends.
  const budget = new BudgetEnforcer(db);
  const service = new RetrieveService({ db, logger: app.log, budget });
  const multiService = new RetrieveMultiService({ db, logger: app.log, budget });

  app.post('/', async (req, reply) => {
    const parsed = retrieveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const modelRefusal = refusedRerankModel(parsed.data.rerankModel);
    if (modelRefusal) return reply.badRequest(modelRefusal);
    // No `catch`. This route used to answer `CorpusNotFoundError` with
    // `reply.notFound(err.message)`, i.e. fastify-sensible's flat
    // `{statusCode, error: 'Not Found', message}` — while `/v1/corpora` and
    // `/v1/corpus` answered the SAME class with its own nested
    // `{error:{code:'CORPUS_NOT_FOUND', message}}`. One class, two envelopes.
    // The class wins: same 404, same message, one shape everywhere.
    //
    // Cross-tenant access (a corpus owned by another org/project) still lands
    // on this class — the lookup filters by `{org, project, name}`, so a
    // missing row is indistinguishable from a foreign row by design.
    return service.retrieve(parsed.data, {
      org: req.auth.org,
      project: req.auth.project,
    });
  });

  // POST /v1/retrieve/multi — fan out across N corpora + fuse, with an optional
  // cheap query-rewrite step. A missing/erroring corpus never 404s the whole
  // call (it lands in the response's `corpora` diagnostics), so there is no
  // CorpusNotFoundError to map here. A budget refusal DOES fail the whole call
  // (402): the org cannot pay for any corpus. The tighter generate-tier rate limit
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
      const modelRefusal = refusedRerankModel(parsed.data.rerankModel);
      if (modelRefusal) return reply.badRequest(modelRefusal);
      return multiService.retrieveMulti(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
      });
    },
  );
};

export default retrieveRoutes;
