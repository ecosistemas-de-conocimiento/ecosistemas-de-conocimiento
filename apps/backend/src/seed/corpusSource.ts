/**
 * READING `corpus-generativo` IN PLACE. Nothing here copies a byte into this
 * repo.
 *
 * ── 🔴 THE CONTRACT, WHICH IS NOT NEW ────────────────────────────────────────
 *
 * `../corpus-generativo` is a SEPARATE repo (250 synthetic Mexican-Spanish
 * documents, regenerable with `gen_corpus.py` seed 445) and
 * `resultados/MANIFEST.csv` is its ground-truth table. `plan/handoff-fixtures-e2e.md`
 * wrote the rule down: the corpus is never vendored, it is read where it lives,
 * and `CORPUS_DIR` points at another checkout. A vendored copy forks from the
 * real one on the first regeneration and then quietly seeds yesterday's corpus.
 *
 * ── WHY THIS IS A SECOND READER AND NOT A REUSE OF `e2e/support/fixtures.ts` ─
 *
 * It reuses that module's BEHAVIOUR — `CORPUS_DIR`, read in place, never
 * committed, fail with the command that fixes it — but it cannot reuse its
 * code, and the reason is worth stating so nobody "unifies" them:
 *
 *   · `e2e/support/fixtures.ts` reads `fixtures.json`, a BUILT artefact that
 *     `scripts/corpus-fixtures.sh` writes. That file names exactly THREE
 *     documents (a pdf, a docx, an m4a) plus their marker words, because three
 *     is what an upload test needs.
 *   · The seed needs all 250 rows and their TEXT. That is `MANIFEST.csv`
 *     itself, and no build step stands between it and us.
 *   · They also live on opposite sides of a boundary: `e2e/` is not compiled
 *     into the app, and `src/seed/` is imported by `payload.config.ts`.
 *
 * So: same rules, different question. What must NEVER diverge is the path
 * resolution and the "absent is not fatal" behaviour, and both are here in one
 * function each.
 *
 * ⚠ EXTENSIONLESS IMPORTS, and no static import of anything heavy. This module
 * is reached from `seed/demo.ts`, which `payload.config.ts` imports for
 * `onInit` — so Next BUNDLES it. See the note at the top of `seed/admin.ts`.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where the corpus lives when `CORPUS_DIR` is unset: a sibling of this repo. */
const CORPUS_DIRNAME = 'corpus-generativo'

/** The manifest, relative to the corpus checkout. Same path the scripts use. */
const MANIFEST_RELATIVE = path.join('resultados', 'MANIFEST.csv')

/**
 * One row of `MANIFEST.csv`, narrowed to the columns the seed actually uses.
 *
 * ⚠ `nombre`, `edad`, `rol`, `origen`, `residencia` and `pariente` EXIST in the
 * CSV and are deliberately NOT on this type. They name the (synthetic) person a
 * document is about, and the one thing this seed must never do is put a
 * speaker's name on a row. Widening this interface is how that rule gets broken
 * by accident — the columns are unreachable from here on purpose.
 *
 * 🔴 `lengua` IS THE ONE EXCEPTION, AND IT IS ADMITTED UNDER A CONDITION.
 *
 * It belongs to the same person-describing block as the six above — same row,
 * same subject — so admitting it here is exactly the widening that warning
 * exists to prevent, and it needs its own argument rather than silence:
 *
 *   · It reaches `documents.lengua`, which `collections/Documents.ts` refuses to
 *     store on anything that is not a `documento` (`enforceLenguaDocumentoOnly`,
 *     and a `read` gate on the field saying the same thing). On a `documento`
 *     the person filed the material under their own name and the text says
 *     which language they speak; the column restates it. On a `testimonio` it
 *     is a re-identification key — 18 of the 34 `(tema, lengua)` cells the 59
 *     seeded testimonios fall into hold exactly ONE of them.
 *   · The other six have no such conditional reading. There is no content kind
 *     for which storing a speaker's `nombre` is fine, which is why they stay
 *     unreachable and this one does not.
 *
 * ⚠ SO THE RULE FOR ANYONE EDITING THIS TYPE IS UNCHANGED IN SPIRIT: a column
 * that describes the PERSON gets on here only if there is a written rule saying
 * where it may and may not land. `lengua` has one. Nothing else does.
 */
export interface CorpusEntry {
  /**
   * `SIM_0055` — the corpus's own filing reference.
   *
   * ⚠ Taken from the FILENAME, not from the manifest's `id` column. That column
   * is a plain 1..250 ordinal, which renumbers on every regeneration and reads
   * like nothing at all on a document title. The `SIM_` prefix is part of the
   * filename and is what a person would grep for.
   */
  id: string
  /** Filename inside `resultados/txt` or `resultados/docx`. */
  archivo: string
  /**
   * `traduccion | dengue | escuela | discapacidad` — the corpus's own theme.
   *
   * ⚠ It lands on `documents.tema`, NOT on a column called `ecosistema`. In this
   * product an ecosistema is an `organizations` row; all 250 of these are in one.
   * See the field's header in `collections/Documents.ts`.
   */
  ecosistema: string
  /**
   * The indigenous language of the person the row describes — NOT the language
   * the document is written in, which is Spanish for every one of them.
   *
   * 🔴 ONLY EVER WRITTEN ONTO A `documento`. Read the conditional in this file's
   * header before using it for anything else.
   */
  lengua: string
  /** `testimonio | biografia_oral | carta_presentacion | diario_personal | ficha_participante` */
  formato: string
  /** `corta | media | larga` */
  longitud: string
  /** Word count, as the generator counted it. */
  palabras: number
  /** Absolute path to the file this row describes. */
  sourcePath: string
  /** `.docx` files need mammoth; `.txt` files are read directly. */
  isDocx: boolean
}

/**
 * Where the corpus is, or `null`.
 *
 * 🔴 `null` IS A NORMAL ANSWER, NOT AN ERROR. A developer who has not cloned
 * the corpus must still get a working stack — the seed degrades to the
 * ecosistema it created before this existed. Throwing here would turn "I did
 * not clone an optional sibling repo" into "the backend does not boot", and
 * this module is reached from `onInit`.
 *
 * `CORPUS_DIR` wins outright when set, including when it points at nothing:
 * an operator who named a directory gets told that directory is wrong, rather
 * than silently falling back to a different corpus.
 */
export function resolveCorpusDir(): { dir: string } | { dir: null; reason: string } {
  const override = process.env.CORPUS_DIR?.trim()
  if (override) {
    return fs.existsSync(path.join(override, MANIFEST_RELATIVE))
      ? { dir: override }
      : { dir: null, reason: `CORPUS_DIR=${override} has no ${MANIFEST_RELATIVE}` }
  }

  /**
   * ⚠ WALK UP FROM `cwd`, do not resolve from this module's own path.
   * `process.cwd()` is `apps/backend` under `payload run` and the repo root
   * under some scripts, and after Next bundles this file `import.meta.url`
   * points into `.next/`, which is nowhere near the checkout. Walking ancestors
   * covers every one of those without knowing which one we are in.
   */
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, CORPUS_DIRNAME)
    if (fs.existsSync(path.join(candidate, MANIFEST_RELATIVE))) return { dir: candidate }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return {
    dir: null,
    reason:
      `no ${CORPUS_DIRNAME}/${MANIFEST_RELATIVE} in any ancestor of ${process.cwd()}. ` +
      `Clone it (git clone git@github.com:furenku/corpus-generativo.git) or set CORPUS_DIR.`,
  }
}

/**
 * A minimal RFC-4180 reader: quoted fields, doubled quotes, embedded commas
 * and newlines.
 *
 * ⚠ WRITTEN OUT RATHER THAN SPLIT ON COMMAS, because the manifest really does
 * quote — `"Huautla de Jiménez, Oaxaca"` is a single field, and a `split(',')`
 * would shift every column after it by one. It is also why this is not a
 * dependency: the whole parser is thirty lines and a new package in the backend
 * for one CSV is a worse trade.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '')
}

/**
 * Every manifest row whose file is actually on disk, in manifest order.
 *
 * ⚠ ORDER IS THE MANIFEST'S ORDER, and everything downstream (which documents
 * are published, which are testimonios) is a deterministic function of it. Two
 * runs against the same corpus therefore produce the same demo, which is what
 * makes "run the seed again and compare" a usable debugging move.
 *
 * ⚠ A row naming a missing file is DROPPED, not fatal. A partially-built corpus
 * checkout should seed what it has and say how many it skipped.
 */
export function readCorpusManifest(corpusDir: string): CorpusEntry[] {
  const manifestPath = path.join(corpusDir, MANIFEST_RELATIVE)
  const rows = parseCsv(fs.readFileSync(manifestPath, 'utf8'))
  const header = rows.shift()
  if (!header) return []

  const col = (name: string): number => header.indexOf(name)
  const iId = col('id')
  const iArchivo = col('archivo')
  const iEco = col('ecosistema')
  const iLengua = col('lengua')
  const iFormato = col('formato')
  const iLongitud = col('longitud')
  const iPalabras = col('palabras')
  if (iArchivo < 0 || iFormato < 0) {
    throw new Error(`${manifestPath} has no \`archivo\`/\`formato\` column — is this the manifest?`)
  }

  const entries: CorpusEntry[] = []
  for (const row of rows) {
    const archivo = row[iArchivo] ?? ''
    if (!archivo) continue
    const isDocx = archivo.toLowerCase().endsWith('.docx')
    const sourcePath = path.join(corpusDir, 'resultados', isDocx ? 'docx' : 'txt', archivo)
    if (!fs.existsSync(sourcePath)) continue
    entries.push({
      // `SIM_0055_traduccion_testimonio_larga.txt` → `SIM_0055`. Falls back to
      // the manifest ordinal for a corpus that does not use that convention.
      id: /^(SIM_\d+)/.exec(archivo)?.[1] || (row[iId] ?? '').trim() || archivo,
      archivo,
      ecosistema: (row[iEco] ?? '').trim(),
      // ⚠ Absent column ⇒ empty string, never a crash. `iLengua` is -1 for a
      // manifest that predates the column, and `row[-1]` is `undefined`. A
      // corpus without it seeds without it; nothing here is required.
      lengua: (row[iLengua] ?? '').trim(),
      formato: (row[iFormato] ?? '').trim(),
      longitud: (row[iLongitud] ?? '').trim(),
      palabras: Number.parseInt(row[iPalabras] ?? '', 10) || 0,
      sourcePath,
      isDocx,
    })
  }
  return entries
}

/**
 * The document's text.
 *
 * ⚠ `.docx` goes through MAMMOTH — the same extractor `collections/Documents.ts`
 * uses for a real upload. Rolling a second, simpler unzip-and-strip-tags reader
 * here would mean the seeded text differs from the text the product would have
 * extracted from the identical file, and every retrieval oddity traced to a
 * seeded document would first have to rule that out.
 *
 * Imported dynamically so the bundled `onInit` path does not pull mammoth in
 * on a boot that never reads a corpus.
 */
export async function readCorpusText(entry: CorpusEntry): Promise<string> {
  if (!entry.isDocx) return sanitise(fs.readFileSync(entry.sourcePath, 'utf8'))
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: entry.sourcePath })
  return sanitise(result.value)
}

/**
 * 🔴 STRIP NUL BYTES. Not defensive padding — this aborts the seed.
 *
 * Postgres refuses a NUL character in a `text` column with `22021 invalid byte sequence
 * for encoding "UTF8"`, and the error names a bind parameter (`unnamed portal
 * parameter $17`) rather than a column or a row, so a single bad character in
 * one of 250 files fails the insert with nothing to say which file it was. This
 * seed hit exactly that during development.
 *
 * The corpus is generated text and should never contain one — but it comes from
 * a repo this one does not control, it is regenerated by a script, and a
 * truncated `.docx` extracts to something with NULs in it. Dropping the
 * character costs nothing and turns "the seed dies with an opaque driver error"
 * into "one document is missing an unprintable character".
 */
function sanitise(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text
}
