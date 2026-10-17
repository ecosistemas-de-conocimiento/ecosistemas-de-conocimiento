// 🔴 THE GATE, TESTED ON ITSELF.
//
// `where-recorder.ts` is the tripwire eighteen other test files now depend on.
// A tripwire that cannot fail is worse than none: it reads as coverage. So this
// file does to the recorder exactly what the recorder does to the query
// builders — feeds it the mutation and checks it goes red.
//
// Every case here builds a REAL drizzle predicate against a REAL table from the
// schema, so what is exercised is `PgDialect.sqlToQuery`'s actual output, not a
// hand-written string that happens to match the regex.

import { describe, expect, it } from 'vitest';
import { and, eq, or } from 'drizzle-orm';

import { corpora, generationRequests } from '../db/schema/index.js';

import { NO_PREDICATE, WhereRecorder, isScopedTo, snapshotWhere } from './where-recorder.js';

/**
 * The two stub shapes this repo actually uses, reduced to their skeletons and
 * wired through `guard()`. They exist so the guard is exercised the way the
 * eighteen consumer files use it — as a chain the production code either
 * filters or does not — rather than through direct `record()` calls.
 */
function stubUpdate(rec: WhereRecorder, table: string) {
  const g = rec.guard(table);
  return {
    set() {
      return {
        where(predicate: unknown) {
          g.where(predicate);
          return Promise.resolve();
        },
        // `await db.update(t).set(v)` with no `.where()` lands here.
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          return g.settle(Promise.resolve(undefined)).then(resolve, reject);
        },
      };
    },
  };
}

function stubSelect(rec: WhereRecorder, table: string, rows: unknown[]) {
  const g = rec.guard(table);
  const chain = {
    where(predicate: unknown) {
      g.where(predicate);
      return chain;
    },
    limit() {
      return g.settle(Promise.resolve(rows));
    },
    then(resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) {
      return g.settle(Promise.resolve(rows)).then(resolve, reject);
    },
  };
  return chain;
}

const ORG = 'acme';
const PROJECT = 'chat';

describe('snapshotWhere', () => {
  it('serialises a real drizzle predicate to SQL + bound params', () => {
    const snap = snapshotWhere(
      'corpora',
      and(eq(corpora.org, ORG), eq(corpora.project, PROJECT), eq(corpora.name, 'payroll')),
    );
    expect(snap.table).toBe('corpora');
    expect(snap.sql).toContain('"org" = $');
    expect(snap.sql).toContain('"project" = $');
    expect(snap.params).toEqual([ORG, PROJECT, 'payroll']);
  });

  // 🔴 THE SHAPE A DELETED TENANT PREDICATE ACTUALLY TAKES. Strip the `eq()`
  // terms from an `and()` and drizzle hands `where()` an `undefined` — which is
  // precisely what the old parameterless stubs could not see.
  it('records a missing predicate as a visible marker, not as nothing', () => {
    expect(snapshotWhere('corpora', and()).sql).toBe(NO_PREDICATE);
    expect(snapshotWhere('corpora', undefined).sql).toBe(NO_PREDICATE);
    expect(snapshotWhere('corpora', null).sql).toBe(NO_PREDICATE);
  });
});

describe('WhereRecorder.expectScopedTo', () => {
  it('passes on a fully tenant-scoped predicate', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.project, PROJECT)));
    rec.expectScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  // ── The mutations. Each `expect(...).toThrow()` IS the proof that the
  // corresponding real-world mistake would fail a suite using this recorder.
  it('FAILS when the org half of the predicate is deleted', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.project, PROJECT), eq(corpora.name, 'x')));
    expect(() => rec.expectScopedTo('corpora', { org: ORG, project: PROJECT })).toThrow(
      /was scoped to org=acme/,
    );
  });

  it('FAILS when the project half of the predicate is deleted', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.name, 'x')));
    expect(() => rec.expectScopedTo('corpora', { org: ORG, project: PROJECT })).toThrow(
      /was scoped to org=acme \+ project=chat/,
    );
  });

  it('FAILS when the predicate is dropped entirely', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', undefined);
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/NO PREDICATE/);
  });

  // The column is checked as well as the value, because a query can bind the
  // right string to the WRONG filter — `eq(corpora.name, 'acme')` carries the
  // org's value without scoping anything.
  it('FAILS when the tenant VALUE appears but not on a tenant COLUMN', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', eq(corpora.name, ORG));
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/was scoped to org=acme/);
  });

  // …and the value as well as the column, because a query can filter on `org`
  // and compare it to somebody else's.
  it('FAILS when the tenant COLUMN is filtered against the wrong value', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', eq(corpora.org, 'someone-else'));
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/was scoped to org=acme/);
  });

  // 🔴 The vacuity guard. An assertion against a table the stub never saw must
  // fail LOUDLY rather than pass on an empty list — otherwise renaming a table
  // in a stub silently switches the check off.
  it('FAILS when nothing was ever recorded for that table', () => {
    const rec = new WhereRecorder();
    rec.record('documents', eq(corpora.org, ORG));
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/never reached/);
  });

  it('accepts an org-only scope where the schema itself is org-only', () => {
    // `generation_requests` is unique on `(org, client_request_id)` — no
    // project column participates, so demanding one here would be wrong.
    const rec = new WhereRecorder();
    rec.record(
      'generation_requests',
      and(eq(generationRequests.org, ORG), eq(generationRequests.clientRequestId, 'k')),
    );
    rec.expectScopedTo('generation_requests', { org: ORG });
  });
});

describe('WhereRecorder.expectNoUnfilteredQuery', () => {
  it('passes when every query carried some predicate', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', eq(corpora.org, ORG));
    rec.record('documents', eq(corpora.name, 'x'));
    rec.expectNoUnfilteredQuery();
  });

  it('FAILS, naming the table, when one query carried none', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', eq(corpora.org, ORG));
    rec.record('documents', undefined);
    expect(() => rec.expectNoUnfilteredQuery()).toThrow(/documents/);
  });
});

// ── 🔴 THE MUTATION THE RECORDER USED TO MISS ENTIRELY ─────────────────────
// Every case above deletes the CONTENTS of a `where()`. This block deletes the
// CALL. Traced on this repo at e99c438: removing `.where(eq(generationJobs.id,
// row.id))` from `generation.worker.ts` — a statement that in real drizzle
// rewrites every tenant's job rows — left the full unit suite green at
// 1328/1328, because the stub's `set()` result had no `then`, `await` of a
// non-thenable resolved to the stub object, and nothing was ever recorded.
describe('WhereRecorder.guard', () => {
  it('records NO PREDICATE when an UPDATE chain is awaited without where()', async () => {
    const rec = new WhereRecorder();
    await stubUpdate(rec, 'generation_jobs').set();
    expect(rec.for('generation_jobs').map((c) => c.sql)).toEqual([NO_PREDICATE]);
    expect(() => rec.expectNoUnfilteredQuery()).toThrow(/generation_jobs/);
  });

  it('records NO PREDICATE when a SELECT chain is awaited without where()', async () => {
    const rec = new WhereRecorder();
    await stubSelect(rec, 'corpora', []);
    expect(rec.for('corpora').map((c) => c.sql)).toEqual([NO_PREDICATE]);
    expect(() => rec.expectNoUnfilteredQuery()).toThrow(/corpora/);
  });

  it('records NO PREDICATE when a SELECT is limited without where()', async () => {
    const rec = new WhereRecorder();
    await stubSelect(rec, 'corpora', []).limit();
    expect(rec.for('corpora').map((c) => c.sql)).toEqual([NO_PREDICATE]);
  });

  // The other half of the gate: it must stay SILENT on the correct code, or the
  // eighteen files that adopt it all go red for nothing.
  it('stays silent when the chain was filtered before it settled', async () => {
    const rec = new WhereRecorder();
    await stubUpdate(rec, 'generation_jobs').set().where(eq(generationRequests.org, ORG));
    await stubSelect(rec, 'corpora', []).where(eq(corpora.org, ORG));
    await stubSelect(rec, 'corpora', []).where(eq(corpora.org, ORG)).limit();
    expect(rec.calls.map((c) => c.sql)).not.toContain(NO_PREDICATE);
    rec.expectNoUnfilteredQuery();
  });

  // A chain can settle more than once — `.limit()` awaited on a handle that is
  // itself awaited. One dropped predicate is one finding, not three.
  it('records an unfiltered chain once however many times it settles', async () => {
    const rec = new WhereRecorder();
    const chain = stubSelect(rec, 'corpora', []);
    await chain;
    await chain.limit();
    await chain;
    expect(rec.for('corpora')).toHaveLength(1);
  });

  it('keeps guards independent, so one filtered chain does not cover another', async () => {
    const rec = new WhereRecorder();
    await stubSelect(rec, 'corpora', []).where(eq(corpora.org, ORG));
    await stubSelect(rec, 'corpora', []);
    expect(rec.for('corpora').map((c) => c.sql)).toEqual([
      expect.stringContaining('"org" = $'),
      NO_PREDICATE,
    ]);
  });
});

describe('WhereRecorder.expectEveryQueryScopedTo', () => {
  it('passes when every recorded read of the table carries the tuple', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.project, PROJECT)));
    rec.record(
      'corpora',
      and(eq(corpora.org, ORG), eq(corpora.project, PROJECT), eq(corpora.name, 'payroll')),
    );
    rec.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  // 🔴 THE CASE `expectScopedTo` LETS THROUGH. A file that reads the table
  // twice — once scoped, once not — satisfies "at least one was scoped" while
  // the unscoped read is the cross-tenant one.
  it('FAILS on a second, unscoped read that expectScopedTo tolerates', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.project, PROJECT)));
    rec.record('corpora', eq(corpora.name, 'payroll'));

    // The weaker assertion is green on exactly this input…
    rec.expectScopedTo('corpora', { org: ORG, project: PROJECT });
    // …and the stronger one is not.
    expect(() =>
      rec.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT }),
    ).toThrow(/1 of 2 queries on "corpora" were NOT scoped/);
  });

  it('FAILS on a dropped predicate among otherwise scoped reads', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.project, PROJECT)));
    rec.record('corpora', undefined);
    expect(() =>
      rec.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT }),
    ).toThrow(/NO PREDICATE/);
  });

  it('FAILS vacuously-loudly when nothing was recorded for that table', () => {
    const rec = new WhereRecorder();
    rec.record('documents', eq(corpora.org, ORG));
    expect(() => rec.expectEveryQueryScopedTo('corpora', { org: ORG })).toThrow(/never reached/);
  });
});

describe('WhereRecorder scope matching pairs the column with its own value', () => {
  // 🔴 The column check and the value check used to run independently, so each
  // half could be satisfied by a DIFFERENT term of the same `and()`. Here `org`
  // is compared to a constant and the caller's org is bound to `name`: nothing
  // is scoped to the caller at all, and both halves are nonetheless present.
  it('FAILS when the tenant column and the tenant value are on different terms', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', and(eq(corpora.org, 'some-constant'), eq(corpora.name, ORG)));
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/was scoped to org=acme/);
  });

  // Same split, one level up: `org` is right, `project` is compared to a
  // constant while the caller's project rides on an unrelated column.
  it('FAILS when only the project half is column/value-split', () => {
    const rec = new WhereRecorder();
    rec.record(
      'corpora',
      and(eq(corpora.org, ORG), eq(corpora.project, 'other'), eq(corpora.name, PROJECT)),
    );
    expect(() => rec.expectScopedTo('corpora', { org: ORG, project: PROJECT })).toThrow(
      /was scoped to org=acme \+ project=chat/,
    );
  });

  // The pairing must not reject a legitimate predicate that compares the same
  // column twice — only one of the comparisons has to be the caller's own.
  it('passes when the column is compared twice and one comparison is the caller', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', or(eq(corpora.org, 'someone-else'), eq(corpora.org, ORG)));
    rec.expectScopedTo('corpora', { org: ORG });
  });

  // `isScopedTo` exists so a file asserting on ONE record inside its own loop
  // gets the paired check instead of re-deriving the decoupled one. It has to
  // agree with the assertions, or the two readings drift apart again.
  it('exposes the same verdict per-record as the assertions reach as a whole', () => {
    const rec = new WhereRecorder();
    const scoped = rec.record('corpora', and(eq(corpora.org, ORG), eq(corpora.project, PROJECT)));
    const split = rec.record('corpora', and(eq(corpora.org, 'some-constant'), eq(corpora.name, ORG)));

    expect(isScopedTo(scoped, { org: ORG, project: PROJECT })).toBe(true);
    expect(isScopedTo(split, { org: ORG })).toBe(false);
    expect(isScopedTo(rec.record('corpora', undefined), { org: ORG })).toBe(false);
  });
});

describe('WhereRecorder.reset', () => {
  it('empties the log so a per-test recorder cannot inherit the last test’s calls', () => {
    const rec = new WhereRecorder();
    rec.record('corpora', eq(corpora.org, ORG));
    rec.reset();
    expect(rec.calls).toEqual([]);
    expect(() => rec.expectScopedTo('corpora', { org: ORG })).toThrow(/never reached/);
  });
});
