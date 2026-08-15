// Unit tests for /v1/budget/:org (GET snapshot + PUT cap).
//
// `db.select(...).from(...).where(...).limit(1)` is mocked per-table to return
// the seeded `budget_state` / `llm_configs` rows and the aggregate sum over
// `usage_logs`. Cross-org access is 403; bootstrap-fallback path covered.
// `insert`/`update` are recorded so the PUT tests can assert the upsert
// semantics without a real Postgres.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../db/client.js', () => ({
  db: {
    select: (cols?: Record<string, unknown>) => ({
      from(table: unknown) {
        let rows: Record<string, unknown>[];
        if (table === BS_TABLE) rows = dbState.budgetState;
        else if (table === LC_TABLE) rows = dbState.llmConfigs;
        else if (table === UL_TABLE) {
          // The sum query selects `{ spent: sql<string> }`. Return one row
          // shaped to match the alias `spent` regardless of column param.
          rows = [{ spent: dbState.usageSum }];
        } else rows = [];
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
          then: (resolve: (v: unknown[]) => void) => resolve(rows),
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
        return {
          where: () => ({
            returning: async () => [
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
            ],
          }),
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
});
