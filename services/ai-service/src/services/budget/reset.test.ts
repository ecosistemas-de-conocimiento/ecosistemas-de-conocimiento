// Unit tests for the pure budget-reset boundary math in `reset.ts`.
//
// No DB — every test is a direct function call. Time-zone math is the
// trickiest part; the suite picks `America/Mexico_City` (CST = UTC-6 in
// the timestamps tested; CDT = UTC-5 during DST) because that's the
// non-UTC consumer ai-service actually serves today.

import { describe, expect, it } from 'vitest';

import { computeNextResetAt, shouldResetNow } from './reset.js';

describe('computeNextResetAt — monthly_anniversary', () => {
  it('anchor day 15 in America/Mexico_City; called on 2026-05-10 → 2026-05-15 06:00 UTC', () => {
    // 2026-05-10 12:00 UTC. CST is UTC-6 (no DST in Mexico City as of
    // 2022's permanent-standard-time switch), so 2026-05-15 00:00 CST =
    // 2026-05-15 06:00 UTC.
    const now = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    const next = computeNextResetAt(now, 'monthly_anniversary', 15, 'America/Mexico_City');
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-15T06:00:00.000Z');
  });

  it('anchor day 15 in America/Mexico_City; called on 2026-05-16 → next is 2026-06-15 06:00 UTC', () => {
    const now = new Date(Date.UTC(2026, 4, 16, 12, 0, 0));
    const next = computeNextResetAt(now, 'monthly_anniversary', 15, 'America/Mexico_City');
    expect(next!.toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });

  it('anchor day 1 in UTC; called on 2026-05-15 → 2026-06-01 00:00 UTC', () => {
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const next = computeNextResetAt(now, 'monthly_anniversary', 1, 'UTC');
    expect(next!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('clamps anchorDay to 1..28 (anchor 31 → 28)', () => {
    const now = new Date(Date.UTC(2026, 0, 5, 0, 0, 0));
    const next = computeNextResetAt(now, 'monthly_anniversary', 31, 'UTC');
    expect(next!.toISOString()).toBe('2026-01-28T00:00:00.000Z');
  });
});

describe('computeNextResetAt — monthly_calendar', () => {
  it('called on 2026-05-31 → 2026-06-01 00:00 UTC', () => {
    const now = new Date(Date.UTC(2026, 4, 31, 23, 0, 0));
    const next = computeNextResetAt(now, 'monthly_calendar', 1, 'UTC');
    expect(next!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('called on 2026-12-30 → 2027-01-01 00:00 UTC (year wrap)', () => {
    const now = new Date(Date.UTC(2026, 11, 30, 12, 0, 0));
    const next = computeNextResetAt(now, 'monthly_calendar', 1, 'UTC');
    expect(next!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('computeNextResetAt — weekly', () => {
  it("called on a Wednesday (2026-05-13 UTC) → next Monday 2026-05-18 00:00 UTC", () => {
    // 2026-05-13 is a Wednesday.
    const now = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
    const next = computeNextResetAt(now, 'weekly', 1, 'UTC');
    expect(next!.toISOString()).toBe('2026-05-18T00:00:00.000Z');
  });

  it('called on a Monday → next Monday (7 days later)', () => {
    // 2026-05-11 is a Monday.
    const now = new Date(Date.UTC(2026, 4, 11, 12, 0, 0));
    const next = computeNextResetAt(now, 'weekly', 1, 'UTC');
    expect(next!.toISOString()).toBe('2026-05-18T00:00:00.000Z');
  });
});

describe('computeNextResetAt — never', () => {
  it("returns null", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
    expect(computeNextResetAt(now, 'never', 1, 'UTC')).toBeNull();
  });
});

describe('shouldResetNow', () => {
  it('now < nextResetAt → no reset, nextResetAt unchanged', () => {
    const now = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    const next = new Date(Date.UTC(2026, 4, 15, 0, 0, 0));
    const out = shouldResetNow(
      {
        lastResetAt: null,
        nextResetAt: next,
        cadence: 'monthly_anniversary',
        anchorDay: 15,
        tz: 'UTC',
      },
      now,
    );
    expect(out.shouldReset).toBe(false);
    expect(out.nextResetAt!.toISOString()).toBe(next.toISOString());
  });

  it('now >= nextResetAt → reset, new boundary computed', () => {
    const now = new Date(Date.UTC(2026, 4, 16, 12, 0, 0));
    const out = shouldResetNow(
      {
        lastResetAt: null,
        nextResetAt: new Date(Date.UTC(2026, 4, 15, 0, 0, 0)),
        cadence: 'monthly_anniversary',
        anchorDay: 15,
        tz: 'UTC',
      },
      now,
    );
    expect(out.shouldReset).toBe(true);
    expect(out.nextResetAt!.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it("'never' cadence → never resets regardless of nextResetAt", () => {
    const now = new Date(Date.UTC(2030, 0, 1, 0, 0, 0));
    const out = shouldResetNow(
      {
        lastResetAt: null,
        nextResetAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 0)),
        cadence: 'never',
        anchorDay: 1,
        tz: 'UTC',
      },
      now,
    );
    expect(out.shouldReset).toBe(false);
    expect(out.nextResetAt).toBeNull();
  });

  it('null nextResetAt + cadence != never → no reset but computes a boundary', () => {
    const now = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    const out = shouldResetNow(
      {
        lastResetAt: null,
        nextResetAt: null,
        cadence: 'monthly_anniversary',
        anchorDay: 15,
        tz: 'UTC',
      },
      now,
    );
    expect(out.shouldReset).toBe(false);
    expect(out.nextResetAt!.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });
});
