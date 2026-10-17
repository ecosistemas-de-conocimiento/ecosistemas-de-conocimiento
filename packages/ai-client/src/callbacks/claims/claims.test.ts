// Unit suite for `@edc/ai-client/callbacks/claims`. No database: the
// behaviour against real Postgres is pinned by the conformance cases, run from
// `src/test/ai-client-callback-claims.integration.test.ts` at the repo root.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CALLBACK_CLAIMS_CONFORMANCE_CASES,
  CLAIM_LEASE_MS,
  CallbackClaimsPoolError,
  assertSqlIdentifier,
  buildCallbackClaimsSql,
  createCallbackClaims,
  type QueryablePool,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

const FIRST_LEDGER = {
  table: 'callback_dedupe',
  stateColumn: 'outcome',
  sourceEnumType: 'enum_callback_dedupe_source',
} as const;

const SECOND_LEDGER = {
  table: 'ai_service_callbacks',
  stateColumn: 'claim_state',
  sourceEnumType: 'enum_ai_service_callbacks_source',
  finishExtras: {
    outcome: { column: 'outcome', type: 'enum_ai_service_callbacks_outcome', clearOnReclaim: true },
    versionId: { column: 'document_version_id', type: 'int' },
  },
} as const;

/** A pool that records every statement and answers with canned rows. */
function recordingPool(answers: Array<Record<string, unknown>[]> = []) {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
  const pool: QueryablePool = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: (answers.shift() ?? []) as R[] };
    },
  };
  return { pool, calls };
}

describe('identifier validation', () => {
  it.each(['callback_dedupe', '_x', 'a1_b2'])('accepts %s', (id) => {
    expect(() => assertSqlIdentifier(id, 'table')).not.toThrow();
  });

  it.each(['', 'Callback', '1abc', 'a-b', 'a b', 'x"; drop table y; --', 'public.t', 'é'])(
    'rejects %j',
    (id) => {
      expect(() => assertSqlIdentifier(id, 'table')).toThrow(/table/);
    },
  );

  it('the factory validates every identifier it will splice into SQL', () => {
    expect(() => createCallbackClaims({ ...FIRST_LEDGER, table: 'bad"name' })).toThrow(/table/);
    expect(() => createCallbackClaims({ ...FIRST_LEDGER, stateColumn: 'Outcome' })).toThrow(/stateColumn/);
    expect(() => createCallbackClaims({ ...FIRST_LEDGER, sourceEnumType: 'x;y' })).toThrow(/sourceEnumType/);
    expect(() =>
      createCallbackClaims({ ...FIRST_LEDGER, finishExtras: { a: { column: 'a b', type: 'int' } } }),
    ).toThrow(/finishExtras\.a\.column/);
    expect(() =>
      createCallbackClaims({ ...FIRST_LEDGER, finishExtras: { a: { column: 'a', type: 'int)--' } } }),
    ).toThrow(/finishExtras\.a\.type/);
  });

  it('refuses an extra column that would overwrite a lifecycle column', () => {
    for (const column of ['claimed_at', 'attempts', 'detail', 'id', 'outcome']) {
      expect(() =>
        createCallbackClaims({ ...FIRST_LEDGER, finishExtras: { x: { column, type: 'int' } } }),
      ).toThrow(/reserved|stateColumn/);
    }
  });

  it('refuses a state column that is one of the fixed columns', () => {
    expect(() => createCallbackClaims({ ...FIRST_LEDGER, stateColumn: 'claimed_at' })).toThrow(/reserved/);
  });
});

describe('the SQL', () => {
  const firstLedgerSql = buildCallbackClaimsSql(FIRST_LEDGER);
  const secondLedger = buildCallbackClaimsSql(SECOND_LEDGER);

  it('keeps ON CONFLICT bare — inference would 500 every callback if the index vanished', () => {
    expect(firstLedgerSql.insert).toMatch(/ON CONFLICT DO NOTHING/);
    expect(firstLedgerSql.insert).not.toMatch(/ON CONFLICT\s*\(/);
    expect(firstLedgerSql.insert).toMatch(/WHERE NOT EXISTS/);
  });

  it('casts the source to the consumer enum, or varchar when none is given', () => {
    expect(firstLedgerSql.insert).toContain('$1::"enum_callback_dedupe_source"');
    const plain = buildCallbackClaimsSql({ table: 't', stateColumn: 'state' });
    expect(plain.insert).toContain('$1::varchar');
    expect(plain.insert).not.toContain('enum');
  });

  it('writes the lifecycle into the configured state column', () => {
    expect(firstLedgerSql.insert).toContain('"outcome"');
    expect(secondLedger.insert).toContain('"claim_state"');
    expect(secondLedger.insert).not.toMatch(/"outcome"/);
  });

  it('reclaims from an ALLOW-LIST of states, reading NULL as done', () => {
    expect(firstLedgerSql.reclaim).toMatch(/COALESCE\(p\.prev_state, 'done'\) = 'error'/);
    expect(firstLedgerSql.reclaim).toMatch(/COALESCE\(p\.prev_state, 'done'\) = 'in_progress'/);
    expect(firstLedgerSql.reclaim).toMatch(/FOR UPDATE/);
    expect(firstLedgerSql.reclaim).not.toMatch(/<>\s*'done'|!=\s*'done'|NOT IN/);
  });

  it('clears the previous attempt detail on reclaim, and extras marked clearOnReclaim', () => {
    expect(firstLedgerSql.reclaim).toMatch(/detail\s*= NULL/);
    expect(secondLedger.reclaim).toMatch(/"outcome"\s*= NULL/);
    expect(secondLedger.reclaim).not.toMatch(/"document_version_id"\s*= NULL/);
  });

  it('fences finish on claimed_at', () => {
    expect(firstLedgerSql.finish).toMatch(/claimed_at IS NOT DISTINCT FROM \$4::timestamptz/);
  });

  it('writes extras in the same UPDATE as the state, cast to their declared types', () => {
    expect(secondLedger.finish).toContain('"outcome" = $5::"enum_ai_service_callbacks_outcome"');
    expect(secondLedger.finish).toContain('"document_version_id" = $6::int');
  });

  it('findStuck takes BOTH unfinished states and orders by the age it filters on', () => {
    expect(firstLedgerSql.findStuck).toMatch(/"outcome" IN \('in_progress', 'error'\)/);
    expect(firstLedgerSql.findStuck).toMatch(/ORDER BY COALESCE\(claimed_at, received_at, created_at\) ASC/);
    expect(firstLedgerSql.findStuck).not.toMatch(/ORDER BY claimed_at/);
  });
});

describe('createCallbackClaims', () => {
  it('pins the 120 s lease from the contract', () => {
    expect(CLAIM_LEASE_MS).toBe(120_000);
    expect(createCallbackClaims(FIRST_LEDGER).config.leaseMs).toBe(120_000);
  });

  it('has NO degraded mode: every method throws CallbackClaimsPoolError without a pool', async () => {
    const claims = createCallbackClaims(FIRST_LEDGER);
    const k = { source: 'ingest', sourceId: 's', itemKey: '', event: 'e' };
    for (const missing of [null, undefined, {}, { query: 'nope' }]) {
      await expect(claims.claim(missing as never, k, '{}')).rejects.toBeInstanceOf(CallbackClaimsPoolError);
      await expect(
        claims.finish(missing as never, { rowId: 1, claimedAt: new Date() }, { state: 'done' }),
      ).rejects.toThrow(/no degraded mode/);
      await expect(claims.findStuck(missing as never)).rejects.toBeInstanceOf(CallbackClaimsPoolError);
    }
  });

  it('the pool-less conformance case goes red against a ledger that degrades', async () => {
    const real = createCallbackClaims(FIRST_LEDGER);
    const degrading = {
      ...real,
      claim: async () => ({ claimed: true, rowId: null, claimedAt: null, attempts: 1, reason: 'fresh' as const }),
    };
    const { pool } = recordingPool();
    const c = CALLBACK_CLAIMS_CONFORMANCE_CASES.find((x) => x.name.startsWith('a missing pool THROWS'))!;
    await expect(c.run({ claims: degrading, pool })).rejects.toThrow(/instead of throwing/);
  });

  it('finish without a row id is a no-op returning false', async () => {
    const claims = createCallbackClaims(FIRST_LEDGER);
    const { pool, calls } = recordingPool();
    expect(await claims.finish(pool, { rowId: null, claimedAt: null }, { state: 'done' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('finish refuses an extra the config did not declare', async () => {
    const claims = createCallbackClaims(SECOND_LEDGER);
    const { pool } = recordingPool([[{ id: 1 }]]);
    await expect(
      claims.finish(pool, { rowId: 1, claimedAt: new Date() }, {
        state: 'done',
        extras: { bogus: 1 } as never,
      }),
    ).rejects.toThrow(/bogus/);
  });

  it('finish passes undeclared-but-omitted extras as NULL and truncates detail', async () => {
    const claims = createCallbackClaims(SECOND_LEDGER);
    const { pool, calls } = recordingPool([[{ id: 7 }]]);
    const at = new Date('2026-01-01T00:00:00.000Z');
    const ok = await claims.finish(pool, { rowId: 7, claimedAt: at }, {
      state: 'error',
      detail: 'x'.repeat(5000),
      extras: { outcome: 'error' },
    });
    expect(ok).toBe(true);
    expect(calls[0]!.params).toEqual([7, 'error', 'x'.repeat(2000), at, 'error', null]);
  });

  it('truncates the raw body it stores', async () => {
    const claims = createCallbackClaims(FIRST_LEDGER);
    const { pool, calls } = recordingPool([[{ id: 1, claimed_at: new Date(), attempts: 1 }]]);
    await claims.claim(pool, { source: 'ingest', sourceId: 's', itemKey: '', event: 'e' }, 'y'.repeat(100_500));
    expect((calls[0]!.params![5] as string).length).toBe(100_000);
  });
});

describe('packaging', () => {
  it('the module imports nothing outside itself — no pg, no Payload, no node builtins', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(here, f), 'utf8');
      // Line-anchored so a doc-comment usage example (` * import …`) is not counted.
      const specifiers = [...src.matchAll(/^(?:import|export)\b[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
      expect(specifiers.length, `${f} parsed no imports — the regex is broken`).toBeGreaterThan(f === 'types.ts' ? -1 : 0);
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\//);
    }
  });

  it('is exported as the ./callbacks/claims subpath, not from the main entry', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8'));
    expect(pkg.exports['./callbacks/claims']).toEqual({
      types: './dist/callbacks/claims/index.d.ts',
      import: './dist/callbacks/claims/index.js',
    });
    const mainIndex = readFileSync(join(here, '../../index.ts'), 'utf8');
    expect(mainIndex).not.toMatch(/callbacks\/claims/);
  });

  it('ships conformance cases with unique names', () => {
    const names = CALLBACK_CLAIMS_CONFORMANCE_CASES.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(new Set(names).size).toBe(names.length);
  });
});
