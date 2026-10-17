// Unit tests for the generation orchestrator.
//
// Strategy: the drizzle `db` is replaced with a minimal stub that records
// every insert/update/delete call and returns canned select results. Pattern
// borrowed from `src/services/registry/resolve.test.ts` +
// `src/services/idempotency.test.ts`. `db.transaction(fn)` invokes `fn(tx)`
// where `tx` is the same stub (so the transaction body's calls land on the
// same recorder). The mock queue + flow producer come from a per-test
// `createTestRuntime()` — the same in-memory impls, now owned by a value
// instead of module-scope singletons. A fresh `EventBus` and stubbed `BudgetEnforcer`
// are injected per test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { generationRequests, generationJobs } from '../../db/schema/index.js';
import type { BudgetEnforcer } from '../budget/enforcer.js';
import { BudgetExceeded, BudgetNotConfigured } from '../budget/errors.js';
import { createEventBus, type EventBus } from '../events/bus.js';
import {
  __getMockJobs,
  type GenerationQueueLike,
  type MockFlowProducer,
} from '../../queue/queues.js';
import { createTestRuntime } from '../../testing/runtime.js';
import type { Runtime } from '../../runtime.js';
import type { ResolvedSpec } from '../registry/resolve.js';
import type { GenerateRequest, Unit } from '../../types/generation.js';

import { hashPayload } from '../idempotency.js';

import { isScopedTo, WhereRecorder, type RecordedWhere } from '../../test/where-recorder.js';

import {
  CrossBatchDependencyError,
  DependencyCycleError,
  enqueueGeneration as enqueueGenerationRaw,
  IdempotencyConflictError,
  type OrchestratorDeps,
} from './orchestrator.js';

// ---------------------------------------------------------------------------
// Stub db
// ---------------------------------------------------------------------------

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}
interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}
interface DeleteCall {
  table: unknown;
  /** The predicate the DELETE actually carried, serialised. */
  where: RecordedWhere;
}

interface StubState {
  idempotencyRows: Record<string, unknown>[];
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: DeleteCall[];
  /**
   * 🔴 EVERY `where()` THE ORCHESTRATOR BUILDS, SERIALISED.
   *
   * The three chains below used to declare `where()` with NO parameter, so the
   * predicate the orchestrator passed was discarded at the door and this file
   * agreed with any WHERE clause at all — including none. That is not
   * hypothetical: it is what hid a REAL cross-tenant DELETE. Step 2's
   * "probe once more for a same-key row" ran unscoped
   * (`eq(generationRequests.clientRequestId, …)` and nothing else) and its
   * result was fed to `tx.delete(generationRequests).where(eq(id, staleId))`
   * inside the insert transaction, with `generation_jobs` cascading. Because
   * `clientRequestId` is caller-supplied and the unique index is
   * `("org","client_request_id")`, any authenticated tenant could destroy
   * another tenant's finished batch by guessing a correlation id.
   *
   * The full proof is in `src/routes/tenant-isolation.integration.test.ts`
   * against a real Postgres, which reads the victim's rows back. This recorder
   * is the database-free tripwire that keeps it from coming back.
   *
   * ⚠ Taking the argument is only HALF the gate, and the half that catches the
   * weaker mutation. `where(undefined)` — the emptied call — reaches `where()`
   * and gets recorded; the call being DELETED never reaches it at all. All
   * three chains therefore settle their terminals (`limit`/`then` on the
   * select, `then`/`catch` on the update and the delete) through
   * `WhereRecorder.guard()`, which records `<NO PREDICATE>` for a chain that
   * was never filtered. Take those terminals away and this file goes back to
   * agreeing with a whole-table read, UPDATE or DELETE.
   */
  wheres: WhereRecorder;
  /**
   * Counter used to mint deterministic insert ids — the orchestrator captures
   * them via `.returning({ id })`. Test fixtures key off these.
   */
  nextRequestId: () => string;
  nextJobId: () => string;
}

function makeStubDb(initial?: {
  idempotencyRows?: Record<string, unknown>[];
}): { db: Db; state: StubState } {
  let reqCounter = 0;
  let jobCounter = 0;
  const state: StubState = {
    idempotencyRows: initial?.idempotencyRows ?? [],
    inserts: [],
    updates: [],
    deletes: [],
    wheres: new WhereRecorder(),
    nextRequestId: () => `req-${++reqCounter}`,
    nextJobId: () => `job-${++jobCounter}`,
  };

  /** Which table a drizzle schema object refers to, for the recorder's label. */
  const nameOf = (table: unknown): string =>
    table === generationRequests
      ? 'generation_requests'
      : table === generationJobs
        ? 'generation_jobs'
        : 'unknown';

  // 🔴 BOTH TERMINALS SETTLE THROUGH THE GUARD — not just `where`.
  //
  // Recording from inside `where()` catches the mutation that EMPTIES the call.
  // It cannot catch the one that DELETES it. `then` here was the literal
  // `undefined`, so `await db.select({…}).from(t).limit(1)` with its
  // `.where(...)` removed handed the orchestrator the right rows and left the
  // recorder with nothing to report — an unscoped read of a caller-supplied key
  // looked exactly like a scoped one. `WhereRecorder.guard()` closes it: a
  // chain that settles through EITHER terminal having never been given a
  // predicate is recorded as `<NO PREDICATE>`.
  const selectChain = (table: unknown) => {
    let result: unknown[] = [];
    if (table === generationRequests) result = state.idempotencyRows;
    // One guard per `from()` — that is one per SELECT statement.
    const guard = state.wheres.guard(nameOf(table));
    const chain: {
      where: (predicate: unknown) => typeof chain;
      limit: (n?: number) => Promise<unknown[]>;
      then: (
        resolve: (v: unknown[]) => void,
        reject?: (e: unknown) => void,
      ) => Promise<void>;
    } = {
      // 🔴 TAKES its argument — see `StubState.wheres`.
      where: (predicate: unknown) => {
        guard.where(predicate);
        return chain;
      },
      limit: async () => guard.settle(result),
      then: (resolve, reject) =>
        Promise.resolve(guard.settle(result)).then(resolve, reject),
    };
    return chain;
  };

  const insertBuilder = (table: unknown) => ({
    values(vals: Record<string, unknown>) {
      state.inserts.push({ table, values: vals });
      const id =
        table === generationRequests
          ? state.nextRequestId()
          : table === generationJobs
            ? state.nextJobId()
            : `id-${state.inserts.length}`;
      return {
        returning() {
          return Promise.resolve([{ id }]);
        },
      };
    },
  });

  const updateBuilder = (table: unknown) => ({
    set(s: Record<string, unknown>) {
      const upd: UpdateCall = { table, set: s };
      state.updates.push(upd);
      // One guard per `set()` — that is one per UPDATE statement.
      const guard = state.wheres.guard(nameOf(table));
      const tail = {
        where(predicate: unknown) {
          guard.where(predicate);
          return Promise.resolve();
        },
        // 🔴 THE TERMINALS THAT USED NOT TO EXIST.
        // `await db.update(t).set(v)` with the `.where()` deleted is legal
        // drizzle and rewrites EVERY tenant's rows. `tail` had no `then`, so
        // `await` of a non-thenable settled instantly, the caller ignored the
        // result, and the whole statement left no trace. `catch` is here for
        // the same reason: the one UPDATE the orchestrator makes ends
        // `.catch(() => undefined)`, so without it the deleted-`.where()`
        // mutation surfaced as a TypeError about the stub's own shape instead
        // of as the whole-table write it actually is — a red for the wrong
        // reason, and no red at all for any UPDATE that skips `.catch`.
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          return Promise.resolve(guard.settle(undefined)).then(resolve, reject);
        },
        catch(reject: (e: unknown) => unknown) {
          return Promise.resolve(guard.settle(undefined)).catch(reject);
        },
      };
      return tail;
    },
  });

  const deleteBuilder = (table: unknown) => {
    // One guard per `delete()` — that is one per DELETE statement.
    const guard = state.wheres.guard(nameOf(table));
    return {
      // 🔴 THE DESTRUCTIVE ONE. This is the `where()` that carried `staleId`.
      where(predicate: unknown) {
        state.deletes.push({ table, where: guard.where(predicate) });
        return Promise.resolve();
      },
      // 🔴 …and THIS is what makes deleting the line above visible at all.
      // `await tx.delete(generationRequests)` with no `.where()` wipes the
      // table for every tenant, and `generation_jobs` cascades. Against a plain
      // `{ where }` object it settled instantly and recorded nothing, so the
      // only symptom was `state.deletes` staying empty — which reads as "the
      // DELETE never ran", the exact opposite of what happened. Settling
      // through the guard records `<NO PREDICATE>` instead.
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        return Promise.resolve(guard.settle(undefined)).then(resolve, reject);
      },
      catch(reject: (e: unknown) => unknown) {
        return Promise.resolve(guard.settle(undefined)).catch(reject);
      },
    };
  };

  // The transaction body receives the same stub so the recorder sees every
  // call regardless of whether the caller used `db.x()` or `tx.x()`.
  const stub: Record<string, unknown> = {
    select: () => ({ from: selectChain }),
    insert: insertBuilder,
    update: updateBuilder,
    delete: deleteBuilder,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(stub);
    },
    execute: async () => ({ rows: [] }),
  };
  return { db: stub as unknown as Db, state };
}

// ---------------------------------------------------------------------------
// Stub spec resolver + budget enforcer + rng/clock
// ---------------------------------------------------------------------------

function makeSpec(over: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return {
    // No placeholders — most tests don't supply matching vars and strict
    // Handlebars throws on undefined references. Tests that exercise
    // rendering pass an explicit `promptTemplate` via the `over` arg.
    promptTemplate: 'static prompt',
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
    registryEntryId: '11111111-1111-1111-1111-111111111111',
    registryEntryVersion: '1',
    ...over,
  };
}

/**
 * Budget stub.
 *
 * 🔴 `reserve` / `adjust` / `refund` ARE SPIES THAT MUST NEVER FIRE from this
 * module. The orchestrator used to reserve the whole-batch estimate inside the
 * insert transaction and nothing in the service ever released it, so every
 * batch permanently subtracted its estimate from `budget_state.remaining_usd`
 * on top of the router's real per-call spend. Money is now moved ONLY by the
 * router's per-call reserve/true-up; see the orchestrator header. The spies
 * stay here so re-introducing a call is a test failure and not a silent leak.
 */
function makeBudget(opts: {
  remaining?: number;
  /** When set, `assertConfigured` throws it (simulating a fail-closed org). */
  assertConfiguredThrows?: Error;
  /** Canned answer for the read-only soft-cap probe. */
  softCap?: boolean;
}): BudgetEnforcer {
  return {
    assertConfigured: vi.fn(async () => {
      if (opts.assertConfiguredThrows) throw opts.assertConfiguredThrows;
    }),
    getRemaining: vi.fn(async () => opts.remaining ?? 100),
    checkSoftCap: vi.fn(async () => opts.softCap ?? false),
    reserve: vi.fn(async () => {
      throw new Error('orchestrator must not reserve: the batch reserve leaked');
    }),
    adjust: vi.fn(async () => {
      throw new Error('orchestrator must not adjust budget');
    }),
    refund: vi.fn(async () => {
      throw new Error('orchestrator must not refund budget');
    }),
  } as unknown as BudgetEnforcer;
}

let uuidCounter = 0;
const rng = () => `uuid-${++uuidCounter}`;
const clock = () => new Date('2026-05-15T12:00:00Z');

// ---------------------------------------------------------------------------
// Common setup
// ---------------------------------------------------------------------------

const CTX = { org: 'test-org', project: 'test-project' };

let runtime: Runtime;
let queue: GenerationQueueLike;
let flow: MockFlowProducer;
let bus: EventBus;

// `queue` + `flow` are now REQUIRED orchestrator deps (they used to default to
// the module-scope singletons). Every call in this file went through the
// defaults, so rather than adding the same two keys to ~25 object literals, this
// wrapper supplies the test runtime's pair and lets each case override.
const enqueueGeneration = (
  req: Parameters<typeof enqueueGenerationRaw>[0],
  ctx: Parameters<typeof enqueueGenerationRaw>[1],
  deps: Partial<OrchestratorDeps> = {},
) => enqueueGenerationRaw(req, ctx, { queue, flow, ...deps });

beforeEach(() => {
  runtime = createTestRuntime();
  queue = runtime.queues.generation;
  flow = runtime.queues.flow as MockFlowProducer;
  bus = createEventBus();
  uuidCounter = 0;
});

afterEach(async () => {
  await runtime.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enqueueGeneration', () => {
  it('happy path: 2 units, no deps → 2 jobs + 2 FlowJobs in queue', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const req: GenerateRequest = {
      units: [
        { unitKey: 'u1', input: { name: 'Alice' } },
        { unitKey: 'u2', input: { name: 'Bob' } },
      ],
    };
    const result = await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    expect(result.totalJobs).toBe(2);
    expect(result.requestId).toMatch(/^req-/);
    expect(result.channel).toBe(`request:${result.requestId}:generations`);
    // perCall(0.001) * passes(1) * samples(1) * 2 units = 0.002.
    expect(result.estimatedCostUsd).toBeCloseTo(0.002, 9);

    // 1 request row + 2 job rows.
    const requestInserts = state.inserts.filter(
      (i) => i.table === generationRequests,
    );
    const jobInserts = state.inserts.filter((i) => i.table === generationJobs);
    expect(requestInserts).toHaveLength(1);
    expect(jobInserts).toHaveLength(2);

    // 2 mock queue jobs queued via FlowProducer.
    expect(__getMockJobs(queue)).toHaveLength(2);
  });

  it('registry-resolved spec: registry_entry_id is stamped, spec_override is null', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      { units: [{ unitKey: 'u1', unitType: 'thing', input: { name: 'A' } }] },
      CTX,
      {
        db,
        queue,
        flow,
        resolver: async () =>
          makeSpec({ registryEntryId: 'reg-1', registryEntryVersion: 'v1' }),
        bus,
        budget,
        rng,
        clock,
      },
    );
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    expect(jobInsert.values.registryEntryId).toBe('reg-1');
    expect(jobInsert.values.specOverride).toBeNull();
  });

  it('inline specOverride: registry_entry_id is null, spec_override populated', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const override = {
      promptTemplate: 'inline {{x}}',
      model: 'inline/model',
    };
    await enqueueGeneration(
      {
        units: [
          {
            unitKey: 'u1',
            input: { x: 1 },
            specOverride: override,
          },
        ],
      },
      CTX,
      {
        db,
        queue,
        flow,
        // Inline override path: the resolver returns a spec with no
        // registryEntryId. The orchestrator forwards `unit.specOverride`
        // straight onto the row.
        resolver: async () => makeSpec({ registryEntryId: undefined }),
        bus,
        budget,
        rng,
        clock,
      },
    );
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    expect(jobInsert.values.registryEntryId).toBeNull();
    expect(jobInsert.values.specOverride).toEqual(override);
  });

  it('dependsOn DAG: A → B → C builds the right FlowJob tree + two-phase render', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    // FlowProducer mock surface — spy on `add` so we can inspect the tree
    // shape rather than just the resulting queue contents (the flat job
    // buffer hides parent/child relationships).
    const spyFlow: MockFlowProducer = {
      add: vi.fn(flow.add.bind(flow)),
      addBulk: flow.addBulk.bind(flow),
    };
    // C depends on B (slot `b`); B depends on A (slot `a`); A is the leaf.
    const units: Unit[] = [
      { unitKey: 'A', input: { x: 1 } },
      { unitKey: 'B', dependsOn: { a: 'A' }, input: { y: 2 } },
      { unitKey: 'C', dependsOn: { b: 'B' }, input: { z: 3 } },
    ];
    await enqueueGeneration({ units }, CTX, {
      db,
      queue,
      flow: spyFlow,
      // Leaf A renders now with `{ x: 1 }` in its input; B/C defer to the
      // worker (their `{{x}}` slots aren't satisfied until predecessors
      // complete). Template is purposely lean so A renders cleanly.
      resolver: async () => makeSpec({ promptTemplate: 'tpl-{{x}}' }),
      bus,
      budget,
      rng,
      clock,
    });

    // Only C is a root (nothing references it). FlowProducer.add called once.
    expect(spyFlow.add).toHaveBeenCalledTimes(1);
    const rootArg = (spyFlow.add as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // C → children: [B] → children: [A]. Verify tree shape.
    expect(rootArg.data.unitKey).toBe('C');
    expect(rootArg.children).toHaveLength(1);
    expect(rootArg.children![0]!.data.unitKey).toBe('B');
    expect(rootArg.children![0]!.children).toHaveLength(1);
    expect(rootArg.children![0]!.children![0]!.data.unitKey).toBe('A');
    expect(rootArg.children![0]!.children![0]!.children).toBeUndefined();

    // Two-phase render: A (leaf) has __renderedPrompt; B + C (dependent)
    // carry the raw template + __promptVars + __dependencySlots instead.
    const jobInserts = state.inserts.filter((i) => i.table === generationJobs);
    const inputs = jobInserts.map(
      (i) => i.values.input as Record<string, unknown>,
    );
    const inputA = inputs.find((i) => 'x' in i)!;
    const inputB = inputs.find((i) => 'y' in i)!;
    const inputC = inputs.find((i) => 'z' in i)!;
    expect(inputA.__renderedPrompt).toBeTypeOf('string');
    expect(inputA.__promptTemplate).toBeUndefined();
    expect(inputB.__promptTemplate).toBe('tpl-{{x}}');
    expect(inputB.__renderedPrompt).toBeUndefined();
    expect(inputB.__dependencySlots).toEqual({ a: 'A' });
    expect(inputC.__promptTemplate).toBe('tpl-{{x}}');
    expect(inputC.__renderedPrompt).toBeUndefined();
    expect(inputC.__dependencySlots).toEqual({ b: 'B' });
  });

  it('cycle in dependsOn: A ↔ B throws DependencyCycleError before any DB write', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const units: Unit[] = [
      { unitKey: 'A', dependsOn: { other: 'B' } },
      { unitKey: 'B', dependsOn: { other: 'A' } },
    ];
    await expect(
      enqueueGeneration({ units }, CTX, {
        db,
        queue,
        flow,
        resolver: async () => makeSpec(),
        bus,
        budget,
        rng,
        clock,
      }),
    ).rejects.toBeInstanceOf(DependencyCycleError);
    expect(state.inserts).toHaveLength(0);
  });

  it('cross-batch dependency: throws CrossBatchDependencyError before any DB write', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const units: Unit[] = [
      { unitKey: 'A', dependsOn: { ghost: 'not-in-batch' } },
    ];
    await expect(
      enqueueGeneration({ units }, CTX, {
        db,
        queue,
        flow,
        resolver: async () => makeSpec(),
        bus,
        budget,
        rng,
        clock,
      }),
    ).rejects.toBeInstanceOf(CrossBatchDependencyError);
    expect(state.inserts).toHaveLength(0);
  });

  it('budget exceeded: tiny remaining < estimate → BudgetExceeded, no inserts', async () => {
    const { db, state } = makeStubDb();
    // perCall(0.5) × 1 × 1 = 0.5; remaining = 0.1.
    const budget = makeBudget({ remaining: 0.1 });
    const expensive = makeSpec({
      effortProfile: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.5,
      },
    });
    await expect(
      enqueueGeneration({ units: [{ unitKey: 'u1' }] }, CTX, {
        db,
        queue,
        flow,
        resolver: async () => expensive,
        bus,
        budget,
        rng,
        clock,
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(state.inserts).toHaveLength(0);
    expect(__getMockJobs(queue)).toHaveLength(0);
  });

  it('fail-closed: org with no budget configured → BudgetNotConfigured, no inserts (ADR-0003 D5)', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({
      assertConfiguredThrows: new BudgetNotConfigured(CTX.org),
    });
    await expect(
      enqueueGeneration({ units: [{ unitKey: 'u1' }] }, CTX, {
        db,
        queue,
        flow,
        resolver: async () => makeSpec(),
        bus,
        budget,
        rng,
        clock,
      }),
    ).rejects.toBeInstanceOf(BudgetNotConfigured);
    // Fail-closed before any DB write or enqueue.
    expect(state.inserts).toHaveLength(0);
    expect(__getMockJobs(queue)).toHaveLength(0);
  });

  it('idempotency replay: second call same body within 24h returns existing handle without enqueue', async () => {
    const REQ_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const CLIENT_ID = 'client-1';
    // Body the orchestrator will hash — must match what we stash on the
    // canned row's metadata.payloadHash.
    const reqBody: GenerateRequest = {
      clientRequestId: CLIENT_ID,
      units: [{ unitKey: 'u1', input: { x: 1 } }],
    };
    // Borrow the real hash function so we don't have to recompute it inline.
    const { hashPayload } = await import('../idempotency.js');
    const hash = hashPayload({
      units: reqBody.units,
      effortLevel: undefined,
      effortOverrides: undefined,
      promptOverride: undefined,
      modelOverride: undefined,
      includeContext: undefined,
    });
    const idempotencyRow = {
      id: REQ_ID,
      org: CTX.org,
      project: CTX.project,
      clientRequestId: CLIENT_ID,
      status: 'queued',
      totalJobs: 1,
      completedJobs: 0,
      failedJobs: 0,
      estimatedCostUsd: '0.001',
      actualCostUsd: '0',
      metadata: { payloadHash: hash },
      createdAt: new Date('2026-05-15T11:00:00Z'),
    };
    const { db, state } = makeStubDb({
      idempotencyRows: [idempotencyRow],
    });
    const budget = makeBudget({ remaining: 100 });
    const before = __getMockJobs(queue).length;
    const result = await enqueueGeneration(reqBody, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });
    expect(result.requestId).toBe(REQ_ID);
    expect(result.channel).toBe(`request:${REQ_ID}:generations`);
    expect(state.inserts).toHaveLength(0);
    // No new mock jobs were enqueued.
    expect(__getMockJobs(queue).length).toBe(before);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 🔴 THE STALE-ROW PROBE — the query that was a cross-tenant DELETE
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Step 2 runs TWO reads of `generation_requests` when a `clientRequestId` is
  // supplied:
  //   1. `checkIdempotency` — always carried `eq(generationRequests.org, …)`.
  //   2. the "probe once more for a same-key row" that recovers `staleId` —
  //      which did NOT, and whose result is handed to
  //      `tx.delete(generationRequests).where(eq(id, staleId))` in step 9.
  //
  // Read 1 returning `{ kind: 'new' }` is precisely the state "no row for this
  // key IN MY ORG", so read 2's unscoped match landed on another org's row
  // whenever one existed. This case pins BOTH reads, not just the first: the
  // old stub's parameterless `where()` could not tell them apart, because it
  // could not see either.
  //
  // The end-to-end proof (seed a victim, POST, read the victim's rows back)
  // lives in `src/routes/tenant-isolation.integration.test.ts`. This is the
  // database-free tripwire.
  it('🔴 both generation_requests reads on the idempotency path are scoped to the caller’s org', async () => {
    const CLIENT_ID = 'client-stale';
    // 25h old ⇒ outside the 24h window ⇒ `{ kind: 'new' }` AND a stale id to
    // delete, so BOTH reads and the DELETE all execute in one call.
    const staleRow = {
      id: 'stale-req-id',
      org: CTX.org,
      project: CTX.project,
      clientRequestId: CLIENT_ID,
      status: 'queued',
      totalJobs: 1,
      completedJobs: 0,
      failedJobs: 0,
      estimatedCostUsd: '0.001',
      actualCostUsd: '0',
      metadata: { payloadHash: 'whatever' },
      createdAt: new Date('2026-05-14T10:00:00Z'),
    };
    const { db, state } = makeStubDb({ idempotencyRows: [staleRow] });
    const budget = makeBudget({ remaining: 100 });

    await enqueueGeneration(
      { clientRequestId: CLIENT_ID, units: [{ unitKey: 'u1', input: { x: 1 } }] },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );

    // 🔴 FIRST: did ANY of it run with no predicate at all? Both reads, the
    // step-9 DELETE and the queueJobId UPDATE settle through
    // `WhereRecorder.guard()`, so a `.where()` that was DELETED rather than
    // emptied lands here as `<NO PREDICATE>`. Asserted before the shape checks
    // below on purpose: "the DELETE never happened" is the wrong diagnosis for
    // a DELETE that ran against the whole table.
    state.wheres.expectNoUnfilteredQuery();

    // Both reads bind the idempotency key, which is how they are told apart
    // from the unrelated selects the rest of the pipeline makes.
    const keyedReads = state.wheres
      .for('generation_requests')
      .filter((w) => w.params.includes(CLIENT_ID));
    expect(
      keyedReads.length,
      'expected checkIdempotency AND the stale-row probe to both run',
    ).toBe(2);

    // 🔴 THE ASSERTION. EVERY one of them, not just the first.
    //
    // Deliberately NOT `expectEveryQueryScopedTo('generation_requests', …)`:
    // the step-9 `tx.delete(generationRequests).where(eq(id, staleId))` is
    // recorded against this same table and is legitimately un-org-scoped — it
    // targets an id the org-scoped probe above minted. Narrowing to the two
    // reads that bind the caller-supplied key gives the same "every one of
    // them" guarantee over the queries where the guarantee applies.
    //
    // 🔴 ONE paired check, not "the SQL mentions org" AND "the params contain
    // the org" as two independent ones. Done separately those two are satisfied
    // by DIFFERENT terms of the same predicate, so they accept
    // `and(eq(t.org, 'some-constant'), eq(t.project, ctx.org))`: `"org"` is
    // compared to a constant, `ctx.org` is bound to a different column, nothing
    // is scoped to the caller — and the pair passes. Measured on this file:
    // rewriting the probe into exactly that shape left all 19 cases green.
    // `isScopedTo` pairs each tenant column to the parameter its own
    // placeholder index binds, which is what the two halves have to share.
    for (const [i, read] of keyedReads.entries()) {
      expect(
        isScopedTo(read, { org: CTX.org }),
        `read ${i} on generation_requests carries the caller-supplied ` +
          `clientRequestId but is NOT scoped to org=${CTX.org}: ` +
          `${read.sql} params=${JSON.stringify(read.params)}`,
      ).toBe(true);
    }

    // And the stale row really was deleted — otherwise the two reads above
    // could be scoped correctly on a path that never reaches the DELETE, and
    // this case would be proving nothing about the destructive half.
    const requestDeletes = state.deletes.filter((d) => d.table === generationRequests);
    expect(requestDeletes).toHaveLength(1);
    expect(requestDeletes[0]!.where.params).toContain(staleRow.id);
  });

  // Nothing may run a whole-table read or write. `<NO PREDICATE>` is exactly
  // the shape `where(and())` collapses to when its terms are removed, so this
  // catches a deletion the per-table assertions above would miss.
  it('no query in the happy path runs without a predicate at all', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      { units: [{ unitKey: 'u1', input: { x: 1 } }] },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    state.wheres.expectNoUnfilteredQuery();
  });

  it('idempotency conflict: same clientRequestId, different body → IdempotencyConflictError', async () => {
    const CLIENT_ID = 'client-2';
    const idempotencyRow = {
      id: 'existing-req-id',
      org: CTX.org,
      project: CTX.project,
      clientRequestId: CLIENT_ID,
      status: 'queued',
      totalJobs: 1,
      completedJobs: 0,
      failedJobs: 0,
      estimatedCostUsd: '0.001',
      actualCostUsd: '0',
      metadata: { payloadHash: 'some-other-hash' },
      createdAt: new Date('2026-05-15T11:00:00Z'),
    };
    const { db, state } = makeStubDb({ idempotencyRows: [idempotencyRow] });
    const budget = makeBudget({ remaining: 100 });
    await expect(
      enqueueGeneration(
        {
          clientRequestId: CLIENT_ID,
          units: [{ unitKey: 'u1', input: { x: 99 } }],
        },
        CTX,
        {
          db,
          queue,
          flow,
          resolver: async () => makeSpec(),
          bus,
          budget,
          rng,
          clock,
        },
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(state.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// System prompt persistence
// ---------------------------------------------------------------------------
//
// The worker re-resolves the spec at pickup time, so registry-level system
// prompts need no persistence — but the two REQUEST-level levels do. Both land
// on columns/keys that already existed: `generation_requests.meta_prompt_override`
// (present since migration 0001, never written until now) and the job row's
// `input` jsonb.

// ---------------------------------------------------------------------------
// Spec FLOOR (`specDefault`) persistence
// ---------------------------------------------------------------------------
//
// Unlike `specOverride`, the floor has no column of its own. It rides on the
// job row's `input` jsonb — the same trick `__systemPrompt` uses. Without that,
// a `specDefault` would exist only for the enqueue-time cost estimate and be
// GONE by the time the worker re-resolves the spec: the unit would resolve from
// a different chain than the one it was costed against, and (for a caller whose
// project registered nothing) would fail with "no prompt template available".

describe('enqueueGeneration — spec floor persistence', () => {
  it('passes unit.specDefault to the resolver', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    // Contextually typed from the deps shape, so `args` is a real ResolveSpecArgs.
    const seen: Array<{ specDefault?: unknown }> = [];
    const resolver: NonNullable<Parameters<typeof enqueueGeneration>[2]>['resolver'] = async (
      _db,
      args,
    ) => {
      seen.push(args);
      return makeSpec();
    };
    await enqueueGeneration(
      {
        units: [
          {
            unitKey: 'u1',
            unitType: 'text-to-sql',
            input: { name: 'A' },
            specDefault: { promptTemplate: 'FLOOR {{name}}' },
          },
        ],
      },
      CTX,
      { db, queue, flow, resolver, bus, budget, rng, clock },
    );
    expect(seen[0]).toMatchObject({ specDefault: { promptTemplate: 'FLOOR {{name}}' } });
  });

  it('persists unit.specDefault on the job row input as __specDefault', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      {
        units: [
          {
            unitKey: 'u1',
            input: { name: 'A' },
            specDefault: { promptTemplate: 'FLOOR', effortLevel: 'quick' },
          },
        ],
      },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    const input = jobInsert.values.input as Record<string, unknown>;
    expect(input.__specDefault).toEqual({ promptTemplate: 'FLOOR', effortLevel: 'quick' });
    // Payload for the worker, not a template variable.
    expect(input.__promptVars).toBeUndefined();
  });

  it('BACKWARD COMPAT: without a floor the row shape is unchanged', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      { units: [{ unitKey: 'u1', input: { name: 'A' } }] },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    expect(
      Object.prototype.hasOwnProperty.call(jobInsert.values.input as object, '__specDefault'),
    ).toBe(false);
  });
});

describe('enqueueGeneration — system prompt persistence', () => {
  it('persists unit.systemPrompt on the job row input as __systemPrompt', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      {
        units: [
          { unitKey: 'u1', input: { name: 'A' }, systemPrompt: 'YOU ARE TERSE' },
        ],
      },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    const input = jobInsert.values.input as Record<string, unknown>;
    expect(input.__systemPrompt).toBe('YOU ARE TERSE');
    // Not smuggled into the template variable bag.
    expect(input.__promptVars).toBeUndefined();
  });

  it('persists systemPromptOverride on generation_requests.meta_prompt_override', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      {
        units: [{ unitKey: 'u1', input: { name: 'A' } }],
        systemPromptOverride: 'BATCH CONTRACT',
      },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    const reqInsert = state.inserts.find((i) => i.table === generationRequests)!;
    expect(reqInsert.values.metaPromptOverride).toBe('BATCH CONTRACT');
  });

  it('BACKWARD COMPAT: without system input the row shape is unchanged', async () => {
    const { db, state } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    await enqueueGeneration(
      { units: [{ unitKey: 'u1', input: { name: 'A' } }] },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );
    const reqInsert = state.inserts.find((i) => i.table === generationRequests)!;
    const jobInsert = state.inserts.find((i) => i.table === generationJobs)!;
    expect(reqInsert.values.metaPromptOverride).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(
        jobInsert.values.input as object,
        '__systemPrompt',
      ),
    ).toBe(false);
  });

  it('BACKWARD COMPAT: the idempotency hash is unchanged for callers that send no system prompt', async () => {
    // `systemPromptOverride` joined the hashed payload. `safe-stable-stringify`
    // drops undefined values, so an unmigrated caller's hash must be byte-identical
    // to the pre-change one — otherwise every live clientRequestId would flip from
    // "replay" to "conflict" (409) the moment this deploys.
    const before = hashPayload({
      units: [{ unitKey: 'u1', input: { name: 'A' } }],
      effortLevel: undefined,
      effortOverrides: undefined,
      promptOverride: undefined,
      modelOverride: undefined,
      includeContext: undefined,
    });
    const after = hashPayload({
      units: [{ unitKey: 'u1', input: { name: 'A' } }],
      effortLevel: undefined,
      effortOverrides: undefined,
      promptOverride: undefined,
      modelOverride: undefined,
      systemPromptOverride: undefined,
      includeContext: undefined,
    });
    expect(after).toBe(before);
    // …but a supplied system prompt DOES change it, so reusing a
    // clientRequestId with new instructions is a 409, not a silent replay.
    const changed = hashPayload({
      units: [{ unitKey: 'u1', input: { name: 'A' } }],
      systemPromptOverride: 'NEW CONTRACT',
    });
    expect(changed).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Budget: the batch reserve is GONE
//
// 🔴 THE LEAK THESE LOCK. `enqueueGeneration` used to call
// `budget.reserve({ amountUsd: estimate.estimatedCostUsd })` inside the insert
// transaction, and no code path in the service ever released it: the only
// refund/adjust callers are the router (its own per-call reserve/true-up) and
// `routes/embed.ts`. MEASURED: remaining 10 → 9.999263 on POST /v1/generate,
// still 9.999263 after the job completed with an actual cost of 0. Every batch
// permanently ate its estimate on top of what it really spent.
//
// Fail-closed (ADR-0003 D5) did NOT move: `assertConfigured` still 402s an org
// with no `budget_state` row before any work, and the advisory `estimateBatch`
// gate still 402s a batch bigger than `remaining_usd`. Both are covered by the
// pre-existing cases above; these add the "and nothing is subtracted" half.
// ---------------------------------------------------------------------------

describe('enqueueGeneration — budget', () => {
  it('moves NO money: reserve/adjust/refund are never called', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const req: GenerateRequest = { units: [{ unitKey: 'u1', input: {} }] };

    await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    // The stub's reserve/adjust/refund THROW, so a re-introduced call would
    // also fail this test by rejecting — the explicit assertions name it.
    const spies = budget as unknown as Record<string, { mock: { calls: unknown[] } }>;
    expect(spies.reserve!.mock.calls).toHaveLength(0);
    expect(spies.adjust!.mock.calls).toHaveLength(0);
    expect(spies.refund!.mock.calls).toHaveLength(0);
  });

  it('still checks the org is configured BEFORE reading remaining (fail-closed order)', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const req: GenerateRequest = { units: [{ unitKey: 'u1', input: {} }] };

    await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    const spies = budget as unknown as Record<
      string,
      { mock: { invocationCallOrder: number[] } }
    >;
    expect(spies.assertConfigured!.mock.invocationCallOrder[0]!).toBeLessThan(
      spies.getRemaining!.mock.invocationCallOrder[0]!,
    );
  });

  it('surfaces BUDGET_SOFT_CAP from the read-only probe, with no reserve behind it', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100, softCap: true });
    const req: GenerateRequest = { units: [{ unitKey: 'u1', input: {} }] };

    const result = await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    expect(result.warnings?.map((w) => w.code)).toEqual(['BUDGET_SOFT_CAP']);
  });

  it('omits warnings entirely when the soft cap is not breached', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100, softCap: false });
    const req: GenerateRequest = { units: [{ unitKey: 'u1', input: {} }] };

    const result = await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    expect(result.warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Soft-cap probe receives the BATCH ESTIMATE
//
// 🔴 A stub returning `softCap: true` proves nothing about WHICH number the
// enforcer judged. The regression was that `checkSoftCap` was called with the
// org only, so the PRE-spend remaining was tested and the batch that crosses
// the threshold stopped warning. The real-enforcer proof lives in
// `services/budget/enforcer.test.ts`; here we pin the CALL — that the
// orchestrator hands the estimate over at all.
// ---------------------------------------------------------------------------

describe('enqueueGeneration — soft-cap probe arguments', () => {
  it('passes the batch estimate to checkSoftCap, not just the org', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });
    const req: GenerateRequest = {
      units: [
        { unitKey: 'u1', input: {} },
        { unitKey: 'u2', input: {} },
      ],
    };

    const result = await enqueueGeneration(req, CTX, {
      db,
      queue,
      flow,
      resolver: async () => makeSpec(),
      bus,
      budget,
      rng,
      clock,
    });

    const probe = (budget as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .checkSoftCap!;
    expect(probe).toHaveBeenCalledTimes(1);
    const [org, projected] = probe.mock.calls[0]!;
    expect(org).toBe(CTX.org);
    // The same number the launch response reports, so the warning and the
    // quoted estimate can never disagree.
    expect(projected).toBe(result.estimatedCostUsd);
    expect(projected).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// httpRequestId — transport correlation id (contract with the HTTP lane)
//
// ⚠ NAME: `httpRequestId`, never `requestId`. `requestId` already means
// `generation_requests.id` in this service (the batch row, shared by every
// unit and outliving the HTTP call). Collapsing the two names would make a
// worker log line ambiguous about which id it is quoting.
// ---------------------------------------------------------------------------

describe('enqueueGeneration — httpRequestId round-trip', () => {
  it('carries ctx.httpRequestId into every enqueued job payload', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });

    await enqueueGeneration(
      {
        units: [
          { unitKey: 'u1', input: {} },
          { unitKey: 'u2', input: {} },
        ],
      },
      { ...CTX, httpRequestId: 'http-req-abc' },
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );

    const jobs = __getMockJobs(queue);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.data.httpRequestId).toBe('http-req-abc');
      // The pre-existing payload fields are untouched — a consumer reading the
      // job data keeps seeing exactly what it saw before.
      expect(job.data.org).toBe(CTX.org);
      expect(job.data.project).toBe(CTX.project);
    }
  });

  it('omits the key entirely when the caller sends none (payload stays byte-identical)', async () => {
    const { db } = makeStubDb();
    const budget = makeBudget({ remaining: 100 });

    await enqueueGeneration(
      { units: [{ unitKey: 'u1', input: {} }] },
      CTX,
      { db, queue, flow, resolver: async () => makeSpec(), bus, budget, rng, clock },
    );

    const jobs = __getMockJobs(queue);
    expect(jobs).toHaveLength(1);
    // `in`, not `=== undefined`: an explicit `httpRequestId: undefined` would
    // change the serialized payload for every existing consumer.
    expect('httpRequestId' in jobs[0]!.data).toBe(false);
  });
});
