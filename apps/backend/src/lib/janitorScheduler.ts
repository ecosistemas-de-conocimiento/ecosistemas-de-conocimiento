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

/** One timer per janitor, keyed by prefix. Two janitors must not share a slot. */
const timers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Arm a janitor's sweep. Idempotent: a second call is a no-op while a timer is
 * already armed. Returns true if armed (or already armed), false if disabled.
 *
 * The first sweep does NOT run at boot — we wait one interval, so a deploy
 * never fails or stamps anything the instant it comes up. The interval is
 * unref'd so it never keeps the process alive on its own.
 *
 * ⚠ THE TRY/CATCH IS THE REASON THIS IS SHARED. A sweep that throws must not
 * kill the interval; without the catch, one bad pass silently disarms the
 * janitor for the life of the process and nothing says so.
 */
export function startJanitor(payload: Payload, schedule: JanitorSchedule): boolean {
  if (!schedule.enabled()) {
    payload.logger.info(
      `[${schedule.prefix}] disabled by ${schedule.enabledVar}. ${schedule.disabledDetail}`,
    )
    return false
  }
  if (timers.has(schedule.prefix)) return true

  const intervalMs = schedule.intervalMs()
  payload.logger.info(
    { intervalMinutes: intervalMs / 60_000, ...(schedule.armedContext?.() ?? {}) },
    `[${schedule.prefix}] armed`,
  )

  const timer = setInterval(() => {
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
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  timers.set(schedule.prefix, timer)

  return true
}

/** Stop a janitor's interval (used by tests / graceful shutdown). */
export function stopJanitor(prefix: string): void {
  const timer = timers.get(prefix)
  if (timer) {
    clearInterval(timer)
    timers.delete(prefix)
  }
}
