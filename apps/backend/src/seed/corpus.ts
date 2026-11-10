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
 * ── ⚠ EVERY SEEDED ROW IS A DRAFT UNTIL THE GATE CLEARS IT ───────────────────
 *
 * The library screen lists ONLY `publicationStatus: 'published'` rows
 * (`apps/web/src/lib/server/biblioteca.ts`). Every seeded row is a gated
 * `testimonio` (see {@link seedCorpusDocuments}), and a gated row can be
 * published only once the gate has cleared it (`corpusTextFor`). So the seed
 * writes drafts, and with ingest off the library is EMPTY.
 *
 * 🔴 `SEED_CORPUS_INGEST=1` is what fills it: {@link ingestSeededDocuments}
 * runs the gate on each row and publishes what clears, through the product's
 * own `beginPublish` rather than by writing a column. This is stated here,
 * logged at seed time, and is the reason the flag exists.
 *
 * ⚠ EXTENSIONLESS IMPORTS. Reached from `seed/demo.ts`, which
 * `payload.config.ts` imports for `onInit` — see the note in `seed/admin.ts`.
 */

import type { Payload } from 'payload'

import type { CorpusEntry } from './corpusSource'
import { readCorpusManifest, readCorpusText, resolveCorpusDir } from './corpusSource'
import { safeErrMessage } from '../lib/errorSummary'

/**
 * 🔴 WHICH CORPUS DOCUMENTS BECOME A `testimonio`: ALL OF THEM.
 *
 * 🔴 OWNER'S RULING (2026-10-21): in the product every corpus item is a Voz.
 * The genre split (biografía, carta, ficha, diario, …) is an artefact of the
 * synthetic corpus, not a content kind. So EVERY seeded row — every formato,
 * the `.docx` files, and a formato this file has never heard of — is seeded
 * `contentKind: 'testimonio'` and goes through the gate. There is no
 * `documento` branch left in the seed.
 *
 * `contentKind: 'testimonio'` is not a genre label in this product. It is a
 * SWITCH: it routes the row through the anonymisation gate
 * (`lib/anonymiseDocument.ts` — `mustPassAnonymisationGate` gates everything
 * that is not `documento`), hides the unredacted original from everyone but the
 * uploader, shows `redactedText` in the library, and forces a neutral citation
 * title.
 *
 * 🔴 OWNER'S RULING (2026-10-21, backlog #34): biografías orales, cartas de
 * presentación, fichas de participante and diarios personales go through the
 * same gate as a testimonio. Each one is a person's own account of themselves,
 * with their name and their town in it. Measured on dev before the ruling: 163
 * of them were published as ungated `documento` rows (58 / 55 / 27 / 23).
 *
 * ⚠ WHY THE SWITCH AND NOT A NEW FLAG. Every privacy rule downstream — the gate,
 * `mayReadGatedOriginal`, the library's `documentText`, the graph's person rule,
 * `lengua` — keys on `contentKind === 'documento'`. A `documento` that is also
 * gated would need each of those taught a second rule, and the one that got
 * missed would serve the raw original to the ecosistema.
 *
 * ⚠ WHAT IT COSTS, STATED: the seeded library has no `documento` left, so no
 * seeded row carries a `lengua` and every card reads "Testimonio".
 *
 * ⚠ A user's own upload is unaffected: it is a `documento` unless the
 * Investigador files it as a Voz. That is the owner's earlier rule ("docs
 * uploaded should be kept in their original form") and this ruling does not
 * change it.
 */
const SEEDED_CONTENT_KIND = 'testimonio' as const

/**
 * Genres the seed PUBLISHES once the gate has cleared them, so the library is
 * not empty. A seeded `testimonio`-genre row stays a draft, as before: the demo
 * still needs drafts to show the publish flow. So does a formato not listed
 * here — its title falls back to "Testimonio — …" — which is the safe direction:
 * it is still gated, it is just not published by the seed.
 */
const PUBLISHED_AFTER_GATE_FORMATOS: ReadonlySet<string> = new Set([
  'biografia_oral',
  'carta_presentacion',
  'diario_personal',
  'ficha_participante',
])

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
 * 🔴 THE ONLY WAY BACK TO A SEEDED TESTIMONIO'S THEME, AND IT EXISTS BECAUSE OF
 * A DELIBERATE OMISSION ELSEWHERE IN THIS FILE.
 *
 * A `documento` from an older seed carries its `SIM_xxxx` id in `name`, so the
 * backfill can join it straight to `MANIFEST.csv`. A seeded `testimonio` — every
 * seeded row today — deliberately does
 * NOT — see {@link titleFor}: that id is a key into a table with a `nombre`
 * column, and putting it on an anonymous row would rebuild the link the whole
 * anonymisation design refuses to keep.
 *
 * So the seeded Voces are unjoinable to the manifest, on purpose, and the
 * only ground truth still legible on the row is the theme this function wrote
 * into the title in plain Spanish. Reading it back is not a loophole in that
 * rule: the theme is four values over 250 documents, it is already displayed to
 * every reader of the library, and it points at nobody. `lengua` is NOT
 * recoverable this way and must not be — that is the half the rule protects.
 *
 * ⚠ Lives beside `THEME_LABELS` so the two cannot drift. Change one, change the
 * other, or the backfill silently stops matching.
 */
export function themeFromSeededTitle(name: string): string | null {
  for (const [ecosistema, label] of Object.entries(THEME_LABELS)) {
    if (name.includes(` — ${label} (`)) return ecosistema
  }
  return null
}

/**
 * 🔴 THE TITLE OF A SEEDED `testimonio` NAMES NOBODY, AND CARRIES NO HANDLE
 * BACK TO ANYBODY.
 *
 * `documents.name` is free text and it is what the library shows. Every seeded
 * row is a testimonio, so none carries its corpus id (older seeds put it on a
 * `documento`'s title; `publishesAfterGate` still recognises those).
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
function titleFor(entry: CorpusEntry, ordinal: number): string {
  // The genre stays on the row for whoever filed it; readers see "Testimonio".
  // ⚠ An unknown formato falls back to "Testimonio", which keeps it out of
  // `publishesAfterGate`: gated, and left a draft.
  const genre = FORMATO_LABELS[entry.formato] ?? 'Testimonio'
  return `${genre} — ${themeLabel(entry.ecosistema)} (${String(ordinal).padStart(2, '0')})`
}

/**
 * True for a SEEDED row of a genre in {@link PUBLISHED_AFTER_GATE_FORMATOS}.
 *
 * ⚠ THE GENRE IS READ OFF THE TITLE, because the row has nowhere else that
 * keeps it, and it is this file's own title shape (`titleFor`).
 *
 * 🔴 AND THE ROW MUST BE SEEDED. {@link ingestSeededDocuments} loads EVERY
 * document in the ecosistema, so a person's own draft that they happened to
 * title "Diario personal — …" would otherwise be published by a forced seed
 * (audit, 2026-10-21). Seeded means a `tema` (the seed writes one on every row;
 * `documents.tema` takes no API writes — `gateWritesOnly` in
 * `collections/Documents.ts`) or a SIM id in the title. A row that does not
 * match is simply not published — the safe direction.
 */
export function publishesAfterGate(row: { name?: unknown; tema?: unknown }): boolean {
  const name = row.name
  if (typeof name !== 'string') return false
  const tema = typeof row.tema === 'string' ? row.tema.trim() : ''
  if (tema === '' && !/\(SIM_\d+\)$/.test(name)) return false
  for (const formato of PUBLISHED_AFTER_GATE_FORMATOS) {
    if (name.startsWith(`${FORMATO_LABELS[formato]} — `)) return true
  }
  return false
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
 * How many documents an ecosistema must already hold before the corpus seed
 * treats it as already-seeded and refuses.
 *
 * Defaults to the manifest size — "it already has at least what I would add".
 * `SEED_CORPUS_SKIP_ABOVE` overrides it for the cases the default cannot know
 * about: several corpora in one ecosistema, or a deliberate top-up. A value that
 * is not a positive integer is IGNORED rather than obeyed, with a warning, so a
 * typo cannot silently disable the guard that stops a double seed.
 */
export function resolveSkipThreshold(
  manifestSize: number,
  raw: string | undefined = process.env.SEED_CORPUS_SKIP_ABOVE,
  warn: (message: string) => void = () => {},
): number {
  const trimmed = raw?.trim()
  if (!trimmed) return manifestSize
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warn(
      `[seed-corpus] SEED_CORPUS_SKIP_ABOVE=${trimmed} is not a positive integer — ` +
        `ignoring it and using the manifest size (${manifestSize}).`,
    )
    return manifestSize
  }
  return parsed
}

export interface SeedCorpusResult {
  /** Rows written. Every one is a `testimonio` draft; see {@link SEEDED_CONTENT_KIND}. */
  created: number
  corpusDir: string
}

export interface SeedCorpusOptions {
  organizationId: number
  /** Files the rows when there is no Investigador. Normally the platform admin. */
  uploaderId: number
  /**
   * Files every seeded row (all are `testimonio`).
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
 * 🔴 The seed refuses to run when the ecosistema ALREADY HOLDS THE CORPUS, and
 * `force` does not widen that. Re-seeding would mean DELETING 250 rows first,
 * and `collections/Documents.ts` retires a deleted document's chunks from
 * ai-service on the way out. A seed that quietly destroys corpus content on a
 * second run is a worse failure than a seed that refuses to run twice.
 *
 * ⚠ "ALREADY HOLDS THE CORPUS" USED TO MEAN "HAS ANY DOCUMENT AT ALL", AND THAT
 * WAS TOO TIGHT. A developer's ecosistema accumulates rows that have nothing to
 * do with the corpus — e2e runs leave them behind by the dozen, and so does any
 * manual upload. Under the old test, thirty-odd such rows made the demo library
 * permanently un-seedable, and the only remedies on offer were destructive:
 * delete real uploads, or reset the database. The seed was refusing in order to
 * protect content it had not written.
 *
 * So the test is now a THRESHOLD, not a presence check: skip once the ecosistema
 * holds at least as many documents as the manifest would add. That number is the
 * honest signal for "the corpus is already in here", it leaves ordinary residue
 * well below the line, and it still refuses the second run the old gate existed
 * to refuse. `SEED_CORPUS_SKIP_ABOVE` overrides it.
 *
 * ⚠ WHAT THIS TRADES AWAY, stated rather than discovered: delete a large chunk
 * of a seeded corpus and the count drops back under the line, so the next seed
 * tops it up and you get duplicates of everything still present. That is the
 * price of not requiring an empty ecosistema. To re-seed cleanly: drop the
 * corpus rows yourself, or reset the database.
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

  // 🔴 READ THE MANIFEST FIRST. The skip threshold below is derived from how many
  // documents this seed would ADD, so the manifest has to be in hand before the
  // count can be judged. Reading it is a few hundred stat-free CSV lines; the
  // ordering costs nothing and makes the threshold self-describing.
  const entries = readCorpusManifest(located.dir)
  if (entries.length === 0) {
    payload.logger.warn(`[seed-corpus] ${located.dir} has a manifest but no readable files.`)
    return null
  }

  const existing = await payload.count({
    collection: 'documents',
    where: { organization: { equals: opts.organizationId } },
  })
  const skipAbove = resolveSkipThreshold(entries.length)
  if (existing.totalDocs >= skipAbove) {
    payload.logger.info(
      `[seed-corpus] ecosistema ${opts.organizationId} already holds ${existing.totalDocs} ` +
        `documents, at or above the ${skipAbove} this seed would add — skipping. ` +
        'Set SEED_CORPUS_SKIP_ABOVE to change the line, or drop the corpus rows to re-seed.',
    )
    return null
  }
  if (existing.totalDocs > 0) {
    // Not a warning: this is the ordinary case on a developer box, and it is the
    // case the old zero-document gate got wrong. Say what is being added and to
    // what, so a library that ends up with more rows than the corpus has is
    // explained here rather than puzzled over later.
    payload.logger.info(
      `[seed-corpus] ecosistema ${opts.organizationId} already holds ${existing.totalDocs} ` +
        `documents (below the ${skipAbove} skip line) — seeding ${entries.length} alongside them.`,
    )
  }

  const startedAt = Date.now()
  const result: SeedCorpusResult = {
    created: 0,
    corpusDir: located.dir,
  }

  // Per-genre-and-theme counters, so a Voz is numbered without borrowing the corpus id.
  const testimonioOrdinals = new Map<string, number>()

  for (const entry of entries) {

    let text: string
    try {
      text = (await readCorpusText(entry)).trim()
    } catch (err) {
      payload.logger.warn(
        `[seed-corpus] could not read ${entry.archivo}: ${safeErrMessage(err)}`,
      )
      continue
    }
    if (!text) continue

    // Per genre AND theme, so "Carta de presentación — traducción en salud"
    // runs 01, 02, … on its own and no two titles repeat.
    const key = `${entry.formato}/${entry.ecosistema}`
    const ordinal = (testimonioOrdinals.get(key) ?? 0) + 1
    testimonioOrdinals.set(key, ordinal)

    await payload.create({
      collection: 'documents',
      data: {
        organization: opts.organizationId,
        uploadedBy: opts.investigadorId ?? opts.uploaderId,
        name: titleFor(entry, ordinal),
        kind: fileKindFor(entry),
        contentKind: SEEDED_CONTENT_KIND,
        /**
         * The corpus's ground truth, which the product had nowhere to put until
         * `documents.tema` / `documents.lengua` existed. Until then the only
         * place a theme or a language surfaced was as an accidentally-extracted
         * graph node, which a graph cleanup nearly deleted.
         *
         * ⚠ `tema`, not `ecosistema`. The manifest's column is called
         * `ecosistema`; in this product that word means an `organizations` row,
         * and all 250 of these live in ONE. See the field in
         * `collections/Documents.ts`.
         */
        tema: entry.ecosistema || null,
        /**
         * 🔴 NEVER ON A TESTIMONIO. `lengua` is the language of the person the
         * document is about — the manifest keeps it in the same row as `nombre`
         * — and on an anonymous Voz it is a re-identification key: 18 of the 34
         * `(tema, lengua)` cells the 59 seeded testimonios fall into hold
         * exactly one of them.
         *
         * ⚠ THIS LINE IS THE BELT, NOT THE BRACES. `enforceLenguaDocumentoOnly`
         * in `collections/Documents.ts` nulls the column for any non-`documento`
         * write, including this one, and a `read` gate on the field says the
         * same thing again. The check is repeated here so the seed READS as
         * obeying the rule rather than relying on a hook two files away.
         */
        lengua: null,
        /**
         * 🔴 ALWAYS A DRAFT. Publishing puts a document in front of the whole
         * ecosistema, and `corpusTextFor` refuses a gated row with no
         * `redactedText`. A seeded Voz has not been through the gate yet, so
         * `published` would be a state the product's own publish path refuses
         * to create. `ingestSeededDocuments` publishes what the gate clears.
         */
        publicationStatus: 'draft',
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
  }

  payload.logger.info(
    `[seed-corpus] ${result.created} documents in ${Date.now() - startedAt}ms from ${located.dir} ` +
      '(all testimonio drafts). ' +
      'NOTHING IS EMBEDDED, and every row stays a draft until the gate clears it, ' +
      'so the library is empty. ' +
      'Set SEED_CORPUS_INGEST=1 to run the gate and the real ingest pipeline.',
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
 * 🔴 THE SEED IS THROTTLED, BECAUSE ai-service IS. `/v1` allows 100 requests
 * per minute per API key (`lib/aiRetry.ts` has the incident). A dev run with
 * ingest on sent the corpus faster than that: publishes were refused and
 * testimonios were held with `transporte` errors when the gate's model calls
 * got a 429.
 *
 * Two brakes, both env-overridable:
 *
 *   · `SEED_INGEST_CONCURRENCY` (default 2) documents in flight at once.
 *   · `SEED_INGEST_SPACING_MS` (default 2000) between two starts, across all
 *     workers — at most 30 starts a minute.
 *
 * ⚠ The defaults are INFERRED, not measured: a published `documento` is one
 * request, a draft `testimonio` is three (two gate calls and an enqueue), so 30
 * starts a minute stays under 100 even if every one were a testimonio. The
 * graph extraction that follows each ingest also spends from the same key, and
 * this brake does not cover it.
 */
const DEFAULT_INGEST_CONCURRENCY = 2
const DEFAULT_INGEST_SPACING_MS = 2000

/**
 * The publish enqueue's 429 backoff for the seed: `beginPublish` waits the
 * server's own `retryAfterMs` (`RateLimitError`, via `withRateLimitRetry`).
 *
 * ⚠ Far more patient than the default ~2 min. That default exists because a
 * person is holding an HTTP request open (`lib/aiRetry.ts`); nobody is waiting
 * on a seed, and giving up only writes a `publicationError` onto a demo row.
 */
export const SEED_PUBLISH_RETRY = { attempts: 20, budgetMs: 15 * 60_000 } as const

/** How long one draft may take to clear the gate and enqueue before the seed moves on. */
const DRAFT_SETTLE_TIMEOUT_MS = 5 * 60_000
const DRAFT_POLL_MS = 2000

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

export interface IngestSeedOptions {
  /** Default `SEED_INGEST_CONCURRENCY`, else 2. */
  concurrency?: number
  /** Default `SEED_INGEST_SPACING_MS`, else 2000. */
  spacingMs?: number
  /**
   * Hold a draft's slot until its in-process work (gate, enqueue) has run. The
   * CLI sets it: that work runs in a `setImmediate` inside the hook, and without
   * the wait the throttle would bound only the re-saves, not the model calls —
   * and the CLI would exit with the gate still running.
   */
  awaitDrafts?: boolean
  /**
   * Only these document ids (as strings). For a targeted re-gate
   * (`scripts/regate-place-holds.ts`): without it every published row is
   * re-published as well.
   */
  onlyIds?: ReadonlySet<string>
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injected in tests: the retry jitter. */
  random?: () => number
}

/**
 * 🔴 THE OPT-IN. Hand every seeded row to the PRODUCT'S OWN pipeline — no
 * second ingest path, no shortcut around the anonymisation gate.
 *
 * Three routes, because a seeded row is in one of three honest states:
 *
 *   · `published` → `beginPublish`, which embeds into the ecosistema's SHARED
 *     corpus. This is what makes the seeded `published` column true; see the
 *     header. The row goes to `publishing` and the ai-service callback flips it
 *     back to `published`.
 *   · a gated draft of a genre in `PUBLISHED_AFTER_GATE_FORMATOS` → the gate,
 *     then `beginPublish` on the cleared text. A hold stays a draft for
 *     Revisión. See the branch below.
 *   · `draft` → a plain re-save with NO `__skipDocsExtract`, which is exactly
 *     what an ordinary edit does. `extractAndIngestHook` picks it up, skips
 *     extraction (the text is cached), runs the anonymisation gate for a
 *     `testimonio`, and enqueues into the uploader's draft corpus.
 *
 * ⚠ NEITHER PATH WAITS FOR ai-service TO FINISH EMBEDDING. `beginPublish`
 * returns when the job is ENQUEUED. With `awaitDrafts` a draft waits for its
 * gate and enqueue, not for the embedding. Expect rows to sit in `embedding` /
 * `publishing` for a while after the seed logs "done", and watch `ingestStatus`.
 *
 * ⚠ ONE FAILURE DOES NOT STOP THE REST. A document that cannot be enqueued is
 * logged and skipped: 249 embedded documents and one loud line is a better
 * demo than a seed that aborted a third of the way through.
 */
export type IngestSeedResult = { enqueued: number; failed: number; held: number }

/**
 * 🔴 ONE RUN PER ECOSISTEMA PER PROCESS. `payload run src/seed/demo.cli.ts`
 * boots Payload, and the boot seed starts this detached; the CLI then calls it
 * again in the same process. Two runs over the same snapshot gated the same
 * rows twice and left 13 testimonios `held` + `published` on dev (2026-10-21).
 * A second caller now waits for the run already going and gets its result.
 * The gate's own claim (`GATE_CLAIM_GUARD`) covers the cross-process case.
 */
const inFlightIngests = new Map<number, Promise<IngestSeedResult>>()

export function ingestSeededDocuments(
  payload: Payload,
  organizationId: number,
  opts: IngestSeedOptions = {},
): Promise<IngestSeedResult> {
  const running = inFlightIngests.get(organizationId)
  if (running) {
    payload.logger.info(
      `[seed-corpus] an ingest for ecosistema ${organizationId} is already running in this process — waiting for it.`,
    )
    return running
  }
  const run = runIngestSeededDocuments(payload, organizationId, opts).finally(() => {
    inFlightIngests.delete(organizationId)
  })
  inFlightIngests.set(organizationId, run)
  return run
}

async function runIngestSeededDocuments(
  payload: Payload,
  organizationId: number,
  opts: IngestSeedOptions = {},
): Promise<IngestSeedResult> {
  const { getAdminAIClient } = await import('@/lib/aiClient')
  const { ingestCallbackUrl } = await import('@/lib/callbackConfig')
  const { beginPublish } = await import('@/lib/publishDocument')
  const { anonymiseDocumentText } = await import('@/lib/anonymiseDocument')
  const { scheduleTestimonioTitle } = await import('@/lib/testimonioTitle')
  const { aiServiceDetector } = await import('@/lib/anonymise')
  const { throttledEach, waitForDraftSettled } = await import('./throttle')

  let client: unknown
  try {
    client = getAdminAIClient(organizationId)
  } catch (err) {
    // ⚠ Refuse the whole opt-in rather than half of it. Without an admin key
    // the publish path cannot retire the draft copy, and a partially-published
    // library is harder to reason about than an unembedded one.
    payload.logger.error(
      `[seed-corpus] SEED_CORPUS_INGEST is set but the AI service is not configured ` +
        `(${safeErrMessage(err)}). Nothing was ingested.`,
    )
    return { enqueued: 0, failed: 0, held: 0 }
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
    name?: unknown
    tema?: unknown
    contentKind?: unknown
    extractedText?: unknown
    publicationStatus?: unknown
    anonymisationStatus?: unknown
  }>

  const concurrency =
    opts.concurrency ?? positiveIntFromEnv('SEED_INGEST_CONCURRENCY', DEFAULT_INGEST_CONCURRENCY)
  const spacingMs =
    opts.spacingMs ?? positiveIntFromEnv('SEED_INGEST_SPACING_MS', DEFAULT_INGEST_SPACING_MS)
  const deps = {
    payload,
    client: client as never,
    callbackUrl: ingestCallbackUrl() ?? undefined,
    retry: {
      ...SEED_PUBLISH_RETRY,
      label: 'seed publish',
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.random ? { random: opts.random } : {}),
    },
  }
  const startedAt = Date.now()
  let enqueued = 0
  let failed = 0
  let unsettled = 0
  let held = 0
  let gateUnavailable = 0
  let skipped = 0

  /**
   * 🔴 THE DETECTOR GETS THE SEED'S PATIENCE TOO. Its default budget (4 tries /
   * 120 s, `aiRetry.ts`) is sized for a person waiting on an upload; two
   * full-window 429s exhaust it. Nobody waits on a seed, so each chunk waits
   * like `beginPublish` does. One detector per run: it holds no per-document
   * state (the allocator lives in the gate).
   */
  const detector = aiServiceDetector({
    organizationId,
    retry: {
      ...SEED_PUBLISH_RETRY,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.random ? { random: opts.random } : {}),
    },
  })

  // ⚠ A HELD ROW IS LEFT ALONE. The gate refused it; re-saving it would do
  // nothing (the hook skips held rows) and publishing it would be refused by
  // `corpusTextFor`. Touching it here would only add noise to the log.
  // ⚠ A row whose gate could not RUN is not held: it sits at `n/a` with a
  // `gate_unavailable` error, so it is in `todo` and is gated again here.
  const todo = rows.filter(
    (row) =>
      row.anonymisationStatus !== 'held' &&
      row.anonymisationStatus !== 'rejected' &&
      (!opts.onlyIds || opts.onlyIds.has(String(row.id))),
  )

  payload.logger.info(
    `[seed-corpus] ingesting ${todo.length} documents, ${concurrency} at a time, ` +
      `${spacingMs}ms apart (ai-service allows 100 requests/min per key).`,
  )

  await throttledEach(
    todo,
    async (row) => {
      try {
        if (row.publicationStatus !== 'published' && publishesAfterGate(row) && row.contentKind === 'testimonio') {
          /**
           * 🔴 GATE, THEN PUBLISH — and nothing else (#34). A biografía, carta,
           * ficha or diario is meant for the library, which shows published
           * rows only, and a gated row can be published only once the gate has
           * cleared it (`corpusTextFor`). So the gate runs here directly and
           * the cleared text goes straight to the shared corpus: no draft
           * ingest in between, so nothing waits on two corpora.
           *
           * ⚠ A HOLD STOPS HERE. The row stays a draft at `held`, which is
           * exactly what puts it in Revisión.
           */
          const cleared = row.anonymisationStatus === 'ready' || row.anonymisationStatus === 'approved'
          if (!cleared) {
            const gated = await anonymiseDocumentText({
              payload: payload as never,
              docId: row.id,
              organizationId,
              contentKind: row.contentKind,
              text: typeof row.extractedText === 'string' ? row.extractedText : '',
              detector,
            })
            if (!gated.ok) {
              // 🔴 Not claimed: another run owns this row, or it is already
              // decided or shared. Leave it alone — see `GATE_CLAIM_GUARD`.
              if (gated.busy) {
                skipped += 1
                return
              }
              // 🔴 A gate that could not run (429, 5xx, 402, timeout) is NOT a
              // hold: the row is left at `n/a` and the next run gates it again.
              if (gated.retryable) gateUnavailable += 1
              else held += 1
              return
            }
            // The title, from the gate's output only; detached, never awaited.
            scheduleTestimonioTitle({
              contentKind: row.contentKind,
              docId: row.id,
              organizationId,
              redactedText: gated.text,
              payload: payload as never,
            })
          }
          const fresh = await payload.findByID({
            collection: 'documents',
            id: row.id as never,
            depth: 0,
            overrideAccess: true,
          })
          await beginPublish(fresh as never, deps)
        } else if (row.publicationStatus === 'published') {
          await beginPublish(row as never, deps)
        } else {
          await payload.update({
            collection: 'documents',
            id: row.id as never,
            data: {},
            overrideAccess: true,
          })
          if (opts.awaitDrafts) {
            const settled = await waitForDraftSettled(
              async () =>
                (await payload.findByID({
                  collection: 'documents',
                  id: row.id as never,
                  depth: 0,
                  overrideAccess: true,
                })) as never,
              {
                pollMs: DRAFT_POLL_MS,
                timeoutMs: DRAFT_SETTLE_TIMEOUT_MS,
                ...(opts.sleep ? { sleep: opts.sleep } : {}),
              },
            )
            if (!settled) {
              unsettled += 1
              payload.logger.warn(
                `[seed-corpus] document ${row.id} had not cleared the gate and enqueue after ` +
                  `${DRAFT_SETTLE_TIMEOUT_MS / 60_000} min — moving on.`,
              )
            }
          }
        }
        enqueued += 1
      } catch (err) {
        failed += 1
        payload.logger.warn(
          `[seed-corpus] could not enqueue document ${row.id}: ${safeErrMessage(err)}`,
        )
      }
    },
    { concurrency, spacingMs },
  )
  if (held > 0) {
    payload.logger.info(`[seed-corpus] ${held} document(s) were held by the gate; they wait in Revisión.`)
  }
  if (gateUnavailable > 0) {
    failed += gateUnavailable
    payload.logger.warn(
      `[seed-corpus] ${gateUnavailable} document(s) could not be gated (ai-service did not answer: ` +
        'rate limit, 5xx, budget or timeout). NOT in Revisión — re-run the seed ingest to gate them.',
    )
  }
  if (skipped > 0) {
    payload.logger.info(`[seed-corpus] ${skipped} document(s) skipped: another gate run or a decision already holds them.`)
  }
  if (unsettled > 0) {
    payload.logger.warn(`[seed-corpus] ${unsettled} draft(s) were still in the gate when the seed moved on.`)
  }

  payload.logger.info(
    `[seed-corpus] ingest requested for ${enqueued} documents (${failed} refused) in ` +
      `${Date.now() - startedAt}ms. ⚠ ENQUEUED, NOT FINISHED — ai-service is still working; ` +
      'watch `ingestStatus` and `publicationStatus`.',
  )

  return { enqueued, failed, held }
}
