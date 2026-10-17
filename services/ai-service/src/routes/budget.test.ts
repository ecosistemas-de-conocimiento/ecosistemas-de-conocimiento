// Unit tests for /v1/budget/:org (GET snapshot + PUT cap).
//
// `db.select(...).from(...).where(...).limit(1)` is mocked per-table to return
// the seeded `budget_state` / `llm_configs` rows and the aggregate sum over
// `usage_logs`. Cross-org access is 403; bootstrap-fallback path covered.
// `insert`/`update` are recorded so the PUT tests can assert the upsert
// semantics without a real Postgres.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// This mock used to declare `where: () => chain` — a function taking NO
// parameter. Every predicate the route built was DISCARDED at the door, so the
// GET tests below agreed with any WHERE clause at all, INCLUDING NONE: delete
// `eq(budgetState.org, org)` from `budget.ts` and this file stayed green while
// the endpoint served whichever `budget_state` row Postgres happened to return
// first — another tenant's cap and remaining balance, on an endpoint whose only
// isolation IS that predicate. The 403 on a mismatched `:org` does not help;
// it guards the path param, not the query.
//
// So `where()` now records its argument through `WhereRecorder`, which
// serialises it with drizzle's own dialect and lets the tests assert on the SQL
// text and the bound values. `/v1/budget` is ORG-scoped and nothing else — the
// three queries carry no `project` column at all — so the assertions ask for
// `{ org }` only. A mock still cannot prove isolation; the full-strength proof
// (seed tenant B, act as tenant A, read B's rows back) lives in
// `src/routes/tenant-isolation.integration.test.ts`.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WhereRecorder } from '../test/where-recorder.js';

// Two keys on the SAME tenant: the app-role one that the pre-existing GET tests
// use, and an admin-role one for the write endpoint. Set before `server.js` is
// dynamically imported so `config/env.ts` parses this value.
process.env.API_KEYS = JSON.stringify({
  'test-key': { org: 'test-org', project: 'test-project', role: 'app' },
  'admin-key': { org: 'test-org', project: 'test-project', role: 'admin' },
});

import {
  budgetState as BS_TABLE,
  llmConfigs as LC_TABLE,
  usageLogs as UL_TABLE,
} from '../db/schema/index.js';

import { useBuildServer } from '../test/server-harness.js';

interface DbState {
  budgetState: Record<string, unknown>[];
  llmConfigs: Record<string, unknown>[];
  usageSum: string; // numeric returned as a string from postgres
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
}

const dbState: DbState = {
  budgetState: [],
  llmConfigs: [],
  usageSum: '0',
  inserts: [],
  updates: [],
};

/** Every predicate the route hands to `where()`, keyed by SQL table name. */
const wheres = new WhereRecorder();

vi.mock('../db/client.js', () => ({
  db: {
    select: (cols?: Record<string, unknown>) => ({
      from(table: unknown) {
        let rows: Record<string, unknown>[];
        // The table name is resolved by IDENTITY against the imported schema
        // objects (not by sniffing a drizzle-internal symbol), so a recorded
        // predicate can never be attributed to the wrong table.
        let name: string;
        if (table === BS_TABLE) {
          rows = dbState.budgetState;
          name = 'budget_state';
        } else if (table === LC_TABLE) {
          rows = dbState.llmConfigs;
          name = 'llm_configs';
        } else if (table === UL_TABLE) {
          // The sum query selects `{ spent: sql<string> }`. Return one row
          // shaped to match the alias `spent` regardless of column param.
          rows = [{ spent: dbState.usageSum }];
          name = 'usage_logs';
        } else {
          rows = [];
          name = 'unknown';
        }
        // ONE guard per chain instance — per `from()`. `record()` sees only
        // the predicates that were PASSED; the guard additionally sees a chain
        // that SETTLES having never been filtered, which is the shape a
        // deleted `.where()` takes.
        const guard = wheres.guard(name);
        const chain: Record<string, unknown> = {
          // 🔴 TAKES its argument. The parameterless version this replaced is
          // what let a dropped `eq(*.org, org)` pass green — see the header.
          where: (predicate: unknown) => {
            guard.where(predicate);
            return chain;
          },
          // Not a terminal — `.orderBy(...)` still has to be `.limit()`ed or
          // awaited, and both of those settle through the guard below.
          orderBy: () => chain,
          // 🔴 BOTH TERMINALS SETTLE THROUGH THE GUARD. This chain is thenable,
          // so `await db.select(...).from(usageLogs)` with its `.where(...)`
          // DELETED used to hand the route the rows and record nothing at all;
          // the failure that followed said the stub "was never reached", which
          // was the opposite of what happened. `<NO PREDICATE>` now says so.
          limit: () => Promise.resolve(guard.settle(rows)),
          then: (resolve: (v: unknown[]) => void) => resolve(guard.settle(rows)),
        };
        // Reference the `cols` arg so TS doesn't complain about it being unused.
        void cols;
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        dbState.inserts.push({ table, values });
        return {
          returning: async () => [
            {
              limitUsd: values.limitUsd,
              remainingUsd: values.remainingUsd,
              currency: 'USD',
            },
          ],
        };
      },
    }),
    update: (table: unknown) => ({
      set(set: Record<string, unknown>) {
        dbState.updates.push({ table, set });
        const existing = dbState.budgetState[0] ?? {};
        // Recorded under an `update:` prefix so a WRITE predicate can never be
        // read as satisfying a READ assertion on the same table. An unfiltered
        // UPDATE here rewrites EVERY org's cap and remaining balance.
        const guard = wheres.guard(
          table === BS_TABLE ? 'update:budget_state' : 'update:unknown',
        );
        // The rows Postgres would hand back from RETURNING. Shared by both
        // terminals ON PURPOSE: the unfiltered path has to return the same
        // shape as the filtered one, or the mutation fails on a missing stub
        // method instead of on the missing predicate.
        const returningRows = async () => [
          {
            limitUsd: set.limitUsd,
            // `remainingUsd` may be a drizzle SQL expression (the
            // LEAST(...) clamp). Stand in for what Postgres would compute.
            remainingUsd:
              typeof set.remainingUsd === 'string'
                ? set.remainingUsd
                : Math.min(
                    Number(existing.remainingUsd ?? 0),
                    Number(set.limitUsd),
                  ).toFixed(6),
            currency: 'USD',
          },
        ];
        return {
          // 🔴 TAKES its argument now. This `where` used to declare NO
          // parameter at all and record nothing, so `setOrgBudget`'s write
          // predicate was discarded at the door.
          where: (predicate: unknown) => {
            guard.where(predicate);
            return { returning: returningRows };
          },
          // 🔴 `.set(...).returning(...)` with the `.where(...)` DELETED lands
          // HERE — a whole-table UPDATE. It used to surface as a 500, because
          // this object had no `returning` and the route threw a TypeError:
          // red by accident, naming nothing, and green the instant the stub
          // grew the method. Settling through the guard records
          // `<NO PREDICATE>` for the assertions to reject by name.
          returning: () => guard.settle(returningRows()),
          // `await db.update(t).set(v)` with neither `.where()` nor
          // `.returning()` — a non-thenable would swallow this one too.
          then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            guard.settle(null);
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
      },
    }),
  },
}));

const APP_TOKEN = 'test-key';
const ADMIN_TOKEN = 'admin-key';
const ORG = 'test-org';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

beforeEach(() => {
  dbState.budgetState = [];
  dbState.llmConfigs = [];
  dbState.usageSum = '0';
  dbState.inserts = [];
  dbState.updates = [];
  wheres.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /v1/budget/:org', () => {
  it('returns the live budget_state row + usage_logs aggregate', async () => {
    const app = await makeApp();
    dbState.budgetState = [
      {
        limitUsd: '100.00',
        remainingUsd: '42.50',
        currency: 'USD',
      },
    ];
    dbState.usageSum = '57.50';

    const res = await app.inject({
      method: 'GET',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      org: ORG,
      limitUsd: 100,
      remainingUsd: 42.5,
      spentUsd: 57.5,
      currency: 'USD',
    });
    // Both reads on this path are tenant reads. Numbers this handler returns
    // are only the caller's numbers if the predicate says so.
    wheres.expectScopedTo('budget_state', { org: ORG });
    wheres.expectScopedTo('usage_logs', { org: ORG });
    await app.close();
  });

  it('falls back to llm_configs.monthlyBudgetUsd when no budget_state row exists', async () => {
    const app = await makeApp();
    dbState.budgetState = [];
    dbState.llmConfigs = [{ monthlyBudgetUsd: '200.00' }];
    dbState.usageSum = '10.00';

    const res = await app.inject({
      method: 'GET',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.limitUsd).toBe(200);
    expect(body.remainingUsd).toBe(200);
    expect(body.spentUsd).toBe(10);
    expect(body.currency).toBe('USD');
    // The bootstrap branch reads a DIFFERENT table, so it needs its own guard:
    // an unscoped `llm_configs` read would seed a new tenant's cap from
    // whichever org's config row came back first.
    wheres.expectScopedTo('llm_configs', { org: ORG });
    await app.close();
  });

  it('returns 403 when :org does not match the caller', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/some-other-org',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // ── The predicate itself ──────────────────────────────────────────────────

  it('🔴 every read behind the snapshot is scoped to the caller ORG — not a whole-table read', async () => {
    // The dedicated statement of the contract. `/v1/budget` is org-scoped and
    // carries no project column, so `{ org }` is the whole tenancy tuple here:
    // asking for `project` too would be asserting a column that does not exist.
    //
    // MUTATION TO CATCH: drop `eq(budgetState.org, org)` (budget.ts:37) or
    // `eq(usageLogs.org, org)` (budget.ts:64) and the corresponding
    // `expectScopedTo` goes red — the recorded SQL loses its `"org" = $n`
    // comparison, and `expectNoUnfilteredQuery` additionally catches the
    // `where(undefined)` shape a fully-stripped predicate takes.
    const app = await makeApp();
    dbState.budgetState = [{ limitUsd: '100.00', remainingUsd: '42.50', currency: 'USD' }];
    dbState.usageSum = '57.50';

    const res = await app.inject({
      method: 'GET',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    wheres.expectScopedTo('budget_state', { org: ORG });
    wheres.expectScopedTo('usage_logs', { org: ORG });
    wheres.expectNoUnfilteredQuery();

    // Column AND value, table by table — a predicate that named the column but
    // bound something other than the caller's org would satisfy neither.
    const [state] = wheres.for('budget_state');
    expect(state!.sql).toContain('"budget_state"."org" =');
    expect(state!.params).toEqual([ORG]);
    const [spend] = wheres.for('usage_logs');
    expect(spend!.sql).toContain('"usage_logs"."org" =');
    expect(spend!.params).toEqual([ORG]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/budget/:org — the write path that used to require a DB session.
// ---------------------------------------------------------------------------

describe('PUT /v1/budget/:org', () => {
  it('creates the budget row when the org has none (lifts the fail-closed gate)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { limitUsd: 25 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.org).toBe(ORG);
    expect(body.limitUsd).toBe(25);
    expect(body.remainingUsd).toBe(25);
    expect(body.created).toBe(true);
    expect(dbState.inserts).toHaveLength(1);
    // The write key is always the AUTHENTICATED org, never the path param.
    expect(dbState.inserts[0]!.values.org).toBe(ORG);
    await app.close();
  });

  it('updates an existing row and clamps remaining down, never up', async () => {
    const app = await makeApp();
    dbState.budgetState = [{ limitUsd: '100', remainingUsd: '80', currency: 'USD' }];
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { limitUsd: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    expect(res.json().remainingUsd).toBe(10);
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(1);
    // 🔴 …and it rewrote exactly ONE org's row. `dbState.updates` records only
    // the SET clause and the stub builds the returned row either way, so
    // nothing above this line can tell a one-org UPDATE from a whole-table one.
    // MUTATION TO CATCH: drop `eq(budgetState.org, org)` at
    // `src/services/budget/provision.ts:97`.
    wheres.expectNoUnfilteredQuery();
    wheres.expectScopedTo('update:budget_state', { org: ORG });
    await app.close();
  });

  it('refill tops remaining back up to the new cap', async () => {
    const app = await makeApp();
    dbState.budgetState = [{ limitUsd: '100', remainingUsd: '0', currency: 'USD' }];
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { limitUsd: 50, refill: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().remainingUsd).toBe(50);
    await app.close();
  });

  it('403s for an app-role key', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { limitUsd: 25 },
    });
    expect(res.statusCode).toBe(403);
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
    await app.close();
  });

  it('403s on a cross-org write — the path param can never widen tenancy', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/budget/some-other-org',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { limitUsd: 999999 },
    });
    expect(res.statusCode).toBe(403);
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
    await app.close();
  });

  it('400s on a negative or non-numeric cap', async () => {
    const app = await makeApp();
    for (const payload of [{ limitUsd: -1 }, { limitUsd: 'lots' }, {}]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/budget/${ORG}`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('401s without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      payload: { limitUsd: 25 },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('🔴 the insert/update decision is made from an ORG-scoped probe, not a bare budget_state read', async () => {
    // `setOrgBudget` decides between INSERT and UPDATE from a single existence
    // probe. Unscoped, that probe answers "a row exists" whenever ANY org has
    // one — so provisioning a brand-new tenant would take the UPDATE branch and
    // rewrite somebody else's cap. The row-returning stub cannot see that (it
    // keys off the table, not the predicate); the recorder can.
    //
    // MUTATION TO CATCH: drop `eq(budgetState.org, org)` at
    // `src/services/budget/provision.ts:60`.
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { limitUsd: 25 },
    });
    expect(res.statusCode).toBe(201);

    wheres.expectScopedTo('budget_state', { org: ORG });
    wheres.expectNoUnfilteredQuery();
    const [probe] = wheres.for('budget_state');
    expect(probe!.params).toEqual([ORG]);
    await app.close();
  });
});
