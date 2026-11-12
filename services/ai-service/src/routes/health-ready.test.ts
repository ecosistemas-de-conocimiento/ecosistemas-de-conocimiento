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

// `warn` lines must reach the stream; `env.ts` reads it at the first dynamic import.
process.env['LOG_LEVEL'] = 'info';

const DB_SECRET_ERROR = 'connect ECONNREFUSED db.internal.example:5432 password=hunter2';
/** A test may set the next database failure; otherwise DB_SECRET_ERROR. */
const dbFailure = vi.hoisted(() => ({ next: undefined as Error | undefined }));
const REDIS_SECRET_ERROR = 'redis auth failed for redis://:sekret@redis.internal:6379';

vi.mock('../db/client.js', async () => {
  const actual = await vi.importActual<typeof import('../db/client.js')>('../db/client.js');
  return {
    ...actual,
    db: { execute: () => Promise.reject(dbFailure.next ?? new Error(DB_SECRET_ERROR)) },
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

describe('GET /health/ready — the server-side log never carries database text (audit 2026-11-12)', () => {
  it('a database error that quotes a value is logged as its summary', async () => {
    dbFailure.next = Object.assign(new Error('invalid input syntax for type integer: "Juana Perez"'), { code: '22P02' });
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const log = app.log as unknown as Record<symbol, unknown>;
    const streamSym = Object.getOwnPropertySymbols(log).find((s) => s.description === 'pino.stream');
    const stream = log[streamSym!] as { write: (chunk: string) => unknown };
    const original = stream.write.bind(stream);
    const lines: string[] = [];
    stream.write = (chunk: string) => (lines.push(String(chunk)), true);
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const dbLine = lines.find((l) => l.includes('readiness check failed: database'));
      expect(dbLine).toBeDefined();
      expect(dbLine).toContain('22P02');
      expect(lines.join('')).not.toContain('Juana');
    } finally {
      stream.write = original;
      dbFailure.next = undefined;
      await app.close();
    }
  });
});
