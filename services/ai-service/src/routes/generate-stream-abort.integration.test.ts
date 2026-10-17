// Client-disconnect propagation on POST /v1/generate/stream, over a REAL socket.
//
// ── Why this file exists ───────────────────────────────────────────────────
// 🔴 This propagation was DEAD for the entire life of the feature, and nothing
// noticed. The handler registered its abort listener on `req.raw` — but by the
// time a Fastify handler runs, the body has been read, so the IncomingMessage
// is already `complete`, `readableEnded` and `destroyed`, and its `'close'`
// has ALREADY fired. `once('close')` on a past event never runs.
//
// The consequence was silent and financial: a reader who pressed Stop dropped
// the socket, the provider kept generating, and the trace closed as `completed`
// carrying the FULL cost of an answer nobody received. The partial-cost path in
// `router.ts` (OpenRouterAbortError → status `aborted` → refund the unspent
// reserve) was unreachable from a client disconnect.
//
// ── Why it has to use a real socket ────────────────────────────────────────
// ⚠ `app.inject()` CANNOT cover this. It is a light-weight request simulation
// with no TCP connection to drop, so the very thing under test — a client that
// hangs up mid-stream — has no representation in it. That is precisely why a
// service with a thorough inject-based suite still shipped the bug. This test
// listens on a real ephemeral port and destroys the request.
//
// ⚠ It also cannot assert through the HTTP response: we deliberately destroyed
// it. The observable is the TRACE ROW, which is what the billing reads anyway.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';

/** Same opaque scoping tag the sibling integration file uses. */
const ORG = 'tenant-b';

// Env must be rewritten BEFORE `server.js` / `env.ts` are imported. Vitest does
// not hoist plain assignments, so top-level statements here run first.
// 🔴 SLOW ON PURPOSE. The window between "first delta arrived" and "generation
// finished" is the only place this test can act. 200 tokens at 10/sec is ~20 s;
// the disconnect happens on the first delta, ~0.1 s in. The provider is the
// TEST-ONLY fake provider, reached over real HTTP by the real streaming adapter.
const fake = await startFakeProvider({
  bodyTokens: 200,
  streamTokensPerSec: 10,
  streamFirstDelayMs: 100,
});
Object.assign(process.env, fake.env);
process.env.API_KEYS = JSON.stringify({
  'dev-key-tenant-b': { org: ORG, project: 'tenant-b', role: 'app' },
});

import http from 'node:http';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

interface TraceRow {
  status: string;
  abort_cause: string | null;
}

describe('POST /v1/generate/stream — client disconnect (integration)', () => {
  let app: FastifyInstance;
  let port: number;

  async function seedOrgBudget(): Promise<void> {
    const { db } = await import('../db/client.js');
    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${ORG}, 100::numeric, 100::numeric)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
    `);
  }

  async function traceFor(unitKey: string): Promise<TraceRow | null> {
    const { db } = await import('../db/client.js');
    const res = await db.execute(sql`
      SELECT "status", "metadata"->>'abortCause' AS abort_cause
      FROM "traces"
      WHERE "org" = ${ORG} AND "metadata"->>'unitKey' = ${unitKey}
      ORDER BY "created_at" DESC
      LIMIT 1
    `);
    return ((res as unknown as { rows?: TraceRow[] }).rows?.[0] ??
      (res as unknown as TraceRow[])[0] ??
      null) as TraceRow | null;
  }

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
    // A real listener. `inject()` would defeat the entire point of the file.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    port = addr.port;
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  it('records the generation as `aborted` with abortCause=disconnect, not `completed`', async () => {
    await seedOrgBudget();
    const unitKey = `abort-${Date.now()}`;

    const payload = JSON.stringify({
      unit: {
        unitKey,
        input: { name: 'Ada' },
        specOverride: { promptTemplate: 'Hello {{name}}, tell me a very long story.' },
      },
    });

    // Open the stream, wait for the FIRST delta, then hang up hard.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/generate/stream',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            authorization: 'Bearer dev-key-tenant-b',
          },
        },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            // The handler writes `: ok` before the first frame; wait for an
            // actual delta so the provider has certainly produced tokens.
            if (!chunk.toString().includes('"type":"delta"')) return;
            // 🔴 `destroy()`, not `end()` — a reader pressing Stop drops the
            // connection; it does not politely finish it.
            req.destroy();
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.setTimeout(25_000, () => {
        req.destroy();
        reject(new Error('no delta frame arrived within 25s'));
      });
      req.write(payload);
      req.end();
    });

    // The terminal row is written on the server's own timeline, a moment after
    // the socket dies. Poll rather than sleep on a guessed number.
    let row: TraceRow | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      row = await traceFor(unitKey);
      if (row && row.status !== 'running' && row.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(row, `no trace row was ever written for unitKey ${unitKey}`).toBeTruthy();
    // 🔴 `completed` here is the regression: it means the disconnect never
    // reached the adapter and the org was billed for the whole answer.
    expect(row!.status).toBe('aborted');
    // And it was the CLIENT that ended it, not the wall-clock backstop — the
    // two share the `aborted` status and mean very different things.
    expect(row!.abort_cause).toBe('disconnect');
  }, 60_000);
});
