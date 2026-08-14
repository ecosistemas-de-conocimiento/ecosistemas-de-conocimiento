// Unit tests for the combined disconnect+timeout signal helper.
//
// No mocks needed: this is pure runtime behaviour around AbortSignal.any /
// setTimeout. We use fake timers to fire the wall-clock backstop deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withRequestTimeout } from './timeout-signal.js';

describe('withRequestTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts on the wall-clock deadline and reports cause=timeout', () => {
    const d = withRequestTimeout(undefined, 1000);
    expect(d.signal.aborted).toBe(false);
    expect(d.cause()).toBe('unknown');

    vi.advanceTimersByTime(1000);

    expect(d.signal.aborted).toBe(true);
    expect(d.cause()).toBe('timeout');
    d.dispose();
  });

  it('aborts when the inbound (disconnect) signal fires and reports cause=disconnect', () => {
    const inbound = new AbortController();
    const d = withRequestTimeout(inbound.signal, 60_000);

    inbound.abort();

    expect(d.signal.aborted).toBe(true);
    expect(d.cause()).toBe('disconnect');
    d.dispose();
  });

  it('races: inbound disconnect BEFORE the deadline wins as cause=disconnect', () => {
    const inbound = new AbortController();
    const d = withRequestTimeout(inbound.signal, 5000);

    inbound.abort();
    // Advancing past the deadline must not flip the recorded cause: the
    // combined signal already latched the disconnect reason.
    vi.advanceTimersByTime(10_000);

    expect(d.signal.aborted).toBe(true);
    expect(d.cause()).toBe('disconnect');
    d.dispose();
  });

  it('dispose() clears the backstop timer so it never fires afterwards', () => {
    const d = withRequestTimeout(undefined, 1000);
    d.dispose();

    vi.advanceTimersByTime(5000);

    expect(d.signal.aborted).toBe(false);
    expect(d.cause()).toBe('unknown');
  });

  it('timeout disabled (ms <= 0) passes the inbound signal through unchanged', () => {
    const inbound = new AbortController();
    const d = withRequestTimeout(inbound.signal, 0);

    expect(d.signal).toBe(inbound.signal);
    vi.advanceTimersByTime(10_000);
    expect(d.signal.aborted).toBe(false);

    inbound.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.cause()).toBe('disconnect');
  });

  it('timeout disabled with no inbound signal yields a never-aborting signal', () => {
    const d = withRequestTimeout(undefined, 0);
    vi.advanceTimersByTime(10_000);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });
});
