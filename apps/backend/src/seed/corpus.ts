/**
 * THE DEMO'S LIBRARY. 250 documents, read out of `../corpus-generativo`.
 *
 * Before this existed the demo seed built an ecosistema with nothing in it: an
 * empty library, an empty graph, and a retrieval feature with nothing to
 * retrieve. The corpus was already sitting next door, already used to build the
 * e2e fixtures (`plan/handoff-fixtures-e2e.md`), and nothing read it as SEED
 * data.
 *
 * ── 🔴 THE EXPENSIVE HALF IS THE INGEST, AND IT IS OFF BY DEFAULT ────────────
 *
 * Inserting 250 rows is a few seconds of Postgres. EMBEDDING 250 documents is
 * 250 jobs at ai-service, and for a `testimonio` it is two model calls through
 * the anonymisation gate on top. A developer who runs `docker compose up` must
 * not be made to wait on that, and CI must never pay for it by accident.
 *
 * So the seed writes ROWS ONLY. Every row carries its `extractedText`, which is
 * the input the pipeline would have produced anyway, and nothing is sent
 * anywhere. Ingest is a separate, explicit opt-in:
 *
 *     SEED_CORPUS_INGEST=1     # hand every seeded row to the REAL pipeline
 *
 * ⚠ WHAT THAT COSTS YOU WHEN IT IS OFF, said plainly rather than discovered:
 * the library is full and browsable, and the assistant retrieves NOTHING,
 * because nothing has been embedded. That is the honest trade — a demo that
 * boots in seconds and a chat that finds nothing, versus a boot that blocks on
 * 250 embeddings. Flip the flag when you want the chat half.
 *
 * ── ⚠ THE ONE THING THE SEED WRITES THAT IT CANNOT YET BACK UP ───────────────
 *
 * The library screen lists ONLY `publicationStatus: 'published'` rows
 * (`apps/web/src/lib/server/biblioteca.ts`). A seed that left everything at
 * `draft` would therefore produce the empty library it was written to fix. So
 * most `documento` rows are seeded `published`.
 *
 * 🔴 With ingest off, that column is TRUE OF THE ROW AND FALSE OF THE CORPUS:
 * the document is shared with the ecosistema, and there is not a chunk of it
 * anywhere. `SEED_CORPUS_INGEST=1` is what makes it true, and it does so
 * through the product's own `beginPublish` rather than by writing a column.
 * This is stated here, logged at seed time, and is the reason the flag exists.
 *
 * ⚠ EXTENSIONLESS IMPORTS. Reached from `seed/demo.ts`, which
 * `payload.config.ts` imports for `onInit` — see the note in `seed/admin.ts`.
 */

import type { Payload } from 'payload'

import type { CorpusEntry } from './corpusSource'
import { readCorpusManifest, readCorpusText, resolveCorpusDir } from './corpusSource'

/**
 * 🔴 WHICH CORPUS DOCUMENTS BECOME A `testimonio`, AND WHY IT IS ONE GENRE AND
 * NOT FIVE.
 *
 * `contentKind: 'testimonio'` is not a genre label in this product. It is a
 * SWITCH: it routes the row through the anonymisation gate
 * (`lib/anonymiseDocument.ts` — `mustPassAnonymisationGate` gates everything
 * that is not `documento`), it forces a neutral citation title, and it means
 * "somebody's words, filed by an Investigador on their behalf".
 *
 * Read against that meaning, the corpus's five `formato` values split cleanly:
 *
 *   testimonio         🔴 a person's own account, collected and written down by
 *                         someone else. THE paradigm case. → `testimonio`
 *   biografia_oral        an interview transcript, headed with the project's
 *                         name and the interviewee's, filed by the project as
 *                         its own record. → `documento`
 *   carta_presentacion    a letter the person wrote about themselves and filed
 *                         under their own name. → `documento`
 *   diario_personal       the practitioner's own field notes. Their material.
 *                         → `documento`
 *   ficha_participante    an administrative registration form the project holds.
 *                         → `documento`
 *
 * ⚠ `biografia_oral` IS THE ARGUABLE ONE, and it is called out rather than
 * hidden. It is oral material, so a case exists for gating it. It lands on
 * `documento` because its own header names the project, the interviewer and the
 * interviewee openly — it is a research record, not an anonymous voice — and
 * because the alternative is the outcome this seed was explicitly told to
 * avoid: 125 of 250 documents gated, which on a live stack is 250 model calls
 * and a review queue with a hundred entries in it. 59 Voces out of 250 is a
 * believable ecosistema; 125 is a queue.
 *
 * ⚠ IF YOU DISAGREE, CHANGE THIS SET AND NOTHING ELSE. Everything downstream
 * reads it.
 */
const TESTIMONIO_FORMATOS: ReadonlySet<string> = new Set(['testimonio'])

/** Plain-language names for the corpus's own four themes. */
const THEME_LABELS: Record<string, string> = {
  traduccion: 'traducción en salud',
  dengue: 'prevención del dengue',
  escuela: 'acompañamiento escolar',
  discapacidad: 'vida con discapacidad',
}

/** Plain-language names for the corpus's own five genres. */
const FORMATO_LABELS: Record<string, string> = {
  testimonio: 'Testimonio',
  biografia_oral: 'Biografía oral',
  carta_presentacion: 'Carta de presentación',
  diario_personal: 'Diario personal',
  ficha_participante: 'Ficha de participante',
}

function themeLabel(ecosistema: string): string {
  return THEME_LABELS[ecosistema] ?? ecosistema
}

/**
 * 🔴 THE TITLE OF A SEEDED `testimonio` NAMES NOBODY, AND CARRIES NO HANDLE
 * BACK TO ANYBODY.
 *
 * `documents.name` is free text and it is what the library shows. For a
 * `documento` the corpus id belongs on it — it is the document's filing
 * reference and makes a seeded row traceable to the file it came from.
 *
 * ⚠ FOR A TESTIMONIO THE CORPUS ID IS EXACTLY WHAT MUST NOT BE THERE. `SIM_0055`
 * is a key into `MANIFEST.csv`, and that table has a `nombre` column. Putting
 * the id on the row would rebuild, in one join, the link the whole
 * anonymisation design refuses to keep — with the excuse that the person is
 * synthetic, which is not a property the code can check. So a Voz is titled by
 * THEME and a per-theme counter, and nothing else.
 *
 * (`lib/contentKind.ts` already replaces the title with a bare "Testimonio" on
 * every chunk that reaches a corpus. This is the row-level half of the same
 * rule: the library shows `name`, and the gate never looked at it.)
 */
function titleFor(entry: CorpusEntry, contentKind: 'documento' | 'testimonio', ordinal: number): string {
  const theme = themeLabel(entry.ecosistema)
  if (contentKind === 'testimonio') {
    return `Testimonio — ${theme} (${String(ordinal).padStart(2, '0')})`
  }
  const genre = FORMATO_LABELS[entry.formato] ?? 'Documento'
  return `${genre} — ${theme} (${entry.id})`
}

/**
 * `kind` is the FILE FORMAT, and the corpus ships two of them.
 *
 * ⚠ A `.txt` becomes `pdf` rather than `markdown`, and that is a deliberate,
 * arguable call. Plain text is not one of this product's four formats, and the
 * two candidates are not equivalent:
 *
 *   · `markdown` is honest about "there is no file" — but markdown is NOT in
 *     `INGESTABLE_KINDS` (`collections/Documents.ts`), so a markdown row has no
 *     draft corpus at all and can never demonstrate ingestion, retrieval or the
 *     anonymisation gate. The seed would then be decorative.
 *   · `pdf` is what these same `.txt` files become when they are really
 *     uploaded — `scripts/corpus-fixtures.sh` renders them with
 *     `scripts/lib/txt_to_pdf.py` for exactly that reason — and it puts the row
 *     on the real pipeline.
 *
 * ⚠ THE COST, STATED: a seeded row has NO `mediaFile`. Nothing in the product
 * offers a seeded document for download (the library renders `extractedText`
 * and never links a file), and extraction is skipped because the text is
 * already on the row, so nothing looks for the missing file. But `kind: 'pdf'`
 * with no PDF behind it is a small fiction, and a seed is fiction by
 * definition. If that ever stops being acceptable, the fix is to render the
 * PDFs with the existing script and upload them as media — not to change this
 * line alone.
 */
function fileKindFor(entry: CorpusEntry): 'pdf' | 'docx' {
  return entry.isDocx ? 'docx' : 'pdf'
}

/**
 * ⚠ VARIED ON PURPOSE — a demo where everything is `published` cannot show the
 * draft/publish flow at all, and one where everything is a draft has an empty
 * library.
 *
 *   · `documento`  — published, except every 8th, which stays a draft (~12%).
 *   · `testimonio` — ALWAYS a draft. Not a style choice: publishing is what
 *     puts a document in front of the whole ecosistema, and `corpusTextFor`
 *     refuses a gated row that has no `redactedText`. A seeded Voz has never
 *     been through the gate, so `published` would be a state the product's own
 *     publish path would have refused to create.
 *
 * Deterministic in the manifest's order, so two runs against the same corpus
 * produce the same demo.
 */
function publicationFor(contentKind: 'documento' | 'testimonio', index: number): 'draft' | 'published' {
  if (contentKind === 'testimonio') return 'draft'
  return index % 8 === 5 ? 'draft' : 'published'
}

export interface SeedCorpusResult {
  created: number
  documentos: number
  testimonios: number
  published: number
  drafts: number
  corpusDir: string
}

export interface SeedCorpusOptions {
  organizationId: number
  /** Files the `documento` rows. Normally the platform admin. */
  uploaderId: number
  /**
   * Files the `testimonio` rows.
   *
   * ⚠ A Voz is filed by whoever holds `voces:upload` — the Investigador — and
   * `uploadedBy` records WHO PERFORMED THE UPLOAD, never whose words these are
   * (`lib/permissions.ts`). Falls back to `uploaderId` when no Investigador was
   * created, because a row still needs an uploader; the log says so.
   */
  investigadorId?: number
}

/**
 * Insert the corpus as documents. Returns `null` when there is no corpus to
 * read or the ecosistema already has documents.
 *
 * ── IDEMPOTENCE ──────────────────────────────────────────────────────────────
 *
 * 🔴 Gated on the ecosistema having ZERO documents, and `force` does NOT widen
 * it. Same shape as the outer seed's "empty `organizations` table" gate, and
 * for a stronger reason: re-seeding would mean DELETING 250 rows first, and
 * `collections/Documents.ts` retires a deleted document's chunks from ai-service
 * on the way out. A seed that quietly destroys corpus content on a second run
 * is a worse failure than a seed that refuses to run twice.
 *
 * To re-seed: drop the documents yourself, or reset the database.
 */
export async function seedCorpusDocuments(
  payload: Payload,
  opts: SeedCorpusOptions,
): Promise<SeedCorpusResult | null> {
  const located = resolveCorpusDir()
  if (located.dir === null) {
    // 🔴 DEGRADE, NEVER CRASH AND NEVER HALF-SEED. The corpus is an optional
    // sibling checkout; a developer without it gets exactly the ecosistema this
    // seed built before the corpus existed, plus one line saying what is
    // missing and how to get it.
    payload.logger.warn(
      `[seed-corpus] no corpus — seeding an ecosistema with no documents. ${located.reason}`,
    )
    return null
  }

  const existing = await payload.count({
    collection: 'documents',
    where: { organization: { equals: opts.organizationId } },
  })
  if (existing.totalDocs > 0) {
    payload.logger.info(
      `[seed-corpus] ecosistema ${opts.organizationId} already has ${existing.totalDocs} documents — skipping.`,
    )
    return null
  }

  const entries = readCorpusManifest(located.dir)
  if (entries.length === 0) {
    payload.logger.warn(`[seed-corpus] ${located.dir} has a manifest but no readable files.`)
    return null
  }

  const startedAt = Date.now()
  const result: SeedCorpusResult = {
    created: 0,
    documentos: 0,
    testimonios: 0,
    published: 0,
    drafts: 0,
    corpusDir: located.dir,
  }

  // Per-theme counters, so a Voz can be numbered without borrowing the corpus id.
  const testimonioOrdinals = new Map<string, number>()

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const contentKind = TESTIMONIO_FORMATOS.has(entry.formato) ? 'testimonio' : 'documento'

    let text: string
    try {
      text = (await readCorpusText(entry)).trim()
    } catch (err) {
      payload.logger.warn(
        `[seed-corpus] could not read ${entry.archivo}: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    if (!text) continue

    let ordinal = 0
    if (contentKind === 'testimonio') {
      ordinal = (testimonioOrdinals.get(entry.ecosistema) ?? 0) + 1
      testimonioOrdinals.set(entry.ecosistema, ordinal)
    }

    const publicationStatus = publicationFor(contentKind, index)

    await payload.create({
      collection: 'documents',
      data: {
        organization: opts.organizationId,
        uploadedBy:
          contentKind === 'testimonio' ? (opts.investigadorId ?? opts.uploaderId) : opts.uploaderId,
        name: titleFor(entry, contentKind, ordinal),
        kind: fileKindFor(entry),
        contentKind,
        publicationStatus,
        /**
         * ⚠ THE TEXT THE PIPELINE WOULD HAVE PRODUCED, cached on the row. It is
         * also what makes the ingest opt-in cheap: `runExtractAndIngest` skips
         * extraction when `extractedText` is already there, so opting in costs
         * an embedding and not an extraction as well.
         */
        extractedText: text,
        /**
         * ⚠ `pending` means "the row exists; nothing has happened yet", which is
         * exactly true. Not `ready` — `ready` claims the document is retrievable
         * and citable, and with ingest off it is neither.
         */
        ingestStatus: 'pending',
        /**
         * ⚠ A LIBRARY DOCUMENT IS RETRIEVED, NOT INLINED. `full-text` (the
         * default) means "paste this whole document into the prompt when it is
         * pinned", which is right for a one-page working note and catastrophic
         * for 250 of them. `isPinned` is false for the same reason.
         */
        mode: 'rag-retrieve',
        isPinned: false,
      } as never,
      overrideAccess: true,
      /**
       * 🔴 THE FLAG THAT KEEPS THE SEED FREE. Without it `extractAndIngestHook`
       * fires on every one of these creates and starts 250 background ingests —
       * plus the anonymisation gate's two model calls per Voz — while the seed
       * is still running, on a boot that never asked for any of it.
       */
      context: { __skipDocsExtract: true },
    })

    result.created += 1
    if (contentKind === 'testimonio') result.testimonios += 1
    else result.documentos += 1
    if (publicationStatus === 'published') result.published += 1
    else result.drafts += 1
  }

  payload.logger.info(
    `[seed-corpus] ${result.created} documents in ${Date.now() - startedAt}ms from ${located.dir} ` +
      `(${result.documentos} documento / ${result.testimonios} testimonio, ` +
      `${result.published} published / ${result.drafts} draft). ` +
      'NOTHING IS EMBEDDED: the library is browsable, the assistant retrieves nothing. ' +
      'Set SEED_CORPUS_INGEST=1 to hand these to the real ingest pipeline.',
  )

  return result
}

/**
 * Should the seed pay for embeddings? Off unless somebody says otherwise.
 *
 * ⚠ Opt-IN, never opt-out. The failure mode of the other direction is a CI job
 * or a colleague's first `docker compose up` quietly spending an ai-service
 * budget on 250 documents nobody asked to embed.
 */
export function corpusIngestRequested(): boolean {
  const raw = process.env.SEED_CORPUS_INGEST?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * How many documents to have in flight at once when ingest IS requested.
 *
 * ⚠ Bounded, and low. Each one is an HTTP call to ai-service and, for a Voz,
 * two model calls; firing 250 at once is how a local ai-service gets knocked
 * over by its own seed.
 */
const INGEST_CONCURRENCY = 4

/**
 * 🔴 THE OPT-IN. Hand every seeded row to the PRODUCT'S OWN pipeline — no
 * second ingest path, no shortcut around the anonymisation gate.
 *
 * Two routes, because a seeded row is in one of two honest states:
 *
 *   · `published` → `beginPublish`, which embeds into the ecosistema's SHARED
 *     corpus. This is what makes the seeded `published` column true; see the
 *     header. The row goes to `publishing` and the ai-service callback flips it
 *     back to `published`.
 *   · `draft` → a plain re-save with NO `__skipDocsExtract`, which is exactly
 *     what an ordinary edit does. `extractAndIngestHook` picks it up, skips
 *     extraction (the text is cached), runs the anonymisation gate for a
 *     `testimonio`, and enqueues into the uploader's draft corpus.
 *
 * ⚠ NEITHER PATH IS AWAITED TO COMPLETION, and it cannot be. `beginPublish`
 * returns when the job is ENQUEUED; the draft path runs in a `setImmediate`
 * inside the hook. What this function bounds is how many are enqueued at once,
 * not how long ai-service takes. Expect the rows to sit in `embedding` /
 * `publishing` for a while after the seed logs "done", and watch
 * `ingestStatus`.
 *
 * ⚠ ONE FAILURE DOES NOT STOP THE REST. A document that cannot be enqueued is
 * logged and skipped: 249 embedded documents and one loud line is a better
 * demo than a seed that aborted a third of the way through.
 */
export async function ingestSeededDocuments(
  payload: Payload,
  organizationId: number,
): Promise<{ enqueued: number; failed: number }> {
  const { getAdminAIClient } = await import('@/lib/aiClient')
  const { ingestCallbackUrl } = await import('@/lib/callbackConfig')
  const { beginPublish } = await import('@/lib/publishDocument')

  let client: unknown
  try {
    client = getAdminAIClient()
  } catch (err) {
    // ⚠ Refuse the whole opt-in rather than half of it. Without an admin key
    // the publish path cannot retire the draft copy, and a partially-published
    // library is harder to reason about than an unembedded one.
    payload.logger.error(
      `[seed-corpus] SEED_CORPUS_INGEST is set but the AI service is not configured ` +
        `(${err instanceof Error ? err.message : String(err)}). Nothing was ingested.`,
    )
    return { enqueued: 0, failed: 0 }
  }

  const found = await payload.find({
    collection: 'documents',
    where: { organization: { equals: organizationId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })

  const rows = found.docs as unknown as Array<{
    id: number | string
    publicationStatus?: unknown
    anonymisationStatus?: unknown
  }>

  const deps = { payload, client: client as never, callbackUrl: ingestCallbackUrl() ?? undefined }
  const startedAt = Date.now()
  let enqueued = 0
  let failed = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= rows.length) return
      const row = rows[index]

      // ⚠ A HELD ROW IS LEFT ALONE. The gate refused it; re-saving it would do
      // nothing (the hook skips held rows) and publishing it would be refused
      // by `corpusTextFor`. Touching it here would only add noise to the log.
      if (row.anonymisationStatus === 'held' || row.anonymisationStatus === 'rejected') continue

      try {
        if (row.publicationStatus === 'published') {
          await beginPublish(row as never, deps)
        } else {
          await payload.update({
            collection: 'documents',
            id: row.id as never,
            data: {},
            overrideAccess: true,
          })
        }
        enqueued += 1
      } catch (err) {
        failed += 1
        payload.logger.warn(
          `[seed-corpus] could not enqueue document ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  await Promise.all(Array.from({ length: INGEST_CONCURRENCY }, worker))

  payload.logger.info(
    `[seed-corpus] ingest requested for ${enqueued} documents (${failed} refused) in ` +
      `${Date.now() - startedAt}ms. ⚠ ENQUEUED, NOT FINISHED — ai-service is still working; ` +
      'watch `ingestStatus` and `publicationStatus`.',
  )

  return { enqueued, failed }
}
