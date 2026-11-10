/**
 * ONE-OFF REPAIR: `published` rows stuck at `ingestStatus: 'pending'`.
 *
 * Driven by `scripts/repair-pending-published.ts`. Logic lives here so it is
 * tested; the script only wires Payload and the ai-service client.
 *
 * ── Why the rows exist ──────────────────────────────────────────────────────
 *
 * Until `confirmPublish` wrote `ingestStatus: 'ready'`, a publish never touched
 * `ingestStatus`, and the ai-service callback returns early on a publish move
 * before its own `ready` write. A row that was never draft-ingested therefore
 * reads `published` + `pending` forever.
 *
 * ── 🔴 WHY IT ASKS AI-SERVICE FIRST ─────────────────────────────────────────
 *
 * `published` on the backend row is NOT proof the document is in the shared
 * corpus. `seed/corpus.ts` writes `publicationStatus: 'published'` directly,
 * with ingest off by default, so most seeded "published" rows were never
 * embedded anywhere. Writing `ready` on those would turn "en cola" into a lie
 * that says "citable". So a row is repaired only when ai-service returns at
 * least one current chunk for its id from the org's PUBLISHED corpus.
 *
 * ⚠ `edc_ai` is a separate database, so the check goes through the `/v1`
 * API. There is no document-lookup endpoint; `/v1/retrieve` with a
 * `filter: { docId }` metadata constraint and `asOf: now` (excludes retired
 * chunks) is the closest read-only probe. ⚠ It embeds the query string, so
 * each check costs one embedding call and one request against the shared
 * 100/min `/v1` limit — hence the delay between checks.
 *
 * Absent, or any error, leaves the row untouched and is listed in the report.
 * Those rows need a real publish (or `SEED_CORPUS_INGEST=1`), not a status edit.
 */

import type { Payload, Where } from 'payload'

import { publishedCorpus } from './corpus'
import { safeErrMessage } from './errorSummary'
import { relationId } from './permissions'

/** The whole candidate predicate. Guarded writes re-assert it. */
export const CANDIDATE_WHERE: Where[] = [
  { publicationStatus: { equals: 'published' } },
  { ingestStatus: { equals: 'pending' } },
  { ingestId: { exists: false } },
]

export interface RepairCandidate {
  id: number | string
  name?: string | null
  organization?: unknown
}

/** `live` = ai-service holds a current chunk for this doc. THROWS when it cannot tell. */
export type LiveCheck = (doc: RepairCandidate) => Promise<'live' | 'absent'>

interface Retriever {
  retrieve(req: {
    corpus: string
    query: string
    topK?: number
    filter?: Record<string, unknown>
    asOf?: string
  }): Promise<{ chunks: unknown[] }>
}

/** The `/v1/retrieve` probe. 404 (corpus missing) is `absent`; anything else rethrows. */
export function liveCheckViaRetrieve(
  /**
   * One retriever, or a resolver per ecosistema. Production passes the
   * resolver: each document's shared corpus lives in its own ai-service org.
   */
  client: Retriever | ((organizationId: number | string) => Retriever),
  now: () => Date = () => new Date(),
): LiveCheck {
  return async (doc) => {
    const org = relationId(doc.organization)
    if (org == null) throw new Error(`document ${doc.id} has no organization`)
    const retriever = typeof client === 'function' ? client(org) : client
    try {
      const res = await retriever.retrieve({
        corpus: publishedCorpus(org),
        // Fixed query: the filename of a testimonio was never anonymised.
        query: 'documento',
        topK: 1,
        filter: { docId: String(doc.id) },
        asOf: now().toISOString(),
      })
      // Don't trust the filter alone: a service that ignored it would mark every row live.
      const id = String(doc.id)
      const hit = (res?.chunks ?? []).some(
        (c) => String((c as { metadata?: { docId?: unknown } })?.metadata?.docId) === id,
      )
      return hit ? 'live' : 'absent'
    } catch (err) {
      if ((err as { status?: number })?.status === 404) return 'absent'
      throw err
    }
  }
}

export interface RepairReport {
  apply: boolean
  candidates: number
  live: number
  absent: number
  errors: number
  repaired: number
  liveIds: string[]
  absentIds: string[]
  errorIds: string[]
}

export async function repairPendingPublished(
  payload: Pick<Payload, 'find' | 'update'>,
  isLive: LiveCheck,
  opts: {
    apply?: boolean
    limit?: number
    /** Pause between ai-service checks, to stay under the shared `/v1` rate limit. */
    delayMs?: number
    log?: (line: string) => void
  } = {},
): Promise<RepairReport> {
  const apply = opts.apply === true
  const delayMs = opts.delayMs ?? 750
  const log = opts.log ?? (() => {})

  const page = (await payload.find({
    collection: 'documents',
    where: { and: CANDIDATE_WHERE },
    sort: 'id',
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: RepairCandidate[] }
  const docs = page?.docs ?? []

  const report: RepairReport = {
    apply,
    candidates: docs.length,
    live: 0,
    absent: 0,
    errors: 0,
    repaired: 0,
    liveIds: [],
    absentIds: [],
    errorIds: [],
  }

  for (const [i, doc] of docs.entries()) {
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const id = String(doc.id)

    let verdict: 'live' | 'absent'
    try {
      verdict = await isLive(doc)
    } catch (err) {
      report.errors += 1
      report.errorIds.push(id)
      log(`error  ${id}  ${safeErrMessage(err)}`)
      continue
    }

    if (verdict === 'absent') {
      report.absent += 1
      report.absentIds.push(id)
      log(`absent ${id}  not in the published corpus — left as is`)
      continue
    }

    report.live += 1
    report.liveIds.push(id)
    if (!apply) {
      log(`live   ${id}  would set ingestStatus=ready (dry run)`)
      continue
    }

    const res = (await payload.update({
      collection: 'documents',
      where: { and: [{ id: { equals: doc.id } }, ...CANDIDATE_WHERE] },
      data: { ingestStatus: 'ready', ingestError: null },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })) as unknown as { docs?: unknown[] }
    if ((res?.docs?.length ?? 0) > 0) {
      report.repaired += 1
      log(`fixed  ${id}  ingestStatus=ready`)
    } else {
      log(`skip   ${id}  row changed since the read — left as is`)
    }
  }

  return report
}
