/**
 * ONE-OFF BACKFILL: re-stamp `metadata.lengua` on the chunks of PUBLISHED
 * documentos (audit C-3).
 *
 * Driven by `scripts/backfill-lengua.ts`. Logic lives here so it is tested; the
 * script only wires Payload and the ai-service client.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * `lengua` reached chunk metadata with the lengua-filters change. Chunks embedded before that do
 * not carry it, so chat's `filter: { lengua }` excludes them (audit C-3,
 * measured on `edc_ai`/`edc_backend` 2026-10-17: 0 of 253 `eco-1` chunks carry
 * `metadata.lengua`, while 191 documents have `lengua`).
 *
 * ── How: a re-ingest, because there is no metadata patch ────────────────────
 *
 * ai-service has no endpoint that rewrites chunk metadata (read:
 * `services/ai-service/src/routes/corpus.ts` — only the DELETE routes, the
 * `validity` PATCH and the alias POST). So each document is RE-INGESTED into
 * its ecosistema's published corpus under the SAME external id. The ingest
 * worker then deletes that document's chunks and inserts the new ones in one
 * transaction (read: `services/ai-service/src/workers/ingest.worker.ts`,
 * "Dedupe / upsert the document row"), so a failure leaves the old chunks.
 *
 * 🔴 IT RE-EMBEDS. Every document costs embedding calls. That is why this is
 * dry-run by default and running it with `apply` is Rodrigo's call.
 *
 * The request is built EXACTLY as `beginPublish` builds it — `corpusTextFor`
 * (the gate's output for gated content), `titleFor`, `chunkMetadata` with
 * `publication: 'published'` — so the re-ingested copy is the copy a publish
 * would make today. No `callbackUrl`: the row is already `published`/`ready`,
 * and a callback with an unknown `ingestId` would only be noise.
 *
 * ⚠ `chunkMetadata` keeps `lengua` on a `documento` only. The candidate query
 * asks for documentos, and the builder enforces it a second time.
 */

import type { Payload, Where } from 'payload'

import { corpusTextFor } from './anonymiseDocument'
import { chunkMetadata, contentKindOf, documentTitleFor } from './contentKind'
import { publishedCorpus } from './corpus'
import { relationId } from './permissions'

const CORPUS_LANGUAGE = process.env.CORPUS_LANGUAGE?.trim() || 'spanish'

export const BACKFILL_WHERE: Where[] = [
  { contentKind: { equals: 'documento' } },
  { publicationStatus: { equals: 'published' } },
  { lengua: { exists: true } },
]

export interface BackfillCandidate {
  id: number | string
  name?: string | null
  kind?: string | null
  contentKind?: string | null
  extractedText?: string | null
  redactedText?: string | null
  anonymisationStatus?: string | null
  /** 🔴 The title gate's columns (P-13): a gated documento re-ingests under its redacted title. */
  anonymise?: unknown
  anonymisationReport?: unknown
  lengua?: string | null
  organization?: unknown
}

export interface LenguaIngester {
  ingest: {
    enqueue(req: {
      corpus: string
      documents: Array<{ id: string; text: string; title: string; metadata?: Record<string, unknown> }>
      language?: string
    }): Promise<{ ingestId: string }>
  }
}

export interface BackfillReport {
  apply: boolean
  candidates: number
  /** Re-ingests enqueued (apply) or that would be (dry run). */
  planned: number
  enqueued: number
  skipped: number
  errors: number
  /** Characters that would be embedded — the cost driver. */
  chars: number
  /** The last id handled, to resume with `afterId`. */
  lastId: string | null
  skippedIds: string[]
  errorIds: string[]
}

export async function backfillLengua(
  payload: Pick<Payload, 'find'>,
  clientFor: (organizationId: number | string) => LenguaIngester,
  opts: {
    apply?: boolean
    limit?: number
    /** Only this ecosistema. */
    organizationId?: number | string
    /** Resume: only ids greater than this. */
    afterId?: number
    /** Pause between enqueues — the shared 100/min `/v1` limit. */
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
    log?: (line: string) => void
  } = {},
): Promise<BackfillReport> {
  const apply = opts.apply === true
  const delayMs = opts.delayMs ?? 1000
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const log = opts.log ?? (() => {})

  const where: Where[] = [...BACKFILL_WHERE]
  if (opts.organizationId != null) where.push({ organization: { equals: opts.organizationId } })
  if (opts.afterId != null) where.push({ id: { greater_than: opts.afterId } })

  const page = (await payload.find({
    collection: 'documents',
    where: { and: where },
    sort: 'id',
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: BackfillCandidate[] }
  const docs = page?.docs ?? []

  const report: BackfillReport = {
    apply,
    candidates: docs.length,
    planned: 0,
    enqueued: 0,
    skipped: 0,
    errors: 0,
    chars: 0,
    lastId: null,
    skippedIds: [],
    errorIds: [],
  }

  for (const [i, doc] of docs.entries()) {
    const id = String(doc.id)
    report.lastId = id
    const lengua = typeof doc.lengua === 'string' ? doc.lengua.trim() : ''
    const org = relationId(doc.organization)
    const selected = corpusTextFor(doc)
    if (!lengua || org == null || contentKindOf(doc) !== 'documento' || !selected.ok) {
      report.skipped += 1
      report.skippedIds.push(id)
      log(
        `skip ${id}: ${!lengua ? 'no lengua' : org == null ? 'no organization' : !selected.ok ? selected.reason : 'not a documento'}`,
      )
      continue
    }

    const corpus = publishedCorpus(org)
    report.planned += 1
    report.chars += selected.text.length
    if (!apply) {
      log(`would re-ingest ${id} into ${corpus} (lengua=${lengua}, ${selected.text.length} chars)`)
      continue
    }

    try {
      const { ingestId } = await clientFor(org).ingest.enqueue({
        corpus,
        documents: [
          {
            id,
            text: selected.text,
            // 🔴 P-13 (review R4-04): the gated title, never `doc.name`, on both copies.
            title: documentTitleFor(doc),
            metadata: chunkMetadata({
              docId: id,
              organizationId: org,
              contentKind: contentKindOf(doc),
              format: doc.kind,
              publication: 'published',
              title: doc.name,
              gate: doc,
              lengua,
            }),
          },
        ],
        language: CORPUS_LANGUAGE,
      })
      report.enqueued += 1
      log(`enqueued ${id} into ${corpus} (ingestId=${ingestId})`)
    } catch (err) {
      report.errors += 1
      report.errorIds.push(id)
      log(`error ${id}: ${(err as Error)?.name ?? 'Error'} ${(err as { status?: number })?.status ?? ''}`)
    }
    if (i < docs.length - 1 && delayMs > 0) await sleep(delayMs)
  }

  return report
}
