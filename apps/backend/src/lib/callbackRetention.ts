/**
 * THE DAILY PURGE OF CALLBACK BODIES (owner decision 2026-11-10).
 *
 * 🔴 `ai_service_callbacks.raw_body` HAD NO PLAZO. The ledger scrubs a
 * transcript, a title and a filename on the way in (`ledgerBody` in
 * `app/api/ai-service/callback/route.ts`), but what is left (ids, chunk counts,
 * error text) stayed forever. After `CALLBACK_RETENTION_DAYS` the body is set
 * to NULL.
 *
 * ⚠ THE ROW STAYS. It IS the dedupe: the receiver's INSERT conflicting on
 * `ai_service_callbacks_natural_key_unq` (correlation_key, event_key, event) is
 * what turns a retry into "already processed". Deleting old rows would let a
 * late retry run its dispatch a second time; nulling the body keeps the key and
 * drops the content. The row is three ids and a date.
 *
 *   CALLBACK_RETENTION_JANITOR_ENABLED       on unless 0/false/off/no
 *   CALLBACK_RETENTION_JANITOR_INTERVAL_MIN  default 1440 (daily)
 *   CALLBACK_RETENTION_DAYS                  default 30
 *
 * No inference calls: one UPDATE.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'

import { janitorEnabledFromEnv, janitorIntervalMsFromEnv, startJanitor, stopJanitor } from './janitorScheduler'

export const CALLBACK_RETENTION_JANITOR_PREFIX = 'callback-retention-janitor'
export const CALLBACK_RETENTION_JANITOR_ENABLED_VAR = 'CALLBACK_RETENTION_JANITOR_ENABLED'
export const CALLBACK_RETENTION_JANITOR_INTERVAL_VAR = 'CALLBACK_RETENTION_JANITOR_INTERVAL_MIN'
export const CALLBACK_RETENTION_DAYS_VAR = 'CALLBACK_RETENTION_DAYS'
export const CALLBACK_RETENTION_JANITOR_DEFAULT_MIN = 1440
export const CALLBACK_RETENTION_DEFAULT_DAYS = 30

/** Days a body is kept. Unparseable or under one day falls back to the default. */
export function callbackRetentionDaysFromEnv(): number {
  const raw = Number(process.env[CALLBACK_RETENTION_DAYS_VAR])
  return Number.isFinite(raw) && raw >= 1 ? raw : CALLBACK_RETENTION_DEFAULT_DAYS
}

export interface CallbackRetentionPayload {
  db: { drizzle: { execute(query: unknown): Promise<unknown> } }
}

/** One pass: NULL every body received before `now - days`. Returns how many. */
export async function purgeCallbackBodies(
  payload: CallbackRetentionPayload,
  days: number = callbackRetentionDaysFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
  const result = await payload.db.drizzle.execute(
    sql`UPDATE ai_service_callbacks SET raw_body = NULL, updated_at = ${now.toISOString()} WHERE received_at < ${cutoff} AND raw_body IS NOT NULL RETURNING id`,
  )
  const r = result as { rowCount?: unknown; rows?: unknown } | null
  if (typeof r?.rowCount === 'number') return r.rowCount
  return Array.isArray(r?.rows) ? r.rows.length : 0
}

export function startCallbackRetentionJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: CALLBACK_RETENTION_JANITOR_PREFIX,
    enabledVar: CALLBACK_RETENTION_JANITOR_ENABLED_VAR,
    enabled: () => janitorEnabledFromEnv(CALLBACK_RETENTION_JANITOR_ENABLED_VAR),
    intervalMs: () =>
      janitorIntervalMsFromEnv(CALLBACK_RETENTION_JANITOR_INTERVAL_VAR, CALLBACK_RETENTION_JANITOR_DEFAULT_MIN),
    disabledDetail: 'Callback bodies stay in ai_service_callbacks.raw_body with no time limit.',
    armedContext: () => ({ retentionDays: callbackRetentionDaysFromEnv() }),
    sweep: async (p) => {
      const purged = await purgeCallbackBodies(p as unknown as CallbackRetentionPayload)
      p.logger.info({ purged }, `[${CALLBACK_RETENTION_JANITOR_PREFIX}] swept`)
    },
  })
}

/** Test seam / graceful shutdown. */
export function stopCallbackRetentionJanitor(): void {
  stopJanitor(CALLBACK_RETENTION_JANITOR_PREFIX)
}
