import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { redisConnection } from '../queue/connection.js';

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

  // Readiness: dependencies reachable.
  app.get('/health/ready', async (_req, reply) => {
    const [database, redis] = await Promise.all([
      check(() => db.execute(sql`select 1`)),
      check(() => redisConnection.ping()),
    ]);
    const ok = database.ok && redis.ok;
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks: { database, redis } };
  });
};
