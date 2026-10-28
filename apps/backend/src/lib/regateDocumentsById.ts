/**
 * 🔴 ONE-OFF, BY ID: send named, already-gated documents back through the
 * anonymisation gate after a prompt change.
 *
 * Why (owner's ruling Q24 = A, 2026-10-28): on dev the model typed public
 * institution and project names as `otro`, and the gate turned each into
 * "[Dato omitido]". The prompt now says such names are not personal data; the
 * rows already gated keep the old redaction until they are gated again.
 * ⚠ Not used for the staff teaching material that prompted it: the owner
 * re-uploads that WITHOUT the gate (2026-10-28). Kept, dry run by default, for
 * gated participant and student documents.
 *
 * Selection is EXPLICIT: the caller names the ids and the ecosistema. Each id
 * is refused, and left untouched, when:
 *
 *   · it does not exist, or belongs to another ecosistema;
 *   · it is a `testimonio`, unless `allowTestimonio` is set;
 *   · it was never gated (`anonymise` not `true`): `regateMemberDocumentos` is
 *     the path for those;
 *   · it is mid-transition (`publishing`, `unpublishing`) or the gate is
 *     running on it (`pending`): another writer owns it right now.
 *
 * Apply, ONE ROW AT A TIME, in this order (same order as
 * `regateMemberDocumentos.ts`):
 *
 *   1. Retire it from the ecosistema's SHARED corpus, then from the uploader's
 *      DRAFT corpus (`retireFrom`, a 404 is "already absent"). Sharing stops
 *      first. A failure leaves the row as it was.
 *   2. One guarded write: a draft, gate columns reset to the retryable `n/a`,
 *      ingest reset to `extracting` with no `ingestId`.
 *   3. Gate and ingest it (`gate`; the script passes `enqueueIngestForDoc`).
 *      A cleared row ingests into the draft corpus.
 *
 * ⚠ A ROW THAT WAS PUBLISHED ENDS AS A DRAFT. A participant's upload is
 * auto-published by the ai-service callback (`lib/autoPublish.ts`); anyone
 * else's must be published again by hand. The dry run says which.
 * ⚠ DRY RUN BY DEFAULT: reads only, no ai-service call, no model call.
 */

import type { Payload } from 'payload'

import { draftCorpus, publishedCorpus } from './corpus'
import { relationId } from './permissions'
import { retireFrom, type CorpusMover } from './publishDocument'

type Id = number | string
type Row = Record<string, unknown>

export type RegateRefusal = 'not-found' | 'other-ecosistema' | 'testimonio' | 'not-gated' | 'in-flight'

/** Placeholder counts in the stored gate output. */
export interface PlaceholderCounts {
  omitted: number
  persona: number
  domicilio: number
}

export interface RegateByIdLine {
  id: string
  contentKind: unknown
  publicationStatus: unknown
  anonymisationStatus: unknown
  ingestStatus: unknown
  placeholders: PlaceholderCounts
  refused?: RegateRefusal
  /** What happened on apply; absent on a dry run or a refusal. */
  outcome?: 'regated' | 'withdrawn-only' | 'changed-meanwhile' | 'failed'
}

export interface RegateByIdReport {
  apply: boolean
  lines: RegateByIdLine[]
  regated: string[]
  refused: string[]
  failed: string[]
}

/** Counts `[Dato omitido]`, `[Persona X]` and `[Domicilio X]` in a gated text. */
export function countPlaceholders(text: unknown): PlaceholderCounts {
  const s = typeof text === 'string' ? text : ''
  const n = (re: RegExp) => (s.match(re) ?? []).length
  return {
    omitted: n(/\[Dato omitido\]/g),
    persona: n(/\[Persona [A-Z]+\]/g),
    domicilio: n(/\[Domicilio [A-Z]+\]/g),
  }
}

/** Why this row may not be re-gated, or `null` when it may. */
export function refusalFor(row: Row | undefined, organizationId: Id, allowTestimonio: boolean): RegateRefusal | null {
  if (!row) return 'not-found'
  if (String(relationId(row.organization)) !== String(organizationId)) return 'other-ecosistema'
  if (row.contentKind === 'testimonio' && !allowTestimonio) return 'testimonio'
  if (row.anonymise !== true) return 'not-gated'
  if (row.publicationStatus === 'publishing' || row.publicationStatus === 'unpublishing') return 'in-flight'
  if (row.anonymisationStatus === 'pending') return 'in-flight'
  return null
}

export async function regateDocumentsById(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: {
    ids: Id[]
    organizationId: Id
    apply: boolean
    allowTestimonio?: boolean
    /** Admin client for the ecosistema: retiring is an admin route. */
    client: CorpusMover
    /** Gate and ingest one reset row. */
    gate: (row: Row) => Promise<unknown>
    now?: Date
    log?: (line: string) => void
  },
): Promise<RegateByIdReport> {
  const log = opts.log ?? (() => undefined)
  const report: RegateByIdReport = { apply: opts.apply, lines: [], regated: [], refused: [], failed: [] }
  if (opts.ids.length === 0) return report

  const found = (await payload.find({
    collection: 'documents',
    where: { id: { in: opts.ids } },
    limit: opts.ids.length,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const byId = new Map((found.docs ?? []).map((r) => [String(r.id), r]))

  for (const rawId of opts.ids) {
    const id = String(rawId)
    const row = byId.get(id)
    const line: RegateByIdLine = {
      id,
      contentKind: row?.contentKind ?? null,
      publicationStatus: row?.publicationStatus ?? null,
      anonymisationStatus: row?.anonymisationStatus ?? null,
      ingestStatus: row?.ingestStatus ?? null,
      placeholders: countPlaceholders(row?.redactedText ?? row?.heldText),
    }
    report.lines.push(line)
    const p = line.placeholders
    const status =
      `${String(line.contentKind)}, ${String(line.publicationStatus)}, gate ${String(line.anonymisationStatus)},` +
      ` ingest ${String(line.ingestStatus)}; placeholders: ${p.omitted} [Dato omitido],` +
      ` ${p.persona} [Persona], ${p.domicilio} [Domicilio]`

    const refusal = refusalFor(row, opts.organizationId, opts.allowTestimonio === true)
    if (refusal || !row) {
      line.refused = refusal ?? 'not-found'
      report.refused.push(id)
      log(`doc ${id}: REFUSED (${line.refused}) — ${status}`)
      continue
    }
    const uploader = relationId(row.uploadedBy)
    const wasPublished = row.publicationStatus === 'published'
    log(
      `doc ${id}: ${opts.apply ? 'regating' : 'would withdraw, reset and regate'} — ${status}` +
        (wasPublished ? '; ends a draft (auto-published only if a participant uploaded it)' : ''),
    )
    if (!opts.apply) continue

    try {
      // 1. Out of both corpora, the shared one FIRST.
      const now = opts.now ?? new Date()
      await retireFrom(opts.client, publishedCorpus(opts.organizationId), row.id as Id, now)
      if (uploader != null) await retireFrom(opts.client, draftCorpus(opts.organizationId, uploader), row.id as Id, now)

      // 2. Reset, guarded on the state we read.
      const res = (await payload.update({
        collection: 'documents',
        where: {
          and: [
            { id: { equals: row.id } },
            { publicationStatus: { equals: row.publicationStatus } },
            { anonymisationStatus: { equals: row.anonymisationStatus } },
          ],
        },
        data: {
          publicationStatus: 'draft',
          publicationError: null,
          publishIngestId: null,
          anonymisationStatus: 'n/a',
          anonymisationError: null,
          redactedText: null,
          heldText: null,
          anonymisationSurvivors: null,
          testimonioTitle: null,
          ingestId: null,
          ingestStatus: 'extracting',
          ingestError: null,
        },
        depth: 0,
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      } as never)) as unknown as { docs?: Row[] }
      const updated = res?.docs?.[0]
      if (!updated) {
        line.outcome = 'changed-meanwhile'
        log(`doc ${id}: changed since it was read — left alone (already withdrawn from the corpus)`)
        continue
      }

      // 3. Through the gate, then ingest.
      const text = updated.extractedText
      if (typeof text !== 'string' || text.trim() === '') {
        line.outcome = 'withdrawn-only'
        log(`doc ${id}: no extracted text — withdrawn, left a private gated draft`)
        continue
      }
      await opts.gate(updated)
      line.outcome = 'regated'
      report.regated.push(id)
      log(`doc ${id}: withdrawn and sent through the gate`)
    } catch (err) {
      line.outcome = 'failed'
      report.failed.push(id)
      log(`doc ${id}: NOT processed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return report
}
