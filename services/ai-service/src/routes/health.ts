import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';

type Check = { ok: true } | { ok: false; error: string };

async function check(fn: () => Promise<unknown>): Promise<Check> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness: process is up. No dependencies touched.
  app.get('/health', async () => ({ status: 'ok', service: 'ai-service' }));

  // Readiness: dependencies reachable. The endpoint is unauthenticated, so
  // the response carries only booleans — raw dependency error strings
  // (connection targets, driver internals) are logged server-side instead.
  app.get('/health/ready', async (req, reply) => {
    const [database, redis] = await Promise.all([
      check(() => db.execute(sql`select 1`)),
      check(() => app.runtime.redis.ping()),
    ]);
    if (!database.ok) {
      req.log.warn({ error: database.error }, 'readiness check failed: database');
    }
    if (!redis.ok) {
      req.log.warn({ error: redis.error }, 'readiness check failed: redis');
    }
    const ok = database.ok && redis.ok;
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      checks: { database: { ok: database.ok }, redis: { ok: redis.ok } },
    };
  });
};
