// Unit tests for `CorpusDeleteService`.
//
// The DB is a hand-rolled stub: `select().from().where().limit()` returns the
// pre-seeded corpus lookup row (or empty), and `delete().where().returning()`
// returns one row per id in the pre-seeded "to-be-deleted" arrays. The
// `db.transaction(fn)` shim just calls `fn(self)` synchronously so the
// service's transactional path is exercised without touching Postgres.

import { describe, expect, it, vi } from 'vitest';

import { CorpusDeleteService } from './corpus-delete.js';

interface FakeDeleteRow {
  id: string;
}

interface StubState {
  corpusLookup: { id: string } | null;
  chunkRows: FakeDeleteRow[];
  documentRows: FakeDeleteRow[];
  corporaRows: FakeDeleteRow[];
  deleteCalls: { table: string }[];
}

interface FakeTx {
  select: () => { from: () => { where: () => { limit: () => Promise<unknown[]> } } };
  delete: (tbl: unknown) => { where: () => { returning: () => Promise<FakeDeleteRow[]> } };
}

function makeDb(state: StubState): import('../../db/client.js').Db {
  let currentDeleteTable: string | null = null;
  const tx: FakeTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(state.corpusLookup ? [state.corpusLookup] : []),
        }),
      }),
    }),
    delete: (tbl: unknown) => {
      // The schema objects pass through as opaque references — sniff which is
      // which by matching identity against the table-shape recorded below.
      currentDeleteTable = tableName(tbl);
      state.deleteCalls.push({ table: currentDeleteTable });
      return {
        where: () => ({
          returning: () => {
            if (currentDeleteTable === 'chunks') return Promise.resolve(state.chunkRows);
            if (currentDeleteTable === 'documents') return Promise.resolve(state.documentRows);
            if (currentDeleteTable === 'corpora') return Promise.resolve(state.corporaRows);
            return Promise.resolve([]);
          },
        }),
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
    const state: StubState = {
      corpusLookup: null,
      chunkRows: [],
      documentRows: [],
      corporaRows: [],
      deleteCalls: [],
    };
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    const result = await svc.deleteCorpus('missing', { org: ORG, project: PROJECT });
    expect(result.matched).toBe(false);
    expect(result.deleted).toEqual({ chunks: 0, documents: 0, corpora: 0 });
    expect(state.deleteCalls).toHaveLength(0);
  });

  it('cascade-deletes chunks → documents → corpora and reports counts', async () => {
    const state: StubState = {
      corpusLookup: { id: 'cor-1' },
      chunkRows: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }, { id: 'c5' }],
      documentRows: [{ id: 'd1' }, { id: 'd2' }],
      corporaRows: [{ id: 'cor-1' }],
      deleteCalls: [],
    };
    const svc = new CorpusDeleteService({ db: makeDb(state) });
    const result = await svc.deleteCorpus('pop', { org: ORG, project: PROJECT });
    expect(result.matched).toBe(true);
    expect(result.deleted).toEqual({ chunks: 5, documents: 2, corpora: 1 });
    // Order matters for the transactional sanity: chunks first (they FK to
    // documents *and* corpora), then documents, then the corpora row.
    expect(state.deleteCalls.map((c) => c.table)).toEqual([
      'chunks',
      'documents',
      'corpora',
    ]);
  });

  it('runs inside a single transaction', async () => {
    const state: StubState = {
      corpusLookup: { id: 'cor-2' },
      chunkRows: [],
      documentRows: [],
      corporaRows: [{ id: 'cor-2' }],
      deleteCalls: [],
    };
    const db = makeDb(state);
    const svc = new CorpusDeleteService({ db });
    await svc.deleteCorpus('empty', { org: ORG, project: PROJECT });
    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
  });
});
