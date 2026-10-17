// Provider timeout ⇒ 504 / error frame, UNBILLED, `truncated` — end to end.
//
// Decision (Rodrigo, option A of
// `plan/tecnología/prod-readiness/ai-reality-audit.md` §3 item 5).
// Measured reproducer in that audit: req-1gk, 120038 ms against a 120 s
// `LLM_REQUEST_TIMEOUT_MS`, answered HTTP 200 and charged $0.0009979. The
// deadline fired in the REFINE pass; the router kept the draft and billed it.
//
// Everything here is the real stack: real router, real streaming adapter, real
// budget enforcer and trace writer on Postgres, over a real socket, against
// the TEST-ONLY fake provider. Only the clock is shortened: the request
// timeout is 1.5 s and the slow provider pass sleeps 30 s.
//
// What each case pins, per transport:
//   - the caller sees a 504 `ProviderTimeout` (or the stream's terminal error
//     frame), with `truncated: true`, `reason: 'provider_timeout'`;
//   - no `usage_logs` row for the trace carries a cost;
//   - `budget_state.remaining_usd` is back where it started and no hold for
//     the trace is left `reserved` (a reserved-then-cut call releases it).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';

const ORG = 'tenant-b';
const SLOW_MS = 30_000;

/** Per-test queue of first-frame delays, one per chat call, in order. */
let delays: number[] = [];

// Env must be rewritten BEFORE `server.js` / `env.ts` are imported.
const fake = await startFakeProvider({
  bodyTokens: 20,
  // Non-zero so a FAST pass would be billed — the assertion that the org paid
  // $0 is then meaningful, not true by default.
  costUsd: 0.001,
  chatPacing: () => ({ firstDelayMs: delays.shift() ?? 0 }),
});
Object.assign(process.env, fake.env);
process.env.LLM_REQUEST_TIMEOUT_MS = '1500';
process.env.API_KEYS = JSON.stringify({
  'dev-key-tenant-b': { org: ORG, project: 'tenant-b', role: 'app' },
});

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('provider timeout — 504, unbilled, truncated (integration)', () => {
  let app: FastifyInstance;
  let base: string;

  async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    const { db } = await import('../db/client.js');
    const res = await db.execute(query);
    return ((res as unknown as { rows?: T[] }).rows ?? (res as unknown as T[])) as T[];
  }

  async function seedOrgBudget(): Promise<void> {
    await q(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${ORG}, 100::numeric, 100::numeric)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
    `);
  }

  /** The billing view of one router call. */
  async function ledgerFor(traceId: string) {
    const usage = await q<{ status: string; actual: string | null }>(sql`
      SELECT "status", "actual_cost_usd"::text AS actual
      FROM "usage_logs" WHERE "trace_id" = ${traceId}::uuid
    `);
    const trace = await q<{ status: string; actual: string | null; truncated: string | null; reason: string | null }>(sql`
      SELECT "status", "actual_cost_usd"::text AS actual,
             "metadata"->>'truncated' AS truncated, "metadata"->>'reason' AS reason
      FROM "traces" WHERE "metadata"->>'traceId' = ${traceId}
    `);
    const [budget] = await q<{ remaining: string }>(sql`
      SELECT "remaining_usd"::text AS remaining FROM "budget_state" WHERE "org" = ${ORG}
    `);
    const live = await q<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM "budget_reservations"
      WHERE "trace_id" = ${traceId} AND "state" = 'reserved'
    `);
    return { usage, trace, remaining: Number(budget?.remaining), liveHolds: Number(live[0]?.n) };
  }

  function expectUnbilled(ledger: Awaited<ReturnType<typeof ledgerFor>>): void {
    expect(ledger.usage.length).toBeGreaterThan(0);
    for (const row of ledger.usage) {
      expect(row.status).not.toBe('completed');
      expect(Number(row.actual ?? 0)).toBe(0);
    }
    expect(ledger.trace).toHaveLength(1);
    expect(ledger.trace[0]!.status).toBe('aborted');
    expect(Number(ledger.trace[0]!.actual ?? 0)).toBe(0);
    expect(ledger.trace[0]!.truncated).toBe('true');
    expect(ledger.trace[0]!.reason).toBe('provider_timeout');
    // Reserved, then cut: the hold is released in full.
    expect(ledger.remaining).toBe(100);
    expect(ledger.liveHolds).toBe(0);
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-key-tenant-b' },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  beforeEach(async () => {
    delays = [];
    await seedOrgBudget();
  });

  it('/v1/generate/sync, deep effort, REFINE pass outlives the deadline → 504, not a billed 200 draft', async () => {
    // Pass 1 (the draft) is instant; pass 2 (the refine) stalls past 1.5 s.
    delays = [0, SLOW_MS];
    const res = await post('/v1/generate/sync', {
      unit: {
        unitKey: `timeout-sync-${Date.now()}`,
        input: { name: 'Ada' },
        specOverride: { promptTemplate: 'Hello {{name}}, analyse this call.' },
      },
      effortLevel: 'deep',
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(504);
    expect(body).toMatchObject({
      error: 'ProviderTimeout',
      code: 'ERR_PROVIDER_TIMEOUT',
      truncated: true,
      reason: 'provider_timeout',
    });
    expect(body.text).toBeUndefined();
    expect(typeof body.traceId).toBe('string');
    expectUnbilled(await ledgerFor(body.traceId as string));
  }, 60_000);

  it('/v1/generate/stream, primary pass outlives the deadline → terminal error frame, no done, unbilled', async () => {
    delays = [SLOW_MS];
    const res = await post('/v1/generate/stream', {
      unit: {
        unitKey: `timeout-stream-${Date.now()}`,
        input: { name: 'Ada' },
        specOverride: { promptTemplate: 'Hello {{name}}, tell me a story.' },
      },
    });
    expect(res.status).toBe(200); // the status line is sent before the provider is called
    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

    expect(frames.some((f) => f.type === 'done')).toBe(false);
    const last = frames.at(-1)!;
    expect(last).toMatchObject({
      type: 'error',
      code: 'ProviderTimeout',
      errorCode: 'ERR_PROVIDER_TIMEOUT',
      truncated: true,
      reason: 'provider_timeout',
    });
    expect(typeof last.traceId).toBe('string');
    expectUnbilled(await ledgerFor(last.traceId as string));
  }, 60_000);

  it('/v1/route, provider outlives the deadline → 504 ProviderTimeout (not 499, not a fallback 200)', async () => {
    delays = [SLOW_MS];
    const res = await post('/v1/route', {
      question: '¿cuánto gastamos por colonia?',
      candidates: [
        { id: 'sql', description: 'Answer with a SQL query over the uploaded table' },
        { id: 'rag', description: 'Answer from the document corpus' },
      ],
      defaultRouteId: 'rag',
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    expect(res.status).toBe(504);
    expect(body).toMatchObject({ error: 'ProviderTimeout', truncated: true, reason: 'provider_timeout' });
    expectUnbilled(await ledgerFor(body.traceId as string));
  }, 60_000);
});
