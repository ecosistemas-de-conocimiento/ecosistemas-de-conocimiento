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
 *   · it was never gated (`anonymise` not `true`, on anything but a
 *     testimonio): `regateMemberDocumentos` is the path for those;
 *   · it is mid-transition (`publishing`, `unpublishing`) or the gate is
 *     running on it (`pending`): another writer owns it right now.
 *
 * Apply, ONE ROW AT A TIME, in this order (same order as
 * `regateMemberDocumentos.ts`):
 *
 *   1. Retire it from the ecosistema's SHARED corpus, then from the uploader's
 *      DRAFT corpus (`retireFrom`, a 404 is "already absent"). Sharing stops
 *      first. A failure leaves the row as it was.
 *      With `purgeGraph` (the switch re-gate), the document's graph rows go
 *      too, before the reset; a purge that throws stops there (`erase-failed`).
 *   2. One guarded write: a draft, gate columns reset to the retryable `n/a`,
 *      ingest reset to `extracting` with no `ingestId`. Once it landed, ERASE
 *      both copies (`eraseWithdrawnCopies`, audit 2026-10-28; never throws).
 *   3. Gate and ingest it (`gate`; the script passes `enqueueIngestForDoc`).
 *      A cleared row ingests into the draft corpus.
 *
 * ⚠ A ROW THAT WAS PUBLISHED ENDS AS A DRAFT. A participant's upload is
 * auto-published by the ai-service callback (`lib/autoPublish.ts`); anyone
 * else's must be published again by hand. The dry run says which.
 * ⚠ DRY RUN BY DEFAULT: reads only, no ai-service call, no model call.
 */

import type { Payload } from 'payload'

import { isConsentHeld, isConsentHeldNow } from './consentHold'
import { draftCorpus, publishedCorpus } from './corpus'
import { errSummary } from './errorSummary'
import { relationId } from './permissions'
import { eraseWithdrawnCopies, retireFrom, type CorpusDeleter } from './publishDocument'

type Id = number | string
type Row = Record<string, unknown>

export type RegateRefusal = 'not-found' | 'other-ecosistema' | 'consent-held' | 'testimonio' | 'not-gated' | 'in-flight'

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
  outcome?: 'regated' | 'withdrawn-only' | 'changed-meanwhile' | 'failed' | 'erase-failed'
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
  // 🔴 Held for consent: never withdrawn, erased or re-gated (owner decision 2026-11-10).
  if (isConsentHeld(row)) return 'consent-held'
  if (row.contentKind === 'testimonio' && !allowTestimonio) return 'testimonio'
  // A testimonio is gated whatever `anonymise` says (`mustPassAnonymisationGate`).
  if (row.contentKind !== 'testimonio' && row.anonymise !== true) return 'not-gated'
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
    /** Admin client for the ecosistema: retiring and erasing are admin routes. */
    client: CorpusDeleter
    /** Gate and ingest one reset row. */
    gate: (row: Row) => Promise<unknown>
    /**
     * More columns for the reset write, in the same guarded UPDATE: the
     * per-document switches `lib/anonymisationControls.ts` saves, so a
     * refusal or a failed withdrawal saves nothing.
     */
    resetData?: Row
    /**
     * 🔴 Erase BOTH old copies before the reset, and stop if either fails
     * (audit 2026-11-07, E3/X10): a retired copy is hidden, not gone, and holds
     * the names the change is meant to remove. The row is left as it was read,
     * outcome `erase-failed`, so the same request retries.
     */
    requireErase?: boolean
    /**
     * 🔴 Purge the document's graph rows built from the old text (audit
     * 2026-11-10, P-02; `lib/graph/documentGraph.ts` `purgeDocumentGraph`),
     * next to the corpus erase and BEFORE the reset. A purge that throws is
     * `erase-failed`, exactly like an erase: the row is left as it was read.
     */
    purgeGraph?: (id: Id) => Promise<unknown>
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
    // 🔴 A depth-0 revision carries only its note's id: read the note's hold
    // now, so `refusalFor`'s sync check sees it (`lib/consentHold.ts`).
    if (row && relationId(row.revisionOf) !== null) {
      row.revisionOfConsentHeld = await isConsentHeldNow(payload, { revisionOf: relationId(row.revisionOf) })
    }
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
      const corpora = [publishedCorpus(opts.organizationId)]
      if (uploader != null) corpora.push(draftCorpus(opts.organizationId, uploader))

      // 1b. 🔴 `requireErase`: erase BEFORE the reset (audit 2026-11-07, X10).
      // A failure leaves the row as it was read (its copies retired, hidden
      // from every retrieve), so the same request again retries the erase. A
      // reset row would instead be re-driven by the ingest sweeps
      // (`recoverAbandonedClaims` re-drives an audio row) next to a copy that
      // still holds the names.
      if (opts.requireErase) {
        const { failed: notErased } = await eraseWithdrawnCopies(opts.client, corpora, row.id as Id)
        if (notErased.length > 0) {
          log(`doc ${id}: retired but NOT erased from ${notErased.join(', ')} — not reset, retry`)
          line.outcome = 'erase-failed'
          report.failed.push(id)
          continue
        }
      }
      // 1c. 🔴 The graph rows of the old text go too (P-02), before the reset.
      if (opts.purgeGraph) {
        try {
          await opts.purgeGraph(row.id as Id)
        } catch (err) {
          log(`doc ${id}: graph NOT purged (${err instanceof Error ? err.name : 'error'}) — not reset, retry`)
          line.outcome = 'erase-failed'
          report.failed.push(id)
          continue
        }
      }

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
          // The keep logs describe the text being replaced.
          publicFiguresKept: null,
          authorsKept: null,
          citedAuthorsKept: null,
          testimonioTitle: null,
          ingestId: null,
          ingestStatus: 'extracting',
          ingestError: null,
          ...(opts.resetData ?? {}),
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

      // 2b. 🔴 Erase both copies BEFORE the gate re-ingests (audit 2026-10-28):
      // retired is hidden, not gone, and the old redaction is what is being replaced.
      if (!opts.requireErase) {
        const { failed: notErased } = await eraseWithdrawnCopies(opts.client, corpora, row.id as Id)
        if (notErased.length > 0) log(`doc ${id}: retired but NOT erased from ${notErased.join(', ')}`)
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
      // ⚠ The name only: a database error's message carries the query's params.
      log(`doc ${id}: NOT processed: ${errSummary(err)}`)
    }
  }
  return report
}
