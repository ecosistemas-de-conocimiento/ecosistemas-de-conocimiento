// /v1/budget/:org — caller-scoped budget snapshot (GET) + cap write (PUT).
//
// The path's `:org` MUST equal `req.auth.org`; cross-org access is 403 (per
// plan §3 "New" budget.ts notes) on BOTH verbs — the org in the path is never
// allowed to widen the caller's auth scope. GET aggregates `usage_logs` for
// spend (audit-trail truth) alongside the live `budget_state` counter for
// remaining, falling back to `llm_configs.monthlyBudgetUsd` when the org has no
// `budget_state` row yet (bootstrap window).
//
// PUT is admin-only and is the endpoint form of `scripts/set-budget.ts` — the
// one thing that lifts the ADR-0003 D5 fail-closed gate. Before it existed,
// provisioning an org's budget required shell access to the target
// environment's Postgres.

import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { budgetState, llmConfigs, usageLogs } from '../db/schema/index.js';
import { setBudgetRequestSchema } from '../contract/tenant.js';
import { setOrgBudget } from '../services/budget/provision.js';

const budgetRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { org: string } }>('/:org', async (req, reply) => {
    if (req.params.org !== req.auth.org) {
      return reply.forbidden(`cannot read budget for org '${req.params.org}'`);
    }
    const org = req.auth.org;

    const stateRows = await db
      .select({
        limitUsd: budgetState.limitUsd,
        remainingUsd: budgetState.remainingUsd,
        currency: budgetState.currency,
      })
      .from(budgetState)
      .where(eq(budgetState.org, org))
      .limit(1);

    let limitUsd: number;
    let remainingUsd: number;
    let currency = 'USD';
    if (stateRows[0]) {
      limitUsd = Number(stateRows[0].limitUsd);
      remainingUsd = Number(stateRows[0].remainingUsd);
      currency = stateRows[0].currency;
    } else {
      // Bootstrap fallback: read the newest active llm_configs row's budget.
      const configRows = await db
        .select({ monthlyBudgetUsd: llmConfigs.monthlyBudgetUsd })
        .from(llmConfigs)
        .where(and(eq(llmConfigs.org, org), eq(llmConfigs.isActive, true)))
        .orderBy(desc(llmConfigs.createdAt))
        .limit(1);
      limitUsd = configRows[0] ? Number(configRows[0].monthlyBudgetUsd) : 100;
      remainingUsd = limitUsd;
    }

    const spentRows = await db
      .select({
        spent: sql<string>`COALESCE(SUM(${usageLogs.actualCostUsd}), 0)`,
      })
      .from(usageLogs)
      .where(eq(usageLogs.org, org));
    const spentUsd = Number(spentRows[0]?.spent ?? 0);

    return {
      org,
      limitUsd,
      remainingUsd,
      spentUsd,
      currency,
    };
  });

  // -------------------------------------------------------------------------
  // PUT /v1/budget/:org — set (or raise/lower) the org's hard cap. Admin only.
  // -------------------------------------------------------------------------
  app.put<{ Params: { org: string } }>(
    '/:org',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      if (req.params.org !== req.auth.org) {
        return reply.forbidden(`cannot set budget for org '${req.params.org}'`);
      }
      const parsed = setBudgetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const result = await setOrgBudget(db, {
        // Always the authenticated org — the path param is validated against it
        // above and never used as the write key.
        org: req.auth.org,
        limitUsd: parsed.data.limitUsd,
        refill: parsed.data.refill,
      });
      if (result.created) reply.code(201);
      return result;
    },
  );
};

export default budgetRoutes;
