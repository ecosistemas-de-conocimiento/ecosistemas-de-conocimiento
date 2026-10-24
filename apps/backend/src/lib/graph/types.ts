/**
 * THE GRAPH'S VOCABULARY, IN ONE PLACE.
 *
 * `plan/adr-corpus-graph.md` §4.1 fixes these enums, and three different layers
 * have to agree on them: the Payload collections (the Postgres enum), the JSON
 * Schema handed to the model (§5.4), and the writer that turns a model response
 * into rows. Declaring them once as `as const` tuples is what keeps the three
 * from drifting — the collections build their `options` from these arrays, and
 * the schema builds its `enum` from them.
 *
 * ⚠ SPANISH VALUES, ENGLISH IDENTIFIERS. House convention, and here it also
 * carries weight: the model is never asked to translate a category, so the
 * stored value is the same string the prompt showed it (ADR §5.4).
 */

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const GRAPH_ENTITY_TYPES = [
  'tema',
  'lugar',
  'evento',
  'organizacion',
  'persona',
] as const

export type GraphEntityType = (typeof GRAPH_ENTITY_TYPES)[number]

/**
 * The types a `testimonio` / `conversacion` may produce — everything except
 * `persona`.
 *
 * 🔴 ORGANISATIONS ARE ALWAYS EXTRACTED, from every content type (ADR §5.3).
 * Naming an institution does not identify a participant, and dropping
 * organisations would gut the analysis this graph exists for.
 */
export const GRAPH_ENTITY_TYPES_WITHOUT_PERSONA = GRAPH_ENTITY_TYPES.filter(
  (t) => t !== 'persona',
) as readonly Exclude<GraphEntityType, 'persona'>[]

export function isGraphEntityType(value: unknown): value is GraphEntityType {
  return (
    typeof value === 'string' &&
    (GRAPH_ENTITY_TYPES as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const GRAPH_RELATION_TYPES = [
  'ocurre_en',
  'participa_en',
  'ubicado_en',
  'parte_de',
  'afecta_a',
  'relacionado_con',
] as const

export type GraphRelationType = (typeof GRAPH_RELATION_TYPES)[number]

export function isGraphRelationType(value: unknown): value is GraphRelationType {
  return (
    typeof value === 'string' &&
    (GRAPH_RELATION_TYPES as readonly string[]).includes(value)
  )
}

/**
 * Relation types with NO DIRECTION.
 *
 * ⚠ A→B and B→A are the same fact for these, and stored as two rows they would
 * double the edge's apparent support — which is exactly the number
 * `GRAPH_MIN_SUPPORT` gates on (ADR §7.3.3). The writer collapses them by
 * ordering the two entity ids ascending; see `writer.ts`.
 */
export const SYMMETRIC_RELATION_TYPES: ReadonlySet<GraphRelationType> = new Set<GraphRelationType>([
  'relacionado_con',
])

// ---------------------------------------------------------------------------
// Content kind — the privacy control
// ---------------------------------------------------------------------------

export const CONTENT_KINDS = ['documento', 'testimonio', 'conversacion'] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]

/**
 * 🔴 THE PERSON RULE, AS A PREDICATE (ADR §5.3, §7.3.1).
 *
 * `contentKind` is a column, not a model's judgement. Asking an LLM "is this
 * person public?" is unreliable and fails open; asking "is this document a
 * testimony?" is a SELECT.
 *
 * ⚠ NOTE THE EXACT COMPARISON, AND THAT IT FAILS CLOSED. It is
 * `=== 'documento'`, not `!== 'testimonio'`. An unknown, null or missing value
 * therefore produces NO person nodes. That is the safe direction: the cost of
 * being wrong here is a missing node; the cost of the other direction is a
 * named participant in a re-identification surface.
 */
export function personaAllowed(contentKind: string | null | undefined): boolean {
  return contentKind === 'documento'
}

/**
 * 🔴 NO PRIVATE INDIVIDUAL IN THE GRAPH (owner, 2026-10-24).
 *
 * A `persona` is kept only when {@link personaAllowed} holds for the content
 * kind AND extraction marked her a public figure — an official, a named public
 * institution's representative, a historical or public person. The mark is the
 * model's `figura_publica`, read as public only when it is literally `true`, so
 * a missing or malformed mark fails closed.
 */
export function publicPersonaKept(
  contentKind: string | null | undefined,
  publicFigure: unknown,
): boolean {
  return personaAllowed(contentKind) && publicFigure === true
}

/**
 * 🔴 SNIPPETS ARE NEVER STORED FOR A TESTIMONY (ADR §7.3.4).
 *
 * `graph_mentions.snippet` is a short verbatim quotation answering "why is this
 * entity here". A verbatim quotation from a testimony is the most direct
 * re-identification surface in the whole design, so it is simply not held —
 * following `plan/anonimizacion-y-voces.md` §3.2's reasoning about the
 * re-identification map: data with no product need and a real leak cost is best
 * not to have.
 *
 * Same predicate as {@link personaAllowed} today, and deliberately a SEPARATE
 * function: the two rules answer different questions and one may later change
 * without the other.
 */
export function snippetAllowed(contentKind: string | null | undefined): boolean {
  return contentKind === 'documento'
}

// ---------------------------------------------------------------------------
// Pipeline state on `documents`
// ---------------------------------------------------------------------------

/**
 * `documents.graphStatus`. Same shape and same purpose as the existing
 * `ingestStatus` / `ingestError` pair: extraction has no durable queue
 * (ADR §5.1), so a lost run has to be VISIBLE and RETRYABLE rather than silent.
 *
 *   n/a         nothing to extract from — a markdown note, or never scheduled
 *   pending     scheduled; the fire-and-forget run has not started yet
 *   extracting  windows are being sent to the model
 *   ready       entities, mentions and relations are written
 *   failed      terminal, reason in `graphError`, retry via
 *               POST /api/documents/:id/graph-retry
 *   skipped     deliberately not extracted (no text on the row)
 */
export const GRAPH_STATUSES = [
  'n/a',
  'pending',
  'extracting',
  'ready',
  'failed',
  'skipped',
] as const

export type GraphStatus = (typeof GRAPH_STATUSES)[number]

// ---------------------------------------------------------------------------
// The shape extraction hands to the writer
// ---------------------------------------------------------------------------

/** One entity, already merged across every window of one document. */
export interface MergedEntity {
  type: GraphEntityType
  /** Display form, Spanish, as extracted. The first surface form seen wins. */
  label: string
  /** `canonicalKey(label)` — see `normalise.ts`. */
  canonicalKey: string
  /** Summed across windows. */
  occurrences: number
  /** Other surface forms seen for this entity, excluding `label`. */
  aliases: string[]
  /**
   * 🔴 Carried only so the writer can store it for a `documento`. It is
   * dropped, not stored, for every other content kind — see
   * {@link snippetAllowed}.
   */
  snippet: string | null
  /**
   * 🔴 The public-figure mark ({@link publicPersonaKept}). True only for a
   * `persona` the model marked public; absent or false means "not public", and
   * the writer stores no such persona.
   */
  publicFigure?: boolean
}

/**
 * One edge, with endpoints still named by CANONICAL KEY rather than by row id.
 * The writer resolves them and drops what it cannot resolve (ADR §5.4) — a
 * dangling edge is worse than a missing one.
 */
export interface MergedRelation {
  fromKey: string
  toKey: string
  type: GraphRelationType
}

export interface GraphExtraction {
  entities: MergedEntity[]
  relations: MergedRelation[]
  /** How many windows the text was split into. */
  windows: number
  /** How many of those returned nothing usable. */
  windowsFailed: number
  /**
   * ⚠ True when the document was longer than
   * `GRAPH_EXTRACT_WINDOW_CHARS × GRAPH_EXTRACT_MAX_WINDOWS` and the tail was
   * not read at all (ADR §5.2). Recorded here so a caller CAN see it; nothing
   * on `documents` stores it yet, which is the honest limitation the ADR names.
   */
  truncated: boolean
  promptVersion: string
}
