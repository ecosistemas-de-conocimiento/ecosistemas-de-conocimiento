/**
 * Self-scheduling wrapper for the session janitor.
 *
 * Why setInterval-on-onInit rather than the Payload Jobs Queue:
 *   - this backend runs as a long-lived `next start` on Node (never serverless;
 *     the Bun footgun forbids `next start` under Bun anyway), so an in-process
 *     interval reliably fires.
 *   - The Payload Jobs Queue (tasks + `schedule` + `autoRun` cron) IS supported
 *     in 3.84.1, but enabling it requires `jobs.stats: true` plus the
 *     `payload-jobs` collection and `payload-jobs-stats` global — new tables and
 *     therefore new committed migrations (the app runs `payload migrate` on
 *     start, not push). That schema/migration footprint is not worth it for a
 *     single daily reaper. See the PR notes for the upgrade path.
 *
 * The core `runSessionJanitor` is a pure exportable function, so an external
 * cron or the `payload` CLI can drive the same sweep without this scheduler.
 *
 * Disabled by default: only arms when SESSION_JANITOR_ENABLED is truthy.
 */

import type { Payload } from 'payload'
import {
  janitorConfigFromEnv,
  janitorEnabled,
  janitorIntervalMs,
  runSessionJanitor,
} from './sessionJanitor'
import { safeErrMessage } from './errorSummary'
import { janitorsDisabledForTests } from './janitorScheduler'

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Arm the janitor interval. Idempotent: a second call is a no-op while a timer
 * is already armed. Returns true if armed (or already armed), false if disabled.
 *
 * The first sweep does NOT run at boot — we wait one interval so a deploy never
 * reaps data the instant it comes up. The interval is unref'd so it never keeps
 * the process alive on its own.
 */
export function startSessionJanitor(payload: Payload): boolean {
  // 🔴 Off in every test run unless the test asks (`lib/janitorScheduler.ts`).
  if (janitorsDisabledForTests()) return false
  if (!janitorEnabled()) {
    payload.logger.info(
      '[session-janitor] disabled (set SESSION_JANITOR_ENABLED=true to arm the daily sweep)',
    )
    return false
  }
  if (timer) {
    payload.logger.info('[session-janitor] already armed; skipping re-arm')
    return true
  }

  const intervalMs = janitorIntervalMs()
  payload.logger.info(
    { intervalMinutes: intervalMs / 60000, ...janitorConfigFromEnv() },
    '[session-janitor] armed',
  )

  timer = setInterval(() => {
    void sweepGuarded(payload)
  }, intervalMs)
  // Don't hold the event loop open purely for the janitor.
  if (typeof timer.unref === 'function') timer.unref()

  return true
}

/** Stop the interval (used by tests / graceful shutdown). */
export function stopSessionJanitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function sweepGuarded(payload: Payload): Promise<void> {
  try {
    await runSessionJanitor(payload, janitorConfigFromEnv())
  } catch (err) {
    payload.logger.error(
      { err: safeErrMessage(err) },
      '[session-janitor] sweep threw (will retry next interval)',
    )
  }
}
