// Unit tests for cancelGeneration. The drizzle `db` is replaced with a tiny
// stub (same pattern as `services/registry/resolve.test.ts` /
// `services/idempotency.test.ts`) that returns canned select results, records
// `update` calls, and runs `transaction` callbacks with itself as `tx`. The
// queue comes from the in-memory mock returned by `getGenerationQueue()` in
// test mode (NODE_ENV=test, see `queue/queues.ts`).
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// Both the select chain and the update chain used to end in `where: () => …` —
// functions with NO parameter — so every predicate `cancelGeneration` builds
// was discarded at the door. The `cross-tenant cancel attempt` case below said
// so in its own comment ("the stub returns no row because the WHERE-filter
// would not match") and then proved nothing of the kind: the stub returned no
// row because its `request` field was set to `null` by hand. Delete
// `eq(generationRequests.org, ctx.org)` from `cancel.ts` and this file stayed
// green while any tenant could cancel any other tenant's in-flight generation
// by requestId — a destructive cross-tenant write, not a read.
//
// Predicates now go through `WhereRecorder`, which serialises them with
// drizzle's own dialect and keeps the bound parameters, so the cases below can
// assert the tenant COLUMNS and the tenant VALUES are actually there.
//
// ⚠ Still the cheap complement, not the proof — a mock shows which predicate
// was BUILT, never that Postgres honoured it. The real cross-tenant cancel case
// runs against Postgres in `src/routes/tenant-isolation.integration.test.ts`.
//
// ── 🔴 …AND WHY EVERY TERMINAL SETTLES THROUGH `WhereRecorder.guard` ───────
// Recording from inside `where()` catches the mutation that EMPTIES the call.
// It cannot catch the one that DELETES it. Both chains here were blind to that:
//
//   - the select chain is thenable, so `await db.select().from(generationJobs)`
//     with its `.where(...)` deleted returned the same rows and recorded
//     nothing. Measured: that mutation left this file green at 8/8.
//   - the update chain's `set()` returned a plain object with no `then`, so
//     `await tx.update(t).set(v)` — a whole-table write in real drizzle —
//     settled on a non-thenable and reached the recorder not at all. It went
//     red only incidentally, on `wheres.for(...)` holding ZERO entries, which
//     reads as "the write never happened".
//
// So each chain instance now builds ONE `wheres.guard(table)`, routes `where`
// through `guard.where`, and routes EVERY terminal — `limit`, `then` — through
// `guard.settle`. A chain that settles unfiltered records `<NO PREDICATE>`,
// which `expectNoUnfilteredQuery()` rejects by name. Revert either terminal to
// a bare value and this file's whole-table gate switches off silently.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { generationJobs, generationRequests, projectConfigs } from '../../db/schema/index.js';
import { WhereRecorder } from '../../test/where-recorder.js';
import { __getMockJobs } from '../../queue/queues.js';
import { createTestRuntime } from '../../testing/runtime.js';
import type { Runtime } from '../../runtime.js';
import { createEventBus } from '../events/bus.js';
import type { AppEvent } from '../events/types.js';

import { cancelGeneration } from './cancel.js';

// One isolated runtime per case, replacing `_resetQueuesForTests()`.
let runtime: Runtime;
const getGenerationQueue = () => runtime.queues.generation;

// ---------------------------------------------------------------------------
// Stub db
// ---------------------------------------------------------------------------

interface StubState {
  request: Record<string, unknown> | null;
  jobs: Array<Record<string, unknown>>;
  /** Captured update calls (in order). */
  updates: Array<{ table: 'requests' | 'jobs'; values: Record<string, unknown> }>;
  /**
   * Models the half of the lost-worker predicate this stub cannot express:
   * `started_at < now() - <window>`. False (the default) ⇒ the row's owner may
   * still be alive ⇒ the guarded UPDATE matches nothing, which is the
   * pre-existing "running jobs are left to the cancel bus" behaviour.
   */
  lost?: boolean;
  /** Raw SQL the stub was asked to `execute` — the budget refund lands here. */
  executes?: string[];
}

/**
 * Every predicate every stubbed query and write built, in call order.
 *
 * Writes are recorded under an `update:` prefix so `expectScopedTo` and
 * `expectNoUnfilteredQuery` can talk about reads and writes separately — a
 * cancel is a WRITE, and an unfiltered UPDATE is a whole-table mutation.
 */
const wheres = new WhereRecorder();

function makeDb(state: StubState): Db {
  const stub = {
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          let result: unknown[] = [];
          // Name the table as Postgres knows it, so a failure message reads
          // like the schema rather than like a JS object identity.
          let name = 'unknown';
          if (table === generationRequests) {
            result = state.request ? [state.request] : [];
            name = 'generation_requests';
          } else if (table === generationJobs) {
            result = state.jobs;
            name = 'generation_jobs';
          } else if (table === projectConfigs) {
            // Reached by `resolveProjectCallbackUrl` whenever the request row
            // carries no `callbackUrl` of its own. Returns [] → callbackUrl
            // null → the callback branch is skipped, which is what the cases
            // below rely on.
            name = 'project_configs';
          }
          // ONE guard per chain instance — per `from()`. `record()` alone
          // sees only the predicates that were PASSED; the guard additionally
          // sees a chain that SETTLES having never been filtered, which is the
          // shape a deleted `.where()` takes.
          const guard = wheres.guard(name);
          const chain = {
            // 🔴 TAKES its argument — see the header.
            where: (predicate: unknown) => {
              guard.where(predicate);
              return chain;
            },
            limit: () => Promise.resolve(guard.settle(result)),
            // `await` on the where()-result (no `.limit()`) — for the jobs scan.
            //
            // 🔴 THE TERMINAL THAT USED TO SWALLOW THE MUTATION. This chain is
            // thenable, so `await db.select().from(generationJobs)` with the
            // `.where(...)` DELETED handed `cancel.ts` the right rows and left
            // the recorder empty — a whole-table read, invisible. Measured
            // before this guard: deleting that predicate from `cancel.ts:84`
            // left this file green at 8/8. Settling through the guard records
            // `<NO PREDICATE>`, which `expectNoUnfilteredQuery()` rejects.
            then: (resolve: (v: unknown) => void) => resolve(guard.settle(result)),
          };
          return chain;
        },
      };
    },
    update(table: unknown) {
      const which: 'requests' | 'jobs' =
        table === generationRequests ? 'requests' : 'jobs';
      const name = table === generationRequests
        ? 'update:generation_requests'
        : 'update:generation_jobs';
      return {
        set(values: Record<string, unknown>) {
          state.updates.push({ table: which, values });
          const guard = wheres.guard(name);
          return {
            // 🔴 TAKES its argument too. An UPDATE whose predicate is dropped
            // is a whole-table write, and nothing else in this file would see
            // it — `state.updates` records only the SET clause.
            where: (predicate: unknown) => {
              guard.where(predicate);
              const isLostWrite =
                which === 'jobs' && values['metadata'] !== undefined;
              const rows = isLostWrite
                ? state.lost
                  ? state.jobs.filter((j) => j['status'] === 'running')
                  : []
                : state.jobs;
              return Object.assign(Promise.resolve(), {
                returning: async () => rows,
              });
            },
            // 🔴 …and `await tx.update(t).set(v)` with the `.where()` DELETED
            // lands HERE. Without this `then` the awaited chain is a plain
            // non-thenable: `await` resolves to the stub object itself,
            // `cancel.ts` ignores the result, and the whole-table write leaves
            // no trace. It went red before only because `wheres.for(...)` then
            // held ZERO entries — a count that reads as "the write never
            // happened", which is the opposite of the truth. Settling through
            // the guard records `<NO PREDICATE>` instead, so the failure names
            // the unfiltered write.
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
              guard.settle(null);
              return Promise.resolve(undefined).then(resolve, reject);
            },
          };
        },
      };
    },
    // `BudgetEnforcer.refund` is a raw `execute`. Recorded so a test can say
    // "the reserve came back", and how much.
    async execute(q: unknown) {
      (state.executes ??= []).push(
        JSON.stringify((q as { queryChunks?: unknown[] })?.queryChunks ?? q),
      );
      return { rows: [] };
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(stub);
    },
  };
  return stub as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';
const REQ_ID = '11111111-2222-3333-4444-555555555555';

function makeRequestRow(over: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    org: ORG,
    project: PROJECT,
    status: 'running' as const,
    totalJobs: 3,
    completedJobs: 0,
    failedJobs: 0,
    estimatedCostUsd: '0.30',
    actualCostUsd: '0',
    createdAt: new Date('2026-05-15T12:00:00Z'),
    cancelledAt: null,
    finishedAt: null,
    ...over,
  };
}

function makeJobRow(
  i: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `job-${i}`,
    generationRequestId: REQ_ID,
    queueJobId: null,
    status: 'queued',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  wheres.reset();
});

describe('cancelGeneration', () => {
  beforeEach(async () => {
    runtime = createTestRuntime();
  });

  it('unknown requestId → not-cancelled, no queue interaction', async () => {
    const state: StubState = { request: null, jobs: [], updates: [] };
    const db = makeDb(state);
    const queue = getGenerationQueue();
    // Seed an unrelated job so we can prove nothing was removed.
    await queue.add('generation:test-org:thing', {
      jobId: 'irrelevant',
      generationRequestId: 'other-request',
      org: ORG,
      project: PROJECT,
      unitKey: 'u1',
    });
    const before = __getMockJobs(queue).length;

    const bus = createEventBus();
    let emitted = 0;
    bus.onAny(() => {
      emitted += 1;
    });

    const result = await cancelGeneration(REQ_ID, { org: ORG, project: PROJECT }, {
      db,
      queue,
      bus,
    });

    expect(result).toEqual({ cancelled: false, removedJobs: 0 });
    expect(__getMockJobs(queue).length).toBe(before);
    expect(state.updates).toHaveLength(0);
    expect(emitted).toBe(0);
  });

  it('in-flight request: removes queue jobs, marks rows cancelled, emits event', async () => {
    const queue = getGenerationQueue();
    // Pre-populate the mock queue with 3 jobs whose ids will be stamped onto
    // the job rows below as `queueJobId`.
    const enqueued = [];
    for (let i = 0; i < 3; i++) {
      const job = await queue.add(
        `generation:${ORG}:thing`,
        {
          jobId: `job-${i}`,
          generationRequestId: REQ_ID,
          org: ORG,
          project: PROJECT,
          unitKey: `u${i}`,
        },
        { jobId: `q-${i}` },
      );
      enqueued.push(job);
    }
    expect(__getMockJobs(queue).length).toBe(3);

    const state: StubState = {
      request: makeRequestRow({ status: 'running' }),
      jobs: [
        makeJobRow(0, { queueJobId: 'q-0', status: 'queued' }),
        makeJobRow(1, { queueJobId: 'q-1', status: 'queued' }),
        makeJobRow(2, { queueJobId: 'q-2', status: 'queued' }),
      ],
      updates: [],
    };
    const db = makeDb(state);

    const bus = createEventBus();
    const events: AppEvent[] = [];
    bus.onAny((e) => events.push(e));

    const result = await cancelGeneration(
      REQ_ID,
      { org: ORG, project: PROJECT },
      { db, queue, bus },
    );

    expect(result).toEqual({ cancelled: true, removedJobs: 3 });
    expect(__getMockJobs(queue).length).toBe(0);

    // Both update calls happened: request row + queued job rows.
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]?.table).toBe('requests');
    expect(state.updates[0]?.values).toMatchObject({ status: 'cancelled' });
    expect(state.updates[0]?.values.cancelledAt).toBeInstanceOf(Date);
    expect(state.updates[0]?.values.finishedAt).toBeInstanceOf(Date);
    expect(state.updates[1]?.table).toBe('jobs');
    expect(state.updates[1]?.values).toMatchObject({ status: 'cancelled' });
    expect(state.updates[1]?.values.finishedAt).toBeInstanceOf(Date);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'generation.request.cancelled',
      requestId: REQ_ID,
      org: ORG,
      project: PROJECT,
    });

    // The whole destructive path above began with one tenant-scoped lookup.
    // Pinned here as well as in the dedicated cases below so the file's main
    // success path cannot drift away from the scope it depends on.
    wheres.expectScopedTo('generation_requests', { org: ORG, project: PROJECT });
  });

  it('cross-tenant cancel attempt: behaves as unknown (route maps to 404)', async () => {
    // ⚠ The stub returns no row because `request` is `null` here — NOT because
    // any filter was applied. That is why the assertion at the end of this case
    // reads the predicate itself: without it, this case would pass identically
    // against a `cancelGeneration` that carried no tenant filter at all.
    const state: StubState = { request: null, jobs: [], updates: [] };
    const db = makeDb(state);
    const queue = getGenerationQueue();

    const bus = createEventBus();
    let emitted = 0;
    bus.onAny(() => {
      emitted += 1;
    });

    const result = await cancelGeneration(
      REQ_ID,
      { org: 'other-org', project: 'other-project' },
      { db, queue, bus },
    );

    expect(result).toEqual({ cancelled: false, removedJobs: 0 });
    expect(state.updates).toHaveLength(0);
    expect(emitted).toBe(0);
    // 🔴 The load-bearing half: the lookup carried the CALLER's org/project,
    // so a row belonging to `test-org` could not have matched it. Drop either
    // `eq(generationRequests.org, ctx.org)` or the `project` term from
    // `cancel.ts` and this goes red.
    wheres.expectScopedTo('generation_requests', {
      org: 'other-org',
      project: 'other-project',
    });
  });

  it('already-cancelled: idempotent, no new event, no queue interaction', async () => {
    const state: StubState = {
      request: makeRequestRow({ status: 'cancelled' }),
      jobs: [],
      updates: [],
    };
    const db = makeDb(state);
    const queue = getGenerationQueue();
    await queue.add(`generation:${ORG}:thing`, {
      jobId: 'job-x',
      generationRequestId: REQ_ID,
      org: ORG,
      project: PROJECT,
      unitKey: 'u',
    });
    const before = __getMockJobs(queue).length;

    const bus = createEventBus();
    let emitted = 0;
    bus.onAny(() => {
      emitted += 1;
    });

    const result = await cancelGeneration(
      REQ_ID,
      { org: ORG, project: PROJECT },
      { db, queue, bus },
    );

    expect(result).toEqual({
      cancelled: true,
      removedJobs: 0,
      alreadyCancelled: true,
    });
    expect(__getMockJobs(queue).length).toBe(before); // queue untouched
    expect(state.updates).toHaveLength(0);
    expect(emitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant scope — the predicate, not the returned row
// ---------------------------------------------------------------------------
//
// Every case above asserts on what the stub handed back, and the stub chooses
// that by hand. A cancel is a DESTRUCTIVE cross-tenant risk — it stops another
// customer's in-flight generation and marks their rows cancelled — so the guard
// query gets read directly here.

describe('cancelGeneration — tenant scope of the queries it issues', () => {
  beforeEach(async () => {
    runtime = createTestRuntime();
  });

  function inFlightState(): StubState {
    return {
      request: makeRequestRow({ status: 'running' }),
      jobs: [makeJobRow(0, { status: 'queued' })],
      updates: [],
    };
  }

  it('🔴 the request lookup is scoped to (org, project) — not to the requestId alone', async () => {
    const state = inFlightState();
    await cancelGeneration(REQ_ID, { org: ORG, project: PROJECT }, {
      db: makeDb(state),
      queue: getGenerationQueue(),
      bus: createEventBus(),
    });

    const guards = wheres.for('generation_requests');
    expect(guards).toHaveLength(1);
    const guard = guards[0]!;
    // Column by column, so dropping any ONE of the three is its own named
    // failure rather than one opaque "the SQL changed".
    expect(guard.sql).toContain('"generation_requests"."id" =');
    expect(guard.sql).toContain('"generation_requests"."org" =');
    expect(guard.sql).toContain('"generation_requests"."project" =');
    // …and the bound values are the id asked for plus the CALLER's scope, in
    // that order. A predicate naming the right columns but binding a constant
    // would pass the check above.
    expect(guard.params).toEqual([REQ_ID, ORG, PROJECT]);
  });

  it('🔴 the project_configs callback lookup is scoped to (org, project)', async () => {
    // A request row with no `callbackUrl` of its own falls back to the
    // project-wide default. That read is org+project and nothing else — lose
    // either term and a cancelled generation POSTs to ANOTHER TENANT'S webhook,
    // which is a data leak that never touches this service's own responses.
    const state = inFlightState();
    await cancelGeneration(REQ_ID, { org: ORG, project: PROJECT }, {
      db: makeDb(state),
      queue: getGenerationQueue(),
      bus: createEventBus(),
    });

    const lookups = wheres.for('project_configs');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.sql).toContain('"project_configs"."org" =');
    expect(lookups[0]!.sql).toContain('"project_configs"."project" =');
    expect(lookups[0]!.params).toEqual([ORG, PROJECT]);
  });

  it('🔴 every write keys off the RESOLVED row id, and none of them runs unfiltered', async () => {
    // ⚠ Deliberately NOT asserting a redundant `org` term on the writes. They
    // key off `row.id`, and `row` is the row the tenant-scoped guard query
    // above returned — so they are in-scope BY CONSTRUCTION, and adding an org
    // term would pin an implementation detail rather than a security property.
    // (The same reasoning covers the final counts SELECT in `cancel.ts` on the
    // callback branch, which is likewise `eq(generationRequests.id, row.id)`.)
    //
    // What DOES need pinning is that they are filtered at all: an UPDATE whose
    // predicate went missing cancels every request in the table, and
    // `state.updates` only records the SET clause, so nothing else here sees it.
    const state = inFlightState();
    await cancelGeneration(REQ_ID, { org: ORG, project: PROJECT }, {
      db: makeDb(state),
      queue: getGenerationQueue(),
      bus: createEventBus(),
    });

    // ⚠ ORDER MATTERS, and it is the deleted-`.where()` case that decides it.
    // Since the stub's terminals settle through `WhereRecorder.guard`, a write
    // that ran unfiltered now appears in the list as `<NO PREDICATE>` — so the
    // `toHaveLength(1)` checks below PASS for it and the first thing to notice
    // would be a bare `expected [] to deeply equal [...]` on the params, which
    // reads like a changed predicate rather than an absent one. Asking the
    // unfiltered question FIRST makes that mutation fail by its real name.
    wheres.expectNoUnfilteredQuery();

    const reqWrite = wheres.for('update:generation_requests');
    expect(reqWrite).toHaveLength(1);
    expect(reqWrite[0]!.params).toEqual([REQ_ID]);

    const jobWrite = wheres.for('update:generation_jobs');
    expect(jobWrite).toHaveLength(1);
    // `(generation_request_id = row.id AND status = 'queued')` — running jobs
    // are left alone for the worker to transition.
    expect(jobWrite[0]!.params).toEqual([REQ_ID, 'queued']);
  });

  it('🔴 binds the CALLER scope, never the scope stamped on the row that comes back', async () => {
    // The stub hands back a row owned by (test-org, test-project) no matter who
    // asks — the shape of a cross-tenant read. If `cancelGeneration` ever
    // filtered on the row, or on a cached ctx, only this case would notice.
    const state = inFlightState();
    await cancelGeneration(REQ_ID, { org: 'other-org', project: 'other-project' }, {
      db: makeDb(state),
      queue: getGenerationQueue(),
      bus: createEventBus(),
    });

    wheres.expectScopedTo('generation_requests', {
      org: 'other-org',
      project: 'other-project',
    });
    wheres.expectScopedTo('project_configs', {
      org: 'other-org',
      project: 'other-project',
    });
  });
});


// ---------------------------------------------------------------------------
// POST /cancel and a job whose worker died
//
// 🔴 THE DEFECT THESE LOCK. `cancel.ts` only ever moved rows in 'queued'; the
// comment said a running job is transitioned by the worker when it re-reads
// the parent status. That is true of a LIVE worker and false of a dead one.
// Measured: cancelling a request whose worker had been SIGKILLed returned
// `{cancelled: true, removedJobs: 0}` and left the job row 'running' forever,
// with the router's reserve for it still held.
//
// A job running INSIDE the window is still left to the cancel bus — aborting
// a live LLM call is that path's job, and killing its row from here would be
// the double-write defect turned inside out.
// ---------------------------------------------------------------------------

describe('cancelGeneration — a job whose worker is gone', () => {
  beforeEach(async () => {
    runtime = createTestRuntime();
  });

  const runCancel = async (state: StubState) =>
    cancelGeneration(
      REQ_ID,
      { org: ORG, project: PROJECT },
      { db: makeDb(state), queue: getGenerationQueue(), bus: createEventBus() },
    );

  it("clears a 'running' job past the window and reports it in `lostJobs`", async () => {
    const state: StubState = {
      request: makeRequestRow(),
      jobs: [
        makeJobRow(0, { status: 'running', metadata: { reservePerCallUsd: 0.000737 } }),
      ],
      updates: [],
      lost: true,
    };

    const result = await runCancel(state);

    expect(result.cancelled).toBe(true);
    // ADDITIVE: `removedJobs` keeps meaning "removed from the BullMQ queue",
    // which is 0 here — there is nothing left in the queue to remove.
    expect(result.removedJobs).toBe(0);
    expect(result.lostJobs).toBe(1);
    const lostWrite = state.updates.find((u) => u.values['metadata'] !== undefined);
    expect(lostWrite?.values).toMatchObject({ status: 'cancelled', error: 'cancelled' });
  });

  it('refunds the reserve the dead worker was holding', async () => {
    const state: StubState = {
      request: makeRequestRow(),
      jobs: [
        makeJobRow(0, { status: 'running', metadata: { reservePerCallUsd: 0.000737 } }),
      ],
      updates: [],
      lost: true,
    };

    await runCancel(state);

    const refunds = (state.executes ?? []).filter((e) => e.includes('budget_state'));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toContain('0.000737');
  });

  it("leaves a 'running' job INSIDE the window to the cancel bus, and omits `lostJobs`", async () => {
    const state: StubState = {
      request: makeRequestRow(),
      jobs: [makeJobRow(0, { status: 'running' })],
      updates: [],
      lost: false,
    };

    const result = await runCancel(state);

    // Omitted, not zero: a consumer that has never heard of the field sees the
    // response it has always seen.
    expect(result.lostJobs).toBeUndefined();
    expect((state.executes ?? []).filter((e) => e.includes('budget_state'))).toHaveLength(0);
  });
});
