// Budget-reset boundary math. Pure functions — no DB. Wired into
// `BudgetEnforcer.reserve` for lazy reset on every call (no cron).
//
// See `plan/budget-reset-followup.md`: four cadences
// are supported, per-org timezone is IANA, and reset is "lazy" — the next
// reserve crosses the boundary, the reset happens inline.
//
// Why no external date library: ai-service has a strict "no new deps"
// rule for this work item, and the boundary math we need (compute "next
// 00:00 in TZ X on day Y of next month, returned as a UTC Date") is
// expressible with `Intl.DateTimeFormat({ timeZone })` alone. The trick
// (see `tzOffsetMs`): format the candidate UTC instant in the target TZ,
// parse the wall-clock back, and the difference between that wall-clock
// and the original UTC instant is exactly the TZ offset at that moment
// (handles DST automatically because we re-evaluate per candidate).

export type ResetCadence =
  | 'monthly_calendar'
  | 'monthly_anniversary'
  | 'weekly'
  | 'never';

export interface ResetCheck {
  shouldReset: boolean;
  /** New boundary to write back; null when cadence is 'never'. */
  nextResetAt: Date | null;
}

interface BudgetStateForReset {
  lastResetAt: Date | null;
  nextResetAt: Date | null;
  cadence: string;
  anchorDay: number;
  tz: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** UTC offset in ms for `instant` evaluated in `tz`. Positive ⇒ TZ is ahead
 *  of UTC; negative ⇒ behind. Handles DST per-instant. */
function tzOffsetMs(instant: Date, tz: string): number {
  // `Intl.DateTimeFormat` formatToParts gives us the wall-clock components
  // in the target TZ; reassemble as a UTC Date and the difference from
  // `instant` is the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const year = Number(parts['year']);
  const month = Number(parts['month']);
  const day = Number(parts['day']);
  // Intl returns hour 24 at midnight in some locales/TZ combinations; clamp.
  let hour = Number(parts['hour']);
  if (hour === 24) hour = 0;
  const minute = Number(parts['minute']);
  const second = Number(parts['second']);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return wallAsUtc - instant.getTime();
}

/** Build a UTC Date that, when rendered in `tz`, lands on
 *  `Y-M-D 00:00:00` exactly. Iterates once because the offset at the
 *  candidate instant may differ from the offset at a naive UTC midnight
 *  (DST boundary). Two passes converges in all practical cases. */
function zonedMidnightToUtc(
  year: number,
  monthOneBased: number,
  day: number,
  tz: string,
): Date {
  // First pass: pretend the desired wall-clock is UTC, then subtract the
  // TZ offset we observe at that pretend instant.
  let candidateMs = Date.UTC(year, monthOneBased - 1, day, 0, 0, 0);
  let offset = tzOffsetMs(new Date(candidateMs), tz);
  candidateMs -= offset;
  // Re-evaluate offset at the corrected instant (DST jump check).
  offset = tzOffsetMs(new Date(candidateMs), tz);
  // Reconstruct from the corrected offset.
  return new Date(Date.UTC(year, monthOneBased - 1, day, 0, 0, 0) - offset);
}

/** Wall-clock {year, month, day, weekday} for `instant` in `tz`. */
function zonedParts(instant: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sun..6=Sat (matches Date.getUTCDay)
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    weekday: weekdayMap[parts['weekday'] ?? 'Sun'] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the next reset boundary in UTC for the given cadence/anchor/tz,
 * strictly after `now`. `'never'` ⇒ null.
 *
 *  - `'monthly_calendar'` — next 1st of the month at 00:00 in `tz`
 *    (typically UTC, but `tz` is honoured if a consumer sets it).
 *  - `'monthly_anniversary'` — next instance of `anchorDay` (1–28) at
 *    00:00 in `tz`; if today's wall-clock in `tz` is on or after that
 *    day already this month, advance to next month.
 *  - `'weekly'` — next Monday 00:00 in `tz`.
 *  - `'never'` — null.
 */
export function computeNextResetAt(
  now: Date,
  cadence: string,
  anchorDay: number,
  tz: string,
): Date | null {
  if (cadence === 'never') return null;

  const parts = zonedParts(now, tz);

  if (cadence === 'monthly_calendar') {
    // Next 1st-of-month at 00:00 in tz.
    let year = parts.year;
    let month = parts.month + 1; // next month
    if (month > 12) {
      month = 1;
      year += 1;
    }
    return zonedMidnightToUtc(year, month, 1, tz);
  }

  if (cadence === 'monthly_anniversary') {
    const safeAnchor = Math.min(Math.max(Math.floor(anchorDay), 1), 28);
    // If the wall-clock day in `tz` is strictly before the anchor,
    // boundary is this month at the anchor; otherwise advance one month.
    let year = parts.year;
    let month = parts.month;
    if (parts.day >= safeAnchor) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return zonedMidnightToUtc(year, month, safeAnchor, tz);
  }

  if (cadence === 'weekly') {
    // Next Monday 00:00 in tz.
    // weekday: 0=Sun..6=Sat. Monday=1. Days until next Monday:
    //   if weekday === 1 (already Monday), advance 7 days (next Monday).
    //   else (1 - weekday + 7) % 7, but treat 0 as 7.
    const w = parts.weekday;
    let daysAhead = (1 - w + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    // Build a UTC instant from the zoned-midnight base, then add days.
    const baseMidnight = zonedMidnightToUtc(parts.year, parts.month, parts.day, tz);
    return new Date(baseMidnight.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  }

  // Unknown cadence — fail open (treat as 'never'). Safer than blowing up
  // a reserve on a bad config row.
  return null;
}

/**
 * Decide whether the row's reset boundary has passed and compute the next
 * boundary if so. Both `nextResetAt` and `lastResetAt` may be null on a
 * freshly-bootstrapped row — in that case the caller already wrote a
 * boundary at bootstrap time, so a null `nextResetAt` here means "no
 * reset configured for this row" and we return `shouldReset: false`.
 */
export function shouldResetNow(state: BudgetStateForReset, now: Date): ResetCheck {
  if (state.cadence === 'never') {
    return { shouldReset: false, nextResetAt: null };
  }
  if (!state.nextResetAt) {
    // Bootstrap path or unconfigured. Compute a fresh boundary so the
    // caller can write it back, but don't reset.
    return {
      shouldReset: false,
      nextResetAt: computeNextResetAt(now, state.cadence, state.anchorDay, state.tz),
    };
  }
  if (now.getTime() < state.nextResetAt.getTime()) {
    return { shouldReset: false, nextResetAt: state.nextResetAt };
  }
  // Boundary passed — reset and roll the boundary forward.
  return {
    shouldReset: true,
    nextResetAt: computeNextResetAt(now, state.cadence, state.anchorDay, state.tz),
  };
}
