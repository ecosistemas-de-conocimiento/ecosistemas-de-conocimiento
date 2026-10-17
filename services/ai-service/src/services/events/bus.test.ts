/**
 * M3 Step 5 — bus tests.
 *
 * Fixtures use ai-service event shapes (`org` / `project?`).
 *
 * Covers:
 *  - typed emit + receive
 *  - `off` removes a listener
 *  - the unsubscribe fn returned by `on`
 *  - `onAny` wildcard catches every event
 *  - compile-time narrowing (the `// @ts-expect-error` lines below MUST stay
 *    illegal — if a field is dropped, the assertion flips and the file fails
 *    to compile)
 *  - `listenerCount`
 *  - `resetEventBusForTests` clears the singleton
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createEventBus,
  getEventBus,
  resetEventBusForTests,
} from './bus.js';
import type { AppEvent } from './types.js';

describe('EventBus', () => {
  it('emits a typed event to a per-type listener (ai-service shape)', () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.on('trace.started', handler);
    bus.emit({
      type: 'trace.started',
      traceId: 't1',
      org: 'org-appmx',
      project: 'proj-1',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'trace.started',
      traceId: 't1',
      org: 'org-appmx',
      project: 'proj-1',
    });
  });

  it('omitting the optional `project` field still compiles & dispatches', () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.on('trace.started', handler);
    bus.emit({
      type: 'trace.started',
      traceId: 't-no-project',
      org: 'org-x',
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('narrows event type inside the handler (generation.job.completed → flags)', () => {
    const bus = createEventBus();
    let captured: { jobId: string; flagCount: number; costUsd: number } | null =
      null;

    bus.on('generation.job.completed', (event) => {
      // event is narrowed to the generation.job.completed variant:
      // `flags` and `costUsd` are statically known on this variant. No `as`.
      captured = {
        jobId: event.jobId,
        flagCount: event.flags.length,
        costUsd: event.costUsd,
      };
    });

    bus.emit({
      type: 'generation.job.completed',
      requestId: 'req-1',
      jobId: 'job-1',
      unitKey: 'unit-a',
      org: 'org-1',
      project: 'proj-1',
      flags: [
        { severity: 'warning', code: 'soft-budget', message: 'near cap' },
      ],
      costUsd: 0.0012,
    });

    expect(captured).toEqual({
      jobId: 'job-1',
      flagCount: 1,
      costUsd: 0.0012,
    });
  });

  it('fans out to multiple listeners on the same type', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();

    bus.on('generation.job.started', a);
    bus.on('generation.job.started', b);
    bus.on('generation.job.started', c);

    bus.emit({
      type: 'generation.job.started',
      requestId: 'req-1',
      jobId: 'job-1',
      unitKey: 'unit-a',
      org: 'org-1',
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('onAny catches events of every type', () => {
    const bus = createEventBus();
    const wildcard = vi.fn();

    bus.onAny(wildcard);

    bus.emit({
      type: 'trace.started',
      traceId: 't1',
      org: 'o',
    });
    bus.emit({
      type: 'generation.request.cancelled',
      requestId: 'req-1',
      org: 'o',
      project: 'p',
    });
    bus.emit({
      type: 'trace.failed',
      traceId: 't2',
      org: 'o',
      errorCode: 'rate_limited',
    });

    expect(wildcard).toHaveBeenCalledTimes(3);
    const firstCall = wildcard.mock.calls[0]?.[0] as AppEvent;
    expect(firstCall.type).toBe('trace.started');
  });

  it('off removes only the specified listener; others keep firing', () => {
    const bus = createEventBus();
    const keep = vi.fn();
    const drop = vi.fn();

    bus.on('trace.failed', keep);
    bus.on('trace.failed', drop);

    bus.off('trace.failed', drop);

    bus.emit({
      type: 'trace.failed',
      traceId: 't1',
      org: 'o',
      errorCode: 'rate_limited',
    });

    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it('the unsubscribe fn returned by on() removes that listener', () => {
    const bus = createEventBus();
    const handler = vi.fn();

    const unsubscribe = bus.on('generation.request.cancelled', handler);
    unsubscribe();

    bus.emit({
      type: 'generation.request.cancelled',
      requestId: 'req-1',
      org: 'o',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('the unsubscribe fn returned by onAny removes the wildcard listener', () => {
    const bus = createEventBus();
    const wildcard = vi.fn();

    const unsubscribe = bus.onAny(wildcard);
    unsubscribe();

    bus.emit({
      type: 'trace.started',
      traceId: 't',
      org: 'o',
    });

    expect(wildcard).not.toHaveBeenCalled();
  });

  it('listenerCount reflects registered handlers per type and wildcard', () => {
    const bus = createEventBus();

    expect(bus.listenerCount('trace.started')).toBe(0);
    expect(bus.listenerCount()).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    const w = vi.fn();

    const unsub1 = bus.on('trace.started', h1);
    bus.on('trace.started', h2);
    bus.onAny(w);

    expect(bus.listenerCount('trace.started')).toBe(2);
    expect(bus.listenerCount()).toBe(1);
    expect(bus.listenerCount('trace.completed')).toBe(0);

    unsub1();
    expect(bus.listenerCount('trace.started')).toBe(1);
  });

  it('resetEventBusForTests clears the singleton', () => {
    resetEventBusForTests();
    const first = getEventBus();
    const sameAsFirst = getEventBus();
    expect(sameAsFirst).toBe(first);

    resetEventBusForTests();
    const second = getEventBus();
    expect(second).not.toBe(first);

    resetEventBusForTests();
  });

  it('rejects malformed emits at the type level', () => {
    const bus = createEventBus();

    // Sanity: a well-formed emit compiles.
    bus.emit({
      type: 'trace.started',
      traceId: 't',
      org: 'o',
    });

    // Missing required fields → must not compile.
    // @ts-expect-error trace.started requires traceId + org
    bus.emit({ type: 'trace.started' });

    // Wrong-type value → must not compile.
    // Single-line so the @ts-expect-error directive lands on the offending tok.
    // prettier-ignore
    // @ts-expect-error totalCostUsd must be number, not string
    bus.emit({ type: 'trace.completed', traceId: 't', org: 'o', totalCostUsd: 'free' });

    // Unknown event type → must not compile.
    // @ts-expect-error 'totally.fake.event' is not in AppEvent union
    bus.emit({ type: 'totally.fake.event' });

    // An event shaped orgId/userId must not compile.
    // @ts-expect-error ai-service uses `org`, not `orgId` + `userId`
    bus.emit({ type: 'trace.started', traceId: 't', orgId: 'o', userId: 'u' });
  });
});
