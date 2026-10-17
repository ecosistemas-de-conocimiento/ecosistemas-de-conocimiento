// Unit tests for `CorpusDeleteService`.
//
// 🔴 WHY THE STUB RECORDS `where()` ARGUMENTS NOW.
// This stub used to declare `where: () => ({ … })` — a function taking NO
// parameters. Whatever predicate the production code passed was silently
// DISCARDED, so the three cases below agreed with any WHERE clause at all,
// INCLUDING NONE. A `deleteCorpus` that dropped `eq(corpora.org, ctx.org)` and
// wiped another tenant's corpus passed this file green. Tenant isolation is the
// boundary between two customers' data and nothing here executed the predicate
// that enforces it.
//
// A mock cannot prove tenant isolation, so the REAL proof moved to
// `src/routes/tenant-isolation.integration.test.ts`, which runs against a real
// Postgres and reads the other tenant's rows back after the delete. What is
// left here is the cheap complement: every `where()` now TAKES its argument,
// serialises it with drizzle's own dialect, and the tests assert on the SQL and
// the bound parameters. A discarded filter fails at this level too — it shows
// up as a missing column or a missing param, in milliseconds, without a
// database.
//
// 🔴 …AND WHY IT NOW RECORDS THE `where()` THAT NEVER HAPPENS.
// Taking the argument catches the mutation that EMPTIES the predicate. It is
// blind to the one that DELETES the call:
//
//     await tx.delete(corpora).returning({ id: corpora.id });
//                             // ← `.where(eq(corpora.id, corpusRow.id))` gone
//
// That is legal drizzle and wipes EVERY tenant's corpora rows — the exact
// incident this whole helper was written for. Nothing reached the recorder,
// because the recorder only ran from inside `where()`. What it produced instead
// was an accident of the stub's shape: `returning` lived only inside the
// `where()` result, so the mutation died on
// `TypeError: tx.delete(...).returning is not a function` — five of six cases
// red with a message about the STUB, naming no cross-tenant wipe. A red
// pointing at the wrong thing is worse than a green one: it reads as "the stub
// is out of date", and the fix is to re-shape the stub.
//
// Both chains now build a `WhereRecorder.guard()` per chain instance and route
// EVERY terminal — the `where()`-path `limit`/`returning` and the unfiltered
// `limit`/`returning`/`then` on the chain head — through `guard.settle`. A
// chain that settles unfiltered lands in the recorded list as `<NO PREDICATE>`,
// where `expectNoUnfilteredQuery()` rejects it BY NAME.
//
// The rest of the stub is unchanged: `select().from().where().limit()` returns
// the pre-seeded corpus lookup row (or empty), `delete().where().returning()`
// returns one row per id in the pre-seeded "to-be-deleted" arrays, and
// `db.transaction(fn)` calls `fn(self)` synchronously so the service's
// transactional path is exercised without touching Postgres.

import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

import { WhereRecorder } from '../../test/where-recorder.js';

import { CorpusDeleteService } from './corpus-delete.js';

interface FakeDeleteRow {
  id: string;
}

interface StubState {
  corpusLookup: { id: string } | null;
  chunkRows: FakeDeleteRow[];
  documentRows: FakeDeleteRow[];
  corporaRows: FakeDeleteRow[];
  /**
   * Every SELECT predicate, in call order, labelled by table.
   *
   * ⚠ TWO recorders, not one. `corpora` is both SELECTed and DELETEd here, so
   * a single recorder would file the lookup and the corpus wipe under the same
   * table name and the assertions could no longer tell them apart. Splitting by
   * statement kind keeps `guard()`'s per-chain bookkeeping intact on both.
   */
  selects: WhereRecorder;
  /** Every DELETE predicate, in call order, labelled by the table it targeted. */
  deletes: WhereRecorder;
}

interface FakeTx {
  select: () => {
    from: (tbl: unknown) => {
      where: (p: SQL | undefined) => { limit: () => Promise<unknown[]> };
      limit: () => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => void;
    };
  };
  delete: (tbl: unknown) => {
    where: (p: SQL | undefined) => { returning: () => Promise<FakeDeleteRow[]> };
    returning: () => Promise<FakeDeleteRow[]>;
    then: (resolve: (v: FakeDeleteRow[]) => void, reject?: (e: unknown) => void) => void;
  };
}

function makeState(overrides: Partial<StubState> = {}): StubState {
  return {
    corpusLookup: null,
    chunkRows: [],
    documentRows: [],
    corporaRows: [],
    selects: new WhereRecorder(),
    deletes: new WhereRecorder(),
    ...overrides,
  };
}

function makeDb(state: StubState): import('../../db/client.js').Db {
  const tx: FakeTx = {
    select: () => ({
      from: (tbl: unknown) => {
        // ONE guard per `from()` — per chain instance — so `settle()` can tell
        // "this chain was filtered" from "this chain never was".
        const guard = state.selects.guard(tableName(tbl));
        const rows = () =>
          Promise.resolve(guard.settle(state.corpusLookup ? [state.corpusLookup] : []));
        return {
          // 🔴 TAKES its argument. This parameter is the whole point of the file.
          where: (predicate: SQL | undefined) => {
            guard.where(predicate);
            return { limit: rows };
          },
          // 🔴 The UNFILTERED terminals: the chain settling with no `where()`
          // at all — a whole-table SELECT. Recorded as `<NO PREDICATE>` instead
          // of dying on `tx.select(...).from(...).limit is not a function`.
          limit: rows,
          then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => {
            void rows().then(resolve, reject);
          },
        };
      },
    }),
    delete: (tbl: unknown) => {
      // The schema objects pass through as opaque references — sniff which is
      // which by matching identity against the table-shape recorded below.
      const table = tableName(tbl);
      const guard = state.deletes.guard(table);
      const rows = () => {
        if (table === 'chunks') return Promise.resolve(guard.settle(state.chunkRows));
        if (table === 'documents') return Promise.resolve(guard.settle(state.documentRows));
        if (table === 'corpora') return Promise.resolve(guard.settle(state.corporaRows));
        return Promise.resolve(guard.settle([] as FakeDeleteRow[]));
      };
      return {
        where: (predicate: SQL | undefined) => {
          guard.where(predicate);
          return { returning: rows };
        },
        // 🔴 THE CROSS-TENANT WIPE. `tx.delete(corpora).returning(...)` with the
        // `.where()` deleted is legal drizzle and removes every tenant's rows.
        // These two terminals are the only reason it is visible: without them
        // the mutation surfaced as `tx.delete(...).returning is not a function`,
        // an error about the stub's shape rather than about the data loss.
        returning: rows,
        then: (resolve: (v: FakeDeleteRow[]) => void, reject?: (e: unknown) => void) => {
          void rows().then(resolve, reject);
        },
      };
    },
  };
  const db = {
    ...tx,
    transaction: vi.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => fn(tx)),
  };
  return db as unknown as import('../../db/client.js').Db;
}

function tableName(tbl: unknown): string {
  // The drizzle schema objects expose a Symbol-keyed name. We can't reach the
  // symbol cleanly from outside drizzle, so we inspect the SQL identifier via
  // `String(tbl)`. The schema's `pgTable('chunks', …)` / `pgTable('documents',
  // …)` / `pgTable('corpora', …)` registrations make the value's `toString()`
  // include the table name; this is a test-only heuristic.
  const s = String((tbl as { [k: symbol]: unknown })?.[Symbol.for('drizzle:Name')] ?? tbl);
  if (s.includes('chunks')) return 'chunks';
  if (s.includes('documents')) return 'documents';
  if (s.includes('corpora')) return 'corpora';
  return 'unknown';
}

const ORG = 'acme';
const PROJECT = 'chat';

describe('CorpusDeleteService.deleteCorpus', () => {
  it('returns matched: false when no corpus row exists', async () => {
    const state = makeState({ corpusLookup: null });
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    const result = await svc.deleteCorpus('missing', { org: ORG, project: PROJECT });
    expect(result.matched).toBe(false);
    expect(result.deleted).toEqual({ chunks: 0, documents: 0, corpora: 0 });
    expect(state.deletes.calls).toHaveLength(0);
  });

  it('cascade-deletes chunks → documents → corpora and reports counts', async () => {
    const state = makeState({
      corpusLookup: { id: 'cor-1' },
      chunkRows: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }, { id: 'c5' }],
      documentRows: [{ id: 'd1' }, { id: 'd2' }],
      corporaRows: [{ id: 'cor-1' }],
    });
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    const result = await svc.deleteCorpus('pop', { org: ORG, project: PROJECT });
    expect(result.matched).toBe(true);
    expect(result.deleted).toEqual({ chunks: 5, documents: 2, corpora: 1 });
    // Order matters for the transactional sanity: chunks first (they FK to
    // documents *and* corpora), then documents, then the corpora row.
    expect(state.deletes.calls.map((c) => c.table)).toEqual([
      'chunks',
      'documents',
      'corpora',
    ]);
    // 🔴 …and none of the three ran unfiltered. Without this, a cascade that
    // deleted its `.where()` still produces the right table ORDER above and
    // would pass — while wiping every tenant's rows at that tier.
    state.deletes.expectNoUnfilteredQuery();
    state.selects.expectNoUnfilteredQuery();
  });

  it('runs inside a single transaction', async () => {
    const state = makeState({ corpusLookup: { id: 'cor-2' }, corporaRows: [{ id: 'cor-2' }] });
    const db = makeDb(state);
    const svc = new CorpusDeleteService({ db });
    await svc.deleteCorpus('empty', { org: ORG, project: PROJECT });
    expect(
      (db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction,
    ).toHaveBeenCalledTimes(1);
  });

  // ── The predicate itself ──────────────────────────────────────────────────

  it('🔴 scopes the corpus lookup by org AND project AND name — a dropped tenant filter fails here', async () => {
    const state = makeState({ corpusLookup: { id: 'cor-3' }, corporaRows: [{ id: 'cor-3' }] });
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    await svc.deleteCorpus('pop', { org: ORG, project: PROJECT });

    expect(state.selects.calls).toHaveLength(1);
    const lookup = state.selects.calls[0]!;
    // Column by column, so dropping any ONE of the three is a distinct failure
    // rather than a single opaque "SQL changed".
    expect(lookup.sql).toContain('"corpora"."org" =');
    expect(lookup.sql).toContain('"corpora"."project" =');
    expect(lookup.sql).toContain('"corpora"."name" =');
    // And the values are the CALLER's scope, in that order — a predicate that
    // named the columns but bound the wrong values would pass the check above.
    expect(lookup.params).toEqual([ORG, PROJECT, 'pop']);
    // Catches the other mutation — the `.where()` call DELETED rather than
    // emptied, which `expectScopedTo`-style column checks never see because
    // there is no predicate for them to inspect.
    state.selects.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  it('🔴 scopes every cascade delete to the RESOLVED corpus id, never to the bare name', async () => {
    const state = makeState({
      corpusLookup: { id: 'cor-4' },
      chunkRows: [{ id: 'c1' }],
      documentRows: [{ id: 'd1' }],
      corporaRows: [{ id: 'cor-4' }],
    });
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    await svc.deleteCorpus('pop', { org: ORG, project: PROJECT });

    expect(state.deletes.calls).toEqual([
      { table: 'chunks', sql: '"chunks"."corpus_id" = $1', params: ['cor-4'] },
      { table: 'documents', sql: '"documents"."corpus_id" = $1', params: ['cor-4'] },
      { table: 'corpora', sql: '"corpora"."id" = $1', params: ['cor-4'] },
    ]);
    // A deleted `.where()` shows up in the list above as
    // `{ sql: '<NO PREDICATE>', params: [] }`; this names it outright rather
    // than leaving it to be read out of a `toEqual` diff.
    state.deletes.expectNoUnfilteredQuery();
  });

  it('🔴 the stub cannot silently swallow a missing predicate', async () => {
    // Guard on the guard: if the recorder ever stopped recording, or a future
    // edit reverted `where` to a no-argument function, or a terminal stopped
    // settling through `guard`, this file would go back to proving nothing.
    // Assert the recorder actually captured bound values.
    const state = makeState({ corpusLookup: { id: 'cor-5' }, corporaRows: [{ id: 'cor-5' }] });
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    await svc.deleteCorpus('pop', { org: ORG, project: PROJECT });

    // Every chain the service ran was seen AT ALL. A chain whose terminal does
    // not settle through `guard` leaves no entry, so the loop below would spin
    // over a shorter list and still pass — the counts are what close that.
    expect(state.selects.calls).toHaveLength(1);
    expect(state.deletes.calls).toHaveLength(3);
    for (const p of [...state.selects.calls, ...state.deletes.calls]) {
      expect(p.sql).not.toBe('<NO PREDICATE>');
      expect(p.params.length).toBeGreaterThan(0);
    }
  });
});
