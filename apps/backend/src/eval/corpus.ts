/**
 * The ground truth, COMPUTED — never asserted.
 *
 * Two sources, joined:
 *
 *  1. `corpus-generativo/resultados/MANIFEST.csv` — the seeded regularities.
 *     One row per generated resource, with `nombre`, `sitio_ancla`, `lengua`,
 *     `origen`, `rol`, `ecosistema`, `pariente`, `cruce_ecosistema`.
 *  2. `edc_backend.documents` — what actually got ingested, and what is
 *     PUBLISHED. Retrieval only ever sees published rows.
 *
 * ── THREE THINGS THE JOIN TAUGHT US, ALL OF WHICH CHANGE THE ANSWER ─────────
 *
 * 🔴 1. `documents.name LIKE 'SIM\_%'` matches NOTHING. The seed id is a
 *    SUFFIX in parentheses — `Biografía oral — traducción en salud (SIM_0002)`
 *    (`apps/backend/src/seed/corpus.ts:titleFor`). The join key is the
 *    `SIM_\d{4}` substring.
 *
 * 🔴 2. Only 191 of the manifest's 250 rows are in the database as joinable
 *    documents, and ALL 191 are published. The missing 59 are exactly the
 *    `formato = 'testimonio'` rows: the seeder gives a testimonio an ordinal
 *    title with NO SIM id and `publicationFor()` returns `draft` for every one
 *    of them. So the 61 gate-held testimonios cannot be joined AND cannot be
 *    retrieved — two independent reasons, both correct, and together they mean
 *    the expected answers here are drawn from `documento` rows only.
 *
 * 🔴 3. THE MANIFEST COLUMN IS NOT THE FACT. `sitio_ancla` names an anchor
 *    site, but 55 of the 191 published documents never write it into their
 *    text — the short `diario_personal` and some `carta_presentacion` variants
 *    simply do not mention it. Expecting a fact a document does not contain
 *    would penalise both arms for the corpus generator's choices. So every
 *    support count below is computed by matching the fact IN THE DOCUMENT'S
 *    `extracted_text`, and the manifest is used only for the VOCABULARY of
 *    facts and for the per-document local questions.
 *
 * ⚠ A fourth, smaller trap: the manifest writes `"José G. Parres"` with straight
 * quotes and the corpus text writes it with typographic ones. Before that was
 * normalised (`text.ts:fold`), 71 of 191 documents falsely read as not
 * mentioning their own anchor site.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { selectJson } from './db'
import { EVAL_ORGANIZATION_ID, type EvalEnv } from './env'
import { containsAny } from './text'

export interface ManifestRow {
  id: string
  archivo: string
  /** `traduccion` | `dengue` | `escuela` | `discapacidad`. A column, not a tenant. */
  ecosistema: string
  formato: string
  nombre: string
  rol: string
  lengua: string
  origen: string
  residencia: string
  sitio_ancla: string
  cruce_ecosistema: string
  pariente: string
}

/** A published document, joined to its manifest row. */
export interface CorpusDoc {
  /** Payload `documents.id`. The citation join key. */
  documentId: number
  /** `SIM_0002`. */
  sim: string
  name: string
  text: string
  manifest: ManifestRow
}

// ── MANIFEST.csv ───────────────────────────────────────────────────────────

/** Minimal RFC-4180 reader. The manifest quotes fields containing commas. */
export function parseCsv(raw: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]
    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...body] = rows
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

export function loadManifest(env: EvalEnv): ManifestRow[] {
  const raw = readFileSync(path.join(env.corpusRoot, 'MANIFEST.csv'), 'utf8')
  return parseCsv(raw) as unknown as ManifestRow[]
}

// ── The join ───────────────────────────────────────────────────────────────

interface DocRow {
  id: number
  name: string
  extracted_text: string | null
}

/**
 * Every PUBLISHED document of the eval ecosistema that carries a `SIM_xxxx` id,
 * joined to its manifest row.
 *
 * ⚠ `publication_status = 'published'` is in the SQL, not filtered afterwards,
 * for the same reason the graph queries put it there: it is the gate, and a
 * gate applied in application code is a gate someone removes by accident.
 */
export async function loadCorpus(env: EvalEnv): Promise<CorpusDoc[]> {
  const manifest = loadManifest(env)
  const bySim = new Map<string, ManifestRow>()
  for (const row of manifest) {
    const m = /SIM_\d{4}/.exec(row.archivo)
    if (m) bySim.set(m[0], row)
  }

  const rows = await selectJson<DocRow>(
    env,
    env.backendDb,
    `SELECT id, name, extracted_text
       FROM documents
      WHERE organization_id = ${EVAL_ORGANIZATION_ID}
        AND publication_status = 'published'
        AND name ~ 'SIM_[0-9]{4}'
      ORDER BY id`,
  )

  const out: CorpusDoc[] = []
  for (const row of rows) {
    const m = /SIM_\d{4}/.exec(row.name)
    if (!m) continue
    const manifestRow = bySim.get(m[0])
    if (!manifestRow) continue
    out.push({
      documentId: row.id,
      sim: m[0],
      name: row.name,
      text: row.extracted_text ?? '',
      manifest: manifestRow,
    })
  }
  return out
}

// ── Facts ──────────────────────────────────────────────────────────────────

/**
 * One expected fact: a label an answer may name, and the surface forms that
 * count as naming it.
 *
 * ⚠ THE ALIASES ARE THE DISTINCTIVE CORE, NOT THE FULL NAME. The corpus writes
 * `el Centro de Salud de Tlayacapan`; an answer may write `Tlayacapan` or
 * `Centro de Salud de Tlayacapan`. Requiring the full string would score a
 * correct answer as wrong. Requiring too LITTLE would score a wrong answer as
 * right — so each core is chosen to be unique in this corpus (`Tlayacapan`,
 * `Parres`, `Monsiváis`, `ovitrampa`), never a common Spanish word.
 */
export interface Fact {
  label: string
  aliases: string[]
}

/** How many published documents' text names this fact. */
export function factSupport(docs: readonly CorpusDoc[], fact: Fact): number {
  return docs.filter((d) => containsAny(d.text, fact.aliases)).length
}

/** The documents whose text names this fact — the citation-precision oracle. */
export function factDocuments(docs: readonly CorpusDoc[], fact: Fact): Set<number> {
  return new Set(docs.filter((d) => containsAny(d.text, fact.aliases)).map((d) => d.documentId))
}
