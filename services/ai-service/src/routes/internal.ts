// Test-only endpoints. Guarded so they never reach a real deploy.
//
// /v1/internal/latest-trace?unitKey=… — returns the most recent trace row
// for the caller's {org, project} that carries a metadata.unitKey matching
// the query parameter. Used by the e2e cancel-flow test to assert that a
// cancelled sync generation produced a status='aborted' trace with a
// non-zero actualCostUsd.
//
// The trace table doesn't have a dedicated unitKey column — generations
// stamp it into the `metadata` JSONB. We match on that.

import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { traces } from '../db/schema/index.js';

const internalRoutes: FastifyPluginAsync = async (app) => {
  // Belt-and-suspenders boot guard: refuse to register in production.
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'internalRoutes registered in NODE_ENV=production — this surface must not ship to prod',
    );
  }

  app.get<{ Querystring: { unitKey?: string } }>('/latest-trace', async (req, reply) => {
    const unitKey = req.query.unitKey;
    if (!unitKey || typeof unitKey !== 'string') {
      return reply.badRequest('missing unitKey query parameter');
    }

    const rows = await db
      .select({
        traceId: traces.id,
        status: traces.status,
        actualCostUsd: traces.actualCostUsd,
        estimatedCostUsd: traces.estimatedCostUsd,
        model: traces.model,
        label: traces.label,
        createdAt: traces.createdAt,
      })
      .from(traces)
      .where(
        and(
          eq(traces.org, req.auth.org),
          // Project, not just org. `traces` carries both via `scopingColumns()`
          // (`src/db/schema/index.ts`), but this route filtered on org alone —
          // so a key scoped to project A could read project B's trace row from
          // the same org. Dev-only and it returns no prompt or chunk text, so
          // it was never a live leak; it was a one-line predicate missing from
          // a scope that has two halves, and every OTHER surface enforces both.
          // An absent rule is the widest rule.
          eq(traces.project, req.auth.project),
          // metadata->>'unitKey' = $unitKey — Postgres JSONB text accessor.
          sql`${traces.metadata}->>'unitKey' = ${unitKey}`,
        ),
      )
      .orderBy(desc(traces.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return reply.notFound(`no trace for unitKey '${unitKey}' in scope`);
    }

    return {
      traceId: row.traceId,
      status: row.status,
      actualCostUsd: row.actualCostUsd === null ? null : Number(row.actualCostUsd),
      estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd),
      model: row.model,
      label: row.label,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    };
  });
};

export default internalRoutes;
