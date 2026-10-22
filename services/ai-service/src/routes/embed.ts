// /v1/embed — direct embedding pass-through onto OpenRouter's embeddings
// endpoint. Used by consumers who want to embed text without writing into a
// corpus (think: query-time embedding from a non-RAG consumer, or a debug
// probe). Logs a `usage_logs` row so the cost shows up in the budget view.
//
// Budget semantics (mirrors the chat router at
// `src/services/ai/router/router.ts`): bracket the embedder call with an
// atomic `BudgetEnforcer.reserve` *before* and a true-up `adjust` *after*,
// using a chars/4 token estimate for the pre-call cost. On embedder failure
// the full reserve is refunded. `BudgetExceeded` maps to 402 with the same
// body shape as `/v1/generate` (see `mapGenerateError` in `routes/generate.ts`).
//
// Default model is config-driven (`env.EMBEDDING_MODEL`, the open multilingual
// `baai/bge-m3` @ 1024-dim). The route is a thin wrapper; the adapter in
// `src/services/ai/embeddings/openrouter.ts` is the only place that talks to the
// provider.

import type { FastifyPluginAsync } from 'fastify';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { usageLogs } from '../db/schema/index.js';
import {
  callOpenRouterEmbedding,
  embeddingProviderLabel,
} from '../services/ai/embeddings/openrouter.js';
import { embedRequestSchema } from '../contract/rag.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { priceForEmbedding } from '../services/ai/router/task-profiles.js';

const DEFAULT_EMBEDDING_MODEL = env.EMBEDDING_MODEL;

/** chars/4 heuristic — the same one the chunker uses for pre-call estimates.
 *  Real token counts vary by model, but for budget reservation purposes a
 *  cheap deterministic upper bound is fine; the post-call `adjust` trues up
 *  against the provider-reported usage. */
function estimateInputTokens(input: string | string[]): number {
  const strs = Array.isArray(input) ? input : [input];
  let chars = 0;
  for (const s of strs) chars += s.length;
  return Math.ceil(chars / 4);
}

const embedRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const parsed = embedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const model = parsed.data.model ?? DEFAULT_EMBEDDING_MODEL;

    // 1. Pre-call estimate. chars/4 token estimate -> priceForEmbedding.
    const estimatedInputTokens = estimateInputTokens(parsed.data.input);
    const estimatedCost = priceForEmbedding(model, estimatedInputTokens);

    // 2. Atomic reserve. BudgetExceeded => 402 with the standard body.
    //    A `softCap: true` outcome means the reserve succeeded but the org is
    //    below the configured soft-cap remaining threshold; surface that as a
    //    top-level `warnings: [{ code: 'BUDGET_SOFT_CAP', ... }]` on the
    //    response. See `plan/budget-reset-followup.md`.
    const budget = new BudgetEnforcer(db);
    // A budget refusal is not caught here: the class declares `status = 402`
    // and its own body, and the /v1 error handler sends it.
    //
    // `BudgetNotConfigured` and `BudgetExceeded` are byte-for-byte what this
    // route used to build by hand in a two-arm `instanceof` catch.
    //
    // ⚠ DECLARED WIRE CHANGE — `BudgetMisconfigured` on this route only.
    // That third class was NOT in the old catch, so `reserve()` raising it
    // answered a Fastify generic 500. It now answers 402 with the same typed
    // body `/v1/generate` has always sent for it. This is the intended fix (a
    // config fault is a caller-actionable 402, not a server error) and it is
    // pinned in `src/errors/wire-golden.test.ts` → "changed vs main".
    const reserveResult = await budget.reserve({
      org: req.auth.org,
      amountUsd: estimatedCost,
    });

    // 3. Call the embedder. On any failure, refund the full reserve and rethrow.
    let result: Awaited<ReturnType<typeof callOpenRouterEmbedding>>;
    try {
      result = await callOpenRouterEmbedding({
        model,
        input: parsed.data.input,
      });
    } catch (err) {
      await budget.refund({ org: req.auth.org, amountUsd: estimatedCost });
      throw err;
    }

    // 4. True-up against the provider-reported usage. Positive delta refunds.
    const actualCost = priceForEmbedding(result.model, result.usage.inputTokens);
    const deltaUsd = estimatedCost - actualCost;
    await budget.adjust({ org: req.auth.org, deltaUsd });

    // 5. Audit row in usage_logs. Failure here is non-fatal — the embedding
    //    and the budget movement have already happened.
    try {
      await db.insert(usageLogs).values({
        org: req.auth.org,
        project: req.auth.project,
        userId: req.auth.apiKeyId,
        provider: embeddingProviderLabel(result),
        model: result.model,
        endpoint: '/v1/embed',
        inputTokens: result.usage.inputTokens,
        outputTokens: 0,
        estimatedCostUsd: String(estimatedCost),
        actualCostUsd: String(actualCost),
        status: 'completed',
      });
    } catch (err) {
      req.log.error({ err }, 'failed to log embedding usage');
    }

    const warnings = reserveResult.softCap
      ? [
          {
            code: 'BUDGET_SOFT_CAP' as const,
            message: `Budget is below 10% remaining for org=${req.auth.org}`,
          },
        ]
      : undefined;

    return {
      embeddings: result.embeddings,
      model: result.model,
      usage: {
        inputTokens: result.usage.inputTokens,
        estimatedCostUsd: result.usage.estimatedCostUsd,
      },
      ...(warnings ? { warnings } : {}),
    };
  });
};

export default embedRoutes;
