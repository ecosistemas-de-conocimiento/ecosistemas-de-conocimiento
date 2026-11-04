// Unit tests for processGenerationJob.
//
// Pattern (same as services/generation/cancel.test.ts + orchestrator.test.ts):
//   - drizzle `db` is replaced with a tiny stub that exposes the chainable
//     surface processGenerationJob touches (`select`, `update`, `transaction`,
//     `execute`). `transaction(fn)` calls `fn(stub)` so the recorder catches
//     in-tx writes too.
//   - The router is a `vi.fn()` returning a canned `RouteResult`.
//   - The event bus is a fresh `createEventBus()` per test.
//   - We mock `resolveSpec` via `vi.mock` so we don't have to populate
//     project_configs / registry rows in the stub.
//   - `setImmediate` is overridden per test (assigned to `global.setImmediate`)
//     to run callbacks synchronously when we want to assert callback POSTs.
//
// We do NOT exercise `startGenerationWorker` — that touches Redis. The
// processGenerationJob function is the unit under test.
//
// ── 🔴 Why `where()` takes its argument now, and where that MATTERS here ───
// The stub's `where` used to be `() => chain` — no parameter. Whatever
// predicate the production code built was DISCARDED at the door, so every case
// agreed with any WHERE clause at all, including none. Across this repo that
// exact stub shape let a dropped `eq(corpora.org, ctx.org)` ship a cross-tenant
// wipe past a green suite.
//
// ⚠ BUT most of this worker is NOT a tenant-attack surface, and pretending
// otherwise would be worse than leaving it alone. Nearly every query here is
// keyed by a server-generated UUID that arrived in the BullMQ job payload —
// `eq(generationJobs.id, data.jobId)`, `eq(generationRequests.id,
// row.generationRequestId)`, `eq(generationJobs.id, row.id)`. Those ids were
// MINTED by the orchestrator under a tenant predicate and never round-trip
// through a consumer, so adding `and(eq(org, …))` to them would guard nothing.
// They get no tenant assertion; asserting on them would be theatre.
//
// ONE query here is genuinely tenant-scoped: `resolveProjectCallbackUrl`
// (generation.worker.ts ~940) reads `project_configs` by `and(eq(org),
// eq(project))` — a lookup keyed by DATA, not by an id we minted, and it
// decides WHERE a callback envelope carrying generated output is POSTed. Drop
// its `eq(projectConfigs.org, org)` and another tenant's `callback_url` can
// receive this tenant's output. It fires on every job completion (the request
// row's own `callbackUrl` is null in the default fixture), so it is exercised
// by nearly every case in this file — and was, until now, entirely unwatched.
//
// The recorder also watches every UPDATE predicate. That is not a tenant guard;
// it is a full-table-write guard — `db.update(generationJobs).set(…)` with no
// `.where()` is legal drizzle and would rewrite every tenant's job rows.
//
// ⚠ THAT SENTENCE WAS FALSE UNTIL THE STUB GREW A `then`. A recorder sees only
// what a stub hands it, and the stub only recorded from inside `where()` — so
// it watched the predicates that were PASSED and was blind to the call being
// DELETED. `set()` returned a plain object with no `then`; `await` of a
// non-thenable settles at once, the worker ignores the result, and the whole
// query left no trace. Measured: deleting `.where(eq(generationJobs.id,
// row.id))` from `generation.worker.ts:324` kept the full unit suite green at
// 1328/1328. Both terminals — the select chain's `then`/`limit` and the update
// chain's `then` — now settle through `WhereRecorder.guard()`, which records
// `<NO PREDICATE>` for a chain that was never filtered. The claim above holds
// for as long as that stays true; a stub that goes back to recording only from
// `where()` silently switches this file's blast-radius test off again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client.js';
import {
  generationJobs,
  generationRequests,
  projectConfigs,
} from '../db/schema/index.js';
import { createEventBus, type EventBus } from '../services/events/bus.js';
import type { AppEvent } from '../services/events/types.js';
import type { LLMRouter, RouteResult } from '../services/ai/router/types.js';
import type { ResolvedSpec } from '../services/registry/resolve.js';
import type { GenerationJobData } from '../types/generation.js';
import { NO_PREDICATE, WhereRecorder, type RecordedWhere } from '../test/where-recorder.js';

// Mock resolveSpec at the module boundary so the worker's call doesn't hit
// the real DB code path. The test injects a `vi.fn()` per case via the
// mocked module's named export.
vi.mock('../services/registry/resolve.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/registry/resolve.js')
  >('../services/registry/resolve.js');
  return {
    ...actual,
    resolveSpec: vi.fn(),
  };
});

import { resolveSpec } from '../services/registry/resolve.js';

import {
  heldOrEstimatedReserveUsd,
  lostReserveUsd,
  processGenerationJob,
} from './generation.worker.js';

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

type JobRow = typeof generationJobs.$inferSelect;
type RequestRow = typeof generationRequests.$inferSelect;

interface StubState {
  jobs: Map<string, Partial<JobRow> & { id: string }>;
  requests: Map<string, Partial<RequestRow> & { id: string }>;
  projectConfigs: Array<{
    org: string;
    project: string;
    callbackUrl?: string | null;
  }>;
  updates: Array<{
    table: 'jobs' | 'requests';
    set: Record<string, unknown>;
    whereId?: string;
  }>;
  executes: Array<{ sql: string }>;
  /** Callback-deliveries rows the worker inserted via `enqueueCallback`. */
  callbackDeliveries: Array<Record<string, unknown>>;
  /**
   * Every predicate the worker passed to a `where()`, labelled by table and
   * serialised with drizzle's own dialect. Fresh per test via `makeState()`.
   */
  wheres: WhereRecorder;
  /**
   * Every `count(*) filter (where <column> = <value>)` aggregate the worker
   * issued against `generation_jobs`, as the column and value it was COMPILED
   * against. `undefined` for an aggregate with no filter at all — recorded
   * rather than dropped, so deleting the filter is visible here instead of
   * quietly widening the count.
   */
  countFilters: Array<{
    filter: { column: string; value: string } | undefined;
    /**
     * Was this aggregate issued INSIDE `db.transaction`? The cancelled count
     * used to be a SECOND SNAPSHOT taken after the counters transaction had
     * already committed, so the envelope's arithmetic came from two readings of
     * the table with a window in between. `false` here is that defect.
     */
    inTransaction: boolean;
  }>;
  /** Nesting depth of `db.transaction`, so the flag above can be set. */
  txDepth: number;
  /**
   * Models the half of the lost-worker predicate this stub cannot express:
   * `started_at < now() - <window>`. False (the default) means the row's
   * `started_at` is recent, so the reap's UPDATE matches NOTHING — which is
   * exactly what a re-delivery to a still-live worker must see.
   */
  lost: boolean;
}

function makeState(): StubState {
  return {
    jobs: new Map(),
    requests: new Map(),
    projectConfigs: [],
    updates: [],
    executes: [],
    callbackDeliveries: [],
    wheres: new WhereRecorder(),
    countFilters: [],
    txDepth: 0,
    lost: false,
  };
}

/** The table a drizzle `from(...)` / `update(...)` was handed, as drizzle names it. */
function tableName(table: unknown): string {
  const name = (table as Record<symbol, unknown> | null)?.[Symbol.for('drizzle:Name')];
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * Build a chainable select-result handle. The worker uses two access shapes:
 *   - `.where(...).limit(1)` → Promise<rows>
 *   - `.where(...)` (no `.limit`) → Promise<rows> (jobs sibling fetch)
 * The chain returns the SAME rows for both shapes; callers pass already-filtered
 * data via the state-resolver function.
 *
 * 🔴 `where` TAKES its predicate and records it. The old signature declared
 * `where: (...args: unknown[]) => typeof chain` — it accepted arguments in the
 * TYPE and threw them away in the BODY, which is the worst of both worlds: it
 * type-checks against real drizzle while proving nothing about the predicate.
 *
 * 🔴 …and both TERMINALS settle through the same guard, so a chain that never
 * calls `where()` at all is recorded rather than passing unseen. `then` is the
 * one that matters here: this chain IS thenable, so `await db.select().from(t)`
 * with the `.where()` deleted used to hand the worker the right rows and leave
 * the recorder empty.
 */
function selectChain(table: string, wheres: WhereRecorder, rowsFn: () => unknown[]) {
  const guard = wheres.guard(table);
  const chain: {
    where: (predicate: unknown) => typeof chain;
    limit: (n: number) => Promise<unknown[]>;
    then: (resolve: (v: unknown[]) => void) => void;
  } = {
    where: (predicate: unknown) => {
      guard.where(predicate);
      return chain;
    },
    limit: async () => guard.settle(rowsFn()),
    then: (resolve) => {
      Promise.resolve(guard.settle(rowsFn())).then(resolve);
    },
  };
  return chain;
}

/** Flatten a drizzle `sql\`...\`` template into a plain string for test asserts. */
function stringifySql(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object' && 'value' in c) {
          const v = (c as { value: unknown }).value;
          if (Array.isArray(v)) return v.join('');
          return String(v ?? '');
        }
        return String(c ?? '');
      })
      .join('');
  }
  return String(q);
}

/**
 * Does this `select({...})` ask for a `count(*)` AGGREGATE rather than for rows?
 *
 * `updateParentCounters` issues `select({ n: sql`count(*) filter (…)::int` })`
 * and reads `rows[0].n`. Every other select in the worker asks for whole rows.
 * Handing
 * the aggregate the row list makes `rows[0].n` `undefined`, which `Number(…)`
 * turns into 0 — the exact value the bug under test produces, so the stub
 * would agree with the broken code AND the fixed code. It has to be answered
 * as an aggregate or not answered at all.
 */
function isCountAggregate(cols: unknown): boolean {
  return !!cols && typeof cols === 'object' && 'n' in (cols as Record<string, unknown>);
}

/** The VALUE drizzle bound to `"<column>" = $n` in a recorded predicate. */
function boundValue(recorded: RecordedWhere, column: string): unknown {
  const site = recorded.sql.match(new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`));
  return site ? recorded.params[Number(site[1]) - 1] : undefined;
}

/**
 * Render one chunk of a drizzle `sql` template as text.
 *
 * `stringifySql` above handles the STATEMENT-level case, where every chunk
 * either carries a `value` or stringifies usefully. A `count(*) filter (where
 * …)` aggregate does not: the column interpolates as a `PgEnumColumn` object,
 * which `String()` flattens to `[object Object]`, taking the column NAME —
 * the only thing that says which filter this is — with it.
 */
function renderChunk(c: unknown): string {
  if (c == null) return '';
  if (typeof c !== 'object') return String(c);
  const o = c as Record<string, unknown>;
  if (Array.isArray(o['value'])) return (o['value'] as unknown[]).join('');
  if ('value' in o) return String(o['value'] ?? '');
  if (typeof o['name'] === 'string') return o['name']; // a Column
  return String(c);
}

/**
 * The `<column>` and `<value>` an aggregate's `filter (where <column> =
 * <value>)` was compiled against, or undefined when it has no filter at all.
 *
 * 🔴 THIS IS WHAT KEEPS THE STUB HONEST NOW THAT THE COUNT MOVED. The cancelled
 * count used to be its own query with `status = 'cancelled'` in the WHERE, and
 * a dedicated file proved both halves of that predicate by reading the bound
 * VALUES. Folding it into the counters transaction as a
 * `filter (where …)` moved the status OUT of the WHERE clause the recorder
 * watches — so a stub that only reads the WHERE would answer "every job on the
 * request" and stay green with the filter deleted, or with it compiled against
 * 'failed'. Read the aggregate itself, or do not model it.
 */
function aggregateFilter(cols: unknown): { column: string; value: string } | undefined {
  const n = (cols as { n?: unknown } | null | undefined)?.n;
  if (!n || typeof n !== 'object' || !('queryChunks' in n)) return undefined;
  const text = (n as { queryChunks: unknown[] }).queryChunks.map(renderChunk).join('');
  const m = /filter\s*\(\s*where\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  return { column: m[1]!, value: m[2]!.trim() };
}

/**
 * Count the job rows a REAL Postgres would have matched for the aggregate that
 * just recorded its predicate — evaluated from the SQL drizzle built against
 * the VALUES drizzle bound, so a WHERE filtering `status` against the wrong
 * value answers a different question here too.
 *
 * Both filters are modelled: the WHERE (which scopes the request) and the
 * aggregate's own `filter (where status = …)`. Either one missing means the
 * count is over a wider set of rows, which is exactly what the caller would
 * get from Postgres.
 */
function countMatchingJobs(state: StubState, cols?: unknown): number {
  const last = state.wheres.for('generation_jobs').at(-1);
  const rows = Array.from(state.jobs.values());
  if (!last || last.sql === NO_PREDICATE) return rows.length; // unfiltered ⇒ the whole table
  const req = boundValue(last, 'generation_request_id');
  const status = boundValue(last, 'status');
  const agg = aggregateFilter(cols);
  const aggStatus = agg && agg.column === 'status' ? agg.value : undefined;
  return rows.filter(
    (r) =>
      (req === undefined || r.generationRequestId === req) &&
      (status === undefined || r.status === status) &&
      (aggStatus === undefined || r.status === aggStatus),
  ).length;
}

function makeDb(state: StubState): Db {
  const stub: Record<string, unknown> = {
    select(cols?: unknown) {
      // Track the table queried so the chain returns the right rows.
      let table: unknown = null;
      return {
        from(t: unknown) {
          table = t;
          return selectChain(tableName(t), state.wheres, () => {
            if (table === generationJobs) {
              if (isCountAggregate(cols)) {
                state.countFilters.push({
                  filter: aggregateFilter(cols),
                  inTransaction: state.txDepth > 0,
                });
                return [{ n: countMatchingJobs(state, cols) }];
              }
              return Array.from(state.jobs.values());
            }
            if (table === generationRequests) {
              return Array.from(state.requests.values());
            }
            if (table === projectConfigs) {
              return state.projectConfigs;
            }
            return [];
          });
        },
      };
    },
    update(table: unknown) {
      const which: 'jobs' | 'requests' =
        table === generationJobs ? 'jobs' : 'requests';
      const label = tableName(table);
      return {
        set(values: Record<string, unknown>) {
          const captured: Record<string, unknown> = { ...values };
          const upd: StubState['updates'][number] = {
            table: which,
            set: captured,
          };
          state.updates.push(upd);
          const guard = state.wheres.guard(label);
          // Bound params of the predicate this chain was given, if any. Used
          // ONLY to model the STATUS half of the filter — see `statusMatches`.
          let boundParams: unknown[] = [];
          // Apply the SET to every row we know about. The worker scopes by
          // `id`; the stub does not model the ID filter, so tests inspect the
          // recorded `updates` array for ordering. Runs on BOTH terminals
          // because in real Postgres an unfiltered UPDATE writes every row —
          // that is the whole reason the unfiltered case has to be visible.
          //
          // 🔴 THE STATUS FILTER IS MODELLED, AND HAS TO BE. The worker's
          // terminal writes now carry `status NOT IN ('completed','failed',
          // 'cancelled')` and its claim carries `status = 'queued'`, and the
          // ROW COUNT those return is what the worker branches on. A stub that
          // wrote every row and returned every id would report "claimed" and
          // "settled" for a row that Postgres would have refused, which is the
          // opposite of the bug being guarded. The condition is read off the
          // BOUND PARAMS drizzle actually serialised, not off a hand-written
          // copy of the predicate.
          //
          // ⚠ It is still a stub: this proves the worker BRANCHES correctly on
          // the row count. That real Postgres refuses the write is proven in
          // `generation.worker.stalled.integration.test.ts`.
          //
          // Read off the bound params GENERICALLY rather than from a hardcoded
          // terminal list: the parent-request guard bans four statuses
          // (`partial` is terminal for a request and not for a job) and a
          // hardcoded three-element list silently ignored the fourth. One
          // status param ⇒ an equality (the claim); more than one ⇒ the
          // NOT IN guard.
          const STATUS_VALUES = [
            'queued',
            'running',
            'partial',
            'completed',
            'failed',
            'cancelled',
          ];
          const statusMatches = (rowStatus: unknown): boolean => {
            const statusParams = boundParams
              .map((pp) => String(pp))
              .filter((pp) => STATUS_VALUES.includes(pp));
            if (statusParams.length > 1) return !statusParams.includes(String(rowStatus));
            if (statusParams.length === 1) return statusParams[0] === String(rowStatus);
            return true;
          };
          const apply = (): Array<{ id: string }> => {
            const affected: Array<{ id: string }> = [];
            // Only `settleLostGenerationJob` writes `metadata` on a job row,
            // so that field identifies the lost-worker transition — the one
            // write whose predicate also names `started_at`.
            const isLostWrite = which === 'jobs' && captured['metadata'] !== undefined;
            if (isLostWrite && !state.lost) return [];
            if (which === 'jobs') {
              for (const [id, row] of state.jobs) {
                if (!statusMatches(row.status)) continue;
                state.jobs.set(id, { ...row, ...resolveSqlExprs(captured, row) });
                affected.push({ id });
              }
            } else {
              for (const [id, row] of state.requests) {
                if (!statusMatches(row.status)) continue;
                state.requests.set(id, {
                  ...row,
                  ...resolveSqlExprs(captured, row),
                });
                affected.push({ id });
              }
            }
            return affected;
          };
          const filtered = {
            then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
            // The terminal the guarded writes use: `.where(...).returning({id})`.
            // The worker reads `.length` off this to decide whether IT settled
            // the row, so it must reflect the status filter above.
            returning() {
              return Promise.resolve(apply());
            },
            catch(f: (e: unknown) => unknown) {
              return Promise.resolve(apply()).catch(f);
            },
          };
          return {
            // Recorded for the full-table-write guard, NOT as a tenant guard:
            // these are all `eq(<table>.id, <server-minted uuid>)` — now
            // sometimes AND-ed with a status condition.
            where(predicate: unknown) {
              boundParams = guard.where(predicate).params;
              return filtered;
            },
            // 🔴 THE TERMINAL THAT USED NOT TO EXIST, AND THE HOLE IT LEFT.
            // `await db.update(generationJobs).set({…})` with the `.where()`
            // DELETED resolved against a plain object with no `then`: `await`
            // of a non-thenable settles immediately, the worker ignores the
            // result, and nothing reached the recorder. Measured:
            // deleting `.where(eq(generationJobs.id, row.id))` from
            // `generation.worker.ts:324` — a whole-table write in real drizzle
            // — left the suite green at 1328/1328. Settling through the guard
            // records `<NO PREDICATE>`, which the assertion below rejects.
            then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
              guard.settle(null);
              apply();
              return Promise.resolve(undefined).then(resolve, reject);
            },
            // Same hole, one call further along: `.set(…).returning(…)` with
            // the `.where()` DELETED is a whole-table write that returns every
            // row's id — and would read as "I settled it" to the worker.
            returning() {
              guard.settle(null);
              return Promise.resolve(apply());
            },
          };
        },
      };
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      state.txDepth += 1;
      try {
        return await fn(stub);
      } finally {
        state.txDepth -= 1;
      }
    },
    async execute(q: unknown) {
      // jsonb_set UPDATE for __renderedPrompt — accept and record it.
      state.executes.push({ sql: stringifySql(q) });
      return { rows: [] };
    },
    /**
     * `insert(callbackDeliveries).values(...).returning(...)` from
     * `enqueueCallback`. We don't care about other inserts — there are none
     * in the worker path.
     */
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          const row = { id: `mock-delivery-${state.callbackDeliveries.length + 1}`, ...v };
          state.callbackDeliveries.push(row);
          const out = Promise.resolve();
          return Object.assign(out, {
            returning() {
              return Promise.resolve([{ id: row.id }]);
            },
          });
        },
      };
    },
  };
  return stub as unknown as Db;
}

/**
 * SQL template tags emitted by drizzle's `sql\`\`` carry a `.queryChunks`
 * shape we don't want to evaluate. We swap them out with a flat increment
 * applied against the current row so counter logic stays observable in tests.
 */
/**
 * Does this drizzle `sql` expression reference `col` anywhere, at any nesting
 * depth? Identity on the column object, so it cannot be fooled by a same-named
 * column on another table or by SQL-text formatting.
 */
function mentionsColumn(expr: unknown, col: unknown): boolean {
  if (expr === col) return true;
  if (!expr || typeof expr !== 'object') return false;
  const chunks = (expr as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return false;
  return chunks.some((c) => mentionsColumn(c, col));
}

function resolveSqlExprs(
  values: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === 'object' && ('queryChunks' in v || 'sql' in v)) {
      // Counter bumps — apply the known shapes manually.
      //
      // 🔴 THE CAP IS DETECTED, NOT ASSUMED. The production bump is
      // `col + CASE WHEN total_jobs > 0 AND completed + failed >= total_jobs
      // THEN 0 ELSE 1 END`. Modelling that cap unconditionally here would be
      // circular — the test would pass with the CASE deleted from the worker.
      // So the stub looks for a reference to the `total_jobs` COLUMN inside
      // the expression drizzle built: no reference ⇒ this is a bare `+ 1` and
      // the stub bumps unconditionally, which is what makes the overshoot
      // assertions below go red the moment the guard is removed.
      if (k === 'completedJobs' || k === 'failedJobs') {
        const capped = mentionsColumn(v, generationRequests.totalJobs);
        const total = Number(current['totalJobs'] ?? 0) || 0;
        const sum =
          (Number(current['completedJobs'] ?? 0) || 0) +
          (Number(current['failedJobs'] ?? 0) || 0);
        const inc = capped && total > 0 && sum >= total ? 0 : 1;
        out[k] = (Number(current[k] ?? 0) || 0) + inc;
      } else if (k === 'actualCostUsd') {
        // Best-effort: add a numeric cost the test passed in via the route
        // result. The SQL chunk shape carries the literal we want — but it's
        // not stable across drizzle versions; we extract the numeric literal
        // from String(v) as a fallback.
        const text = String(v);
        const match = text.match(/[\d.]+/g);
        const delta = match ? Number(match[match.length - 1]) : 0;
        out[k] = (Number(current[k] ?? 0) || 0) + (isFinite(delta) ? delta : 0);
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';
const REQ_ID = '11111111-2222-3333-4444-555555555555';
const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeJobRow(over: Partial<JobRow> = {}): Partial<JobRow> & { id: string } {
  return {
    id: JOB_ID,
    generationRequestId: REQ_ID,
    org: ORG,
    project: PROJECT,
    unitKey: 'u1',
    unitType: null,
    dependsOn: null,
    input: { __renderedPrompt: 'leaf prompt' },
    output: null,
    registryEntryId: null,
    specOverride: null,
    status: 'queued',
    attempts: 0,
    error: null,
    effort: 'standard',
    priority: 5,
    traceId: '99999999-1111-2222-3333-444444444444',
    queueJobId: null,
    estimatedCostUsd: '0.001',
    actualCostUsd: null,
    metadata: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeRequestRow(over: Partial<RequestRow> = {}): Partial<RequestRow> & {
  id: string;
} {
  return {
    id: REQ_ID,
    org: ORG,
    project: PROJECT,
    requestedBy: null,
    clientRequestId: null,
    status: 'queued',
    totalJobs: 1,
    completedJobs: 0,
    failedJobs: 0,
    effort: 'standard',
    effortOverrides: null,
    promptOverride: null,
    metaPromptOverride: null,
    modelOverride: null,
    includeContext: null,
    callbackUrl: null,
    estimatedCostUsd: '0.001',
    actualCostUsd: '0',
    metadata: null,
    startedAt: new Date(),
    finishedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeSpec(over: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return {
    promptTemplate: 'unused at worker time',
    model: 'mock/model',
    effortLevel: 'standard',
    effortProfile: {
      model: 'mock/model',
      maxOutputTokens: 800,
      validationPasses: 1,
      multiSample: 1,
      temperature: 0.4,
      estimatedCostUsdPerCall: 0.001,
    },
    validators: [],
    registryEntryId: 'reg-1',
    registryEntryVersion: '1',
    ...over,
  };
}

function makeRouteResult(over: Partial<RouteResult> = {}): RouteResult {
  return {
    content: 'router output content',
    flags: [],
    usage: {
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
      estimatedCostUsd: 0.0005,
    },
    model: 'mock/model',
    provider: 'openrouter',
    traceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    cached: false,
    durationMs: 12,
    effort: 'standard',
    effortProfileUsed: {
      model: 'mock/model',
      maxOutputTokens: 800,
      validationPasses: 1,
      multiSample: 1,
      temperature: 0.4,
      estimatedCostUsdPerCall: 0.001,
    },
    ...over,
  };
}

function jobData(over: Partial<GenerationJobData> = {}): GenerationJobData {
  return {
    jobId: JOB_ID,
    generationRequestId: REQ_ID,
    org: ORG,
    project: PROJECT,
    unitKey: 'u1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

let state: StubState;
let db: Db;
let bus: EventBus;
let events: AppEvent[];
let router: LLMRouter & { route: ReturnType<typeof vi.fn> };
let originalSetImmediate: typeof setImmediate;

beforeEach(() => {
  state = makeState();
  db = makeDb(state);
  bus = createEventBus();
  events = [];
  bus.onAny((e) => events.push(e));
  router = {
    route: vi.fn(async () => makeRouteResult()),
  };
  vi.mocked(resolveSpec).mockReset();
  vi.mocked(resolveSpec).mockResolvedValue(makeSpec());
  originalSetImmediate = global.setImmediate;
});

afterEach(() => {
  global.setImmediate = originalSetImmediate;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processGenerationJob', () => {
  it('happy path leaf unit — uses __renderedPrompt, writes output, bumps counter', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const routeArg = router.route.mock.calls[0]![0];
    expect(routeArg.messages).toEqual([
      { role: 'user', content: 'leaf prompt' },
    ]);
    expect(routeArg.org).toBe(ORG);
    expect(routeArg.label).toBe('unit:u1');

    // The first job row update is the 'running' marker; later updates write
    // status/output/cost.
    const jobUpdates = state.updates.filter((u) => u.table === 'jobs');
    const runMark = jobUpdates.find((u) => u.set.status === 'running');
    expect(runMark).toBeDefined();
    const finalWrite = jobUpdates.find((u) => u.set.status === 'completed');
    expect(finalWrite).toBeDefined();
    expect(finalWrite!.set.output).toEqual({
      text: 'router output content',
      flags: [],
    });

    // generation.job.started + generation.job.completed
    const types = events.map((e) => e.type);
    expect(types).toContain('generation.job.started');
    expect(types).toContain('generation.job.completed');
    // Parent not terminal yet (totalJobs=2, only one completed).
    expect(types).not.toContain('generation.request.completed');
  });

  it('dependent unit — renders prompt with predecessor output, writes back to row', async () => {
    const predUnitKey = 'pred-1';
    const predId = 'pred-id-1';
    state.jobs.set(JOB_ID, makeJobRow({
      dependsOn: { context: predUnitKey },
      input: {
        __promptTemplate: 'Q: {{question}} CTX: {{context}}',
        __promptVars: { question: 'why?' },
      },
    }));
    state.jobs.set(predId, {
      id: predId,
      generationRequestId: REQ_ID,
      org: ORG,
      project: PROJECT,
      unitKey: predUnitKey,
      status: 'completed',
      output: 'because',
    });
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const routeArg = router.route.mock.calls[0]![0];
    expect(routeArg.messages[0].content).toBe('Q: why? CTX: because');

    // jsonb_set UPDATE was issued to persist __renderedPrompt.
    expect(state.executes.length).toBeGreaterThanOrEqual(1);
    const renderedExecute = state.executes.find((e) =>
      e.sql.includes('__renderedPrompt'),
    );
    expect(renderedExecute).toBeDefined();
  });

  it('predecessor failed — marks job failed without calling router', async () => {
    const predUnitKey = 'pred-1';
    const predId = 'pred-id-1';
    state.jobs.set(JOB_ID, makeJobRow({
      dependsOn: { slot: predUnitKey },
      input: { __promptTemplate: 'X {{slot}}' },
    }));
    state.jobs.set(predId, {
      id: predId,
      generationRequestId: REQ_ID,
      org: ORG,
      project: PROJECT,
      unitKey: predUnitKey,
      status: 'failed',
      output: null,
    });
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect(String(failed!.set.error)).toContain("predecessor unitKey 'pred-1'");
    const types = events.map((e) => e.type);
    expect(types).toContain('generation.job.failed');
  });

  it('validator blocker — retry once with refine-style messages, use retry if clean', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));

    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          content: 'first draft',
          flags: [
            { severity: 'blocker', code: 'json-schema', message: 'missing field' },
          ],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'clean retry' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(2);
    const retryArg = router.route.mock.calls[1]![0];
    expect(retryArg.messages).toHaveLength(3);
    expect(retryArg.messages[0].role).toBe('user');
    expect(retryArg.messages[1].role).toBe('assistant');
    expect(retryArg.messages[1].content).toBe('first draft');
    expect(retryArg.messages[2].role).toBe('user');
    expect(String(retryArg.messages[2].content)).toContain('failed validation');

    const completed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed!.set.output).toEqual({
      text: 'clean retry',
      flags: [],
    });
    // ADR-0003 S2: the job's actual cost must be the SUM of BOTH router calls
    // (the discarded first draft + the winning retry), not just the final
    // result — each call wrote a trace and spent real budget. Both fixtures
    // carry usage.estimatedCostUsd = 0.0005, so the rollup is 0.001, not 0.0005.
    expect(completed!.set.actualCostUsd).toBe((0.0005 + 0.0005).toFixed(6));
  });

  it('cancel before pickup — parent cancelled, no router call, job marked cancelled', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ status: 'cancelled' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).not.toHaveBeenCalled();
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it('cancel via abort signal — router throws OpenRouterAbortError, job cancelled with partial cost', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    // Import lazily so the mock-aware setup at the top of the file applies.
    const { OpenRouterAbortError } = await import(
      '../services/ai/router/adapters/openrouter.js'
    );

    const partial = {
      contentText: 'partial reply…',
      finishReason: 'aborted' as const,
      model: 'mock/model',
      usage: {
        promptTokens: 25,
        completionTokens: 18,
        costUsd: 0.000234,
        costSource: 'pricing-table' as const,
      },
    };

    // Simulate the pub/sub fast path: the cancel-bus subscriber would normally
    // call ctrl.abort() on the in-flight controller, and the router's
    // streaming adapter would then throw OpenRouterAbortError carrying partial
    // usage. We assert the worker records the partial cost on the job row.
    router.route.mockImplementationOnce(async () => {
      throw new OpenRouterAbortError(partial);
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    // The job row carries the partial cost (priced from the deltas the
    // router accumulated before the abort).
    expect(cancelled?.set.actualCostUsd).toBe(partial.usage.costUsd.toFixed(6));
  });

  it('cancel mid-flight — parent flips during router call, output discarded, job cancelled', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    router.route.mockImplementationOnce(async () => {
      // Simulate the parent flipping to cancelled while the router was busy.
      state.requests.set(
        REQ_ID,
        makeRequestRow({ status: 'cancelled' }),
      );
      return makeRouteResult();
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    // After the post-LLM cancel-check the job is set to cancelled, not completed.
    const completed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'completed',
    );
    expect(completed).toBeUndefined();
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
  });

  it('terminal parent transition — last sibling completes, callback contract envelope enqueued', async () => {
    // totalJobs=1 ⇒ this single completion drives the parent to terminal.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({
        totalJobs: 1,
        callbackUrl: 'https://callback.example/ai-service',
      }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('generation.request.completed');
    const finalEvent = events.find(
      (e) => e.type === 'generation.request.completed',
    );
    expect(finalEvent).toBeDefined();
    if (finalEvent && finalEvent.type === 'generation.request.completed') {
      expect(finalEvent.status).toBe('completed');
    }

    // The worker enqueues callback envelopes through `enqueueCallback`, which
    // INSERTs into `callback_deliveries`. We verify the unit + request
    // terminal envelopes landed at the right URL with the right event types.
    const events_enqueued = state.callbackDeliveries.map((row) => ({
      event: row.event,
      url: row.url,
      source: row.source,
    }));
    expect(events_enqueued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'unit.completed',
          url: 'https://callback.example/ai-service',
          source: 'generate',
        }),
        expect.objectContaining({
          event: 'request.completed',
          url: 'https://callback.example/ai-service',
          source: 'generate',
        }),
      ]),
    );
  });

  // ── `cancelledJobs` on the SUCCESS path ──────────────────────────────────
  //
  // `markJobFailed` was fixed to COUNT the cancelled siblings; this path kept
  // `cancelledJobs: 0` hardcoded. So which number a consumer received depended
  // on whether the LAST job to settle happened to fail — a request whose final
  // unit COMPLETED after a sibling was cancelled reported zero cancellations,
  // and the envelope's own arithmetic (`totalJobs == completed + failed +
  // cancelled`) stopped adding up.
  //
  // Both paths now read `counters.cancelledJobs`, produced by the counters
  // transaction itself. The old second-snapshot helper is gone, and with it the
  // file that proved it: the predicate proof moved here, onto the aggregate.

  /** The `request.*` envelope the worker enqueued, parsed back out of `body`. */
  function requestEnvelope(): Record<string, unknown> {
    const row = state.callbackDeliveries.find((r) =>
      String(r.event).startsWith('request.'),
    );
    expect(row, 'no request-terminal callback was enqueued at all').toBeDefined();
    return JSON.parse(String(row!.body)) as Record<string, unknown>;
  }

  it('🔴 request.completed COUNTS the cancelled siblings — it does not report 0', async () => {
    // Two siblings were settled `cancelled` earlier; THIS job completes and
    // drives the parent terminal. `allDone` is `completed + failed >= total`
    // and deliberately does not read the cancelled rows, so `totalJobs` stays
    // at the number of jobs that can still report — the cancelled ones are a
    // fact about the JOB ROWS, which is exactly where the count comes from.
    state.jobs.set(JOB_ID, makeJobRow());
    state.jobs.set('job-c1', makeJobRow({ id: 'job-c1', unitKey: 'u2', status: 'cancelled' }));
    state.jobs.set('job-c2', makeJobRow({ id: 'job-c2', unitKey: 'u3', status: 'cancelled' }));
    state.requests.set(
      REQ_ID,
      makeRequestRow({
        totalJobs: 1,
        completedJobs: 0,
        callbackUrl: 'https://callback.example/ai-service',
      }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(requestEnvelope().cancelledJobs).toBe(2);
  });

  it('still reports 0 when nothing on the request was cancelled', async () => {
    // The fix must not invent cancellations: a clean request keeps its zero,
    // which is what makes the assertion above about the COUNT and not about
    // "some non-zero number appeared".
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 1, callbackUrl: 'https://callback.example/ai-service' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(requestEnvelope().cancelledJobs).toBe(0);
  });

  it('🔴 the count is scoped to THIS request and to the cancelled status, BY VALUE', async () => {
    // Without the request-id filter the number is every tenant's
    // cancellations; without the status filter it is every job on the request.
    // Asserted on the bound VALUES — a predicate naming `status` and binding
    // 'failed' passes a column-name check and answers a different question.
    state.jobs.set(JOB_ID, makeJobRow());
    state.jobs.set('job-c1', makeJobRow({ id: 'job-c1', unitKey: 'u2', status: 'cancelled' }));
    state.jobs.set(
      'job-other',
      makeJobRow({
        id: 'job-other',
        unitKey: 'u9',
        status: 'cancelled',
        generationRequestId: 'some-other-request',
      }),
    );
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 1, callbackUrl: 'https://callback.example/ai-service' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    // 1, not 2: the other request's cancelled job must not be counted.
    expect(requestEnvelope().cancelledJobs).toBe(1);
    // The row filter is the WHERE (this request); the status filter is the
    // aggregate's own `filter (where …)`. Both are asserted, by VALUE — a
    // filter compiled against 'failed' names the same column and answers a
    // different question, and a WHERE without the request id counts every
    // tenant's cancellations.
    expect(state.countFilters, 'the worker issued no count aggregate at all').not.toHaveLength(0);
    expect(state.countFilters).toContainEqual({
      filter: { column: 'status', value: 'cancelled' },
      // …and inside the counters transaction, not as a second snapshot after it.
      inTransaction: true,
    });
    const scoped = state.wheres
      .for('generation_jobs')
      .find((w) => boundValue(w, 'generation_request_id') === REQ_ID);
    expect(scoped, 'no predicate scoped the count to this request').toBeDefined();

  });
});

// ---------------------------------------------------------------------------
// System prompt (precedence + both router calls)
// ---------------------------------------------------------------------------
//
// The backward-compatibility assertion lives in the happy-path test above,
// which pins `messages` to exactly `[{ role: 'user', … }]` when nothing supplies
// a system prompt. These cases cover the wiring on top of it.

// The spec FLOOR survives the queue only because the orchestrator stashed it on
// `input.__specDefault`. If the worker stopped reading it, an async unit whose
// project has registered nothing would resolve with no prompt at all — a
// failure that looks like a registry problem and is not.

describe('processGenerationJob — spec floor', () => {
  it('passes `input.__specDefault` to resolveSpec', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: {
          __renderedPrompt: 'leaf prompt',
          __specDefault: { promptTemplate: 'FLOOR', effortLevel: 'quick' },
        },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(vi.mocked(resolveSpec).mock.calls[0]![1]).toMatchObject({
      specDefault: { promptTemplate: 'FLOOR', effortLevel: 'quick' },
    });
  });

  it('BACKWARD COMPAT: no floor on the row ⇒ specDefault is undefined', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(vi.mocked(resolveSpec).mock.calls[0]![1].specDefault).toBeUndefined();
  });
});

describe('processGenerationJob — system prompt', () => {
  it('sends `input.__systemPrompt` as a real system message', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'YOU ARE TERSE' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages).toEqual([
      { role: 'system', content: 'YOU ARE TERSE' },
      { role: 'user', content: 'leaf prompt' },
    ]);
  });

  it('falls back to generation_requests.meta_prompt_override (batch-level)', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ metaPromptOverride: 'BATCH CONTRACT' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages).toEqual([
      { role: 'system', content: 'BATCH CONTRACT' },
      { role: 'user', content: 'leaf prompt' },
    ]);
  });

  it('per-unit __systemPrompt beats the batch-level meta_prompt_override', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'UNIT WINS' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow({ metaPromptOverride: 'BATCH' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages[0]).toEqual({
      role: 'system',
      content: 'UNIT WINS',
    });
  });

  it('wires the registry metaPromptTemplate and renders it with the prompt vars', async () => {
    vi.mocked(resolveSpec).mockResolvedValue(
      makeSpec({
        metaPromptTemplate: 'You write for {{audience}}.',
        metaPromptSource: 'registry',
      }),
    );
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', audience: 'vecinos' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages[0]).toEqual({
      role: 'system',
      content: 'You write for vecinos.',
    });
  });

  it('carries the system message into the validator-retry call too', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'JSON ONLY' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    // First pass carries a blocker ⇒ one refine retry; second pass is clean.
    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          flags: [{ severity: 'blocker', code: 'json-parse-error', message: 'nope' }],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'fixed' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route).toHaveBeenCalledTimes(2);
    const retryMessages = router.route.mock.calls[1]![0].messages;
    expect(retryMessages[0]).toEqual({ role: 'system', content: 'JSON ONLY' });
    expect(retryMessages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('retry stays system-less when no system prompt was supplied', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());
    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          flags: [{ severity: 'blocker', code: 'json-parse-error', message: 'nope' }],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'fixed' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const retryMessages = router.route.mock.calls[1]![0].messages;
    expect(retryMessages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('fails the job cleanly when the system template cannot render', async () => {
    vi.mocked(resolveSpec).mockResolvedValue(
      makeSpec({
        metaPromptTemplate: 'Hello {{whoIsMissing}}',
        metaPromptSource: 'registry',
      }),
    );
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect(String(failed!.set.error)).toContain('system prompt render error');
  });
});

// ---------------------------------------------------------------------------
// 🔴 Tenant scope of the `project_configs` callback fallback
// ---------------------------------------------------------------------------
//
// `resolveProjectCallbackUrl` (generation.worker.ts ~940) is the ONE query in
// this worker that is keyed by tenant DATA rather than by a server-minted uuid:
//
//     .from(projectConfigs)
//     .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
//
// It decides where a callback envelope goes. That envelope carries the model's
// generated output for this job. Drop `eq(projectConfigs.org, org)` and the
// first row with a matching `project` string wins — so any tenant that
// registered the project name `chat` could collect another tenant's output at
// their own endpoint. `project` names are consumer-chosen and collide freely
// across orgs, which is what makes the org half load-bearing rather than
// decorative.
//
// Everything else the worker reads or writes is `eq(<table>.id, <uuid from the
// job payload>)`. Those ids were minted by the orchestrator under a tenant
// predicate and never round-trip through a consumer, so they are dismissed
// deliberately — see the file header.
// ---------------------------------------------------------------------------

describe('processGenerationJob — tenant scope of the callback-url fallback', () => {
  it('🔴 the project_configs lookup is scoped to (org, project) — not to project alone', async () => {
    // The request row carries NO callbackUrl, which is what sends the worker to
    // the `project_configs` fallback.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, callbackUrl: null }));
    state.projectConfigs = [
      { org: ORG, project: PROJECT, callbackUrl: 'https://from-project-config.example/cb' },
    ];

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    // First: the row was actually CONSUMED. The envelopes went to a URL only
    // `project_configs` could have supplied, so the predicate asserted below
    // belongs to a query whose result really steers the callback — not to a
    // dead read whose scope nobody would miss.
    expect(state.callbackDeliveries.map((r) => r.url)).toEqual(
      expect.arrayContaining(['https://from-project-config.example/cb']),
    );

    // Then: that query carried BOTH halves of the tenancy tuple, bound to the
    // caller's own values. Deleting either `eq(...)` term makes this red.
    //
    // The worker resolves the fallback TWICE on a terminal job — once for the
    // per-unit envelope (~564) and once for the request-level one (~659), both
    // through the same helper. `expectScopedTo` would be satisfied by ONE of
    // the two being scoped, which is the wrong question when the unscoped one
    // is what leaks: assert EVERY occurrence, without pinning the count, so a
    // future memoisation stays a fine refactor and an unscoped read does not.
    state.wheres.expectEveryQueryScopedTo('project_configs', { org: ORG, project: PROJECT });

    // …and then, more strictly than the helper can: the predicate binds those
    // two values and NOTHING else, so a third term smuggled in alongside them
    // shows up here.
    const lookups = state.wheres.for('project_configs');
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      // Column by column, so a dropped term names itself rather than showing up
      // as one opaque "the SQL changed".
      expect(lookup.sql).toContain('"project_configs"."org" =');
      expect(lookup.sql).toContain('"project_configs"."project" =');
      // Bound to the CALLER's scope — a predicate naming the right columns but
      // binding a constant would pass the checks above.
      expect(lookup.params).toEqual([ORG, PROJECT]);
    }
  });

  it('🔴 every read and write the job ran reached the stub carrying a predicate', async () => {
    // Not a tenant assertion — a blast-radius one. `db.update(generationJobs)
    // .set(…)` with no `.where()` is legal drizzle and would rewrite EVERY
    // tenant's job rows; the same shape on a select is a whole-table read.
    //
    // ⚠ READ THE NAME LITERALLY. This says every query THE STUB SAW carried a
    // predicate. It is not "no unfiltered query ran" — the recorder cannot see
    // a query at all, and the earlier name ("no read or write in the whole job
    // ran without a predicate") claimed exactly the reach it did not have. The
    // two are the same statement only while every chain in `makeDb` settles
    // through `WhereRecorder.guard()`; that is what makes a DELETED `.where()`
    // arrive here as `<NO PREDICATE>` rather than as silence. It did not, until
    // this branch: the deleted-call mutation left the suite green at 1328/1328.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, callbackUrl: null }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(state.wheres.calls.length).toBeGreaterThan(0);
    state.wheres.expectNoUnfilteredQuery();
  });
});

// ---------------------------------------------------------------------------
// Job lifecycle: exclusive claim + terminal-status guard
//
// 🔴 THE DEFECT THESE LOCK. BullMQ's stalled checker hands a job to a SECOND
// worker when the first one's lock expires (measured on this tree with W1
// SIGSTOPped: `attempts` = 2, two trace rows, the LLM called twice, the budget
// charged twice, and W1's late write landing after W2's so a COMPLETED job's
// row read `status = 'cancelled'`). Two SQL-level guards close it: the claim
// only fires from `status = 'queued'`, and every terminal write carries
// `status NOT IN ('completed','failed','cancelled')`.
//
// ⚠ These are the BRANCHING half of the proof — they show the worker reacts to
// the row count correctly. That Postgres enforces the predicate is proven with
// a real database in `generation.worker.stalled.integration.test.ts`.
// ---------------------------------------------------------------------------

describe('processGenerationJob — claim + terminal guard', () => {
  it('a row already `running` is NOT re-claimed: no router call, no second attempts bump', async () => {
    // Exactly the state a stalled re-delivery finds: the first worker claimed
    // the row and is still (or was) working on it.
    state.jobs.set(JOB_ID, makeJobRow({ status: 'running', attempts: 1 }));
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route).not.toHaveBeenCalled();
    expect(state.jobs.get(JOB_ID)!.attempts).toBe(1);
    // Not a single job-level event, so nothing downstream double-counts.
    expect(events.map((e) => e.type)).not.toContain('generation.job.started');
  });

  it('a row already `completed` is never overwritten — a late writer cannot make it `cancelled`', async () => {
    // The exact corruption measured: W2 finished the job, then W1 woke up and
    // wrote its own terminal status on top.
    state.jobs.set(
      JOB_ID,
      makeJobRow({ status: 'completed', attempts: 1, output: { text: 'W2 output' } }),
    );
    // Parent flipped to cancelled, which is the path W1's late write took.
    state.requests.set(REQ_ID, makeRequestRow({ status: 'cancelled' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(state.jobs.get(JOB_ID)!.status).toBe('completed');
    expect(state.jobs.get(JOB_ID)!.output).toEqual({ text: 'W2 output' });
  });

  it('the claim UPDATE is conditional on `status = queued`', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const claim = state.wheres.calls.find(
      (c) => c.table === 'generation_jobs' && c.params.includes('queued'),
    );
    expect(claim, 'the claim ran without a status predicate').toBeDefined();
    expect(claim!.sql).toContain('status');
  });

  it('the terminal write carries `status NOT IN (completed, failed, cancelled)`', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const guarded = state.wheres.calls.find(
      (c) =>
        c.table === 'generation_jobs' &&
        ['completed', 'failed', 'cancelled'].every((t) => c.params.includes(t)),
    );
    expect(
      guarded,
      'a terminal write ran WITHOUT the terminal-status guard — a late writer can clobber it',
    ).toBeDefined();
    expect(guarded!.sql).toContain('status');
  });

  it('a job whose row went terminal mid-flight does not double-count the parent', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));

    // Someone else settles the row while the router call is in flight.
    router.route = vi.fn(async () => {
      const row = state.jobs.get(JOB_ID)!;
      state.jobs.set(JOB_ID, { ...row, status: 'completed' });
      return makeRouteResult();
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    // The rollup transaction never ran, so no counter moved and no terminal
    // request event fired for a request this worker did not settle.
    const requestUpdates = state.updates.filter((u) => u.table === 'requests');
    expect(requestUpdates).toHaveLength(0);
    expect(events.map((e) => e.type)).not.toContain('generation.request.completed');
  });
});

// ---------------------------------------------------------------------------
// Parent-request counters: the bump cannot overshoot, the terminal write is
// conditional
//
// 🔴 THE DEFECT THESE LOCK. `updateParentCounters` bumped `completed_jobs` /
// `failed_jobs` with a bare `+ 1` and then wrote the request's terminal status
// with an UNGUARDED `WHERE id = …`. Two consequences, both reachable from one
// duplicate report:
//   · `completed + failed` could exceed `total_jobs`, and that sum is what
//     decides `allDone` — an overshoot settles a request whose jobs are still
//     running, and the wrong number is served on `GET /v1/generate/:id`.
//   · `terminalNow` was `allDone && !wasTerminal`, read from a SELECT taken
//     before the write, so two workers could both claim the transition and
//     fire the request-level event + terminal callback twice.
//
// The claim in `claimJob` is the first line of defence; these are the second,
// for report paths that never touch a job row.
// ---------------------------------------------------------------------------

describe('processGenerationJob — parent counter guards', () => {
  it('a duplicate completion report cannot push completed_jobs past total_jobs', async () => {
    // The parent is ALREADY fully reported: 1 of 1 done. A second report for
    // another job of the same request (its own row still `queued`, so the claim
    // lets it through) must not move the counter to 2.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 1, completedJobs: 1, failedJobs: 0, status: 'running' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const parent = state.requests.get(REQ_ID)!;
    expect(parent.completedJobs).toBe(1);
    expect((parent.completedJobs ?? 0) + (parent.failedJobs ?? 0)).toBeLessThanOrEqual(
      parent.totalJobs ?? 0,
    );
  });

  it('a duplicate FAILURE report cannot push completed + failed past total_jobs', async () => {
    // Same shape on the other column, and with the two columns MIXED: one job
    // already completed of a total of one, now a failure lands. A per-column
    // `LEAST(failed + 1, total)` would happily write 1 here and take the sum
    // to 2 — the cap has to be on the SUM.
    state.jobs.set(JOB_ID, makeJobRow({ dependsOn: ['dep-1'] }));
    state.jobs.set('dep-row', {
      ...makeJobRow({ status: 'failed', unitKey: 'dep-1' }),
      id: 'dep-row',
    });
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 1, completedJobs: 1, failedJobs: 0, status: 'running' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const parent = state.requests.get(REQ_ID)!;
    expect((parent.completedJobs ?? 0) + (parent.failedJobs ?? 0)).toBeLessThanOrEqual(
      parent.totalJobs ?? 0,
    );
  });

  it('total_jobs = 0 (legacy rows) keeps the unbounded bump — the cap must not freeze them', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 0, completedJobs: 3, status: 'running' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(state.requests.get(REQ_ID)!.completedJobs).toBe(4);
  });

  it('the parent terminal write carries `status NOT IN (completed, failed, partial, cancelled)`', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const guarded = state.wheres.calls.find(
      (c) =>
        c.table === 'generation_requests' &&
        ['completed', 'failed', 'partial', 'cancelled'].every((t) => c.params.includes(t)),
    );
    expect(
      guarded,
      'the parent terminal write ran WITHOUT the terminal-status guard — two workers can both settle it',
    ).toBeDefined();
    expect(guarded!.sql).toContain('status');
  });

  it('a parent already `partial` is not re-settled, and fires no second request event', async () => {
    // `partial` is terminal for a REQUEST and is not in the job-level terminal
    // list — the case a three-status guard would have let through.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 1, completedJobs: 1, failedJobs: 0, status: 'partial' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(state.requests.get(REQ_ID)!.status).toBe('partial');
    expect(events.map((e) => e.type)).not.toContain('generation.request.completed');
  });

  it('the queued → running bump is conditional on `status = queued`', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2, status: 'queued' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const bump = state.wheres.calls.find(
      (c) =>
        c.table === 'generation_requests' &&
        c.params.filter((pp) => String(pp) === 'queued').length > 0 &&
        !c.params.includes('cancelled'),
    );
    expect(bump, 'the running bump ran without a status predicate').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// httpRequestId in worker logs
//
// The correlation id only earns its place if it actually reaches a log line —
// a field carried in the payload and never printed joins nothing. The orphan
// branch is used as the probe because it logs and returns without touching the
// router, so the assertion is about the LOG and nothing else.
//
// ⚠ `httpRequestId`, not `requestId`: `requestId` is `generation_requests.id`.
// ---------------------------------------------------------------------------

describe('generation worker — httpRequestId correlation', () => {
  it('prints the correlation id on the orphan-job warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `state.jobs` is empty, so the row lookup misses and the orphan branch runs.
    await processGenerationJob(
      { id: 'bull-1', data: jobData({ httpRequestId: 'http-req-xyz' }) },
      { db, bus },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('orphan');
    expect(line).toContain('httpRequestId=http-req-xyz');
  });

  it('prints no correlation fragment for a job enqueued without one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processGenerationJob({ id: 'bull-2', data: jobData() }, { db, bus });
    const line = String(warn.mock.calls[0]![0]);
    // Never the literal 'undefined' — old jobs already in Redis carry no id.
    expect(line).not.toContain('httpRequestId');
    expect(line).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// Worker lost — a claimed row whose worker died
//
// 🔴 THE DEFECT THESE LOCK. The claim guard made a re-delivery a no-op, which
// is right for a worker that is still alive and WRONG for one that is gone.
// Measured with a worker SIGKILLed mid-job: the row stayed 'running' with a
// null `finished_at` forever, the parent request never went terminal, no
// event and no callback ever fired, `GET /v1/generate/:id` answered 200
// in-progress indefinitely, and the router's per-call reserve stayed held.
//
// The rule (Rodrigo): never re-run, always REPORT. These cases
// pin the "always report" half at the unit level; that real Postgres refuses
// the write for a row inside the window is pinned in the integration repro.
// ---------------------------------------------------------------------------

describe('processGenerationJob — a lost worker becomes a named failure', () => {
  it("a 'running' row past the window is failed as 'worker_lost' and the router is never called", async () => {
    state.lost = true;
    state.jobs.set(JOB_ID, makeJobRow({ status: 'running', startedAt: new Date(0) }));
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const job = state.jobs.get(JOB_ID)!;
    expect(job.status).toBe('failed');
    expect(job.error).toBe('worker_lost');
    // `metadata` is written as a jsonb MERGE (`COALESCE(metadata,'{}') || …`),
    // so the stub holds the SQL expression rather than a resolved object; the
    // machine-readable code is asserted on the statement it ships in.
    const lostUpdate = state.updates.find(
      (u) => u.table === 'jobs' && u.set['metadata'] !== undefined,
    );
    expect(stringifySql(lostUpdate!.set['metadata'])).toContain('WORKER_LOST');
    // NEVER re-run: no second LLM call, no second charge, no second trace.
    expect(router.route).not.toHaveBeenCalled();
    expect(job.attempts).toBe(0);
  });

  it('the parent settles and the consumer is told — one job.failed, one request event', async () => {
    state.lost = true;
    state.jobs.set(JOB_ID, makeJobRow({ status: 'running', startedAt: new Date(0) }));
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const failed = events.filter((e) => e.type === 'generation.job.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorCode: 'WORKER_LOST', errorMessage: 'worker_lost' });
    const parent = state.requests.get(REQ_ID)!;
    expect(parent.status).toBe('failed');
    expect(parent.failedJobs).toBe(1);
    const requestEvents = events.filter((e) => e.type === 'generation.request.completed');
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]).toMatchObject({ status: 'failed' });
  });

  it("the transition is guarded on status = 'running' AND on `started_at`", async () => {
    // Both halves matter. Without the status half a queued job — one that has
    // no worker because it is still WAITING for one — would be reaped. Without
    // the age half a healthy in-flight job is killed the instant BullMQ
    // re-delivers it, which is the double-run defect turned inside out.
    state.lost = true;
    state.jobs.set(JOB_ID, makeJobRow({ status: 'running', startedAt: new Date(0) }));
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const lostWrite = state.wheres.calls.find(
      (c) => c.table === 'generation_jobs' && c.sql.includes('started_at'),
    );
    expect(
      lostWrite,
      'the lost-worker transition ran without an age predicate — it would kill live jobs',
    ).toBeDefined();
    expect(lostWrite!.params.map(String)).toContain('running');
    expect(lostWrite!.params.map(String)).not.toContain('queued');
  });

  it('the reserve is refunded exactly once, from the recorded per-call amount', async () => {
    state.lost = true;
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        status: 'running',
        startedAt: new Date(0),
        metadata: { reservePerCallUsd: 0.000737 },
        // `standard` is 1 × 1, so the orchestrator writes the SAME number to
        // both fields. The fixture's default 0.001 estimate is not a shape any
        // enqueue produces, and would mask which of the two is being read.
        estimatedCostUsd: '0.000737',
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const refunds = state.executes.filter(
      (e) => e.sql.includes('budget_state') && e.sql.includes('remaining_usd'),
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.sql).toContain('0.000737');
  });

  it('a SECOND re-delivery changes nothing: no write, no event, no second refund', async () => {
    state.lost = true;
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        status: 'running',
        startedAt: new Date(0),
        metadata: { reservePerCallUsd: 0.000737 },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });
    const eventsAfterFirst = events.length;
    await processGenerationJob({ id: 'q-2', data: jobData() }, { db, router, bus });

    // The row is 'failed' now, so the guarded UPDATE matches nothing and every
    // non-idempotent consequence is skipped.
    expect(events).toHaveLength(eventsAfterFirst);
    expect(state.requests.get(REQ_ID)!.failedJobs).toBe(1);
    const refunds = state.executes.filter((e) => e.sql.includes('budget_state'));
    expect(refunds).toHaveLength(1);
  });

  it('a row INSIDE the window is left alone — the pre-existing skip, unchanged', async () => {
    // `state.lost = false` ⇒ `started_at` is recent ⇒ the UPDATE matches
    // nothing. A live worker still owns this row.
    state.jobs.set(JOB_ID, makeJobRow({ status: 'running', startedAt: new Date() }));
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1, status: 'running' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const job = state.jobs.get(JOB_ID)!;
    expect(job.status).toBe('running');
    expect(events).toHaveLength(0);
    expect(state.executes.filter((e) => e.sql.includes('budget_state'))).toHaveLength(0);
  });
});

describe('lostReserveUsd', () => {
  // The reserve is taken ONCE PER PROVIDER CALL, and a tier makes
  // `validationPasses × multiSample` of them under one job. Refunding the bare
  // per-call number left the rest of the money on the org's cap: measured
  // 0.00287 returned against 0.00574 held on `deep`.
  it('multiplies the per-call reserve by passes × samples on `deep`', () => {
    expect(
      lostReserveUsd({
        metadata: { reservePerCallUsd: 0.00287 },
        estimatedCostUsd: null,
        effort: 'deep',
      }),
    ).toBeCloseTo(0.00287 * 2 * 1, 9);
  });

  it('multiplies the per-call reserve by passes × samples on `maximum`', () => {
    expect(
      lostReserveUsd({
        metadata: { reservePerCallUsd: 0.004845 },
        estimatedCostUsd: null,
        effort: 'maximum',
      }),
    ).toBeCloseTo(0.004845 * 2 * 3, 9);
  });

  it('agrees with `estimated_cost_usd`, which is the same product', () => {
    // The orchestrator writes `estimated_cost_usd = perCall × passes × samples`
    // from the RESOLVED profile, so after the fix the two numbers are the same
    // one and neither over- nor under-refunds.
    expect(
      lostReserveUsd({
        metadata: { reservePerCallUsd: 0.00287 },
        estimatedCostUsd: '0.005740',
        effort: 'deep',
      }),
    ).toBeCloseTo(0.00574, 9);
  });

  it('takes the estimate when a project override made it larger', () => {
    // `estimated_cost_usd` carries per-project overrides of the factors that
    // `EFFORT_PROFILES` cannot know about; the larger of the two wins so an
    // overridden profile is not under-refunded.
    expect(
      lostReserveUsd({
        metadata: { reservePerCallUsd: 0.00287 },
        estimatedCostUsd: '0.020000',
        effort: 'deep',
      }),
    ).toBeCloseTo(0.02, 9);
  });

  it('treats quick/standard as 1 × 1 — unchanged by the multiplication', () => {
    expect(
      lostReserveUsd({
        metadata: { reservePerCallUsd: 0.000737 },
        estimatedCostUsd: null,
        effort: 'standard',
      }),
    ).toBeCloseTo(0.000737, 9);
  });

  it('defaults both factors to 1 when the row carries no effort level', () => {
    expect(
      lostReserveUsd({ metadata: { reservePerCallUsd: 0.000737 }, estimatedCostUsd: null }),
    ).toBeCloseTo(0.000737, 9);
  });

  it('falls back to the unit estimate for a row enqueued before the field existed', () => {
    expect(
      lostReserveUsd({ metadata: null, estimatedCostUsd: '0.000737', effort: 'standard' }),
    ).toBeCloseTo(0.000737, 9);
  });

  it('refunds nothing rather than NaN when neither number is usable', () => {
    // A NaN would reach `budget_state.remaining_usd`, which Postgres ACCEPTS
    // as numeric NaN — latching the org's cap at NaN permanently.
    expect(
      lostReserveUsd({ metadata: { reservePerCallUsd: 'oops' }, estimatedCostUsd: null }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// heldOrEstimatedReserveUsd — the ledger is a FLOOR, not the answer
// ---------------------------------------------------------------------------
//
// 🔴 THE DEFECT. `budget_reservations` is audit, not authority: a failed
// INSERT is warned about and swallowed. A `deep`/`maximum` job takes SEVERAL
// holds, so when only some rows land the sum is non-null, non-zero and TOO
// SMALL — measured at 50% of the money held on `deep`. Taking it merely
// because it was non-null under-refunded the org by the missing rows.
describe('heldOrEstimatedReserveUsd', () => {
  const DEEP_ROW = {
    metadata: { reservePerCallUsd: 0.00287 },
    estimatedCostUsd: null,
    effort: 'deep' as const,
  };
  const fakeBudget = (held: number | null | (() => never)) =>
    ({
      heldReserveUsd: async () => (typeof held === 'function' ? held() : held),
    }) as unknown as Parameters<typeof heldOrEstimatedReserveUsd>[0];

  it('🔴 raises a PARTIAL ledger sum to the full estimate', async () => {
    // Two holds expected, one row landed. The bare sum would refund half.
    const refund = await heldOrEstimatedReserveUsd(fakeBudget(0.00287), 'job-1', DEEP_ROW);
    expect(refund).toBeCloseTo(0.00574, 9);
  });

  it('keeps a ledger sum that is LARGER than the estimate', async () => {
    const refund = await heldOrEstimatedReserveUsd(fakeBudget(0.01), 'job-1', DEEP_ROW);
    expect(refund).toBeCloseTo(0.01, 9);
  });

  it('refunds NOTHING on an authoritative zero — rows exist, none reserved', async () => {
    // `heldReserveUsd` answers 0 only when the job HAS ledger rows and none is
    // still 'reserved', which is exactly the state a completed refund leaves.
    // Collapsing this into the estimate would pay the same money out twice on
    // a repeat sweep.
    expect(await heldOrEstimatedReserveUsd(fakeBudget(0), 'job-1', DEEP_ROW)).toBe(0);
  });

  it('falls back to the estimate when the job has NO ledger rows at all', async () => {
    // `null`, not 0: `COUNT(*) = 0` — pre-ledger rows, failed INSERTs, and a
    // worker killed before the router's first reserve.
    const refund = await heldOrEstimatedReserveUsd(fakeBudget(null), 'job-1', DEEP_ROW);
    expect(refund).toBeCloseTo(0.00574, 9);
  });

  it('falls back to the estimate when the ledger read THROWS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = fakeBudget(() => {
      throw new Error('db is down');
    });
    expect(await heldOrEstimatedReserveUsd(budget, 'job-1', DEEP_ROW)).toBeCloseTo(0.00574, 9);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The taxonomy code survives the BullMQ boundary
// ---------------------------------------------------------------------------
//
// ── 🔴 Why this block exists ───────────────────────────────────────────────
// `/v1/generate/sync` and `/stream` classify a refusal from the error INSTANCE
// (`errors/generate-map.ts`), so a consumer can tell "you are out of budget"
// from "the provider is down". The async path re-enters through a queue: the
// worker's `catch` kept only `err.message`, and `markJobFailed` then stamped
// its `'job-failed'` DEFAULT on the `generation.job.failed` bus event and on
// the `unit.failed` callback envelope. Same refusal, typed on two transports
// out of three — and the async path is the one a consumer polls, so the miss
// is invisible until someone tries to branch on it.
//
// Sabotage: drop `errorCode: taxonomyErrorCode(err)` from the router-error
// call site in `generation.worker.ts` and the first case here goes red.

describe('processGenerationJob — the error CODE survives the queue', () => {
  async function runWithRouterError(err: unknown) {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ totalJobs: 2, callbackUrl: 'https://callback.example/ai-service' }),
    );
    router.route.mockRejectedValueOnce(err);
    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });
    const failed = events.find((e) => e.type === 'generation.job.failed');
    expect(failed).toBeDefined();
    return failed as Extract<AppEvent, { type: 'generation.job.failed' }>;
  }

  it('a budget refusal is typed, not the generic `job-failed`', async () => {
    const { BudgetExceeded } = await import('../services/budget/errors.js');
    const failed = await runWithRouterError(new BudgetExceeded(ORG, 1.5, 0.25));

    expect(failed.errorCode).toBe('ERR_BUDGET_EXCEEDED');
    expect(failed.errorCode).not.toBe('job-failed');
    // The message still carries the human detail, unchanged.
    expect(String(failed.errorMessage)).toContain('router error:');

    // …and the same code reaches the consumer's `unit.failed` envelope, which
    // is the only place an async consumer can read it.
    const unitFailed = state.callbackDeliveries.find((r) => r['event'] === 'unit.failed');
    expect(unitFailed).toBeDefined();
    expect(String(unitFailed!['body'])).toContain('"code":"ERR_BUDGET_EXCEEDED"');
  });

  it('a provider outage is typed too — one arm is not a special case', async () => {
    const { ProviderUnavailable } = await import('../services/ai/router/resilience.js');
    const failed = await runWithRouterError(new ProviderUnavailable(30_000));
    expect(failed.errorCode).toBe('ERR_PROVIDER_UNAVAILABLE');
  });

  it('a provider TIMEOUT fails the job, typed and at $0 — not `cancelled` with a partial bill', async () => {
    // Decision (audit §3 item 5). Before it, the router's deadline
    // surfaced as an `AbortError`, which this worker settles as `cancelled`
    // with the partial cost and WITHOUT bumping the parent counters — a
    // request that could then never reach a terminal state.
    const { ProviderTimeout } = await import('../services/ai/router/provider-timeout.js');
    const failed = await runWithRouterError(new ProviderTimeout({ traceId: 'trace-1' }));
    expect(failed.errorCode).toBe('ERR_PROVIDER_TIMEOUT');
    // The async consumer reads the code ONLY from the `unit.failed` envelope.
    // An async deadline cut (`LLM_ASYNC_REQUEST_TIMEOUT_MS`) arrives here as
    // the same `ProviderTimeout`, so this is the code it surfaces with.
    const unitFailed = state.callbackDeliveries.find((r) => r['event'] === 'unit.failed');
    expect(unitFailed).toBeDefined();
    expect(String(unitFailed!['body'])).toContain('"code":"ERR_PROVIDER_TIMEOUT"');
    const terminal = state.updates.find((u) => u.table === 'jobs' && u.set.status === 'failed');
    expect(terminal).toBeDefined();
    expect(terminal!.set.actualCostUsd).toBeUndefined();
    expect(state.updates.some((u) => u.table === 'jobs' && u.set.status === 'cancelled')).toBe(false);
  });

  it('an untyped throw keeps the `job-failed` default — no invented code', async () => {
    const failed = await runWithRouterError(new Error('socket hang up'));
    expect(failed.errorCode).toBe('job-failed');
  });

  it('a spec-resolution refusal is typed on the async path as well', async () => {
    const { SpecResolutionError } = await import('../services/registry/resolve.js');
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));
    vi.mocked(resolveSpec).mockRejectedValueOnce(new SpecResolutionError({ cause: 'no model' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const failed = events.find((e) => e.type === 'generation.job.failed');
    expect(failed).toBeDefined();
    expect((failed as { errorCode?: string }).errorCode).toBe('ERR_SPEC_RESOLUTION');
  });
});

// ---------------------------------------------------------------------------
// F2 — THE DRAIN WINDOW
// ---------------------------------------------------------------------------
//
// `deps.inFlight` is not just the cancel-bus lookup table. `stop()` polls it
// (`waitForDrain`) to answer ONE question on SIGTERM: is any job still inside
// its handler? The registration used to sit two thirds of the way down, right
// before `router.route()`, with a `finally` that closed BEFORE step 9 — the
// terminal write, the parent rollup and the callback insert. So the map said
// "nothing running" during two windows in which a job very much was:
//
//   · handler entry → the router call (row load, parent load, spec resolve,
//     claim, race re-check — six database round-trips), and
//   · the router returning → the rollup finishing.
//
// MEASURED against a real Redis before the fix: a SIGTERM landing in the first
// window printed NO drain line and took NO abort branch, and the process still
// overran a 2 s grace by 20 s, because `worker.close()` was underneath waiting
// on a job the drain could not see.
//
// The three assertions below are the window, observed from inside. They are
// deterministic — no timing, no real Redis — and each one goes red on its own
// if the registration moves back down or the `finally` moves back in.
describe('processGenerationJob — the in-flight map covers the WHOLE handler', () => {
  it('is registered BEFORE the spec resolves, and still held during the rollup', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));

    const inFlight = new Map<string, AbortController>();
    const seen: Record<string, number> = {};

    // (a) BEFORE the router — `resolveSpec` runs at step 4, upstream of the
    //     claim and of `router.route()`. Under the old placement this was 0.
    vi.mocked(resolveSpec).mockImplementation(async () => {
      seen['atSpecResolve'] = inFlight.size;
      return makeSpec();
    });
    // (b) During the provider call — the only window the old code covered.
    router.route = vi.fn(async () => {
      seen['atRoute'] = inFlight.size;
      return makeRouteResult();
    });
    // (c) During the parent-counter transaction — step 10, the rollup. Under
    //     the old placement the `finally` had already fired and this was 0,
    //     which is why a drain could return "empty" mid-rollup.
    // Not `vi.spyOn`: drizzle's `transaction` overload is typed too tightly for
    // a mock implementation to satisfy. `db` is rebuilt in `beforeEach`, so
    // replacing the method outright leaks nothing into the next test.
    const realTransaction = db.transaction.bind(db) as (fn: unknown) => Promise<unknown>;
    (db as unknown as { transaction: unknown }).transaction = async (fn: unknown) => {
      seen['atRollup'] = inFlight.size;
      return realTransaction(fn);
    };

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
      inFlight,
    });

    expect(seen['atSpecResolve']).toBe(1);
    expect(seen['atRoute']).toBe(1);
    expect(seen['atRollup']).toBe(1);
    // …and the handler cleans up after itself, or the next job for this
    // request would inherit a stale controller and a `stop()` would never
    // drain at all.
    expect(inFlight.size).toBe(0);
  });

  it('empties the map even when the job fails, so a drain can never wedge', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));
    const inFlight = new Map<string, AbortController>();
    router.route = vi.fn(async () => {
      throw new Error('provider exploded');
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
      inFlight,
    });

    expect(inFlight.size).toBe(0);
  });

  it('the controller the wrapper registers is the one the router is handed', async () => {
    // The cancel-bus fast path aborts whatever is in the map; the shutdown
    // path aborts the same object. Both are worthless if the router was given
    // a DIFFERENT controller's signal — which is exactly what a careless
    // "register at entry" refactor produces.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));
    const inFlight = new Map<string, AbortController>();
    let routedSignal: AbortSignal | undefined;
    let registered: AbortController | undefined;
    router.route = vi.fn(async (req: { signal?: AbortSignal }) => {
      routedSignal = req.signal;
      registered = inFlight.get(REQ_ID);
      return makeRouteResult();
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
      inFlight,
    });

    expect(registered).toBeDefined();
    expect(routedSignal).toBe(registered!.signal);
  });
});
