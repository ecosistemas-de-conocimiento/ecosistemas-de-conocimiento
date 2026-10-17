// Real-Postgres proof for `@edc/ai-client/callbacks/claims`.
//
// Lives at the repo root, not in `packages/ai-client`, on purpose: the root
// integration config owns the test Postgres (throwaway container, `_test` name
// guard, ownership guard), and `npm test -w packages/ai-client` — which the
// publish gate runs — has no database. A `*.integration.test.ts`
// inside the package would either fail that gate or need a second skip path.
//
// It runs the SAME exported conformance cases a consumer runs, against two
// table shapes:
//   - `callback_dedupe`: lifecycle in `outcome` (varchar).
//   - `ai_service_callbacks`: lifecycle in `claim_state`, audit in an
//     `outcome` ENUM, plus `document_version_id`.
// Both live in a private schema that is dropped afterwards, so the core
// schema fingerprint tests never see them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import {
  CALLBACK_CLAIMS_CONFORMANCE_CASES,
  createCallbackClaims,
  type QueryablePool,
} from '../../../../packages/ai-client/src/callbacks/claims/index.js';
import { assertTestDatabase } from './test-database-guard.js';

const SCHEMA = 'ai_client_claims_it';
const url = process.env.TEST_DATABASE_URL ?? '';
assertTestDatabase(url, 'ai-client callback claims integration');

// `max: 4` so the concurrency cases really race on separate connections.
const sql = postgres(url, {
  max: 4,
  onnotice: () => undefined,
  connection: { search_path: SCHEMA },
});

/** postgres-js → the pg-shaped `QueryablePool` the module takes. */
const pool: QueryablePool = {
  async query<R>(text: string, params: unknown[] = []) {
    const rows = await sql.unsafe(text, params as never[]);
    return { rows: [...rows] as R[], rowCount: rows.count };
  },
};

const FIRST_LEDGER = createCallbackClaims({
  table: 'callback_dedupe',
  stateColumn: 'outcome',
  sourceEnumType: 'enum_callback_dedupe_source',
});

const SECOND_LEDGER = createCallbackClaims({
  table: 'ai_service_callbacks',
  stateColumn: 'claim_state',
  sourceEnumType: 'enum_ai_service_callbacks_source',
  finishExtras: {
    outcome: { column: 'outcome', type: 'enum_ai_service_callbacks_outcome', clearOnReclaim: true },
    versionId: { column: 'document_version_id', type: 'int' },
  },
});

/** A table with NO unique index. */
const NO_INDEX = createCallbackClaims({ table: 'no_index_dedupe', stateColumn: 'state' });

const commonColumns = `
  id serial PRIMARY KEY,
  source_id varchar NOT NULL,
  item_key varchar NOT NULL DEFAULT '',
  event varchar NOT NULL,
  received_at timestamptz,
  raw_body varchar,
  claimed_at timestamptz,
  attempts integer DEFAULT 1,
  detail varchar,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;

beforeAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await sql.unsafe(`
    CREATE TYPE ${SCHEMA}.enum_callback_dedupe_source AS ENUM ('generate', 'ingest');
    CREATE TABLE ${SCHEMA}.callback_dedupe (
      source ${SCHEMA}.enum_callback_dedupe_source NOT NULL,
      outcome varchar,
      ${commonColumns}
    );
    CREATE UNIQUE INDEX callback_dedupe_natural_key
      ON ${SCHEMA}.callback_dedupe (source, source_id, item_key, event);

    CREATE TYPE ${SCHEMA}.enum_ai_service_callbacks_source AS ENUM ('ingest', 'generate');
    CREATE TYPE ${SCHEMA}.enum_ai_service_callbacks_outcome
      AS ENUM ('applied', 'unmatched', 'ignored', 'error');
    CREATE TABLE ${SCHEMA}.ai_service_callbacks (
      source ${SCHEMA}.enum_ai_service_callbacks_source NOT NULL,
      claim_state varchar,
      outcome ${SCHEMA}.enum_ai_service_callbacks_outcome,
      document_version_id integer,
      ${commonColumns}
    );
    CREATE UNIQUE INDEX ai_service_callbacks_natural_key
      ON ${SCHEMA}.ai_service_callbacks (source, source_id, item_key, event);

    CREATE TABLE ${SCHEMA}.no_index_dedupe (
      source varchar NOT NULL,
      state varchar,
      ${commonColumns}
    );
  `);
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.end({ timeout: 5 });
});

describe.each([
  ['a consumer app shape (state in outcome)', FIRST_LEDGER],
  ['second-ledger shape (claim_state + outcome enum)', SECOND_LEDGER],
])('conformance — %s', (_label, claims) => {
  it.each(CALLBACK_CLAIMS_CONFORMANCE_CASES)('$name', async (c) => {
    await c.run({ claims, pool });
  });
});

// A table whose unique index was lost. Everything
// sequential still dedupes through `WHERE NOT EXISTS` …
const RACE = 'concurrent claims of the same delivery — exactly one wins';
describe('conformance — no unique index', () => {
  it.each(CALLBACK_CLAIMS_CONFORMANCE_CASES.filter((c) => c.name !== RACE))('$name', async (c) => {
    await c.run({ claims: NO_INDEX, pool });
  });

  // … but the concurrent race is NOT "microseconds-wide": MEASURED on
  // this suite's throwaway Postgres (pool max 4, 8 parallel claims), 4 of 8
  // won. So the race case going RED is how a consumer's conformance run detects
  // a lost index. Pinned here so the gate is proven able to fail.
  it('the race case FAILS without the index — that is how a lost index is detected', async () => {
    const race = CALLBACK_CLAIMS_CONFORMANCE_CASES.find((c) => c.name === RACE)!;
    let failures = 0;
    for (let i = 0; i < 5; i++) {
      await race.run({ claims: NO_INDEX, pool }).catch((e: Error) => {
        expect(e.name).toBe('CallbackClaimsConformanceError');
        failures++;
      });
    }
    expect(failures).toBeGreaterThan(0);
  });
});

describe('a consumer app extras', () => {
  const key = { source: 'ingest', sourceId: 'extras-1', itemKey: 'doc-1', event: 'ingest.completed' };

  it('writes the audit outcome and version id in the same UPDATE as the state', async () => {
    const c = await SECOND_LEDGER.claim(pool, key, '{}');
    expect(
      await SECOND_LEDGER.finish(pool, c, { state: 'done', extras: { outcome: 'applied', versionId: 42 } }),
    ).toBe(true);
    const [row] = await sql`SELECT claim_state, outcome, document_version_id FROM ai_service_callbacks WHERE id = ${c.rowId!}`;
    expect(row).toEqual({ claim_state: 'done', outcome: 'applied', document_version_id: 42 });
  });

  it('clears the previous attempt outcome on reclaim, keeps what is not marked clearOnReclaim', async () => {
    const k = { ...key, sourceId: 'extras-2' };
    const c = await SECOND_LEDGER.claim(pool, k, '{}');
    await SECOND_LEDGER.finish(pool, c, {
      state: 'error',
      detail: 'boom',
      extras: { outcome: 'error', versionId: 7 },
    });
    const again = await SECOND_LEDGER.claim(pool, k, '{}');
    expect(again.reason).toBe('reclaimed_error');
    const [row] = await sql`SELECT claim_state, outcome, detail, document_version_id FROM ai_service_callbacks WHERE id = ${again.rowId!}`;
    expect(row).toEqual({ claim_state: 'in_progress', outcome: null, detail: null, document_version_id: 7 });
  });

  it('rejects an outcome the enum does not hold — the database, not the module, owns the vocabulary', async () => {
    const c = await SECOND_LEDGER.claim(pool, { ...key, sourceId: 'extras-3' }, '{}');
    await expect(
      SECOND_LEDGER.finish(pool, c, { state: 'done', extras: { outcome: 'nonsense' } }),
    ).rejects.toThrow();
  });
});

it('a database error surfaces as a throw, never as a silent claim', async () => {
  const broken = createCallbackClaims({ table: 'does_not_exist', stateColumn: 'state' });
  await expect(
    broken.claim(pool, { source: 'ingest', sourceId: 'x', itemKey: '', event: 'e' }, '{}'),
  ).rejects.toThrow();
});
