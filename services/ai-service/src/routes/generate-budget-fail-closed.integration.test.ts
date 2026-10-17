// End-to-end proof that an ADMIN-configured zero cost estimate cannot buy free
// generation on `/v1/generate/sync` or `/v1/generate/stream`.
//
// ── Why this needs a REAL database ────────────────────────────────────────
// Security audit, finding C4, fix-spec step 3. The router-level
// semantics are pinned without a DB in
// `services/ai/router/budget-fail-closed.test.ts`. What that file cannot show
// is the POPULATION: the only way to reach a zero reserve now is to write
// `estimatedCostUsdPerCall: 0` into an admin-controlled effort profile, and
// "admin-controlled" means a `project_configs` / `registry_entries` ROW.
// `clampCallerLimits` floors the wire layers at whatever that row resolves to,
// so a request body cannot reproduce this on its own — the fault has to be
// seeded in Postgres, which is what this file does.
//
// It also covers the two DIFFERENT error mappers on the generation surface:
// `mapGenerateError` (a 402 status on /sync) and `classifyStreamError` (a
// terminal SSE `error` frame on /stream, where the status line is already
// gone). One fix, two consumer-visible shapes, so both are asserted — for BOTH
// refusal codes.
//
// ── STRICT (Rodrigo's ruling) ────────────────────────────
// The first cut let an org that HAD a budget row generate on a zero estimate,
// billed by the post-call true-up. That is now a refusal too. Two populations,
// two codes, and this file pins both end to end:
//
//   zero estimate + NO budget row  → 402 `BudgetNotConfigured` (ADR-0003 D5).
//   zero estimate + a budget row   → 402 `BudgetMisconfigured`, message names
//                                    `estimatedCostUsdPerCall` and says the
//                                    budget row itself is fine.
//
// The `remainingUsd()` assertions on the second population are load-bearing:
// they are what distinguishes "refused before the provider call" from
// "generated and then billed".
//
// ── The real router against a fake provider ──────────────────────────────
// The provider is the TEST-ONLY fake provider (`test-support/fake-provider/`),
// reached over real HTTP, so the whole `Router` pipeline — budget included —
// runs for real and nothing can bill a real endpoint. Its env is set in
// `beforeAll`, before `env.ts` is first imported, and RESTORED in `afterAll`.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startFakeProvider, type FakeProvider } from '../../test-support/fake-provider/server.mjs';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** The zero an admin can write into an effort profile. THE fault under test. */
const ZERO_ESTIMATE_PROFILES = {
  standard: { estimatedCostUsdPerCall: 0 },
};

describe('generation is fail-closed when an admin profile zeroes the cost estimate', () => {
  let app: FastifyInstance;
  let token: string;
  let org: string;

  const savedEnv: Record<string, string | undefined> = {};
  let fake: FakeProvider;

  beforeAll(async () => {
    // A non-zero provider-reported cost, so "the normal path decrements the
    // budget" has something to decrement. The fake provider reports it as
    // `usage.cost`, exactly where OpenRouter reports a real one.
    fake = await startFakeProvider({ costUsd: 0.0005 });
    for (const [k, v] of Object.entries(fake.env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }

    // Read the key fixture back out of the parsed env rather than declaring
    // one. `src/config/env.ts` validates `process.env` ONCE at first import,
    // and several integration files set `API_KEYS` at module scope — whichever
    // ran first won. Deriving the token/org from what actually loaded keeps
    // this file correct regardless of suite ordering.
    const { env } = await import('../config/env.js');
    const entry = Object.entries(env.API_KEYS).find(([, v]) => v.role === 'app');
    if (!entry) throw new Error('integration env has no app-role API key to test with');
    token = entry[0];
    org = entry[1].org;

    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  await fake?.close();
  });

  /** Write the admin-controlled effort profile the router will resolve. */
  async function seedProjectProfiles(profiles: unknown): Promise<void> {
    const { db } = await import('../db/client.js');
    const { env } = await import('../config/env.js');
    const project = env.API_KEYS[token]!.project;
    await db.execute(sql`
      INSERT INTO "project_configs" ("org", "project", "effort_profiles")
      VALUES (${org}, ${project}, ${JSON.stringify(profiles)}::jsonb)
    `);
  }

  async function seedBudget(limit = 100): Promise<void> {
    const { db } = await import('../db/client.js');
    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${org}, ${limit}::numeric, ${limit}::numeric)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = ${limit}::numeric, "remaining_usd" = ${limit}::numeric
    `);
  }

  async function remainingUsd(): Promise<number> {
    const { db } = await import('../db/client.js');
    const out = (await db.execute(sql`
      SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${org} LIMIT 1
    `)) as unknown as Array<{ remaining_usd: string }>;
    const rows = Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? []);
    return Number((rows[0] as { remaining_usd: string }).remaining_usd);
  }

  /**
   * A payload unique to `caseId`.
   *
   * The uniqueness is LOAD-BEARING, and it cost a debugging round to find: the
   * router's cache is a process-wide singleton keyed on
   * `(model, messages, maxTokens, temperature, org)`, and the per-test truncate
   * does not touch it. Step 2 of the pipeline (cache lookup) runs BEFORE step 3
   * (budget reserve), so a second test sending the same prompt gets a cache hit
   * and never reaches the gate under test — it returned 200 with no decrement,
   * masking a real assertion. Varying the prompt per case keeps every request
   * on the cold path.
   */
  function payloadFor(caseId: string) {
    return {
      unit: {
        unitKey: `fail-closed-${caseId}`,
        input: { name: caseId },
        specOverride: { promptTemplate: `Hello {{name}} (${caseId}).` },
      },
      effortLevel: 'standard' as const,
    };
  }

  function postSync(caseId: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${token}` },
      payload: payloadFor(caseId),
    });
  }

  /** POST /v1/generate/stream and return the parsed SSE frames. */
  async function postStreamFrames(caseId: string): Promise<Array<Record<string, unknown>>> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: payloadFor(caseId),
    });
    return res.payload
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice('data: '.length)) as Record<string, unknown>);
  }

  it('/v1/generate/sync → 402 BudgetNotConfigured instead of a free generation', async () => {
    await seedProjectProfiles(ZERO_ESTIMATE_PROFILES);
    // Deliberately NO budget_state row: this is the org that used to slip
    // through, because a zero reserve skipped the budget check entirely.

    const res = await postSync('sync-402');

    expect(res.statusCode).toBe(402);
    const body = res.json() as { error: string; org: string; message: string };
    expect(body.error).toBe('BudgetNotConfigured');
    expect(body.org).toBe(org);
    expect(body.message).toContain(`no budget configured for org ${org}`);
  });

  it('/v1/generate/stream → terminal error frame, not a done frame', async () => {
    await seedProjectProfiles(ZERO_ESTIMATE_PROFILES);

    const frames = await postStreamFrames('stream-402');

    // The socket is already hijacked by the time the router refuses, so the
    // rejection can only arrive as a frame. It must still be legible as a
    // budget failure and NOT as a generic INTERNAL.
    const error = frames.find((f) => f['type'] === 'error');
    expect(error).toBeDefined();
    expect(error?.['code']).toBe('BudgetNotConfigured');
    expect(frames.find((f) => f['type'] === 'done')).toBeUndefined();
  });

  it('/v1/generate/sync → 402 BudgetMisconfigured even WITH a budget row', async () => {
    // ── THE STRICT FLIP (Rodrigo) ──────────────────────────────
    // This case used to assert 200 + a post-call true-up ("fail-closed means
    // consult the budget, not always refuse"). Overruled: a $0 hold means the
    // cap cannot bind, so the call is not served at all. The true-up runs after
    // the provider call and can decline nothing.
    await seedProjectProfiles(ZERO_ESTIMATE_PROFILES);
    await seedBudget(100);

    const res = await postSync('zero-configured');

    expect(res.statusCode).toBe(402);
    const body = res.json() as {
      error: string;
      org: string;
      estimatedCostUsdPerCall: number | null;
      message: string;
    };
    // A DIFFERENT code from the no-row case: the remedy is "fix the effort
    // profile", not "provision a budget", and sending an admin to provision a
    // cap they already have is the failure mode this code exists to prevent.
    expect(body.error).toBe('BudgetMisconfigured');
    expect(body.org).toBe(org);
    expect(body.estimatedCostUsdPerCall).toBe(0);
    expect(body.message).toContain('estimatedCostUsdPerCall=0');
    expect(body.message).toContain('budget row is fine');
    // Nothing was spent, so nothing was billed: the cap is untouched.
    expect(await remainingUsd()).toBe(100);
  });

  it('/v1/generate/stream → terminal BudgetMisconfigured frame even WITH a budget row', async () => {
    // The second transport for the flipped population. `classifyStreamError` is
    // a separate mapper from `mapGenerateError` and the socket is already
    // hijacked, so a code added to one and not the other silently degrades to
    // `INTERNAL` here.
    await seedProjectProfiles(ZERO_ESTIMATE_PROFILES);
    await seedBudget(100);

    const frames = await postStreamFrames('zero-configured-stream');

    const error = frames.find((f) => f['type'] === 'error');
    expect(error).toBeDefined();
    expect(error?.['code']).toBe('BudgetMisconfigured');
    expect(String(error?.['message'])).toContain('estimatedCostUsdPerCall=0');
    expect(frames.find((f) => f['type'] === 'done')).toBeUndefined();
    expect(await remainingUsd()).toBe(100);
  });

  it('the normal path is unchanged: no zero profile, real budget → 200 and a decrement', async () => {
    await seedBudget(100);

    const res = await postSync('normal-200');

    expect(res.statusCode).toBe(200);
    expect(await remainingUsd()).toBeLessThan(100);
  });

  it('the normal path was ALREADY fail-closed: no zero profile, no budget → 402', async () => {
    // Control. Proves the 402 above is the zero-estimate org joining a rule
    // that already applied to everyone else (ADR-0003 D5), not a new one.
    const res = await postSync('normal-402');

    expect(res.statusCode).toBe(402);
    expect((res.json() as { error: string }).error).toBe('BudgetNotConfigured');
  });
});
