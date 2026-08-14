// Unit tests for cancelGeneration. The drizzle `db` is replaced with a tiny
// stub (same pattern as `services/registry/resolve.test.ts` /
// `services/idempotency.test.ts`) that returns canned select results, records
// `update` calls, and runs `transaction` callbacks with itself as `tx`. The
// queue comes from the in-memory mock returned by `getGenerationQueue()` in
// test mode (NODE_ENV=test, see `queue/queues.ts`).

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { generationJobs, generationRequests } from '../../db/schema/index.js';
import {
  __getMockJobs,
  _resetQueuesForTests,
  getGenerationQueue,
} from '../../queue/queues.js';
import { createEventBus } from '../events/bus.js';
import type { AppEvent } from '../events/types.js';

import { cancelGeneration } from './cancel.js';

// ---------------------------------------------------------------------------
// Stub db
// ---------------------------------------------------------------------------

interface StubState {
  request: Record<string, unknown> | null;
  jobs: Array<Record<string, unknown>>;
  /** Captured update calls (in order). */
  updates: Array<{ table: 'requests' | 'jobs'; values: Record<string, unknown> }>;
}

function makeDb(state: StubState): Db {
  const stub = {
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          let result: unknown[] = [];
          if (table === generationRequests) {
            result = state.request ? [state.request] : [];
          } else if (table === generationJobs) {
            result = state.jobs;
          }
          const chain = {
            where: () => chain,
            limit: () => Promise.resolve(result),
            // `await` on the where()-result (no `.limit()`) — for the jobs scan.
            then: (resolve: (v: unknown) => void) => resolve(result),
          };
          return chain;
        },
      };
    },
    update(table: unknown) {
      const which: 'requests' | 'jobs' =
        table === generationRequests ? 'requests' : 'jobs';
      return {
        set(values: Record<string, unknown>) {
          state.updates.push({ table: which, values });
          return { where: () => Promise.resolve() };
        },
      };
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

describe('cancelGeneration', () => {
  beforeEach(async () => {
    await _resetQueuesForTests();
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
  });

  it('cross-tenant cancel attempt: behaves as unknown (route maps to 404)', async () => {
    // Stub returns no row because the WHERE-filter would not match on
    // (id, org, project) — same outcome as "missing".
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
