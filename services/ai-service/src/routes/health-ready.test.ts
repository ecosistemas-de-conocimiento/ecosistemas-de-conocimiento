// Mutation test for the /health/ready info-leak fix (audit finding [LOW]
// unauthenticated /health/ready returns dependency error strings, commit
// "sec(health-info-leak)").
//
// The defect: the readiness body echoed raw driver error messages (connection
// targets, hostnames, auth failures) to any anonymous caller. The fix returns
// `{ ok }` booleans per check and logs the raw message server-side.
//
// The db and redis handles are mocked to FAIL with deliberately revealing
// messages; the assertion is that none of those bytes cross the wire.
// Reverting the fix puts `error: <message>` back in the body → RED.

import { describe, expect, it, vi } from 'vitest';

const DB_SECRET_ERROR = 'connect ECONNREFUSED db.internal.example:5432 password=hunter2';
const REDIS_SECRET_ERROR = 'redis auth failed for redis://:sekret@redis.internal:6379';

vi.mock('../db/client.js', async () => {
  const actual = await vi.importActual<typeof import('../db/client.js')>('../db/client.js');
  return {
    ...actual,
    db: { execute: () => Promise.reject(new Error(DB_SECRET_ERROR)) },
  };
});

// The Redis client is now a Runtime value, so it is substituted by CONSTRUCTION
// rather than by module mocking: `createRedisConnection` is the one factory
// `createRuntime()` calls. (BullMQ queue construction never sees this handle —
// the test Runtime uses the in-memory queues.)
vi.mock('../queue/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../queue/connection.js')>(
    '../queue/connection.js',
  );
  return {
    ...actual,
    createRedisConnection: () => ({
      ping: () => Promise.reject(new Error(REDIS_SECRET_ERROR)),
      status: 'wait',
      disconnect: () => undefined,
    }),
  };
});

describe('GET /health/ready — unauthenticated response carries booleans only', () => {
  it('degraded: 503 with exactly {ok:false} per check, no error strings', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    // toEqual is exact on nested keys: an `error` field reappearing on either
    // check (the reverted behaviour) fails this assertion.
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { database: { ok: false }, redis: { ok: false } },
    });
    // Belt and braces: none of the revealing bytes may cross the wire.
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('sekret');
    expect(res.body).not.toContain('internal');
    expect(res.body).not.toContain('ECONNREFUSED');
    await app.close();
  });
});
