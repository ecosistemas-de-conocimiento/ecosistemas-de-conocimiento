// Unit tests for the generation orchestrator.
//
// Strategy: the drizzle `db` is replaced with a minimal stub that records
// every insert/update/delete call and returns canned select results. Pattern
// borrowed from `src/services/registry/resolve.test.ts` +
// `src/services/idempotency.test.ts`. `db.transaction(fn)` invokes `fn(tx)`
// where `tx` is the same stub (so the transaction body's calls land on the
// same recorder). The mock queue + flow producer come from `getGenerationQueue`
// / `getGenerationFlowProducer` after `_resetQueuesForTests` — they're the
// in-memory NODE_ENV=test impls. A fresh `EventBus` and stubbed `BudgetEnforcer`
// are injected per test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { generationRequests, generationJobs } from '../../db/schema/index.js';
import type { BudgetEnforcer } from '../budget/enforcer.js';
import { BudgetExceeded, BudgetNotConfigured } from '../budget/errors.js';
import { createEventBus, type EventBus } from '../events/bus.js';
import {
  _resetQueuesForTests,
  __getMockJobs,
  getGenerationFlowProducer,
  getGenerationQueue,
  type GenerationQueueLike,
  type MockFlowProducer,
} from '../../queue/queues.js';
import type { ResolvedSpec } from '../registry/resolve.js';
import type { GenerateRequest, Unit } from '../../types/generation.js';

import { hashPayload } from '../idempotency.js';

import {
  CrossBatchDependencyError,
  DependencyCycleError,
  enqueueGeneration,
  IdempotencyConflictError,
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
}

interface StubState {
  idempotencyRows: Record<string, unknown>[];
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: DeleteCall[];
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
    nextRequestId: () => `req-${++reqCounter}`,
    nextJobId: () => `job-${++jobCounter}`,
  };

  const selectChain = (table: unknown) => {
    let result: unknown[] = [];
    if (table === generationRequests) result = state.idempotencyRows;
    const chain = {
      where: () => chain,
      limit: () => Promise.resolve(result),
      then: undefined,
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
      const tail = {
        where() {
          return Promise.resolve();
        },
      };
      return tail;
    },
  });

  const deleteBuilder = (table: unknown) => ({
    where() {
      state.deletes.push({ table });
      return Promise.resolve();
    },
  });

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

function makeBudget(opts: {
  remaining?: number;
  reserveThrows?: BudgetExceeded;
  /** When set, `assertConfigured` throws it (simulating a fail-closed org). */
  assertConfiguredThrows?: Error;
}): BudgetEnforcer {
  return {
    assertConfigured: vi.fn(async () => {
      if (opts.assertConfiguredThrows) throw opts.assertConfiguredThrows;
    }),
    getRemaining: vi.fn(async () => opts.remaining ?? 100),
    reserve: vi.fn(async ({ amountUsd }: { amountUsd: number }) => {
      if (opts.reserveThrows) throw opts.reserveThrows;
      return { remainingUsd: (opts.remaining ?? 100) - amountUsd };
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

let queue: GenerationQueueLike;
let flow: MockFlowProducer;
let bus: EventBus;

beforeEach(async () => {
  await _resetQueuesForTests();
  queue = getGenerationQueue();
  flow = getGenerationFlowProducer() as MockFlowProducer;
  bus = createEventBus();
  uuidCounter = 0;
});

afterEach(async () => {
  await _resetQueuesForTests();
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
