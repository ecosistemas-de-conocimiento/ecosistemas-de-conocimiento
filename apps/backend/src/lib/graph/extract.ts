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
 * 🔴 THE ORTHOGRAPHIC RULE DOES NOT TOUCH `tema`. A one-word `tema` is the
 * corpus's SUBJECT — `discapacidad`, `dengue`, `escuela`, and its 11
 * indigenous languages, `náhuatl`, `mixteco`. Since `v4` a `tema` is refused
 * only for two closed word classes: `español`, the language almost the whole
 * corpus is written in, and an unnamed geographic noun (a `lugar` with no
 * name). {@link GRAPH_SHAPE_POLICY} and
 * {@link GRAPH_WORD_CLASSES} hold the reasoning and the measurement; read them
 * before widening the rule.
 *
 * 🔴 LANGUAGES AND REDACTION PLACEHOLDERS are a separate rule since
 * 2026-10-21 — {@link dropNoiseEntities}, `noise.ts` — dropped for EVERY type,
 * and the one rule here that is also applied at read time. It supersedes the
 * "indigenous languages stay `tema`" decision described above.
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

import { mustPassAnonymisationGate } from '@/lib/anonymiseDocument'
import { isGraphNoiseLabel } from './noise'
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
  publicPersonaKept,
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
  /** The model's `figura_publica`, true only when it said literally `true`. */
  figuraPublica?: boolean
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
      // 🔴 Fail-closed: anything but a literal `true` is "not public".
      figuraPublica: row.figura_publica === true,
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
  // 🔴 Owner, 2026-10-24: no private individuals in the graph. A `documento`
  // keeps only the personas the model marked `figura_publica: true`; the mark
  // is judged per window, so one window marking her public is enough for that
  // window's mention to survive.
  return dropEntitiesWhere(
    window,
    (e) => e.tipo === 'persona' && !publicPersonaKept(contentKind, e.figuraPublica),
  )
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
 * {@link GRAPH_SHAPE_POLICY}. Do not add a type check here.
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
 * ⚠ `discapacidad` (27) was on that same list and is NOT a defect: it is a
 * `tema`, and a `tema` is allowed to be one word. That is the whole reason
 * this predicate is not applied to every type. (`español` was on it too; since
 * `v4` it is refused as a language by {@link wordClassOf}, not by this.)
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
 * ⚠ WHAT THIS RULE IS NOT ALLOWED TO TOUCH — see {@link GRAPH_SHAPE_POLICY}.
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
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  LA POLÍTICA DE FORMA DEL GRAFO — EDITA ESTO, NO EL CÓDIGO DE ABAJO       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Esta tabla dice, para cada tipo de entidad, si su etiqueta DEBE contener un
 * nombre propio o si puede ser un sustantivo común a secas. Es una decisión de
 * criterio documental, no de programación: quien la revise puede ser una
 * lingüista o una archivista. Todo lo que hace falta para cambiarla está aquí.
 *
 * ── CÓMO CAMBIARLA ────────────────────────────────────────────────────────
 *
 *   1. Cambia `requiresProperName` del tipo que quieras, y ACTUALIZA su
 *      `rationale` y su `cost` — el motivo viaja con la regla a propósito.
 *   2. Mide qué pasaría, sin gastar en extracción y sin tocar nada:
 *
 *          GRAPH_POLICY_ORG=1 payload run src/lib/graph/policy.cli.ts
 *
 *      Imprime esta misma tabla y, contra el corpus real, cuántas entidades
 *      se descartarían y cuáles.
 *   3. 🔴 NADA CAMBIA EN LA VISTA HASTA QUE SE VUELVA A EXTRAER. Esta política
 *      se aplica al ESCRIBIR el grafo, nunca al leerlo. Para que surta efecto
 *      hay que subir {@link GRAPH_PROMPT_VERSION} y correr el backfill, que
 *      cuesta horas y dinero. Es deliberado: así una política nueva no
 *      reescribe en silencio una vista que alguien esté midiendo.
 *
 * ⚠ NO ES UNA LISTA DE PALABRAS PROHIBIDAS. La regla que se aplica es
 * ortográfica ({@link isGenericLabel}): en español los nombres propios se
 * escriben con mayúscula y los sustantivos comunes no. Esta tabla sólo decide
 * A QUÉ TIPOS se les exige ese nombre. La única lista de palabras es
 * {@link GRAPH_WORD_CLASSES} (v4), y `excludes` decide a qué tipo no le toca
 * cada clase: son palabras con otro sitio, no palabras malas.
 *
 * ⚠ EL COMPILADOR EXIGE QUE ESTÉN TODOS LOS TIPOS. El `satisfies` de abajo
 * falla si se añade un tipo de entidad al ontología y no se decide su forma,
 * que es exactamente cuando alguien tiene que pensarlo.
 */
export interface GraphShapeRule {
  /**
   * `true`  → la etiqueta debe nombrar a UNO en concreto (lleva mayúscula, o
   *           lleva un calificador que la vuelve identificable).
   * `false` → la etiqueta puede ser un sustantivo común de una sola palabra.
   */
  requiresProperName: boolean
  /**
   * Clases de palabra ({@link GRAPH_WORD_CLASSES}) que este tipo NO admite
   * como etiqueta de una sola palabra, aunque `requiresProperName` sea `false`.
   * Vacío → ninguna. Es para las palabras que SÍ tienen un sitio, sólo que no
   * es este tipo.
   */
  excludes: readonly GraphWordClass[]
  /** Qué nombra este tipo, en una línea. */
  rule: string
  /** Por qué se decidió así. */
  rationale: string
  /** Qué cuesta esta decisión, medido contra el corpus — no estimado. */
  cost: string
}

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  CLASES DE PALABRA QUE TIENEN OTRO SITIO — v4                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * La regla ortográfica no distingue `español` de `discapacidad`: en español
 * ni las lenguas ni los conceptos llevan mayúscula. Hace falta saber QUÉ
 * palabra es, y para eso sólo hay una lista.
 *
 * ⚠ NO ES UNA LISTA DE PALABRAS BASURA, y la diferencia importa. Cada clase
 * es CERRADA y corta, y cada una tiene un motivo que no es opinión sobre el
 * asunto del corpus:
 *
 *   · `lengua` → sólo `español`: no distingue nada, porque casi todo el
 *     corpus está en español. Las lenguas indígenas NO están aquí.
 *   · `lugarSinNombre` → el tipo `lugar`, donde la regla ortográfica ya la
 *     descarta por no tener nombre.
 *
 * ── LO QUE SE MIDIÓ — `edc_backend` local, ecosistema 1, 2026-10-16 ─────────
 *
 * Grafo `v3`, sólo lectura. `v3` descartó `barranca` como `lugar` (quedan 4
 * documentos) y el modelo la RE-TIPÓ como `tema` (24 documentos): la regla de
 * `v3` tenía una salida, y la propia regla 3 del prompt se la señalaba ("si el
 * texto trata SOBRE el mercado como asunto, eso es un tema"). Igual `colonia`
 * (10). Y `español` creció a 93 documentos como `tema`: el nodo más grande del
 * grafo, y no dice nada, porque casi todo el corpus está en español.
 *
 * Una palabra entra aquí comparada por `canonicalKey` (sin acentos, en
 * minúsculas), así que `náhuatl` y `nahuatl` son la misma. También se
 * reconoce el plural (`barrancas`) y la forma con núcleo (`idioma español`). Una etiqueta con CALIFICADOR no se toca:
 * `contaminación de barrancas` y `lengua de señas mexicana` son temas.
 */
export const GRAPH_WORD_CLASSES = {
  lengua: {
    rule: 'La lengua en que está escrito casi todo el corpus: el español.',
    rationale:
      'Casi todo el corpus está en español, así que como nodo "español" une ' +
      'casi todos los documentos y no distingue ninguno. ⚠ Desde el ' +
      '2026-10-21 el dueño quitó TODAS las lenguas del grafo, de cualquier ' +
      'tipo (noise.ts, dropNoiseEntities); esta clase queda como la primera ' +
      'versión de esa regla.',
    cost:
      'Medido en el grafo v3 el 2026-10-16: descarta un solo nodo, español ' +
      '(93 documentos), el más grande del grafo.',
    words: ['español', 'castellano'],
  },
  lugarSinNombre: {
    rule: 'Una clase de accidente geográfico o de asentamiento, sin nombre.',
    rationale:
      'Una "barranca" o una "colonia" sin nombre es un LUGAR que no dice cuál. ' +
      'Como lugar ya se descarta; tipada como tema sobrevivía, y v3 lo hizo ' +
      'así. Se quedan fuera a propósito ejido, comunidad, bosque y selva, que ' +
      'en este corpus también son asuntos.',
    cost:
      'Medido en el grafo v3: descarta barranca (24 documentos) y colonia (10). ' +
      'NO toca mercado (10), clínica (6) ni hospital (3): son espacios ' +
      'construidos, no geografía, y quedan como decisión abierta.',
    words: [
      'barranca', 'cañada', 'arroyo', 'río', 'cerro', 'monte', 'montaña', 'sierra',
      'valle', 'laguna', 'lago', 'manantial', 'presa', 'playa', 'costa',
      'colonia', 'barrio', 'pueblo', 'municipio', 'localidad', 'ranchería',
      'ciudad', 'calle', 'avenida',
      // ⚠ Fuera a propósito: `manzana` y `cuadra` (fruta, establo), y en la
      // lista de lenguas `mayo` (el mes) y `mexicano` (el gentilicio).
    ],
  },
} as const satisfies Record<
  string,
  { rule: string; rationale: string; cost: string; words: readonly string[] }
>

export type GraphWordClass = keyof typeof GRAPH_WORD_CLASSES

/** Núcleos que se quitan antes de comparar: `idioma español` → `español`. */
const WORD_CLASS_HEADS = new Set(['lengua', 'lenguas', 'idioma', 'idiomas'])

const WORD_CLASS_KEYS: ReadonlyMap<GraphWordClass, ReadonlySet<string>> = new Map(
  (Object.keys(GRAPH_WORD_CLASSES) as GraphWordClass[]).map((cls) => [
    cls,
    new Set(GRAPH_WORD_CLASSES[cls].words.map((w) => canonicalKey(w))),
  ]),
)

/**
 * ¿A qué clase de {@link GRAPH_WORD_CLASSES} pertenece esta etiqueta, si a
 * alguna? Pura y ciega al tipo, igual que {@link isGenericLabel}: qué tipo
 * rechaza qué clase lo dice {@link GRAPH_SHAPE_POLICY}.
 *
 * Sólo una etiqueta de UNA palabra significativa (tras quitar artículos,
 * preposiciones y un núcleo `lengua`/`idioma`) puede pertenecer a una clase.
 * Con calificador ya es otra cosa: `contaminación de barrancas`.
 */
export function wordClassOf(label: string): GraphWordClass | null {
  const tokens = significantTokens(label).map((t) => canonicalKey(t))
  const core = tokens.length === 2 && WORD_CLASS_HEADS.has(tokens[0]) ? tokens.slice(1) : tokens
  if (core.length !== 1) return null
  const key = core[0]
  // Singular, o plural regular: `barrancas`, `ciudades`, `ríos`.
  const forms = [key, key.replace(/s$/, ''), key.replace(/es$/, '')]
  for (const [cls, keys] of WORD_CLASS_KEYS) {
    if (forms.some((f) => keys.has(f))) return cls
  }
  return null
}

export const GRAPH_SHAPE_POLICY = {
  lugar: {
    requiresProperName: true,
    excludes: [],
    rule: 'Un lugar nombra UN sitio concreto, no una clase de sitio.',
    rationale:
      'Una "barranca", un "mercado" o una "clínica" son tipos de espacio, no ' +
      'lugares. El nodo resultante une documentos que no tienen nada que ver ' +
      'entre sí, y era el nodo más grande del corpus.',
    cost:
      'Descarta 9 de 84 lugares: barranca (34 documentos), clínica, mercado, ' +
      'colonia, escuela, hospital. Ninguno es un lugar identificable.',
  },
  organizacion: {
    requiresProperName: true,
    excludes: [],
    rule: 'Una organización nombra UNA institución concreta.',
    rationale:
      'Nombrar una clase de institución ("escuela", "universidad") no dice de ' +
      'cuál se habla. Era el error de categoría que abrió esta tarea.',
    cost:
      'Descarta 18 de 75 organizaciones: escuela (12 documentos), ' +
      'epidemiólogos, abogados, ingenieros, universidad, comité, cooperativa. ' +
      'El tema "escuela" no se pierde: vive en la columna documents.tema.',
  },
  persona: {
    requiresProperName: true,
    excludes: [],
    rule: 'Una persona nombra a UN individuo, con su nombre.',
    rationale:
      'El propio prompt la define como "una persona nombrada en el texto". ' +
      '"Tallerista" o "vecina" son roles, no personas.',
    cost: 'Descarta 5 de 202 personas: tallerista, ingeniero, vecina.',
  },
  tema: {
    requiresProperName: false,
    excludes: ['lengua', 'lugarSinNombre'],
    rule: 'Un tema nombra un CONCEPTO, y un concepto suele ser una sola palabra.',
    rationale:
      '🔴 LA EXENCIÓN MÁS IMPORTANTE DE ESTA TABLA. Exigirle nombre propio a ' +
      'un tema borra el vocabulario propio del corpus: discapacidad, dengue, ' +
      'traducción, escuela — los cuatro asuntos del corpus, todos de una ' +
      'palabra — y sus 11 lenguas: náhuatl, mixteco, mazateco, zapoteco, ' +
      'totonaco, tlahuica, tlapaneco, amuzgo, hñähñu, tsotsil, mixe. Desde v4 ' +
      'hay dos excepciones: "español", que une casi todo el corpus, y una ' +
      'barranca o una colonia sin nombre, que es un lugar. Ver ' +
      'GRAPH_WORD_CLASSES.',
    cost:
      'Exigir nombre propio aquí descartaría 3 de 4 asuntos del corpus. Las ' +
      'dos excepciones de v4, medidas en el grafo v3 el 2026-10-16: 3 nodos, ' +
      'español (93 documentos, el más grande del grafo), barranca (24) y ' +
      'colonia (10).',
  },
  evento: {
    requiresProperName: false,
    excludes: [],
    rule: 'Un evento nombra un hecho O UN PROCESO, y un proceso es un concepto.',
    rationale:
      'El prompt lo define como "un hecho o un proceso con desarrollo en el ' +
      'tiempo". Un proceso ("migración", "pandemia") es un concepto, así que ' +
      'un sustantivo común aquí no es el error de categoría claro que sí es ' +
      'en lugar, organizacion y persona. Es la decisión menos firme de la ' +
      'tabla y la primera que habría que revisar.',
    cost:
      'No descarta ninguno: 0 de 99. El precio está a la vista: ' +
      '"conversatorio" (27 documentos) sobrevive como nodo genérico, igual ' +
      'que pandemia (16) y huracán (10).',
  },
} as const satisfies Record<GraphEntityType, GraphShapeRule>

/**
 * Does this entity type require its label to carry a name?
 *
 * ⚠ FAILS OPEN — an unknown type KEEPS its entity. This is a quality rule, not
 * a privacy rule, and the two fail in opposite directions on purpose: losing a
 * good entity is worse than keeping a bad one, whereas for the person rule
 * (`personaAllowed`) it is the other way round. `parseWindowResponse` has
 * already rejected any type outside the ontology before this is reached, so in
 * practice the lookup is total; this is what happens if that ever stops
 * being true.
 */
function requiresProperName(type: GraphEntityType): boolean {
  return GRAPH_SHAPE_POLICY[type]?.requiresProperName === true
}

/**
 * Is this word class one the type refuses? Fails open like
 * {@link requiresProperName}: an unknown type excludes nothing.
 */
function excludesClass(type: GraphEntityType, cls: GraphWordClass | null): boolean {
  if (!cls) return false
  const excluded: readonly GraphWordClass[] = GRAPH_SHAPE_POLICY[type]?.excludes ?? []
  return excluded.includes(cls)
}

/**
 * 🔴 THE ONE PREDICATE THE POLICY COMPILES TO. `dropGenericEntities` applies it
 * and `policy.cli.ts` measures it, so the simulation cannot drift from the
 * rule. `requiresName` lets the CLI simulate another `requiresProperName`.
 */
export function policyRejects(
  type: GraphEntityType,
  label: string,
  requiresName: (type: GraphEntityType) => boolean = requiresProperName,
): boolean {
  return (requiresName(type) && isGenericLabel(label)) || excludesClass(type, wordClassOf(label))
}

export function dropGenericEntities(window: ParsedWindow): ParsedWindow {
  const reject = (e: RawEntity): boolean => policyRejects(e.tipo, e.etiqueta)

  const dropped = window.entities.filter(reject)
  if (dropped.length === 0) return window
  console.log(
    '[graph] etiquetas genéricas descartadas:',
    dropped.map((e) => `${e.tipo}/${e.etiqueta}`).join(', '),
  )
  return dropEntitiesWhere(window, reject)
}

/**
 * 🔴 NO LANGUAGE AND NO REDACTION PLACEHOLDER IS EVER A NODE, of any type.
 * Owner decision 2026-10-21; the label sets and the reasoning are in
 * `noise.ts`. Unlike the shape policy above, this rule ALSO runs at read time
 * (`queries.ts`), so rows written before it are hidden without a re-extraction.
 */
export function dropNoiseEntities(window: ParsedWindow): ParsedWindow {
  const reject = (e: RawEntity): boolean => isGraphNoiseLabel(e.etiqueta)
  const dropped = window.entities.filter(reject)
  if (dropped.length === 0) return window
  console.log(
    '[graph] lenguas y marcadores de anonimización descartados:',
    dropped.map((e) => `${e.tipo}/${e.etiqueta}`).join(', '),
  )
  return dropEntitiesWhere(window, reject)
}

// ---------------------------------------------------------------------------
// ⚠ QUALIFIED PLACE NAMES — "Cuernavaca, Morelos" IS CUERNAVACA (backlog #16)
// ---------------------------------------------------------------------------

/** `Lugar, Contenedor` — exactly one comma, both halves non-empty. */
const QUALIFIED_PLACE = /^([^,]+),\s*([^,]+)$/

/**
 * Split a `lugar` written as "Cuernavaca, Morelos" into the place, the place
 * that contains it, and the `ubicado_en` edge between them.
 *
 * WHY. The model writes a place with its state attached about as often as
 * without, and `canonicalKey` rightly treats the two spellings as different
 * strings. The demo corpus had twelve such pairs — Cuernavaca / "Cuernavaca,
 * Morelos", Xoxocotla / "Xoxocotla, Morelos", Juchitán / "Juchitán, Oaxaca"…
 * (measured 2026-10-21, local `edc_backend`, org 1) — so every one of those
 * places showed up twice in "Lugares", each with half the support.
 *
 * The qualifier is not thrown away: it is the information "this place is in
 * that one", which is exactly what `ubicado_en` says. Edges that named the
 * qualified label are re-pointed at the bare place.
 *
 * ⚠ CONSERVATIVE BY DESIGN. Only `lugar`, only one comma, only when the
 * container starts with a capital letter (a proper name, not "…, centro"), and
 * only when the bare place still passes the generic-label rule. Anything else
 * is left exactly as the model wrote it.
 */
export function splitQualifiedPlaces(window: ParsedWindow): ParsedWindow {
  const renamed = new Map<string, string>()
  const entities: RawEntity[] = []
  const added: RawEntity[] = []
  const relations: RawRelation[] = []

  const knownPlaces = new Set(
    window.entities.filter((e) => e.tipo === 'lugar').map((e) => canonicalKey(e.etiqueta)),
  )

  for (const entity of window.entities) {
    const match = entity.tipo === 'lugar' ? QUALIFIED_PLACE.exec(entity.etiqueta) : null
    const place = match ? displayLabel(match[1]) : ''
    const container = match ? displayLabel(match[2]) : ''
    if (
      !match ||
      !place ||
      !container ||
      !HAS_UPPERCASE.test(container.charAt(0)) ||
      canonicalKey(place) === canonicalKey(container) ||
      policyRejects('lugar', place) ||
      policyRejects('lugar', container)
    ) {
      entities.push(entity)
      continue
    }
    renamed.set(canonicalKey(entity.etiqueta), place)
    entities.push({ ...entity, etiqueta: place })
    const containerKey = canonicalKey(container)
    if (!knownPlaces.has(containerKey)) {
      knownPlaces.add(containerKey)
      added.push({ tipo: 'lugar', etiqueta: container, menciones: 1, fragmento: null })
    }
    relations.push({ desde: place, hacia: container, tipo: 'ubicado_en' })
  }

  if (renamed.size === 0) return window

  for (const relation of window.relations) {
    relations.push({
      ...relation,
      desde: renamed.get(canonicalKey(relation.desde)) ?? relation.desde,
      hacia: renamed.get(canonicalKey(relation.hacia)) ?? relation.hacia,
    })
  }

  return { entities: [...entities, ...added], relations }
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
          publicFigure: raw.tipo === 'persona' && publicPersonaKept(contentKind, raw.figuraPublica),
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
  /** Wait before the one retry of a transient failure. Test seam. */
  retryDelayMs?: number
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
      result = await callWindowWithRetry(
        () => callWindow({ client, docId, windowIndex: i, input, spec }),
        args.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS,
      )
    } catch (err) {
      windowsFailed++
      // 🔴 A thrown client error may echo the response; a gated kind keeps only its class.
      const safe = mustPassAnonymisationGate(contentKind)
        ? new Error(`window call failed (${err instanceof Error ? err.name : typeof err})`)
        : err
      failureReasons.push(safe instanceof Error ? safe.message.slice(0, 400) : String(safe).slice(0, 400))
      ;(args.onWindowError ?? defaultWindowError)(i, safe)
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
      const reason = `no usable \`parsed\` payload (schema miss or empty completion)${responsePreview(result.text, contentKind)}`
      failureReasons.push(reason)
      ;(args.onWindowError ?? defaultWindowError)(i, new Error(reason))
      continue
    }

    // 🔴 UNCONDITIONAL, and before the merge. Privacy first: the person rule
    // runs whatever the model returned, and only then does the quality rule.
    // Neither depends on the other's output, so the order is a statement of
    // which one may never be skipped rather than a data dependency.
    // Then the place split: it only renames and adds `lugar`s, so it runs on
    // what the two rules above already kept. The noise rule runs LAST, so a
    // `[Domicilio A], Morelos` split into `[Domicilio A]` is still caught.
    parsedWindows.push(
      dropNoiseEntities(
        splitQualifiedPlaces(dropGenericEntities(dropForbiddenPersonas(shaped, contentKind))),
      ),
    )
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
function responsePreview(text: string | undefined, contentKind: string | null | undefined): string {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return ' — the response carried no text either'
  // 🔴 PRIVACY. Logs and `graphError` are not a place for corpus text. A gated
  // kind (testimonio, conversación, unknown) gets metadata only: the length and
  // where JSON.parse gave up — enough to tell a cut-off array from a malformed one.
  if (mustPassAnonymisationGate(contentKind)) {
    return ` — response length ${body.length}, ${parseErrorPosition(body)}`
  }
  // A documento: a short, capped head and tail. Still no corpus dump.
  const keep = 60
  if (body.length <= keep * 2) return ` — response text was: ${body}`
  const omitted = body.length - keep * 2
  return ` — response length ${body.length}, ${parseErrorPosition(body)}; response text was: ${body.slice(0, keep)} […${omitted} chars…] ${body.slice(-keep)}`
}

/** Where JSON.parse stopped, without echoing the text (V8 messages can quote it). */
function parseErrorPosition(body: string): string {
  try {
    JSON.parse(body)
    return 'valid JSON (schema miss)'
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    const pos = /position (\d+)/.exec(msg)?.[1]
    if (pos) return `parse error at position ${pos}`
    if (/end of JSON input|Unterminated/i.test(msg)) return `parse error at end of input (position ${body.length})`
    return 'parse error (position unknown)'
  }
}

function defaultWindowError(windowIndex: number, err: unknown): void {
  // Message only, capped: never the raw error object, which may carry a response body.
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.warn('[graph] extraction window', windowIndex, 'failed:', message.slice(0, 400))
}

/**
 * How long to wait before retrying a transient window failure.
 *
 * ⚠ WHY A RETRY EXISTS AT ALL (backlog #16). Two of the six `failed` rows in
 * the local database say only `fetch failed` (measured 2026-10-21, local
 * `edc_backend`, documents 347 and 348). Extraction starts on upload, at the
 * same moment ingest is hitting ai-service, and one dropped connection was
 * enough to paint a red "grafo falló" on a fresh upload. One retry turns that
 * blip into nothing; a second failure is still recorded as before.
 */
const TRANSIENT_RETRY_DELAY_MS = 2000

/**
 * True for a failure worth ONE more try: a network error (`fetch failed`, a
 * reset or refused connection) or an ai-service 5xx / 429. Never a 4xx — a bad
 * request, a budget refusal or an auth error will fail the same way again.
 */
export function isTransientWindowError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
  if (typeof e.status === 'number') return e.status >= 500 || e.status === 429
  const code = typeof e.code === 'string' ? e.code : (e.cause as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET)$/.test(code)) {
    return true
  }
  return e.name === 'TypeError' && typeof e.message === 'string' && /fetch failed/i.test(e.message)
}

async function callWindowWithRetry<T>(call: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (!isTransientWindowError(err)) throw err
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return call()
  }
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
