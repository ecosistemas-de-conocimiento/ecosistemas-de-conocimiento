// 🔴 A `where()` STUB THAT TAKES NO PARAMETER PROVES NOTHING.
//
// ── The defect this module exists to kill ──────────────────────────────────
// Tenant isolation in this service is enforced by ONE thing: the `(org,
// project)` predicate every scoped query carries. Across this repo, twenty
// test files stubbed the drizzle query builder like this:
//
//     const chain = { where: () => chain, limit: () => Promise.resolve(rows) };
//
// `where` there takes NO argument. Whatever predicate the production code
// built was DISCARDED at the door, so those tests agreed with any WHERE clause
// at all — INCLUDING NONE. Delete `eq(corpora.org, ctx.org)` from
// `corpus-delete.ts` and the suite stayed green while a cross-tenant corpus
// wipe went live. That is not a weak assertion; it is the assertion being
// absent while looking present.
//
// ── What replaces it ───────────────────────────────────────────────────────
// A stub whose `where()` TAKES its argument, serialises it with drizzle's own
// dialect (`PgDialect.sqlToQuery` — the same code path that talks to Postgres),
// and records the resulting SQL plus bound parameters. The test then asserts
// the tenant columns and the tenant VALUES are actually in there.
//
// ⚠ THIS IS THE CHEAP COMPLEMENT, NOT THE PROOF. A mock still cannot prove
// isolation: it can only show which predicate was BUILT, never that Postgres
// honoured it. The full-strength proof — seed rows owned by tenant B, act as
// tenant A, then READ B'S ROWS BACK — lives in
// `src/routes/tenant-isolation.integration.test.ts` against a real Postgres.
// What this module buys is a millisecond-scale, database-free tripwire in the
// files that were already there, so a dropped predicate fails in the unit lane
// too instead of only in the docker-gated one.
//
// ── Why `<NO PREDICATE>` is a recorded VALUE and not a thrown error ────────
// `where(undefined)` is exactly the shape a removed tenant predicate takes:
// strip the `eq(...)` terms from an `and(...)` and drizzle hands `where()` an
// `undefined`. If the recorder quietly ignored that, the mutation it exists to
// catch would leave no trace. So `undefined`/`null` is recorded as the literal
// marker string `<NO PREDICATE>`, which every assertion below can see and
// report on by name.
//
// ── 🔴 The hole `where(undefined)` does NOT cover: never calling `where()` ──
// Recording `undefined` catches the mutation that leaves the CALL in place and
// empties it. It cannot catch the mutation that deletes the call:
//
//     await db.update(generationJobs).set({ status: 'running' })
//                                    // ← `.where(eq(id, row.id))` deleted
//
// That is legal drizzle and rewrites EVERY tenant's job rows. In a stub it is
// invisible twice over: `set()` returns a plain object with a `where` key and
// no `then`, `await` of a non-thenable resolves to the object itself, and the
// worker ignores the result — so nothing throws, nothing is recorded, and
// `expectNoUnfilteredQuery()` inspects a list the missing query never entered.
// Measured on this repo: deleting that one `.where()` from
// `generation.worker.ts` left the full unit suite green at 1328/1328.
//
// A recorder can only see what a stub hands it, so the fix is a rule the STUBS
// have to follow: every chain routes its terminus — `then`, `limit`,
// `returning`, `catch`, whatever finally settles — through the guard from
// `WhereRecorder.guard()`. Read the terminals off the production call sites and
// not off that list: `orchestrator.ts` ends its only UPDATE in `.catch(…)`, and
// a stub missing that one turns the mutation into "catch is not a function". The
// guard records `<NO PREDICATE>` when a chain settles having never been given
// one, which puts the deleted-call mutation into the same list as the emptied
// one and lets the assertions that already existed reject it. A stub that
// records via `record()` alone is still blind to this case; see `guard()`.

import { expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/** What a recorder stores for a single `where()` call. */
export interface RecordedWhere {
  /** The table the query targeted, as the calling stub named it. */
  table: string;
  /** The predicate as drizzle itself would send it to Postgres. */
  sql: string;
  /** The values drizzle bound to that predicate's placeholders. */
  params: unknown[];
}

/**
 * The marker recorded when production code passes no predicate at all.
 * Deliberately a value, not an exception — see the module header.
 */
export const NO_PREDICATE = '<NO PREDICATE>';

/**
 * One stubbed query chain's view of the recorder.
 *
 * A chain is whatever `db.select().from(t)`, `db.update(t).set(v)` or
 * `db.delete(t)` returns: an object the production code either filters and then
 * settles, or settles directly. `where()` marks it filtered; `settle()` is
 * called wherever it turns into a value.
 */
export interface ChainGuard {
  /** Record this chain's predicate. Marks the chain filtered. */
  where(predicate: unknown): RecordedWhere;
  /**
   * Call at EVERY point the chain settles — `then`, `limit`, `returning`, an
   * `execute`, and `catch`. Records `<NO PREDICATE>` if `where()` was never
   * called on this chain, at most once. Returns `value` unchanged so a stub can
   * wrap in place: `limit: () => guard.settle(Promise.resolve(rows))`.
   *
   * ⚠ `catch` IS A TERMINAL. `orchestrator.ts` ends its only UPDATE with
   * `.catch(() => undefined)`; a stub whose `set()` result has `then` but no
   * `catch` throws `db.update(...).set(...).catch is not a function` on the
   * very mutation this guard exists to name, which reads as a broken stub
   * rather than as a whole-table write. Enumerate the terminals from the
   * production call sites, not from this list.
   */
  settle<T>(value: T): T;
}

/**
 * One shared dialect. `sqlToQuery` is pure with respect to the dialect, so a
 * single instance is safe across every test file and avoids re-constructing it
 * per call.
 */
const dialect = new PgDialect();

/**
 * Serialise whatever production code handed to `where()`.
 *
 * Anything that is not a drizzle `SQL` object is recorded as `<NO PREDICATE>`
 * rather than throwing: the recorder's job is to make a missing filter VISIBLE
 * to an assertion, and a stub that explodes mid-query would instead surface as
 * an unrelated failure somewhere further down the call stack.
 */
export function snapshotWhere(table: string, predicate: unknown): RecordedWhere {
  if (predicate === undefined || predicate === null) {
    return { table, sql: NO_PREDICATE, params: [] };
  }
  try {
    const q = dialect.sqlToQuery(predicate as Parameters<PgDialect['sqlToQuery']>[0]);
    return { table, sql: q.sql, params: [...q.params] };
  } catch {
    return { table, sql: NO_PREDICATE, params: [] };
  }
}

/**
 * A recording stub's memory. One per test file (or per test), reset in
 * `beforeEach`.
 *
 * Usage inside a `vi.mock('../db/client.js', …)` chain:
 *
 * ```ts
 * const wheres = new WhereRecorder();
 * // …
 * const chain = {
 *   where: (p: unknown) => { wheres.record('corpora', p); return chain; },
 *   limit: () => Promise.resolve(rows),
 * };
 * // …then, in the test:
 * wheres.expectScopedTo('corpora', { org: ORG, project: PROJECT });
 * ```
 */
export class WhereRecorder {
  /** Every `where()` the production code made, in call order. */
  readonly calls: RecordedWhere[] = [];

  /** Record one `where()` call. Returns the snapshot for convenience. */
  record(table: string, predicate: unknown): RecordedWhere {
    const snap = snapshotWhere(table, predicate);
    this.calls.push(snap);
    return snap;
  }

  /**
   * 🔴 THE OTHER HALF OF THE GATE — see the module header.
   *
   * `record()` sees a predicate only when production code CALLS `where()`.
   * `guard()` additionally sees the chains that never call it. Build one per
   * chain instance (per `from()`, per `set()`, per `delete()`), route the
   * chain's `where` through `guard.where` and every terminus through
   * `guard.settle`, and a deleted `.where()` lands in `calls` as
   * `<NO PREDICATE>` instead of vanishing:
   *
   * ```ts
   * update(table) {
   *   const g = wheres.guard(tableName(table));
   *   return {
   *     set(values) {
   *       return {
   *         where(p) { g.where(p); return Promise.resolve(); },
   *         // `await db.update(t).set(v)` with no `.where()` lands HERE.
   *         then(res, rej) { return g.settle(Promise.resolve()).then(res, rej); },
   *       };
   *     },
   *   };
   * }
   * ```
   *
   * ⚠ The `then` is not optional decoration. Without it the awaited chain is a
   * non-thenable, `await` hands the production code the stub object back, and a
   * whole-table write leaves no trace at all.
   *
   * ── 🔴 ADOPTING THE GUARD CAN WEAKEN A FILE. RE-CHECK TWO THINGS. ─────────
   * Both were measured while wiring it into the files on this branch.
   *
   * 1. COUNTS STOP DROPPING. Before the guard, an unfiltered query recorded
   *    NOTHING, so `expect(wheres.for('update:generation_requests'))
   *    .toHaveLength(1)` fell to 0 and went red. After, it records one
   *    `<NO PREDICATE>` entry and the count STAYS 1. Any assertion that was
   *    catching a dropped predicate through a count is no longer catching it —
   *    put `expectNoUnfilteredQuery()` ABOVE it so the failure keeps its name.
   *
   * 2. AN ACCIDENTAL GATE CAN DISAPPEAR. Some chains were red under mutation
   *    only because the stub lacked the method the deleted call would have
   *    reached — `db.update(t).set(v).returning()` throwing "returning is not a
   *    function", surfacing as an unrelated 500. Completing the chain shape
   *    removes that crash. If nothing asserts on the predicate, the mutation
   *    goes from red to GREEN. Add the assertion in the same edit; do not
   *    complete a chain's shape and leave.
   *
   * Neither is a reason to skip the guard — a gate that fires with the wrong
   * name is not a gate — but wiring it without checking is a net loss.
   */
  guard(table: string): ChainGuard {
    let filtered = false;
    let recorded = false;
    return {
      where: (predicate: unknown): RecordedWhere => {
        filtered = true;
        return this.record(table, predicate);
      },
      settle: <T>(value: T): T => {
        // Once per chain: a chain may settle twice (`.limit()` awaited on a
        // handle that is itself awaited) and one marker is the honest count.
        if (!filtered && !recorded) {
          recorded = true;
          this.record(table, undefined);
        }
        return value;
      },
    };
  }

  /** Forget everything — call from `beforeEach`. */
  reset(): void {
    this.calls.length = 0;
  }

  /** Every predicate recorded against `table`. */
  for(table: string): RecordedWhere[] {
    return this.calls.filter((c) => c.table === table);
  }

  /**
   * 🔴 THE ASSERTION THE WHOLE MODULE IS FOR.
   *
   * Fails unless at least one predicate recorded for `table` carries BOTH the
   * tenant COLUMN and the tenant VALUE — column, because a query could bind
   * the right string to the wrong filter; value, because a query could compare
   * `org` against a constant or against another column.
   *
   * Pass `project` to require the second half of the tenancy tuple as well.
   * Omit it only where the production query is genuinely org-scoped and the
   * schema says so (`generation_requests` idempotency is unique on
   * `(org, client_request_id)`, not on project).
   *
   * ⚠ AT LEAST ONE. If the code under test reads `table` twice and only one of
   * the two reads is scoped, this PASSES. That is deliberate where a file has a
   * legitimately unscoped read of the same table (a by-id fetch of a row whose
   * id was itself minted under a tenant predicate), and a trap everywhere else:
   * the second, unscoped read is exactly the cross-tenant one. Where every read
   * of `table` must carry the tuple, use {@link expectEveryQueryScopedTo}.
   */
  expectScopedTo(table: string, scope: { org: string; project?: string }): void {
    const recorded = this.for(table);
    expect(
      recorded.length,
      `no where() was recorded for "${table}" at all — the stub was never reached, ` +
        'so this assertion would pass vacuously',
    ).toBeGreaterThan(0);

    const scoped = recorded.filter((c) => matchesScope(c, scope));
    expect(
      scoped.length,
      `no query on "${table}" was scoped to ${describeScope(scope)}. ` +
        `Recorded predicates:\n${format(recorded)}`,
    ).toBeGreaterThan(0);
  }

  /**
   * Like {@link expectScopedTo}, but EVERY predicate recorded for `table` must
   * carry the tuple — not just one of them.
   *
   * This is the assertion to reach for by default. `expectScopedTo` answers
   * "did some query scope itself?", which a file that reads the table twice can
   * satisfy while shipping an unscoped second read; this one answers "is any
   * read of this table unscoped?", which is the question tenancy actually asks.
   * Prefer `expectScopedTo` only where an unscoped read of the same table is
   * intended and the test says why.
   */
  expectEveryQueryScopedTo(table: string, scope: { org: string; project?: string }): void {
    const recorded = this.for(table);
    expect(
      recorded.length,
      `no where() was recorded for "${table}" at all — the stub was never reached, ` +
        'so this assertion would pass vacuously',
    ).toBeGreaterThan(0);

    const unscoped = recorded.filter((c) => !matchesScope(c, scope));
    expect(
      format(unscoped),
      `${unscoped.length} of ${recorded.length} queries on "${table}" were NOT scoped to ` +
        `${describeScope(scope)}. All recorded predicates:\n${format(recorded)}\n` +
        'The unscoped ones',
    ).toBe('');
  }

  /**
   * Fails if ANY recorded predicate is the `<NO PREDICATE>` marker. Use where
   * an unfiltered query would be a full-table read or a full-table write,
   * regardless of which tenant columns the filtered ones happen to carry.
   *
   * ⚠ IT INSPECTS THE RECORDED LIST, NOT THE CODE. A query only appears in that
   * list because a stub put it there, so this assertion is exactly as complete
   * as the stub is. It is a real gate over a chain whose terminus runs through
   * {@link guard} — that is what puts a never-filtered chain in the list — and
   * it is vacuous over a chain that only calls `record()` from its `where`,
   * because the mutation that DELETES the `.where()` call never reaches
   * `record()`. Do not read a green `expectNoUnfilteredQuery()` as "no
   * unfiltered query ran"; read it as "no predicate the stub saw was empty".
   */
  expectNoUnfilteredQuery(): void {
    const bare = this.calls.filter((c) => c.sql === NO_PREDICATE);
    expect(
      bare.map((c) => c.table),
      'a query ran with NO predicate at all — that is a whole-table read or write',
    ).toEqual([]);
  }
}

/**
 * True when `recorded` filters on every column/value pair in `scope`.
 *
 * Exported as {@link isScopedTo} for tests that assert on ONE record rather
 * than on the whole log — a hand-rolled `expect(sql).toMatch(/"org" = \$\d+/)`
 * plus `expect(params).toContain(ctx.org)` is the decoupled check
 * {@link comparesColumnTo} exists to kill, and re-deriving it per file puts the
 * flaw back one file at a time.
 */
function matchesScope(recorded: RecordedWhere, scope: { org: string; project?: string }): boolean {
  if (!comparesColumnTo(recorded, 'org', scope.org)) return false;
  if (scope.project !== undefined && !comparesColumnTo(recorded, 'project', scope.project)) {
    return false;
  }
  return true;
}

/**
 * Does the serialised SQL compare `column` to a bound parameter WHOSE VALUE is
 * `value`?
 *
 * 🔴 The column and the value have to be checked TOGETHER, not one after the
 * other. Checking "the SQL mentions `org`" and "`params` contains the org
 * string" independently accepts a predicate where each half is satisfied by a
 * DIFFERENT term:
 *
 *     and(eq(t.org, 'some-constant'), eq(t.name, ctx.org))
 *     → `"org" = $1 and "name" = $2`, params ['some-constant', 'acme']
 *
 * `org` appears as a column, `'acme'` appears as a value, and nothing is scoped
 * to `'acme'` at all. Every existing mutation test is single-term, so none of
 * them separates the two readings. Pairing them does: drizzle numbers
 * placeholders from `$1` in `params` order, so `"org" = $n` binds
 * `params[n - 1]`, and that is the value to compare.
 *
 * Matching drizzle's own output shape, `"table"."org" = $1`, also keeps a bare
 * substring search out of it: `sql.includes('org')` would be satisfied by an
 * `organisation_id` column or by the word appearing inside a bound string.
 */
function comparesColumnTo(
  recorded: RecordedWhere,
  column: 'org' | 'project',
  value: string,
): boolean {
  // `matchAll`, not a single `match`: `or(eq(t.org, a), eq(t.org, b))` compares
  // the column twice and only one of the two has to be the caller's own value.
  const sites = recorded.sql.matchAll(new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`, 'g'));
  for (const site of sites) {
    if (recorded.params[Number(site[1]) - 1] === value) return true;
  }
  return false;
}

function describeScope(scope: { org: string; project?: string }): string {
  return scope.project === undefined
    ? `org=${scope.org}`
    : `org=${scope.org} + project=${scope.project}`;
}

function format(recorded: RecordedWhere[]): string {
  return recorded
    .map((c, i) => `  [${i}] ${c.table}: ${c.sql}  params=${JSON.stringify(c.params)}`)
    .join('\n');
}

/**
 * Does ONE recorded predicate carry the tenant tuple, column paired to value?
 *
 * The same check `expectScopedTo` and `expectEveryQueryScopedTo` run, exposed
 * for the places that assert on a single record inside a loop of their own.
 * Use it instead of hand-rolling `sql` and `params` assertions side by side:
 * done separately they accept `and(eq(t.org, 'const'), eq(t.name, ctx.org))`,
 * where each half is satisfied by a different term and nothing is scoped.
 */
export function isScopedTo(
  recorded: RecordedWhere,
  scope: { org: string; project?: string },
): boolean {
  return matchesScope(recorded, scope);
}
