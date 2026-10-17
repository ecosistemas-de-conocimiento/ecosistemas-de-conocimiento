// HTTP integration tests for /v1/generate against a real Postgres.
//
// Wiring expectations (see `vitest.integration.config.ts` + `integration-setup.ts`):
//   - `DATABASE_URL` / `REDIS_URL` already rebound to TEST_* by the setup file.
//   - Migrations applied; tables empty (per-test `beforeEach` truncate).
//   - `NODE_ENV=test` ⇒ `queue/queues.ts` returns the in-memory mock queue, so
//     `enqueueGeneration` doesn't try to talk to Redis.
//
// Mock surface kept tiny on purpose:
//   - The model provider is the TEST-ONLY fake provider
//     (`test-support/fake-provider/`), so nothing here can reach a real,
//     billed endpoint. The orchestrator's `estimateBatch` uses the resolved
//     effort profile, so `estimatedCostUsd` is still > 0.
//   - `API_KEYS` is rewritten BEFORE `buildServer()` is dynamically imported,
//     adding a second project key so the cross-project test has
//     a real second tenant to read from.
//
// Two scenarios:
//   1. Happy-path POST with one inline-spec unit → 200 + GET round-trip.
//   2. Cross-project read → 404 (NOT 403; ai-service treats it as
//      "doesn't exist in your scope", per plan/m3-m4-decisions.md routing
//      decisions / generate.ts handler).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';

// The org every key fixture in this file binds to. SINGLE SOURCE OF TRUTH —
// budget seeding and the 402 assertions below derive from it rather than
// repeating a literal.
//
// This constant exists because repeating the literal already broke the suite
// once: two branches spelled the org differently, the ranges were disjoint, and
// the merge was textually clean and semantically wrong. `org` is an opaque scoping tag (src/plugins/auth.ts), so nothing in
// the service constrains the two spellings to agree; only this constant does.
const ORG = 'tenant-b';

// Rewrite env BEFORE any `buildServer` / `env.ts` import. Vitest doesn't hoist
// these (only `vi.mock` is hoisted), so plain top-level assignments are fine —
// they execute before the dynamic import() below.
const fake = await startFakeProvider();
Object.assign(process.env, fake.env);
process.env.API_KEYS = JSON.stringify({
  'dev-key-tenant-b': { org: ORG, project: 'tenant-b', role: 'app' },
  'dev-key-other': { org: ORG, project: 'other', role: 'app' },
});

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('POST /v1/generate (integration)', () => {
  let app: FastifyInstance;

  // ADR-0003 D5: the service is fail-closed — an org with no budget_state row
  // 402s. The per-test truncate wipes budget_state, so we re-seed the org these
  // key fixtures map to before each enqueue.
  async function seedOrgBudget(): Promise<void> {
    const { db } = await import('../db/client.js');
    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${ORG}, 100::numeric, 100::numeric)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
    `);
  }

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    // Close the shared DB pool so vitest can exit cleanly.
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  it('enqueues a minimal unit with inline specOverride and round-trips via GET', async () => {
    await seedOrgBudget();
    const enqueueRes = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: 'Bearer dev-key-tenant-b' },
      payload: {
        units: [
          {
            unitKey: 'greet-1',
            input: { name: 'Ada' },
            specOverride: {
              promptTemplate: 'Hello {{name}}.',
            },
          },
        ],
      },
    });

    expect(enqueueRes.statusCode).toBe(200);
    const body = enqueueRes.json() as {
      requestId: string;
      channel: string;
      totalJobs: number;
      estimatedCostUsd: number;
    };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.channel).toBe(`request:${body.requestId}:generations`);
    expect(body.totalJobs).toBe(1);
    expect(body.estimatedCostUsd).toBeGreaterThan(0);

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/generate/${body.requestId}`,
      headers: { authorization: 'Bearer dev-key-tenant-b' },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as {
      requestId: string;
      status: string;
      totalJobs: number;
      units: Array<{ unitKey: string; status: string }>;
    };
    expect(getBody.requestId).toBe(body.requestId);
    expect(getBody.totalJobs).toBe(1);
    expect(getBody.units).toHaveLength(1);
    expect(getBody.units[0]?.unitKey).toBe('greet-1');
  });

  it('rejects cross-project reads with 404 (not 403)', async () => {
    await seedOrgBudget();
    // Create a request as the first project.
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: 'Bearer dev-key-tenant-b' },
      payload: {
        units: [
          {
            unitKey: 'greet-2',
            input: { name: 'Grace' },
            specOverride: {
              promptTemplate: 'Hello {{name}}.',
            },
          },
        ],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const { requestId } = createRes.json() as { requestId: string };

    // Attempt to read it as project `other` (same org, different project).
    // generate.ts's GET handler matches on (id, org, project) — a mismatch is
    // indistinguishable from "doesn't exist", and the handler returns 404 via
    // `reply.notFound(...)`. We assert 404 to lock that contract in.
    const readRes = await app.inject({
      method: 'GET',
      url: `/v1/generate/${requestId}`,
      headers: { authorization: 'Bearer dev-key-other' },
    });
    expect(readRes.statusCode).toBe(404);
  });

  it('fail-closed: generation for an org with NO budget configured → 402 BudgetNotConfigured (ADR-0003 D5)', async () => {
    // Deliberately do NOT seed a budget. The per-test truncate already wiped
    // budget_state, so this org has no row → the orchestrator's fail-closed
    // gate must reject before any enqueue, with a clear "no budget configured"
    // 402.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: 'Bearer dev-key-tenant-b' },
      payload: {
        units: [
          {
            unitKey: 'no-budget-1',
            input: { name: 'Nemo' },
            specOverride: { promptTemplate: 'Hello {{name}}.' },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as { error: string; org: string; message: string };
    expect(body.error).toBe('BudgetNotConfigured');
    // Derived from ORG, not re-spelled: the service echoes back whatever org
    // the presented key binds to (see BudgetNotConfigured in
    // services/budget/errors.ts), so this assertion tracks the key fixture by
    // construction.
    expect(body.org).toBe(ORG);
    expect(body.message).toContain(`no budget configured for org ${ORG}`);
  });
});
