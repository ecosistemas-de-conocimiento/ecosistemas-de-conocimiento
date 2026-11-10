/**
 * THE SCHEDULING HALF OF A JANITOR, extracted once the third copy appeared.
 *
 * `transcriptionJanitor.ts`, `publishJanitor.ts` and `embeddingJanitor.ts` each
 * owned an identical ~55 lines: read an `*_ENABLED` var, read an
 * `*_INTERVAL_MIN` var, hold a module-level timer, arm it, catch whatever the
 * sweep threw, and clear it again. Only the strings differed. Three copies of a
 * try/catch is three places for a future fix to be applied twice.
 *
 * ⚠ WHAT IS NOT SHARED, AND MUST NOT BE. The three SWEEPS do genuinely
 * different work — different collections' fields, different deadlines,
 * different Spanish messages, and in one case a status change the other two
 * deliberately refuse. This file schedules a callback; it knows nothing about
 * documents.
 *
 * ⚠ EACH JANITOR KEEPS ITS OWN ENV VAR NAMES. The helper is handed the names,
 * never a prefix it expands, so nothing an operator may already have set in a
 * deployment is renamed by this refactor.
 *
 * The `sessionJanitorScheduler.ts` deliberately stays separate: it is opt-in
 * rather than on-by-default, and it logs on a re-arm. Folding it in would mean
 * options that exist for one caller.
 */

import type { Payload } from 'payload'

import { safeErrMessage } from './errorSummary'

/**
 * Read an `*_JANITOR_ENABLED` var. ON when unset — these sweeps turn an
 * invisible non-terminal state into a visible one. The session janitor, which
 * DELETES data, is the opposite and is opt-in.
 */
export function janitorEnabledFromEnv(varName: string): boolean {
  const raw = (process.env[varName] ?? '').trim().toLowerCase()
  if (!raw) return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

/**
 * Read an `*_JANITOR_INTERVAL_MIN` var, in ms. Unparseable or non-positive
 * falls back to the caller's default, with a floor of one minute: a sub-minute
 * sweep is a query loop, not a janitor.
 */
export function janitorIntervalMsFromEnv(varName: string, defaultMin: number): number {
  const raw = Number(process.env[varName])
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : defaultMin
  return Math.max(1, minutes) * 60_000
}

/**
 * 🔴 SET ONLY BY THE BACKEND'S TEST SETUP (`vitest.setup.ts`), never in a
 * deployment. While it is `1`, no janitor arms: a test file that boots Payload
 * would otherwise run real sweeps against its database, 2 min in. A test of a
 * janitor clears it first (`lib/testing/janitors.ts`, `allowJanitors`).
 */
export const JANITORS_DISABLED_VAR = 'EDC_JANITORS_DISABLED'

export function janitorsDisabledForTests(): boolean {
  return process.env[JANITORS_DISABLED_VAR] === '1'
}

/** Shared by every janitor here: minutes from boot to the first sweep. */
export const JANITOR_FIRST_SWEEP_MIN_VAR = 'JANITOR_FIRST_SWEEP_MIN'
/**
 * 2 min: inferred, not measured. Past the boot's own work (migrations, the
 * budget check) and short enough that a backend restarted several times a day
 * still sweeps. Before 2026-11-10 the first sweep waited a whole interval, and
 * a daily janitor on a process that restarts more than once a day never ran.
 */
export const JANITOR_FIRST_SWEEP_DEFAULT_MIN = 2

/**
 * Delay to the first sweep, in ms: `JANITOR_FIRST_SWEEP_MIN` (unparseable or
 * negative falls back to the default; `0` sweeps on the next tick), never
 * longer than the janitor's own interval.
 */
export function janitorFirstSweepMs(intervalMs: number): number {
  const raw = Number(process.env[JANITOR_FIRST_SWEEP_MIN_VAR])
  const minutes = process.env[JANITOR_FIRST_SWEEP_MIN_VAR]?.trim() && Number.isFinite(raw) && raw >= 0 ? raw : JANITOR_FIRST_SWEEP_DEFAULT_MIN
  return Math.min(minutes * 60_000, intervalMs)
}

/** Everything a janitor has to say about itself for the scheduler to run it. */
export interface JanitorSchedule {
  /** Log tag, e.g. `embedding-janitor`. Also the key this janitor's timer is held under. */
  prefix: string
  /** The env var named in the "disabled" log line, so the operator is told the switch. */
  enabledVar: string
  enabled(): boolean
  intervalMs(): number
  /** What NOT running this sweep costs, in one sentence. Appended to the disabled line. */
  disabledDetail: string
  /** Extra fields on the "armed" line, alongside `intervalMinutes`. */
  armedContext?(): Record<string, unknown>
  /** One pass. It logs its own outcome; the scheduler only catches what it throws. */
  sweep(payload: Payload): Promise<void>
}

/** One timer per janitor, keyed by prefix (the first-sweep timeout, then the interval). Two janitors must not share a slot. */
const timers = new Map<string, { first?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>()

/**
 * Arm a janitor's sweep. Idempotent: a second call is a no-op while a timer is
 * already armed. Returns true if armed (or already armed), false if disabled.
 *
 * The first sweep runs {@link janitorFirstSweepMs} after boot (2 min by
 * default), not the instant the process comes up, then every interval. Every
 * sweep here acts only on rows past its own deadline (stuck 30 min, 30 days…),
 * so a sweep soon after a restart finds the same rows a later one would. The
 * timers are unref'd so they never keep the process alive on its own.
 *
 * ⚠ THE TRY/CATCH IS THE REASON THIS IS SHARED. A sweep that throws must not
 * kill the interval; without the catch, one bad pass silently disarms the
 * janitor for the life of the process and nothing says so.
 */
export function startJanitor(payload: Payload, schedule: JanitorSchedule): boolean {
  if (janitorsDisabledForTests()) return false
  if (!schedule.enabled()) {
    payload.logger.info(
      `[${schedule.prefix}] disabled by ${schedule.enabledVar}. ${schedule.disabledDetail}`,
    )
    return false
  }
  if (timers.has(schedule.prefix)) return true

  const intervalMs = schedule.intervalMs()
  const firstMs = janitorFirstSweepMs(intervalMs)
  payload.logger.info(
    { intervalMinutes: intervalMs / 60_000, ...(schedule.armedContext?.() ?? {}) },
    `[${schedule.prefix}] armed`,
  )

  const pass = () => {
    void (async () => {
      try {
        await schedule.sweep(payload)
      } catch (err) {
        payload.logger.error(
          { err: safeErrMessage(err) },
          `[${schedule.prefix}] sweep threw (will retry next interval)`,
        )
      }
    })()
  }
  const slot: { first?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> } = {}
  slot.first = setTimeout(() => {
    slot.first = undefined
    pass()
    slot.every = setInterval(pass, intervalMs)
    if (typeof slot.every.unref === 'function') slot.every.unref()
  }, firstMs)
  if (typeof slot.first.unref === 'function') slot.first.unref()
  timers.set(schedule.prefix, slot)

  return true
}

/** The prefixes armed in this process. For the test that no janitor arms in a test run. */
export function armedJanitors(): string[] {
  return [...timers.keys()]
}

/** Stop a janitor's interval (used by tests / graceful shutdown). */
export function stopJanitor(prefix: string): void {
  const slot = timers.get(prefix)
  if (slot) {
    clearTimeout(slot.first)
    clearInterval(slot.every)
    timers.delete(prefix)
  }
}
