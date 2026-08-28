/**
 * Session/message janitor.
 *
 * The ONLY unbounded-growth path in the chat system: a conversation thread
 * (`sessions`) plus its `messages` + uploaded-doc `documents` and the
 * associated ai-service corpus live forever unless a user manually deletes the
 * session. This sweep reaps "stale" sessions on a schedule.
 *
 * Cascade contract (do NOT bypass):
 *   - 🔴 NOTHING CASCADES. This block used to claim `messages` and `documents`
 *     were removed by `ON DELETE CASCADE` in "migration 20260519_010000". That
 *     migration no longer exists (squashed into the baseline) and the claim was
 *     never true of the schema that shipped. Verified against the live
 *     database, so a reader can stop guessing:
 *
 *       messages.session_id → sessions.id   ON DELETE SET NULL
 *       ratings.session_id  → sessions.id   ON DELETE SET NULL
 *       documents_rels.sessions_id → sessions.id   ON DELETE CASCADE
 *
 *     So reaping a conversation ORPHANS its messages and ratings — the rows
 *     survive with a null `session`. ⚠ That is unbounded growth this sweep does
 *     NOT reclaim, which matters because reclaiming it is the sweep's entire
 *     purpose. Whether to start deleting them is an OPEN PRODUCT DECISION; do
 *     not add cascade behaviour here on your own initiative.
 *
 *     `documents` are the one deliberate exception, and the cascade there does
 *     NOT delete documents. `documents.session` is a `hasMany` relationship, so
 *     the attachment lives in the `documents_rels` join table; deleting a
 *     conversation deletes the ATTACHMENT ROW and leaves the document standing.
 *     That is the intended contract — a document belongs to the ecosistema and
 *     to its uploader, and it outlives every conversation it was attached to.
 *     See `collections/Sessions.ts`, which is the comment that always matched
 *     reality.
 *   - 🔴 NO CORPUS IS DELETED. It used to be: back when there was one corpus
 *     per conversation, `Sessions.afterDelete` dropped it. Under the ecosistema
 *     model the corpora are `eco-{orgId}` and `eco-{orgId}-draft-{userId}`,
 *     SHARED by every session — so reaping one stale conversation would take an
 *     entire ecosistema's knowledgebase with it, on a schedule, at 3am. Do not
 *     re-add corpus cleanup here. `sessionJanitor.test.ts` guards it.
 *   - We still delete through Payload's `payload.delete({ collection:
 *     'sessions', id })` rather than raw SQL, so any future `afterDelete` hook
 *     fires exactly as it does for a manual user delete.
 *
 * Stale definition: a session is stale when its activity timestamp is older
 * than `ttlDays`. Activity timestamp = `lastUsedAt` when present (bumped by the
 * chat FE on every turn), else `updatedAt` (Payload always maintains it). A
 * session with neither (shouldn't happen) is treated as NOT stale — we never
 * reap a row we can't date.
 *
 * Safety:
 *   - Disabled by default (`SESSION_JANITOR_ENABLED` must be `true`).
 *   - `dryRun` logs what it WOULD delete without deleting.
 *   - Paged (`batchSize`), never loads the whole table.
 *   - A single per-session delete failure is logged and the sweep continues.
 *   - A module-level lock prevents overlapping runs in the same process.
 */

import type { Payload, Where } from 'payload'

export interface JanitorConfig {
  /** Sessions idle longer than this many days are reaped. */
  ttlDays: number
  /** Page size for both the find query and the per-batch delete loop. */
  batchSize: number
  /** When true, log candidates but do not delete. */
  dryRun: boolean
  /**
   * Hard cap on sessions deleted in a single sweep (defence-in-depth against a
   * mis-set TTL nuking the table). 0 = unlimited. Default unlimited; the
   * scheduler sets a sane cap.
   */
  maxDeletesPerRun: number
}

export interface JanitorResult {
  evaluated: number
  deleted: number
  failed: number
  dryRun: boolean
  /** Cutoff instant; sessions with activity strictly before this are stale. */
  cutoff: string
  /** True if the run was skipped because another run holds the lock. */
  skippedLocked: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** In-process, non-reentrant lock. Prevents an interval tick from overlapping a
 * still-running sweep (e.g. a slow ai-service making corpus deletes drag). */
let running = false

export const DEFAULTS: JanitorConfig = {
  ttlDays: 90,
  batchSize: 50,
  dryRun: false,
  maxDeletesPerRun: 0,
}

/**
 * Resolve the janitor config from the environment. Pure; no side effects.
 *
 *   SESSION_JANITOR_ENABLED   '1' | 'true' to enable scheduling (default off)
 *   SESSION_TTL_DAYS          integer days of inactivity before reap (default 90)
 *   SESSION_JANITOR_BATCH     page size (default 50)
 *   SESSION_JANITOR_DRY_RUN   '1' | 'true' to log-only (default false)
 *   SESSION_JANITOR_MAX       max deletes per run, 0 = unlimited (default 0)
 *   SESSION_JANITOR_INTERVAL_MIN  minutes between sweeps (default 1440 = daily)
 */
export function janitorConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): JanitorConfig {
  return {
    ttlDays: posInt(env.SESSION_TTL_DAYS, DEFAULTS.ttlDays),
    batchSize: posInt(env.SESSION_JANITOR_BATCH, DEFAULTS.batchSize),
    dryRun: isTrue(env.SESSION_JANITOR_DRY_RUN),
    maxDeletesPerRun: nonNegInt(env.SESSION_JANITOR_MAX, DEFAULTS.maxDeletesPerRun),
  }
}

export function janitorEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTrue(env.SESSION_JANITOR_ENABLED)
}

export function janitorIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const minutes = posInt(env.SESSION_JANITOR_INTERVAL_MIN, 1440)
  return minutes * 60 * 1000
}

/**
 * Compute the staleness cutoff. A session is stale iff its activity timestamp
 * is strictly before this instant. Exported for testing.
 */
export function staleCutoff(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() - ttlDays * DAY_MS)
}

/**
 * The Payload `where` that selects stale sessions: `lastUsedAt` before cutoff,
 * OR (`lastUsedAt` is null AND `updatedAt` before cutoff). This keeps the
 * activity-timestamp fallback (lastUsedAt → updatedAt) inside the DB query so
 * we page efficiently instead of post-filtering. Exported for testing.
 */
export function staleWhere(cutoff: Date): Where {
  const iso = cutoff.toISOString()
  return {
    or: [
      { lastUsedAt: { less_than: iso } },
      {
        and: [{ lastUsedAt: { exists: false } }, { updatedAt: { less_than: iso } }],
      },
    ],
  }
}

/**
 * `staleWhere` AND `id NOT IN excluded`. Used to walk the candidate set down
 * without re-seeing rows whose delete failed (which would loop forever).
 */
export function staleWhereExcluding(cutoff: Date, excluded: Set<number | string>): Where {
  const base = staleWhere(cutoff)
  if (excluded.size === 0) return base
  return {
    and: [base, { id: { not_in: [...excluded] } }],
  }
}

/**
 * Run one sweep. Idempotent and safe to call from a scheduler, an HTTP route,
 * or the `payload` CLI. Never throws for per-session delete failures — they are
 * logged and counted. Throws only for a catastrophic find error.
 */
export async function runSessionJanitor(
  payload: Payload,
  config: JanitorConfig,
  now: Date = new Date(),
): Promise<JanitorResult> {
  const cutoff = staleCutoff(now, config.ttlDays)
  const result: JanitorResult = {
    evaluated: 0,
    deleted: 0,
    failed: 0,
    dryRun: config.dryRun,
    cutoff: cutoff.toISOString(),
    skippedLocked: false,
  }

  if (running) {
    payload.logger.warn('[session-janitor] previous sweep still running; skipping this tick')
    result.skippedLocked = true
    return result
  }
  running = true

  payload.logger.info(
    {
      cutoff: result.cutoff,
      ttlDays: config.ttlDays,
      batchSize: config.batchSize,
      dryRun: config.dryRun,
      maxDeletesPerRun: config.maxDeletesPerRun || 'unlimited',
    },
    '[session-janitor] sweep start',
  )

  // IDs we've already counted this sweep. In a live run a delete removes the row
  // so re-querying never re-sees it; but a FAILED delete leaves the row in the
  // stale set, which would loop forever if we kept re-querying it. Excluding
  // every already-seen id (failed OR dry-run-counted) guarantees the candidate
  // set strictly shrinks each iteration — no infinite loop, no double counting.
  const seen = new Set<number | string>()

  try {
    for (;;) {
      const where = staleWhereExcluding(cutoff, seen)
      const found = await payload.find({
        collection: 'sessions',
        where,
        limit: config.batchSize,
        depth: 0,
        sort: 'createdAt',
        // The default access control is per-user; the janitor is a system task.
        overrideAccess: true,
        pagination: false,
      })

      if (found.docs.length === 0) break
      result.evaluated += found.docs.length

      for (const doc of found.docs) {
        const id = doc.id
        seen.add(id)
        const activity =
          (doc as { lastUsedAt?: string | null }).lastUsedAt ??
          (doc as { updatedAt?: string }).updatedAt ??
          null

        if (config.dryRun) {
          payload.logger.info(
            { sessionId: id, lastActivity: activity },
            '[session-janitor] WOULD delete stale session (dry run)',
          )
          result.deleted += 1
          if (atCap(config, result.deleted)) break
          continue
        }

        try {
          await payload.delete({
            collection: 'sessions',
            id,
            depth: 0,
            overrideAccess: true,
          })
          result.deleted += 1
          payload.logger.info(
            { sessionId: id, lastActivity: activity },
            '[session-janitor] deleted stale session',
          )
        } catch (err) {
          result.failed += 1
          payload.logger.error(
            { sessionId: id, err: err instanceof Error ? err.message : String(err) },
            '[session-janitor] failed to delete session (continuing)',
          )
        }

        if (atCap(config, result.deleted)) break
      }

      if (atCap(config, result.deleted)) break
    }
  } finally {
    running = false
  }

  payload.logger.info(
    {
      evaluated: result.evaluated,
      deleted: result.deleted,
      failed: result.failed,
      dryRun: result.dryRun,
    },
    '[session-janitor] sweep complete',
  )
  return result
}

function atCap(config: JanitorConfig, deleted: number): boolean {
  return config.maxDeletesPerRun > 0 && deleted >= config.maxDeletesPerRun
}

function isTrue(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

function posInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonNegInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Test-only reset of the in-process lock. */
export function __resetJanitorLock(): void {
  running = false
}
