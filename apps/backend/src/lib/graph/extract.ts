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

  const removed = new Set<string>()
  const entities = window.entities.filter((e) => {
    if (e.tipo !== 'persona') return true
    removed.add(canonicalKey(e.etiqueta))
    return false
  })
  if (removed.size === 0) return { entities, relations: window.relations }

  const relations = window.relations.filter(
    (r) => !removed.has(canonicalKey(r.desde)) && !removed.has(canonicalKey(r.hacia)),
  )
  return { entities, relations }
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
      const preview =
        typeof result.text === 'string' && result.text.trim()
          ? ` — response text was: ${result.text.trim().slice(0, 400)}`
          : ' — the response carried no text either'
      ;(args.onWindowError ?? defaultWindowError)(
        i,
        new Error(`no usable \`parsed\` payload (schema miss or empty completion)${preview}`),
      )
      continue
    }

    // 🔴 UNCONDITIONAL, and before the merge. See the file header.
    parsedWindows.push(dropForbiddenPersonas(shaped, contentKind))
  }

  if (parsedWindows.length === 0) {
    throw new Error(`every extraction window failed (${windows.length} of ${windows.length})`)
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
