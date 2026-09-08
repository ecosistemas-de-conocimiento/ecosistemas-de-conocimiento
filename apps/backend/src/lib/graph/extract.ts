/**
 * EXTRACTION — text in, a merged graph out. No database, no I/O except the one
 * call to ai-service. `plan/adr-corpus-graph.md` §5.
 *
 * Three jobs, in order:
 *
 *   1. WINDOW the text on paragraph boundaries, because quality degrades badly
 *      over a whole PDF in one call and `/v1/generate`'s body limit is 1 MiB.
 *   2. CALL `generate.sync` once per window with the prompt and JSON Schema in
 *      the `specDefault` FLOOR slot, at `effortLevel: 'deep'`.
 *   3. MERGE the windows by canonical key, summing `occurrences`.
 *
 * ── 🔴 THE PERSON RULE, MECHANISM 2 OF 2 (ADR §5.3) ────────────────────────
 *
 * {@link dropForbiddenPersonas} runs UNCONDITIONALLY on every parsed window,
 * before anything is merged and long before anything is written. It does not
 * ask what schema was sent, whether the schema was honoured, or what the model
 * meant. It reads `contentKind` — a column — and drops every `persona` unless
 * that column says `documento`.
 *
 * Two mechanisms for one rule is deliberate. The schema variant is the
 * efficient one; THIS is the one that still holds if the schema is edited
 * wrongly, if a project registers a `graph-extract` unit-type that re-admits
 * `persona` (a registry row outranks the `specDefault` floor), if a future model
 * ignores the enum, or if ai-service's strict `parsed` gate is ever relaxed.
 *
 * ── 🔴 THE GENERIC-LABEL RULE (prompt `v3`) ────────────────────────────────
 *
 * {@link dropGenericEntities} runs on every parsed window, right after the
 * person rule, and drops a `lugar`, `organizacion` or `persona` whose label is
 * a bare common noun — `barranca`, `escuela`, `clínica`, `mercado`. Prompt
 * rule 3 has forbidden exactly this since `v1`; the model did not obey. So the
 * rule now lives in code, and the prompt is the cheap second layer. Same
 * division of labour as the person rule, for the same reason: what the code
 * checks is worth more than what the model is asked.
 *
 * 🔴 IT DOES NOT TOUCH `tema`. A one-word `tema` is the corpus's SUBJECT —
 * `náhuatl`, `discapacidad`, `dengue` — and `documents` has no other column
 * carrying any of it. {@link GENERIC_RULE_TYPES} holds the full reasoning and
 * the measurement; read it before widening the rule.
 *
 * ⚠ IT RUNS AT EXTRACTION TIME, NEVER AT READ TIME. A filter in `queries.ts`
 * would change what the view shows the moment the code landed — unversioned,
 * unstamped and invisible to anyone measuring the graph. This one is stamped
 * `GRAPH_PROMPT_VERSION` and takes effect only when a document is re-extracted.
 *
 * ⚠ INFERENCE COSTS MONEY. Nothing in this module retries a window, and nothing
 * loops over generation. One call per window, capped at
 * `GRAPH_EXTRACT_MAX_WINDOWS`. A failed window is counted and skipped.
 */

import { canonicalKey, displayLabel } from './normalise'
import {
  GRAPH_EXTRACT_UNIT_TYPE,
  GRAPH_FRAGMENT_MAX_CHARS,
  GRAPH_PROMPT_VERSION,
  graphBuiltInSpec,
  graphUnitKey,
} from './prompt'
import {
  isGraphEntityType,
  isGraphRelationType,
  personaAllowed,
  snippetAllowed,
  type GraphEntityType,
  type GraphExtraction,
  type GraphRelationType,
  type MergedEntity,
  type MergedRelation,
} from './types'

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** ADR §5.2. Overridable so a deployment can trade quality against cost. */
export const graphWindowChars = (): number => envInt('GRAPH_EXTRACT_WINDOW_CHARS', 12000)

/**
 * ⚠ THE RUNAWAY BRAKE. Eight windows is ~96k characters, and a document longer
 * than that is extracted from its beginning only. At hundreds of documents that
 * is a handful of very long PDFs; without the cap one pathological upload can
 * spend the whole extraction budget by itself.
 *
 * ⚠ A truncated extraction currently looks IDENTICAL to a complete one on the
 * row — `graphStatus` says `ready` either way. `GraphExtraction.truncated`
 * carries the fact for a caller that wants it. The ADR's stated fix if that
 * matters later is a `graphWindows` column, not a bigger cap.
 */
export const graphMaxWindows = (): number => envInt('GRAPH_EXTRACT_MAX_WINDOWS', 8)

/**
 * Split text into windows on PARAGRAPH boundaries.
 *
 * ⚠ Paragraphs, not characters, because a window that stops mid-sentence
 * produces entities that are artefacts of the cut. A single paragraph longer
 * than one window is hard-split at the last whitespace before the limit — a
 * transcript with no blank lines is exactly that case, and it must not become
 * one unbounded window.
 */
export function splitIntoWindows(
  text: string,
  opts: { windowChars?: number; maxWindows?: number } = {},
): { windows: string[]; truncated: boolean } {
  // ⚠ `??` KEEPS AN EXPLICIT `0`, and a zero window size makes the hard-split
  // loop below advance by nothing: `rest.slice(0)` forever, `pieces` growing
  // until the process dies. `envInt` guards the environment path; this guards
  // the direct-argument one. Both floors are a positive integer.
  const windowChars = Math.max(1, Math.floor(opts.windowChars ?? graphWindowChars()) || 0) || 1
  const maxWindows = Math.max(1, Math.floor(opts.maxWindows ?? graphMaxWindows()) || 0) || 1

  const source = (text ?? '').trim()
  if (!source) return { windows: [], truncated: false }

  // Keep the blank line that separated two paragraphs: it is a real signal to
  // the model about where one idea ends.
  const paragraphs = source.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)

  const pieces: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= windowChars) {
      pieces.push(paragraph)
      continue
    }
    let rest = paragraph
    while (rest.length > windowChars) {
      const slice = rest.slice(0, windowChars)
      const cut = slice.lastIndexOf(' ')
      const at = cut > windowChars * 0.5 ? cut : windowChars
      pieces.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) pieces.push(rest)
  }

  const windows: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (!current) {
      current = piece
      continue
    }
    if (current.length + 2 + piece.length <= windowChars) {
      current = `${current}\n\n${piece}`
      continue
    }
    windows.push(current)
    current = piece
  }
  if (current) windows.push(current)

  if (windows.length <= maxWindows) return { windows, truncated: false }
  return { windows: windows.slice(0, maxWindows), truncated: true }
}

// ---------------------------------------------------------------------------
// Parsing one model response
// ---------------------------------------------------------------------------

/** One entity as the model returns it, after shape-checking. */
interface RawEntity {
  tipo: GraphEntityType
  etiqueta: string
  menciones: number
  fragmento: string | null
}

interface RawRelation {
  desde: string
  hacia: string
  tipo: GraphRelationType
}

export interface ParsedWindow {
  entities: RawEntity[]
  relations: RawRelation[]
}

/**
 * Read one `parsed` payload defensively.
 *
 * ⚠ `parsed` IS `unknown`, AND WE NEVER PARSE `text` BY HAND. ai-service
 * surfaces `parsed` only if the response validated against the full JSON Schema
 * (`router.ts:120-135`), so its absence means the model produced something the
 * contract does not describe. Re-deriving it from the raw text would throw that
 * guarantee away for the sake of salvaging a bad window (ADR §5.2).
 *
 * Returns `null` when the payload is not usable at all; the caller counts that
 * as a failed window.
 */
export function parseWindowResponse(parsed: unknown): ParsedWindow | null {
  if (!parsed || typeof parsed !== 'object') return null
  const body = parsed as { entidades?: unknown; relaciones?: unknown }
  if (!Array.isArray(body.entidades)) return null

  const entities: RawEntity[] = []
  for (const item of body.entidades) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (!isGraphEntityType(row.tipo)) continue
    const etiqueta = displayLabel(typeof row.etiqueta === 'string' ? row.etiqueta : '')
    // An entity with no usable label has no identity, so it is not an entity.
    if (!etiqueta || !canonicalKey(etiqueta)) continue
    const menciones = Number(row.menciones)
    // 🔴 THE SLICE IS THE CAP THAT ACTUALLY HOLDS. `maxLength` in the JSON
    // Schema is a request; ai-service withholds `parsed` when a response misses
    // the schema, but nothing here may depend on a length rule having been
    // honoured before the bytes are stored. Same number as the schema, imported
    // rather than repeated — see `GRAPH_FRAGMENT_MAX_CHARS`.
    const fragmento =
      typeof row.fragmento === 'string' && row.fragmento.trim()
        ? row.fragmento.trim().slice(0, GRAPH_FRAGMENT_MAX_CHARS)
        : null
    entities.push({
      tipo: row.tipo,
      etiqueta,
      menciones: Number.isFinite(menciones) && menciones >= 1 ? Math.floor(menciones) : 1,
      fragmento,
    })
  }

  const relations: RawRelation[] = []
  if (Array.isArray(body.relaciones)) {
    for (const item of body.relaciones) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (!isGraphRelationType(row.tipo)) continue
      const desde = displayLabel(typeof row.desde === 'string' ? row.desde : '')
      const hacia = displayLabel(typeof row.hacia === 'string' ? row.hacia : '')
      if (!desde || !hacia) continue
      relations.push({ desde, hacia, tipo: row.tipo })
    }
  }

  return { entities, relations }
}

/**
 * Drop the entities a predicate rejects, AND every relation that touched one.
 *
 * ⚠ THE EDGES ARE NOT OPTIONAL. `mergeWindows` would drop a dangling edge
 * anyway — but only if nothing else in the document happens to share the
 * dropped label. If something does, the edge silently re-attaches to the wrong
 * node, which is worse than losing it. Removing the edges here, by canonical
 * key, is what makes that impossible.
 *
 * Private on purpose: the two callers below are the two rules, and each states
 * its own reason. This function is only the mechanics they share.
 */
function dropEntitiesWhere(
  window: ParsedWindow,
  reject: (entity: RawEntity) => boolean,
): ParsedWindow {
  const removed = new Set<string>()
  const entities = window.entities.filter((e) => {
    if (!reject(e)) return true
    removed.add(canonicalKey(e.etiqueta))
    return false
  })
  if (removed.size === 0) return { entities, relations: window.relations }

  const relations = window.relations.filter(
    (r) => !removed.has(canonicalKey(r.desde)) && !removed.has(canonicalKey(r.hacia)),
  )
  return { entities, relations }
}

/**
 * 🔴 THE PERSON RULE'S SECOND ENFORCEMENT POINT. ADR §5.3, mechanism 2.
 *
 * Unconditional: it runs on every window of every document, whatever schema was
 * sent and whatever the model returned. `contentKind` is read as a value, never
 * inferred, and the comparison is `=== 'documento'` so an unknown or missing
 * value produces no person nodes (see `personaAllowed`).
 *
 * ⚠ Relations touching a dropped person are dropped with it. An edge whose
 * endpoint no longer exists would be resolved against some OTHER entity that
 * happens to share the label, which is worse than losing the edge.
 */
export function dropForbiddenPersonas(
  window: ParsedWindow,
  contentKind: string | null | undefined,
): ParsedWindow {
  if (personaAllowed(contentKind)) return window
  return dropEntitiesWhere(window, (e) => e.tipo === 'persona')
}

// ---------------------------------------------------------------------------
// 🔴 THE GENERIC-LABEL RULE — rule 3 of the prompt, made checkable
// ---------------------------------------------------------------------------

/**
 * Spanish CLOSED-CLASS function words: articles, prepositions, contractions and
 * the coordinating conjunctions.
 *
 * 🔴 THIS IS GRAMMAR, NOT A STOP-LIST, and the difference is the whole design.
 * A stop-list of NOUNS ("barranca", "escuela", "español") is what this rule
 * deliberately is not: it would be unbounded, hand-maintained, fitted to one
 * corpus, and useless the day a second ecosistema arrives with a different
 * vocabulary. This list is finite, closed (Spanish has not gained a preposition
 * in centuries) and carries no opinion about any subject matter. It exists only
 * so that "la barranca" cannot evade the rule by wearing an article — prompt
 * rule 2 forbids the article, and this is what happens when rule 2 is ignored
 * too.
 */
const SPANISH_FUNCTION_WORDS = new Set([
  // articles
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo',
  // contractions
  'al', 'del',
  // prepositions
  'a', 'ante', 'bajo', 'con', 'contra', 'de', 'desde', 'en', 'entre', 'hacia',
  'hasta', 'para', 'por', 'según', 'sin', 'sobre', 'tras',
  // conjunctions
  'y', 'e', 'o', 'u', 'ni', 'que',
])

/** Any uppercase letter, ANYWHERE in the token — `Ó`, `Ñ` and `CIDE` included. */
const HAS_UPPERCASE = /\p{Lu}/u

/** Leading and trailing punctuation, so `"Carlos` compares as `Carlos`. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/**
 * The words in a label that carry meaning — everything that is not grammar.
 *
 * Exported for the tests, which assert the tokenisation directly rather than
 * only through {@link isGenericLabel}: a silent tokenisation bug would make the
 * whole rule pass everything, and a suite of rejection assertions cannot see
 * that (00-context.md's warning about negative-only suites).
 */
export function significantTokens(label: string): string[] {
  return (label ?? '')
    .split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => token.length > 0 && !SPANISH_FUNCTION_WORDS.has(token.toLowerCase()))
}

/**
 * 🔴 IS THIS LABEL A BARE COMMON NOUN, WITH NO NAME IN IT?
 *
 * A PURE, TYPE-BLIND PREDICATE. Whether a bare common noun is a defect depends
 * entirely on the type it was given, and that judgement lives one level up in
 * {@link GENERIC_RULE_TYPES}. Do not add a type check here.
 *
 * ── THE MEASUREMENT THIS EXISTS FOR ────────────────────────────────────────
 *
 * On the `v2` corpus the highest-degree nodes included `barranca` (lugar, 49
 * documents) and `escuela` typed as an `organizacion` (22). Neither is a place
 * or an institution — they name a CLASS of thing. A hub node that means nothing
 * joins documents that have nothing to do with each other, in a view whose
 * entire purpose is finding real patterns across testimonies — and it inflates
 * the support counts `GRAPH_MIN_SUPPORT` gates on (ADR §7.3), so a generic
 * label clears the privacy threshold that a specific one may not.
 *
 * ⚠ `español` (46) and `discapacidad` (27) were on that same list and are NOT
 * defects: they are `tema`, and a `tema` is allowed to be one word. That is the
 * whole reason this predicate is not applied to every type.
 *
 * ── THE RULE, AND WHY IT IS ORTHOGRAPHIC ───────────────────────────────────
 *
 * A label is generic when it has FEWER THAN TWO significant words and its one
 * word carries no uppercase letter.
 *
 *   · TWO OR MORE significant words ⇒ kept, always. The qualifier is the thing
 *     that makes a common noun into an entity, and it is exactly what prompt
 *     rule 3 asks for: "acceso al agua potable" over "agua". Measured against
 *     the 524 multi-word entities in the corpus, this needs no further test —
 *     that half of the data was already good.
 *   · ONE significant word ⇒ kept only if it looks like a PROPER NOUN.
 *
 * 🔴 Distinguishing `Morelos` from `barranca` needs either a Spanish lexicon or
 * orthography, and orthography is what exists in code. Spanish capitalises
 * proper nouns and does not capitalise common nouns, so the capital IS the
 * signal — and it is a rule of the language, not a fact about this corpus,
 * which is what makes it generalise to the next ecosistema. Measured on the
 * 176 one-word entities in the corpus it separates them cleanly: all 55
 * capitalised ones are real (Morelos, Cuernavaca, Oaxaca, Chenalhó, Óscar,
 * CIDE, PILARES, LSM…), and not one is a common noun.
 *
 * ⚠ WHAT THIS RULE IS NOT ALLOWED TO TOUCH — see {@link GENERIC_RULE_TYPES}.
 * Applied to every type, this predicate eats the corpus's own subject
 * vocabulary: `náhuatl`, `mixteco`, `discapacidad`, `dengue`. So it is applied
 * ONLY to the types that name a particular. The predicate itself stays pure and
 * type-blind; the scoping lives in {@link dropGenericEntities}.
 */
export function isGenericLabel(label: string): boolean {
  const tokens = significantTokens(label)
  // Nothing but grammar, or nothing at all. Not an entity either way.
  if (tokens.length === 0) return true
  if (tokens.length >= 2) return false
  return !HAS_UPPERCASE.test(tokens[0])
}

/**
 * 🔴 THE TYPES THE GENERIC-NOUN RULE APPLIES TO, AND WHY IT IS ONLY THESE.
 *
 * `lugar`, `organizacion` and `persona` name a PARTICULAR — one specific place,
 * one specific institution, one specific individual. A bare common noun typed
 * as one of these is a CATEGORY ERROR, and it is wrong whatever the corpus is
 * about: `escuela` is not a named organisation in any corpus, `barranca` is not
 * a place, `tallerista` is not a person. That is exactly the complaint the task
 * was opened for — `escuela` typed as an `organizacion`, 22 documents.
 *
 * 🔴 `tema` IS EXEMPT, AND THIS IS THE LOAD-BEARING EXCLUSION. A `tema` names a
 * CONCEPT, and a concept is very often exactly one common noun. Measured
 * against this corpus, a type-blind rule would have deleted:
 *
 *   · THE ENTIRE LANGUAGE AXIS. All 250 documents carry a `lengua`, 11 distinct
 *     ones, and EVERY one of them lands on `tema`: `náhuatl` (25 documents),
 *     `mixteco` (18), `mazateco` (11), `zapoteco` (9), `totonaco` (7),
 *     `tlahuica` (5), `tlapaneco` (5), `amuzgo` (4), `hñähñu` (3), `tsotsil`
 *     (3), `mixe` (2), plus `español` (45).
 *   · THREE OF THE FOUR SUBJECTS THE CORPUS IS ORGANISED BY: `discapacidad`
 *     (27), `dengue` (4), `traducción` (1).
 *
 * ⚠ AND THERE IS NOWHERE ELSE TO GET THEM. `documents` has no language, theme
 * or ecosistema column — checked in `information_schema`. The graph is the only
 * place this vocabulary surfaces in the product, so dropping it is not a
 * quality trade, it is deleting the corpus's ground truth.
 *
 * ⚠ `evento` IS ALSO EXEMPT, less certainly. The prompt defines it as "un hecho
 * o un proceso", and a PROCESS is a concept — so a bare noun there is not the
 * unambiguous category error it is for the three types above. The cost is
 * named: `conversatorio` (27 documents) survives as a generic hub, as do
 * `pandemia` (16) and `huracán` (10), which may or may not be real referents.
 * Adding `'evento'` to this set is the one-line change if that trade flips.
 */
const GENERIC_RULE_TYPES: ReadonlySet<GraphEntityType> = new Set<GraphEntityType>([
  'lugar',
  'organizacion',
  'persona',
])

/**
 * Drop the entities whose label is a bare common noun where a NAME was
 * required, and the edges that touched one.
 *
 * 🔴 THE PRIMARY DEFENCE, and it runs at EXTRACTION time, never at read time.
 * Prompt rule 3 has forbidden this since `v1` and the model does not obey it; a
 * rule the code checks is worth more than a rule the model is asked to follow,
 * which is the same conclusion the person rule reached (ADR §5.3) for the same
 * reason. The prompt is still sharpened alongside it — as the cheap layer that
 * tries to make the drop unnecessary, not as the guarantee.
 *
 * ⚠ Filtering here rather than in `queries.ts` is deliberate. A read-time
 * filter would change what the view shows the moment the code lands, with no
 * re-extraction and no version stamp — a silent, unversioned change to a
 * surface someone may be measuring. `GRAPH_PROMPT_VERSION` is what makes this
 * one findable and reversible; a read-time filter would have no stamp at all.
 *
 * ⚠ IT LOGS WHAT IT DROPS, unconditionally. If a future model lowercases every
 * label, this rejects every one-word place, organisation and person in the
 * corpus at once, and during a multi-hour backfill the log is the only place
 * that is visible before the money is spent.
 */
export function dropGenericEntities(window: ParsedWindow): ParsedWindow {
  const reject = (e: RawEntity): boolean =>
    GENERIC_RULE_TYPES.has(e.tipo) && isGenericLabel(e.etiqueta)

  const dropped = window.entities.filter(reject)
  if (dropped.length === 0) return window
  console.log(
    '[graph] etiquetas genéricas descartadas:',
    dropped.map((e) => `${e.tipo}/${e.etiqueta}`).join(', '),
  )
  return dropEntitiesWhere(window, reject)
}

// ---------------------------------------------------------------------------
// Merging windows
// ---------------------------------------------------------------------------

/**
 * Identity within one document's extraction is `(type, canonicalKey)` — the
 * same pair the database's UNIQUE index uses, minus the organization, which is
 * constant for one document.
 */
const entityKey = (type: GraphEntityType, key: string): string => `${type}::${key}`

/**
 * Merge every window's entities and relations into one graph.
 *
 * `occurrences` is SUMMED across windows: an entity named in three windows of
 * one document is one mention row with `occurrences: 3`, not three rows
 * (ADR §4.1 — `graph_mentions` is one row per `(document, entity)` pair).
 *
 * The first surface form seen becomes `label`; the rest become `aliases`.
 * The first non-empty `fragmento` becomes the candidate snippet — and it is
 * still the writer, not this function, that decides whether it may be stored.
 */
export function mergeWindows(
  windows: ParsedWindow[],
  contentKind: string | null | undefined,
): { entities: MergedEntity[]; relations: MergedRelation[] } {
  const byKey = new Map<string, MergedEntity>()
  /** canonicalKey → the merged entity, for resolving relation endpoints. */
  const byCanonical = new Map<string, MergedEntity>()

  for (const window of windows) {
    for (const raw of window.entities) {
      const key = canonicalKey(raw.etiqueta)
      if (!key) continue
      const id = entityKey(raw.tipo, key)
      const existing = byKey.get(id)
      if (!existing) {
        const entity: MergedEntity = {
          type: raw.tipo,
          label: raw.etiqueta,
          canonicalKey: key,
          occurrences: raw.menciones,
          aliases: [],
          // ⚠ Held, not yet stored. `writer.ts` drops it unless the document is
          // a `documento` (ADR §7.3.4).
          snippet: snippetAllowed(contentKind) ? raw.fragmento : null,
        }
        byKey.set(id, entity)
        // First type wins for an ambiguous canonical key; see below.
        if (!byCanonical.has(key)) byCanonical.set(key, entity)
        continue
      }
      existing.occurrences += raw.menciones
      if (raw.etiqueta !== existing.label && !existing.aliases.includes(raw.etiqueta)) {
        existing.aliases.push(raw.etiqueta)
      }
      if (!existing.snippet && snippetAllowed(contentKind)) existing.snippet = raw.fragmento
    }
  }

  // ⚠ Endpoints are LABELS, resolved by canonical key (ADR §5.4). When two
  // entities of different types fold to the same key ("Oaxaca" the lugar and
  // "Oaxaca" the organizacion), the first one seen wins. Rare, and the
  // alternative — dropping both edges — loses more than it protects.
  const relations = new Map<string, MergedRelation>()
  for (const window of windows) {
    for (const raw of window.relations) {
      const from = byCanonical.get(canonicalKey(raw.desde))
      const to = byCanonical.get(canonicalKey(raw.hacia))
      // 🔴 A DANGLING EDGE IS WORSE THAN A MISSING ONE (ADR §5.4).
      if (!from || !to) continue
      if (from.canonicalKey === to.canonicalKey) continue
      const id = `${from.canonicalKey}|${to.canonicalKey}|${raw.tipo}`
      if (relations.has(id)) continue
      relations.set(id, {
        fromKey: from.canonicalKey,
        toKey: to.canonicalKey,
        type: raw.tipo,
      })
    }
  }

  return { entities: [...byKey.values()], relations: [...relations.values()] }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** The slice of `@edc/ai-client` this module uses. Faked in tests. */
export interface GraphGenerateClient {
  generate: {
    sync(req: {
      unit: Record<string, unknown>
      [k: string]: unknown
    }): Promise<{ parsed?: unknown; text?: string; costUsd?: number }>
  }
}

/**
 * True when this 400 is an ai-service that predates the `specDefaultSlot`
 * capability rejecting the key, rather than a real complaint about the request.
 *
 * Copied in shape from `packages/ai-client/src/text-to-sql.ts:78-84`, including
 * the reason for matching the FIELD NAME rather than a bare 400: anything else
 * is the caller's to see.
 */
function isUnknownSpecDefaultKey(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; message?: unknown }
  return e.status === 400 && typeof e.message === 'string' && /specDefault/.test(e.message)
}

/**
 * Sticky downgrade to the pre-`specDefault` wire shape, per process. Set once,
 * on the first 400 that names the key, so an old deployment costs one wasted
 * round-trip rather than one per window of every document forever.
 */
let legacySpecSlot = false

/** Test seam — resets the sticky downgrade between cases. */
export function __resetSpecSlotForTests(): void {
  legacySpecSlot = false
}

export interface ExtractGraphArgs {
  docId: string | number
  /** 🔴 The privacy control. Read from the column; never inferred. */
  contentKind: string | null | undefined
  text: string
  title?: string | null
  client: GraphGenerateClient
  windowChars?: number
  maxWindows?: number
  /** Where a failed window is reported. Defaults to `console.warn`. */
  onWindowError?: (windowIndex: number, err: unknown) => void
}

/**
 * Extract one document's graph.
 *
 * Throws only if EVERY window failed — that is a real failure the caller should
 * record on `graphStatus`. A partial result (some windows failed) is returned
 * with `windowsFailed` set, because a document whose second window timed out
 * still has a usable first window and dropping it helps nobody.
 */
export async function extractGraph(args: ExtractGraphArgs): Promise<GraphExtraction> {
  const { docId, contentKind, client } = args
  const allowPersona = personaAllowed(contentKind)
  const spec = graphBuiltInSpec(allowPersona)

  const { windows, truncated } = splitIntoWindows(args.text ?? '', {
    windowChars: args.windowChars,
    maxWindows: args.maxWindows,
  })

  if (windows.length === 0) {
    return {
      entities: [],
      relations: [],
      windows: 0,
      windowsFailed: 0,
      truncated: false,
      promptVersion: GRAPH_PROMPT_VERSION,
    }
  }

  const parsedWindows: ParsedWindow[] = []
  let windowsFailed = 0
  /**
   * 🔴 WHY THE REASONS ARE COLLECTED AND NOT ONLY LOGGED.
   *
   * The 11 documents that failed the first corpus run all carry the same
   * `graphError`: `graph_extract_failed: every extraction window failed
   * (1 of 1)`. The per-window message BELOW already carries the raw response
   * text — but it only ever reached `onWindowError`, which defaults to
   * `console.warn`, so the evidence died with the process and the row said
   * nothing. `schedule.ts`'s `recordFailure` persists THIS throw, so carrying
   * the first reason into it is what actually makes a repeat run diagnose
   * itself. `generate.sync` writes no `generation_jobs` row, so there is no
   * other way to see the response without paying for the call again.
   */
  const failureReasons: string[] = []

  for (let i = 0; i < windows.length; i++) {
    const input = {
      titulo: args.title ?? 'Sin título',
      texto: windows[i],
      ventana: String(i + 1),
      ventanas: String(windows.length),
    }

    let result: { parsed?: unknown; text?: string }
    try {
      result = await callWindow({ client, docId, windowIndex: i, input, spec })
    } catch (err) {
      windowsFailed++
      failureReasons.push(err instanceof Error ? err.message : String(err))
      ;(args.onWindowError ?? defaultWindowError)(i, err)
      continue
    }

    const shaped = parseWindowResponse(result.parsed)
    if (!shaped) {
      windowsFailed++
      // 🔴 CARRY THE RAW TEXT INTO THE ERROR. `parsed` is withheld whenever the
      // response misses the JSON Schema, and without the text the failure is
      // indistinguishable from "the model returned nothing" — which is exactly
      // the dead end the first real run hit. `generate.sync` persists no
      // `generation_jobs` row, so `GET /v1/generate/units/:key/latest` cannot
      // replay it either: if this message does not carry the evidence, the only
      // way to see it is to pay for the call again.
      const reason = `no usable \`parsed\` payload (schema miss or empty completion)${responsePreview(result.text)}`
      failureReasons.push(reason)
      ;(args.onWindowError ?? defaultWindowError)(i, new Error(reason))
      continue
    }

    // 🔴 UNCONDITIONAL, and before the merge. Privacy first: the person rule
    // runs whatever the model returned, and only then does the quality rule.
    // Neither depends on the other's output, so the order is a statement of
    // which one may never be skipped rather than a data dependency.
    parsedWindows.push(dropGenericEntities(dropForbiddenPersonas(shaped, contentKind)))
  }

  if (parsedWindows.length === 0) {
    // ⚠ `recordFailure` slices `graphError` to 500 characters and prefixes
    // ~25 of its own. The reason is capped so the tail of the evidence is not
    // the part that gets cut.
    const why = failureReasons[0] ? ` — ${failureReasons[0].slice(0, 400)}` : ''
    throw new Error(
      `every extraction window failed (${windows.length} of ${windows.length})${why}`,
    )
  }

  const { entities, relations } = mergeWindows(parsedWindows, contentKind)

  return {
    entities,
    relations,
    windows: windows.length,
    windowsFailed,
    truncated,
    promptVersion: GRAPH_PROMPT_VERSION,
  }
}

/**
 * The raw response, as evidence, HEAD AND TAIL.
 *
 * 🔴 THE TAIL IS THE DIAGNOSIS. The failure this exists for is a completion cut
 * off mid-array — the model runs out of output budget rather than closing the
 * JSON — and the only thing that tells a cut-off array apart from a malformed
 * one is what the LAST characters look like. A head-only preview, which is what
 * this was, shows a perfectly well-formed opening every time and says nothing.
 */
function responsePreview(text: string | undefined): string {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return ' — the response carried no text either'
  if (body.length <= 300) return ` — response text was: ${body}`
  const omitted = body.length - 300
  return ` — response text was: ${body.slice(0, 150)} […${omitted} chars…] ${body.slice(-150)}`
}

function defaultWindowError(windowIndex: number, err: unknown): void {
  console.warn('[graph] extraction window', windowIndex, 'failed:', err)
}

/** One `/v1/generate/sync` call, with the built-in spec in the chosen slot. */
async function callWindow(args: {
  client: GraphGenerateClient
  docId: string | number
  windowIndex: number
  input: Record<string, unknown>
  spec: ReturnType<typeof graphBuiltInSpec>
}): Promise<{ parsed?: unknown; text?: string }> {
  const { client, docId, windowIndex, input, spec } = args

  const send = async (
    slot: 'specDefault' | 'specOverride',
  ): Promise<{ parsed?: unknown; text?: string }> => {
    const res = await client.generate.sync({
      unit: {
        // ⚠ STABLE KEY, and it is only half as useful as the ADR hoped.
        // `GET /v1/generate/units/:unitKey/latest` reads `generation_jobs`,
        // which the ASYNC path writes — `generate.sync` does not persist a row,
        // so a sync run cannot be replayed. Measured: that endpoint 404s for a
        // key a sync call has just used. The key still identifies the window in
        // a trace; it does not buy free inspection.
        unitKey: graphUnitKey(docId, windowIndex),
        unitType: GRAPH_EXTRACT_UNIT_TYPE,
        input,
        [slot]: spec,
      },
    })
    return { parsed: res?.parsed, text: res?.text }
  }

  if (legacySpecSlot) return send('specOverride')

  try {
    return await send('specDefault')
  } catch (err) {
    // Only the one condition a retry can fix. A real 400, a budget refusal, an
    // auth error or a network fault is the caller's to see.
    if (!isUnknownSpecDefaultKey(err)) throw err
    legacySpecSlot = true
    return send('specOverride')
  }
}
