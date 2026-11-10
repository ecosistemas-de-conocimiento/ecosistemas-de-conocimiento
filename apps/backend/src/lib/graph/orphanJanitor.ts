/**
 * THE DAILY ORPHAN SWEEP OF THE GRAPH (C-05, audit 2026-11-10).
 *
 * 🔴 A DELETED DOCUMENT LEFT ITS ENTITIES BEHIND. Mentions and relations go
 * with the document (ON DELETE cascade), but a `graph_entities` row (label,
 * aliases: the names themselves) stayed until someone ran the backfill by
 * hand. Its only callers were two CLIs. This puts {@link deleteOrphanEntities}
 * on a timer, one ecosistema at a time, with the sweep's own grace period
 * (`ORPHAN_GRACE_MS`) protecting an entity an in-flight extraction is reusing.
 *
 *   GRAPH_ORPHAN_JANITOR_ENABLED       on unless 0/false/off/no
 *   GRAPH_ORPHAN_JANITOR_INTERVAL_MIN  default 1440 (daily)
 *
 * No inference calls: it reads and deletes rows only.
 */
import type { Payload } from 'payload'

import { janitorEnabledFromEnv, janitorIntervalMsFromEnv, startJanitor, stopJanitor } from '@/lib/janitorScheduler'
import { errSummary } from '@/lib/errorSummary'

import { deleteOrphanEntities, type GraphBackfillPayload } from './backfill'

export const GRAPH_ORPHAN_JANITOR_PREFIX = 'graph-orphan-janitor'
export const GRAPH_ORPHAN_JANITOR_ENABLED_VAR = 'GRAPH_ORPHAN_JANITOR_ENABLED'
export const GRAPH_ORPHAN_JANITOR_INTERVAL_VAR = 'GRAPH_ORPHAN_JANITOR_INTERVAL_MIN'
export const GRAPH_ORPHAN_JANITOR_DEFAULT_MIN = 1440

export interface OrphanSweepResult {
  organizations: number
  deleted: number
  /** Ecosistemas whose sweep threw; the others still ran. */
  failed: number
}

/** One pass over every ecosistema. A failing one does not stop the rest. */
export async function sweepGraphOrphans(
  payload: GraphBackfillPayload,
  log: (line: string) => void = () => undefined,
): Promise<OrphanSweepResult> {
  const orgs = (await payload.find({
    collection: 'organizations',
    limit: 0,
    depth: 0,
    overrideAccess: true,
    sort: 'id',
  })) as { docs?: { id: number | string }[] }

  const result: OrphanSweepResult = { organizations: 0, deleted: 0, failed: 0 }
  for (const org of orgs?.docs ?? []) {
    result.organizations++
    try {
      result.deleted += await deleteOrphanEntities(payload, org.id, log)
    } catch (err) {
      result.failed++
      log(`[${GRAPH_ORPHAN_JANITOR_PREFIX}] ecosistema ${String(org.id)}: ${errSummary(err)}`)
    }
  }
  return result
}

export function startGraphOrphanJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: GRAPH_ORPHAN_JANITOR_PREFIX,
    enabledVar: GRAPH_ORPHAN_JANITOR_ENABLED_VAR,
    enabled: () => janitorEnabledFromEnv(GRAPH_ORPHAN_JANITOR_ENABLED_VAR),
    intervalMs: () => janitorIntervalMsFromEnv(GRAPH_ORPHAN_JANITOR_INTERVAL_VAR, GRAPH_ORPHAN_JANITOR_DEFAULT_MIN),
    disabledDetail:
      'Graph entities (names) of deleted documents stay in graph_entities until the backfill is run by hand.',
    sweep: async (p) => {
      const r = await sweepGraphOrphans(p as unknown as GraphBackfillPayload, (line) => p.logger.warn(line))
      p.logger.info(r, `[${GRAPH_ORPHAN_JANITOR_PREFIX}] swept`)
    },
  })
}

/** Test seam / graceful shutdown. */
export function stopGraphOrphanJanitor(): void {
  stopJanitor(GRAPH_ORPHAN_JANITOR_PREFIX)
}
