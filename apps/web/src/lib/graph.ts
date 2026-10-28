/**
 * El grafo del corpus — la copia en español, el vocabulario y las reglas puras.
 *
 * Sibling of `$lib/biblioteca.ts` and `$lib/publication.ts`, same shape and the
 * same reason: `apps/web` runs vitest in a `node` environment with no DOM, so
 * nothing that lives inside a `.svelte` file can be asserted by a test. Every
 * rule a refactor could quietly break — the ranking, the accent fold, the
 * radial geometry, the Spanish copy, and the paragraph the chat turn is fed —
 * therefore lives here as a plain module with `graph.test.ts` next to it. The
 * components under `lib/components/graph/` only lay the results out.
 *
 * ## 🔴 WHAT THIS SURFACE IS (ADR §7.1)
 *
 * ONE view, and every role sees the same thing. There is deliberately no
 * unprotected internal view: the minimum-support threshold, the published-only
 * scope and the person rule apply to a platform admin exactly as they apply to
 * a member. What differs by role is WHICH ecosistema you can look at, never
 * what the graph shows about it.
 *
 * ## 🔴 THE FIVE LISTS — `persona` IS ONE OF THEM, AND WHY THAT IS SAFE
 *
 * The owner decided (2026-08-29) that a `persona` is shown like any other type.
 * This module header used to argue the opposite, so the reasoning that makes
 * the new answer safe is recorded here rather than left to be re-derived.
 *
 * A person node CANNOT come from a testimonio. Not "is filtered out of" — it
 * cannot be produced. `apps/backend/src/lib/graph/types.ts` gates it on
 * `personaAllowed(contentKind)`, which is `contentKind === 'documento'` and
 * therefore fails CLOSED on a null or unknown value; the extraction schema for
 * gated content omits `persona` from its `tipo` enum entirely
 * (`lib/graph/prompt.ts`), so the model has no way to express one; and
 * `lib/graph/extract.ts` drops any that appear anyway. Three layers, keyed on a
 * COLUMN rather than on a model's judgement.
 *
 * So a person in this view is a cited author or a named official in a public
 * report. Never a participant in a testimony, and never someone whose name a
 * testimony happened to mention.
 *
 * ⚠ AND THEY ARE STILL SUBJECT TO EVERYTHING ELSE. `GRAPH_MIN_ENTITY_DOCS` applies
 * unchanged, so a person named in one or two published documents does not
 * appear at all; the published-only scope applies; and no snippet is ever
 * stored for a testimonio. The re-identification argument in ADR §7.3 rests on
 * minimum support, which is untouched — §7.3.1 was the *extraction* rule, and
 * that is exactly where it still lives.
 *
 * ⚠ `isViewableEntityType` is KEPT as the one seam, now admitting all five
 * types. It still fails closed on a type the backend adds tomorrow, and it is
 * still the single place to change if this decision is ever revisited.
 *
 * ## 🔴 A TESTIMONIO'S TITLE IS TAKEN, NEVER IMPROVED
 *
 * The backend hands back already-neutralised document titles. Nothing here
 * looks up the "real" name of a document, and nothing should: the original file
 * name is free text that never passed the anonymisation gate. See
 * `GraphDocument.title`.
 */

import { foldText } from '$lib/components/admin/summary';
import type { Ecosystem } from '$lib/ecosystems';

/** Re-exported so graph code has one import surface for the accent fold. */
export { foldText };

// ── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * The backend's entity types (`apps/backend/src/lib/graph/types.ts`).
 *
 * ⚠ Spanish values, English identifiers — the house convention, and here it
 * also means the stored value is the same string the extraction prompt showed
 * the model, so nothing translates a category on the way through.
 */
export const GRAPH_ENTITY_TYPES = ['tema', 'lugar', 'evento', 'organizacion', 'persona'] as const;
export type GraphEntityType = (typeof GRAPH_ENTITY_TYPES)[number];

/**
 * The lists the view shows, in the order it shows them.
 *
 * ⚠ SEPARATE FROM `GRAPH_ENTITY_TYPES` ON PURPOSE, even though the two now hold
 * the same five values. That one is the BACKEND'S CONTRACT — what a response
 * may contain. This one is a VIEW decision — what is drawn, and in what order.
 * Collapsing them into one constant would make the next person's change to the
 * running order look like a change to the wire format.
 *
 * `persona` is last because it is the newest list and the least populated: the
 * types the ADR built the view around (§7.2) stay where a returning reader
 * expects to find them.
 */
export const GRAPH_VIEW_TYPES = [
  'tema',
  'lugar',
  'evento',
  'organizacion',
  'persona',
] as const;
export type GraphViewType = (typeof GRAPH_VIEW_TYPES)[number];

export function isGraphEntityType(value: unknown): value is GraphEntityType {
  return typeof value === 'string' && (GRAPH_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * 🔴 THE ONE SEAM DECIDING WHAT THE VIEW DRAWS. See the module header.
 *
 * Fails CLOSED: an unknown type is not viewable. A category the backend adds
 * tomorrow does not appear in this product until someone decides it should —
 * which is the property that survived the owner admitting `persona`, and the
 * reason this predicate was not simply deleted in favour of
 * `isGraphEntityType`. The two answer different questions and are allowed to
 * diverge again.
 */
export function isViewableEntityType(value: unknown): value is GraphViewType {
  return typeof value === 'string' && (GRAPH_VIEW_TYPES as readonly string[]).includes(value);
}

export const GRAPH_RELATION_TYPES = [
  'ocurre_en',
  'participa_en',
  'ubicado_en',
  'parte_de',
  'afecta_a',
  'relacionado_con',
] as const;
export type GraphRelationType = (typeof GRAPH_RELATION_TYPES)[number];

/** `documents.contentKind` — a privacy control, not a label (ADR §0, §3). */
export const CONTENT_KINDS = ['documento', 'testimonio', 'conversacion'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

// ── Shapes, as the BFF hands them to the browser ───────────────────────────

export interface GraphEntity {
  id: string;
  type: GraphViewType;
  label: string;
  /** Distinct PUBLISHED documents this entity appears in. Never a mention count. */
  support: number;
  /**
   * COMBINED VIEW ONLY ("Todos mis ecosistemas"): ids of the included
   * ecosistemas this merged node appears in, ascending. Absent in a
   * single-ecosistema view.
   */
  ecosystems?: number[];
  /** Combined view only: support per ecosistema, aligned with `ecosystems`. */
  ecosystemSupport?: number[];
}

/**
 * Which way an edge points, seen from the entity in focus. `out` ⇒ focus →
 * neighbour; `in` ⇒ neighbour → focus; `both` ⇒ either, or a symmetric type.
 *
 * ⚠ WITHOUT IT EVERY INCOMING EDGE READ BACKWARDS (backlog #16): Morelos was
 * listed as "está en Xoxocotla", because the stored row is "Xoxocotla
 * ubicado_en Morelos" and the panel printed the relation from Morelos' side.
 */
export type GraphEdgeDirection = 'out' | 'in' | 'both';

export interface GraphNeighbour {
  entity: GraphEntity;
  relationType: GraphRelationType;
  /** See {@link GraphEdgeDirection}. An older backend sends none ⇒ `out`. */
  direction: GraphEdgeDirection;
  /**
   * Distinct published documents behind THIS CONNECTION. After
   * {@link mergeNeighbours} that is the PAIR's weight — every relation type —
   * when the backend sends `pairSupport`, else the strongest type's.
   */
  support: number;
  /**
   * The per-type breakdown of a merged connection, strongest first. Present
   * only after {@link mergeNeighbours}, and only when there is more than one
   * type to show.
   */
  relations?: Array<{ relationType: GraphRelationType; direction: GraphEdgeDirection; support: number }>;
  /**
   * The published documents that EVIDENCE THIS EDGE — not the ones the two
   * entities happen to share. `graph_relations` holds one row per
   * `(document, from, to, type)`, so this is the real answer rather than the
   * intersection that used to stand in for it.
   *
   * ⚠ `null` MEANS THE BACKEND DID NOT SEND THE FIELD, which is different from
   * an empty list. Absent ⇒ fall back to the old intersection. Empty ⇒ the
   * backend really found none, which should not happen (an edge exists only
   * when at least `GRAPH_MIN_EDGE_DOCS` documents evidence it) and is shown as
   * "none" rather than papered over.
   */
  documents: GraphDocument[] | null;
  /**
   * The PAIR's weight off the wire: documents behind any relation between the
   * two. {@link mergeNeighbours} folds it into `support`.
   */
  pairSupport?: number;
}

export interface GraphDocument {
  id: string;
  /**
   * 🔴 ALREADY NEUTRALISED BY THE BACKEND. Rendered exactly as received. Never
   * re-resolved against the documents collection — see the module header.
   */
  title: string;
  contentKind: ContentKind | null;
}

export interface GraphView {
  entities: GraphEntity[];
  /**
   * How many entities the minimum-support threshold withheld. Surfaced to the
   * reader verbatim: a number we hold and do not show is a number that makes an
   * empty screen look like a bug.
   */
  hidden: number;
  /**
   * The threshold itself, when the backend names it. `null` → the copy says
   * "muy pocos documentos" instead of naming a number it does not know.
   */
  minSupport: number | null;
  /**
   * 🔴 HOW THE TWO EMPTY GRAPHS ARE TOLD APART. Published documents in this
   * ecosistema, counted without reference to the graph at all.
   *
   * `entities: []` means one of two completely different things — "nobody has
   * published anything yet" or "everything published is still below the
   * threshold" — and they need different Spanish. The first is answered by
   * publishing something; the second by publishing MORE. `null` when the
   * backend did not say, in which case the copy falls back to the threshold
   * wording, which is the more common case and the less alarming one.
   */
  publishedDocuments: number | null;
  /**
   * The edges among `entities`, for the whole-graph picture (backlog #3).
   * Undirected; one per pair. Optional so an older backend, or a hand-built
   * view, still typechecks — absent reads as "no edges".
   */
  edges?: GraphViewEdge[];
  /**
   * Entities above the threshold BEFORE the backend's cap (1,500). Larger than
   * `entities.length` ⇒ the view is capped. Absent on an older backend.
   */
  total?: number;
}

/**
 * What drew an overview edge. `relation` ⇒ the extraction related the pair;
 * `co-mention` ⇒ it did not, but published documents mention both (UI:
 * "aparecen juntos").
 */
export type GraphViewEdgeKind = 'relation' | 'co-mention';

/**
 * One undirected edge of the whole-graph picture: ONE PER PAIR, every relation
 * type and both directions folded in by the backend (owner, 2026-10-21).
 */
export interface GraphViewEdge {
  fromId: string;
  toId: string;
  /**
   * Distinct published documents behind the edge: any relation of the pair for
   * `relation`, documents mentioning both for `co-mention`.
   */
  support: number;
  /** Absent from an older backend ⇒ `relation`. */
  kind: GraphViewEdgeKind;
  /** Published documents mentioning both ends. `0` when the backend did not say. */
  coMentions: number;
  /** `relation` only: the pair's most common type, and its way from `fromId`. */
  relationType?: GraphRelationType;
  direction?: GraphEdgeDirection;
}

export interface GraphEntityDetail {
  entity: GraphEntity;
  neighbours: GraphNeighbour[];
  documents: GraphDocument[];
}

/** One edge of `POST /api/graph/retrieve`, endpoints named by entity id. */
export interface GraphEdge {
  fromId: string;
  toId: string;
  relationType: GraphRelationType;
  support: number;
}

/** The GraphRAG payload. `terms` drives the ONE expansion retrieve. */
export interface GraphRetrieval {
  entities: GraphEntity[];
  edges: GraphEdge[];
  documents: GraphDocument[];
  terms: string[];
  /**
   * Every entity named anywhere in the payload — the seeds PLUS both endpoints
   * of every edge.
   *
   * 🔴 NOT THE SAME LIST AS `entities`, AND THE DIFFERENCE IS LOAD-BEARING.
   * `entities` is the seeds: what the query actually matched. `edges` reaches
   * ONE HOP OUT of them, so an edge's far endpoint is usually NOT a seed. An
   * index built from `entities` alone therefore resolves almost no neighbours,
   * and the context block quietly loses the one thing it is for — "X se conecta
   * con Y" — while still looking well-formed.
   *
   * Optional so a hand-built `GraphRetrieval` (a test fixture) still typechecks;
   * `graphContextParagraph` falls back to `entities` when it is absent.
   */
  nodes?: GraphEntity[];
}

/** The connection currently selected in the view, with its shared documents. */
export interface SelectedEdge {
  entity: GraphEntity;
  relationType: GraphRelationType;
  /** The documents behind this edge. What they MEAN depends on `exact`. */
  documents: GraphDocument[];
  /**
   * 🔴 `true` ⇒ these documents evidence THIS EDGE, from `graph_relations`.
   * `false` ⇒ they are the intersection of the two entities' document lists, a
   * SUPERSET, because the backend did not send per-edge evidence.
   *
   * ⚠ THE COPY MUST FOLLOW THIS FLAG. `GRAPH_EDGE_DOCS_*` and their `_APPROX`
   * counterparts are a pair for exactly this reason: showing the confident
   * sentence over approximate data is the one failure mode here that is worse
   * than showing nothing, because nobody can tell by looking.
   */
  exact: boolean;
  /** `false` ⇒ the neighbour's own read failed. NOT "there are none". */
  ok: boolean;
}

/**
 * Everything `/grafo` renders.
 *
 * ⚠ IT LIVES HERE, NOT IN `+page.server.ts`. SvelteKit rejects any export from
 * a `+page.server.ts` other than `load`, `actions` and its own options, and it
 * does so at REQUEST time — the page 500s with "Invalid export" while
 * `svelte-check` says nothing. A type-only export happens to be erased before
 * that check ever sees it, but "happens to be erased" is not a rule anyone
 * should have to remember. Same footgun `/admin` records in its own header.
 */
export interface GrafoPageData {
  state: 'ready' | 'no-ecosystem' | 'unavailable';
  ecosystem: { id: string; name: string } | null;
  view: GraphView;
  /**
   * `false` ⇒ the graph read FAILED. ⚠ Load-bearing: an empty graph because the
   * backend blinked must never be rendered as "aún no hay suficientes
   * documentos publicados". One is an outage; the other is a sentence about
   * this ecosistema's corpus.
   */
  viewOk: boolean;
  entity: GraphEntityDetail | null;
  entityState: 'none' | 'ok' | 'not-found' | 'unavailable';
  edge: SelectedEdge | null;
  /**
   * The platform admin's ecosistema picker, or `null` for everybody else.
   *
   * ⚠ `null` means "no picker", never "an empty picker" — the page branches on
   * it for the `no-ecosystem` sentence too, because an admin who belongs to
   * nothing must not be told to go ask for access. See `noEcosystemCopy`.
   */
  scope: GraphScopePicker | null;
  /** The full-text search box, `GRAPH_SEARCH_ENABLED` (see `graphSearchEnabled`). */
  searchEnabled: boolean;
  /** `true` ⇒ the page shows "Todos mis ecosistemas" (`?eco=todos`). */
  combined: boolean;
  /** Ecosistema id → name, for the combined view's per-node ecosistema chips. */
  ecosystemNames: Record<string, string>;
  /**
   * The ecosistema's `graph` / `graph3d` switches (`$lib/features`). Absent:
   * on. `graphOff` is a state of its own so it never reads as an outage.
   */
  graphOff?: boolean;
  allow3d?: boolean;
}

// ── Tolerant parsing ───────────────────────────────────────────────────────
//
// ⚠ The backend endpoints were built in a parallel lane against a written
// contract, so these parsers accept the contract's spelling AND the obvious
// neighbouring ones (`from`/`fromId`/`source`, `type`/`relationType`). A field
// we cannot read degrades that ONE row to absent rather than throwing away the
// response — a graph missing an edge is a smaller failure than a page that
// will not load, and the graph path is best-effort by design (ADR §8.2).

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function count(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toRelationType(v: unknown): GraphRelationType {
  return typeof v === 'string' && (GRAPH_RELATION_TYPES as readonly string[]).includes(v)
    ? (v as GraphRelationType)
    : 'relacionado_con';
}

function toContentKind(v: unknown): ContentKind | null {
  return typeof v === 'string' && (CONTENT_KINDS as readonly string[]).includes(v)
    ? (v as ContentKind)
    : null;
}

function idOf(raw: unknown): string | null {
  const direct = str(raw);
  if (direct) return direct;
  if (raw && typeof raw === 'object' && 'id' in raw) return str((raw as { id?: unknown }).id);
  return null;
}

/**
 * One entity row. `null` when it has no id, no label, or a type the view does
 * not show — see `isViewableEntityType`.
 */
export function parseGraphEntity(raw: unknown): GraphEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  const label = str(row.label) ?? str(row.name);
  if (!id || !label || !isViewableEntityType(row.type)) return null;
  const entity: GraphEntity = { id, type: row.type, label, support: count(row.support ?? row.documentCount) };
  const ecosystems = parseEcosystems(row.ecosystems, row.ecosystemSupport);
  if (ecosystems) {
    entity.ecosystems = ecosystems.map((e) => e.id);
    entity.ecosystemSupport = ecosystems.map((e) => e.support);
  }
  return entity;
}

/**
 * The combined view's `ecosystems` (and the aligned `ecosystemSupport`):
 * positive integer ids, de-duplicated, ascending — the data contract.
 * `null` when absent, so a single-ecosistema entity stays without the field.
 */
export function parseEcosystems(
  rawIds: unknown,
  rawSupport: unknown,
): Array<{ id: number; support: number }> | null {
  if (!Array.isArray(rawIds)) return null;
  const supports = Array.isArray(rawSupport) ? rawSupport : [];
  const byId = new Map<number, number>();
  rawIds.forEach((v, i) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isSafeInteger(n) && n > 0) byId.set(n, (byId.get(n) ?? 0) + count(supports[i]));
  });
  return [...byId]
    .sort(([a], [b]) => a - b)
    .map(([id, support]) => ({ id, support }));
}

export function parseGraphDocument(raw: unknown): GraphDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  // ⚠ The fallback is a generic noun, never a file name reconstructed from
  // somewhere else. A missing title stays a missing title.
  const title = str(row.title) ?? str(row.name) ?? 'Documento sin título';
  return { id, title, contentKind: toContentKind(row.contentKind) };
}

export function parseGraphView(raw: unknown): GraphView {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const entities = (Array.isArray(body.entities) ? body.entities : [])
    .map(parseGraphEntity)
    .filter((e): e is GraphEntity => e !== null);
  const minSupport = count(body.minSupport);
  // ⚠ `0` is a real answer here ("nothing published yet"), so absence has to be
  // distinguished from zero rather than folded into it by `count`.
  const published =
    body.publishedDocuments === undefined || body.publishedDocuments === null
      ? null
      : count(body.publishedDocuments);
  return {
    entities: rankEntities(entities),
    hidden: count(body.hidden),
    minSupport: minSupport > 0 ? minSupport : null,
    publishedDocuments: published,
    edges: parseViewEdges(body.edges, entities),
    ...(body.total === undefined || body.total === null ? {} : { total: count(body.total) }),
  };
}

/**
 * The whole-graph edges, kept only when BOTH endpoints are entities this view
 * lists, and one per unordered pair.
 *
 * ⚠ The endpoint check is not paranoia. An edge to a node that is not drawn
 * would be a line to nowhere, and a duplicate pair would be two keyed rows with
 * the same key — the exact crash backlog #7 was.
 */
function parseViewEdges(raw: unknown, entities: readonly GraphEntity[]): GraphViewEdge[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(entities.map((e) => e.id));
  const seen = new Set<string>();
  const out: GraphViewEdge[] = [];
  for (const item of raw) {
    const edge = parseGraphEdge(item);
    if (!edge || !known.has(edge.fromId) || !known.has(edge.toId)) continue;
    const key = edge.fromId < edge.toId ? `${edge.fromId}|${edge.toId}` : `${edge.toId}|${edge.fromId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = item as Record<string, unknown>;
    const kind: GraphViewEdgeKind = row.kind === 'co-mention' ? 'co-mention' : 'relation';
    const parsed: GraphViewEdge = {
      fromId: edge.fromId,
      toId: edge.toId,
      support: edge.support,
      kind,
      coMentions: count(row.coMentions),
    };
    if (kind === 'relation' && (row.relationType ?? row.type) != null) {
      parsed.relationType = edge.relationType;
      parsed.direction = row.direction === 'in' || row.direction === 'both' ? row.direction : 'out';
    }
    out.push(parsed);
  }
  return out;
}

function toDirection(v: unknown): GraphEdgeDirection {
  return v === 'in' || v === 'both' ? v : 'out';
}

export function parseGraphNeighbour(raw: unknown): GraphNeighbour | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const entity = parseGraphEntity(row.entity ?? row);
  if (!entity) return null;
  // ⚠ ABSENT AND ZERO ARE DIFFERENT. An edge with no support of its own falls
  // back to the entity's, but a support the backend actually sent is taken as
  // sent — otherwise a `0` would silently be redrawn as the entity's full
  // count, and the ego network would show a fat spoke for a thin edge.
  const declared =
    row.support === undefined || row.support === null ? null : count(row.support);
  const pair =
    row.pairSupport === undefined || row.pairSupport === null ? null : count(row.pairSupport);
  return {
    entity,
    relationType: toRelationType(row.relationType),
    direction: toDirection(row.direction),
    support: declared ?? entity.support,
    ...(pair !== null ? { pairSupport: pair } : {}),
    // Absent stays `null`; see the field comment. `Array.isArray` is the whole
    // distinction, so an older backend degrades instead of showing "none".
    documents: Array.isArray(row.documents)
      ? row.documents.map(parseGraphDocument).filter((d): d is GraphDocument => d !== null)
      : null,
  };
}

export function parseGraphEntityDetail(raw: unknown): GraphEntityDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const entity = parseGraphEntity(body.entity);
  if (!entity) return null;
  const neighbours = (Array.isArray(body.neighbours) ? body.neighbours : [])
    .map(parseGraphNeighbour)
    .filter((n): n is GraphNeighbour => n !== null);
  const documents = uniqueDocuments(
    (Array.isArray(body.documents) ? body.documents : [])
      .map(parseGraphDocument)
      .filter((d): d is GraphDocument => d !== null),
  );
  return { entity, neighbours: rankNeighbours(mergeNeighbours(neighbours)), documents };
}

/** First occurrence wins; order kept. Every list here is rendered keyed by id. */
export function uniqueDocuments(documents: readonly GraphDocument[]): GraphDocument[] {
  const seen = new Set<string>();
  return documents.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

/**
 * 🔴 ONE ROW PER NEIGHBOUR — THE FIX FOR BACKLOG #7.
 *
 * The backend answers one row per `(neighbour, relationType)`: "traducción en
 * salud" reaches "consentimiento informado" by `afecta_a` (3 documents) AND by
 * `relacionado_con` (5) — measured 2026-10-21 on local `edc_backend`, org 1.
 * The panel keys its rows, the ego network keys its nodes, and `?conexion=`
 * selects, all by ENTITY id. Two rows with one key made Svelte throw
 * `each_key_duplicate`, which blanked the whole page on the very first topic.
 *
 * So the neighbour is folded here, once, before anything renders: the
 * strongest relation names the edge (its type, direction and support), and the
 * evidence is the union of every relation's documents — a document behind
 * either relation IS behind the connection between these two.
 *
 * ⚠ `documents` stays `null` only if NO row sent the field; see
 * `GraphNeighbour.documents`.
 */
export function mergeNeighbours(neighbours: readonly GraphNeighbour[]): GraphNeighbour[] {
  const groups = new Map<string, GraphNeighbour[]>();
  for (const n of neighbours) {
    const list = groups.get(n.entity.id);
    if (list) list.push(n);
    else groups.set(n.entity.id, [n]);
  }
  const out: GraphNeighbour[] = [];
  for (const rows of groups.values()) {
    // Strongest type first; a tie goes to the alphabetically first type, the
    // same order the backend's overview edge uses, so the map and the panel
    // name a tied pair the same way.
    const ranked = [...rows].sort(
      (x, y) => y.support - x.support || x.relationType.localeCompare(y.relationType),
    );
    const strongest = ranked[0]!;
    const documents = rows.every((n) => n.documents === null)
      ? null
      : uniqueDocuments(ranked.flatMap((n) => n.documents ?? []));
    const pair = rows.reduce((m, n) => Math.max(m, n.pairSupport ?? 0), 0);
    const merged: GraphNeighbour = {
      ...strongest,
      support: Math.max(pair, strongest.support),
      documents,
    };
    delete merged.pairSupport;
    if (ranked.length > 1) {
      merged.relations = ranked.map((n) => ({
        relationType: n.relationType,
        direction: n.direction,
        support: n.support,
      }));
    }
    out.push(merged);
  }
  return out;
}

export function parseGraphEdge(raw: unknown): GraphEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const fromId = idOf(row.fromId ?? row.from ?? row.source);
  const toId = idOf(row.toId ?? row.to ?? row.target);
  if (!fromId || !toId || fromId === toId) return null;
  return {
    fromId,
    toId,
    relationType: toRelationType(row.relationType ?? row.type),
    support: count(row.support),
  };
}

export function parseGraphRetrieval(raw: unknown): GraphRetrieval {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const entities = (Array.isArray(body.entities) ? body.entities : [])
    .map(parseGraphEntity)
    .filter((e): e is GraphEntity => e !== null);
  const edges = (Array.isArray(body.edges) ? body.edges : [])
    .map(parseGraphEdge)
    .filter((e): e is GraphEdge => e !== null);
  const documents = (Array.isArray(body.documents) ? body.documents : [])
    .map(parseGraphDocument)
    .filter((d): d is GraphDocument => d !== null);
  const terms = (Array.isArray(body.terms) ? body.terms : [])
    .map((t) => str(t))
    .filter((t): t is string => t !== null);

  // The full node index — seeds plus both endpoints of every edge. See
  // `GraphRetrieval.nodes` for why building it from `entities` alone silently
  // empties the context block's "se conecta con" clause.
  // ⚠ Endpoints go through `parseGraphEntity` like everything else, so an
  // endpoint of a type this view does not draw never reaches the prompt either.
  // The graph block and the screen therefore describe the same graph.
  const nodes = new Map<string, GraphEntity>();
  for (const e of entities) nodes.set(e.id, e);
  for (const raw of Array.isArray(body.edges) ? body.edges : []) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    for (const end of [row.from, row.to, row.source, row.target]) {
      const parsed = parseGraphEntity(end);
      if (parsed && !nodes.has(parsed.id)) nodes.set(parsed.id, parsed);
    }
  }

  return { entities: rankEntities(entities), edges, documents, terms, nodes: [...nodes.values()] };
}

// ── Ranking and search ─────────────────────────────────────────────────────

/**
 * Support descending, then label A→Z in Spanish collation.
 *
 * ⚠ The tie-break is not cosmetic. Two entities with the same support must come
 * back in the same order on every render, or the "ranked list" the ADR promises
 * reshuffles itself while someone is reading it.
 */
export function rankEntities(entities: readonly GraphEntity[]): GraphEntity[] {
  return [...entities].sort(
    (a, b) => b.support - a.support || a.label.localeCompare(b.label, 'es'),
  );
}

export function rankNeighbours(neighbours: readonly GraphNeighbour[]): GraphNeighbour[] {
  return [...neighbours].sort(
    (a, b) =>
      b.support - a.support ||
      b.entity.support - a.entity.support ||
      a.entity.label.localeCompare(b.entity.label, 'es'),
  );
}


/** The four lists, always all four, always in ADR order — empty ones included. */
export function groupByType(
  entities: readonly GraphEntity[],
): Array<{ type: GraphViewType; entities: GraphEntity[] }> {
  return GRAPH_VIEW_TYPES.map((type) => ({
    type,
    entities: entities.filter((e) => e.type === type),
  }));
}

// ── Copy ───────────────────────────────────────────────────────────────────

/** The tab / list heading. Plural, because it names a list. */
export function typeListLabel(type: GraphViewType): string {
  switch (type) {
    case 'tema':
      return 'Temas';
    case 'lugar':
      return 'Lugares';
    case 'evento':
      return 'Eventos';
    case 'organizacion':
      return 'Organizaciones';
    case 'persona':
      return 'Personas';
  }
}

/** The chip on one entity. Singular, because it names a thing. */
export function typeChipLabel(type: GraphViewType): string {
  switch (type) {
    case 'tema':
      return 'tema';
    case 'lugar':
      return 'lugar';
    case 'evento':
      return 'evento';
    case 'organizacion':
      return 'organización';
    case 'persona':
      return 'persona';
  }
}

/**
 * How a relation reads FROM THE ENTITY IN FOCUS, as "[focus] <label> [neighbour]".
 *
 * ⚠ `in` READS THE OTHER WAY. "Xoxocotla ubicado_en Morelos", seen from
 * Morelos, is "Morelos incluye Xoxocotla" — not "está en". See
 * {@link GraphEdgeDirection}. `both` means the rows disagree or the type has no
 * direction, so it gets the one label that is true either way.
 */
export function relationLabel(
  relation: GraphRelationType,
  direction: GraphEdgeDirection = 'out',
): string {
  if (direction === 'both' && relation !== 'relacionado_con') return 'se relaciona con';
  if (direction === 'in') {
    switch (relation) {
      case 'ocurre_en':
        return 'es donde ocurre';
      case 'participa_en':
        return 'cuenta con';
      case 'ubicado_en':
        return 'incluye';
      case 'parte_de':
        return 'tiene como parte a';
      case 'afecta_a':
        return 'recibe el efecto de';
      case 'relacionado_con':
        return 'se relaciona con';
    }
  }
  switch (relation) {
    case 'ocurre_en':
      return 'ocurre en';
    case 'participa_en':
      return 'participa en';
    case 'ubicado_en':
      return 'está en';
    case 'parte_de':
      return 'es parte de';
    case 'afecta_a':
      return 'afecta a';
    case 'relacionado_con':
      return 'se relaciona con';
  }
}

/**
 * `12` → `aparece en 12 documentos`.
 *
 * ⚠ Singular/plural is decided here rather than in a template because
 * "1 documentos" is the kind of thing that reads fine right up until the day it
 * does not.
 */
export function supportCopy(support: number): string {
  const n = Math.max(0, Math.floor(support));
  if (n === 0) return 'sin documentos que lo respalden';
  if (n === 1) return 'aparece en 1 documento';
  return `aparece en ${n.toLocaleString('es-MX')} documentos`;
}

/** Short form for tight places (the neighbour chip, the SVG tooltip). */
export function supportShort(support: number): string {
  const n = Math.max(0, Math.floor(support));
  return n === 1 ? '1 documento' : `${n.toLocaleString('es-MX')} documentos`;
}

/**
 * How a supporting document is labelled.
 *
 * 🔴 A TESTIMONIO AND A DOCUMENTO MUST NOT LOOK THE SAME — the same rule
 * `$lib/biblioteca.ts` states for the library. A reader weighing a connection
 * needs to know whether its evidence is a file somebody wrote or a person's
 * words, gathered and anonymised, without having to guess.
 */
export function contentKindLabel(
  kind: ContentKind | null,
): { label: string; tone: 'voice' | 'document' } {
  switch (kind) {
    case 'testimonio':
      return { label: 'Voz', tone: 'voice' };
    case 'conversacion':
      return { label: 'Conversación', tone: 'document' };
    default:
      return { label: 'Documento', tone: 'document' };
  }
}

export const GRAPH_KICKER = 'Conexiones';

// ⚠ NO TITLE AND NO SUBTITLE (backlog #27, owner's call 2026-10-21). The nav
// tab already says "Conexiones"; the page opens on the graph itself.

// ⚠ NO SCOPE NOTE AND NO "HAY N ENTIDADES QUE NO SE MUESTRAN" LINE (backlog #28,
// #29, owner's call 2026-10-21). The published-only scope and the 3-document
// threshold are unchanged — they live in the backend's SQL — only the sentences
// explaining them are gone from the page. `GraphView.hidden` is still parsed.

/**
 * 🔴 THE EMPTY STATE THE ADR NAMES, WORD FOR WORD (§7.3.3).
 *
 * In a young ecosistema the graph is genuinely empty, and that is the design
 * working. A blank canvas reads as broken and sends someone to report a bug, so
 * the screen says what happened instead of showing nothing.
 */
export const GRAPH_EMPTY_THRESHOLD =
  'Aún no hay suficientes documentos publicados para mostrar conexiones';

export const GRAPH_EMPTY_THRESHOLD_HINT =
  'No es un error. Una conexión se muestra solo cuando varios documentos publicados ' +
  'distintos la respaldan, para que un solo testimonio nunca pueda señalar a alguien.';

export const GRAPH_EMPTY_NOTHING_PUBLISHED = 'Tu ecosistema todavía no ha publicado nada';

export const GRAPH_EMPTY_NOTHING_PUBLISHED_HINT =
  'Cuando alguien publique un documento o una voz, aquí empezarán a aparecer los temas, ' +
  'lugares, eventos, organizaciones y personas que se repiten entre ellos.';

/**
 * 🔴 TWO EMPTY GRAPHS, TWO DIFFERENT SENTENCES.
 *
 * "Nobody has published anything yet" and "everything published is still below
 * the threshold" look identical on screen and are fixed by different actions —
 * publish something, versus publish more. Telling someone the second when the
 * first is true is a small lie that sends them looking for a bug. The backend
 * sends `publishedDocuments` precisely so this can be answered honestly.
 *
 * ⚠ Unknown falls back to the threshold wording: it is the commoner case, and
 * it does not accuse an ecosistema of being empty when we simply did not ask.
 */
export function emptyGraphCopy(view: GraphView): { title: string; hint: string } {
  if (view.publishedDocuments === 0) {
    return { title: GRAPH_EMPTY_NOTHING_PUBLISHED, hint: GRAPH_EMPTY_NOTHING_PUBLISHED_HINT };
  }
  return { title: GRAPH_EMPTY_THRESHOLD, hint: GRAPH_EMPTY_THRESHOLD_HINT };
}

export const GRAPH_NO_RESULTS = 'Nada coincide con lo que buscas.';

export const GRAPH_OFF = 'El grafo está desactivado en este ecosistema.';

export const GRAPH_UNAVAILABLE =
  'No pudimos leer el grafo en este momento. Vuelve a intentarlo en un rato.';

export const GRAPH_NO_ECOSYSTEM =
  'Todavía no perteneces a ningún ecosistema, así que no hay un grafo que mostrar. ' +
  'Pídele acceso a quien administra tu ecosistema.';

/**
 * ⚠ THE SAME EMPTY SCREEN, A COMPLETELY DIFFERENT SENTENCE.
 *
 * A platform admin who belongs to nothing used to be told *"no perteneces a
 * ningún ecosistema… pídele acceso a quien administra"* — advice to go ask
 * themselves for a permission they already have, on a page they can already
 * see every tenant from. They reach this only when the installation genuinely
 * has no ecosistema to look at, and that is what it now says.
 */
export const GRAPH_NO_ECOSYSTEM_ADMIN =
  'Todavía no hay ningún ecosistema en la plataforma, así que no hay un grafo que mostrar.';

/** Which of the two "no ecosistema" sentences this caller should read. */
export function noEcosystemCopy(canSwitch: boolean): string {
  return canSwitch ? GRAPH_NO_ECOSYSTEM_ADMIN : GRAPH_NO_ECOSYSTEM;
}

// ── Full-text search (backlog #31) ─────────────────────────────────────────
//
// The box sends its words to `/grafo/buscar`, which asks the backend's
// `/api/graph/view?q=` — entities whose name matches, or that a matching
// PUBLISHED document of this ecosistema mentions (Postgres `spanish` full-text
// over the same text the corpus holds). The map dims everything else.

/**
 * 🔴 The search box's runtime switch, read from `GRAPH_SEARCH_ENABLED` in the
 * web app's env. ON unless set to `false`/`0`/`off`/`no` (owner, 2026-10-21:
 * "On by default everywhere"). Off hides the box and 404s `/grafo/buscar`.
 */
export function graphSearchEnabled(raw: string | undefined): boolean {
  return !['false', '0', 'off', 'no'].includes((raw ?? '').trim().toLowerCase());
}

/** Same cap on both sides of `/grafo/buscar`; the backend's own is 200. */
export const GRAPH_SEARCH_MAX_LENGTH = 120;

/** Typing pause before a search goes out, in ms. */
export const GRAPH_SEARCH_DEBOUNCE_MS = 300;

export const GRAPH_SEARCH_PLACEHOLDER = 'Buscar en los documentos…';

/** The ids `/grafo/buscar` answered with, read tolerantly. Junk ⇒ `null`. */
export function parseSearchIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return null;
  return ids.map(str).filter((id): id is string => id !== null);
}

/**
 * What the map highlights for a search: the result ids that are ON the map.
 *
 * `null` (nothing dimmed) for an empty query, and also while the answer is not
 * in yet or failed — a map that goes dark because a request blinked reads as
 * "nothing matches". An empty set is a real answer: nothing matches.
 */
export function searchHighlight(
  entities: readonly GraphEntity[],
  query: string,
  resultIds: readonly string[] | null,
): Set<string> | null {
  if (query.trim() === '' || resultIds === null) return null;
  const found = new Set(resultIds);
  return new Set(entities.filter((e) => found.has(e.id)).map((e) => e.id));
}

export const GRAPH_NO_NEIGHBOURS =
  'Todavía no hay conexiones que mostrar para esto. Aparecerán cuando varios ' +
  'documentos publicados las respalden.';

export const GRAPH_ENTITY_UNAVAILABLE =
  'No pudimos leer las conexiones de esta entidad. Vuelve a intentarlo en un rato.';

/**
 * ⚠ Says "ya no aparece", not "no existe". An entity drops out of the graph
 * when a document is unpublished or when it falls back under the threshold, and
 * both are normal. "No existe" would read as a broken link.
 */
export const GRAPH_ENTITY_NOT_FOUND =
  'Eso ya no aparece en el grafo de tu ecosistema. Pudo dejar de cumplir el mínimo ' +
  'de documentos, o el documento que lo respaldaba dejó de estar publicado.';

export const GRAPH_EDGE_DOCS_TITLE = 'Documentos que sustentan esta conexión';

/**
 * The wording for the fallback, when only the intersection is computable.
 *
 * ⚠ If `GraphNeighbour.documents` is ever `null` (an older backend), the caller
 * falls back to the intersection and MUST use this title with it. A confident
 * title over approximate data is the failure this pair exists to prevent.
 */
export const GRAPH_EDGE_DOCS_TITLE_APPROX = 'Documentos donde aparecen los dos';

/**
 * ⚠ TWO DIFFERENT SENTENCES, AND THEY MUST NOT BE MERGED. "We found none" is a
 * fact about this ecosistema; "we could not read them" is a fact about our
 * backend. Saying the first when the second is true tells someone their corpus
 * is thinner than it is.
 */
export const GRAPH_EDGE_DOCS_EMPTY =
  'No encontramos documentos publicados donde aparezcan los dos.';

export const GRAPH_EDGE_DOCS_UNAVAILABLE =
  'No pudimos leer los documentos de esta conexión. Vuelve a intentarlo en un rato.';

/** Heading over one entity's own supporting documents, when no edge is picked. */
export function entityDocsTitle(label: string): string {
  return `Dónde aparece ${label}`;
}

export const GRAPH_ENTITY_DOCS_EMPTY = 'No hay documentos publicados que listar aquí.';

/** Turn a neighbour into the new centre of the picture. */
export const GRAPH_RECENTRE_LABEL = 'Ver sus conexiones';

export const GRAPH_CLEAR_EDGE_LABEL = 'Quitar la selección';

// ⚠ NO EXPLAINER PARAGRAPHS ON /grafo (backlog #33, owner's rule 2026-10-21):
// the per-list hints, the document-list hints, the testimony note and the map
// hint are gone. Labels, buttons, short empty states and errors stay.

/**
 * Human count of what a filtered list is currently showing.
 *
 * `available` is the backend's above-threshold total (`GraphView.total`). When
 * the list is capped below it, the unfiltered count reads "1,500 de N
 * entidades" so the page never implies it holds everything.
 */
export function resultsSummary(input: {
  total: number;
  shown: number;
  filtered: boolean;
  available?: number;
}): string {
  if (input.total === 0) return input.filtered ? GRAPH_NO_RESULTS : GRAPH_EMPTY_THRESHOLD;
  if (!input.filtered && input.available !== undefined && input.available > input.total) {
    return `${input.total.toLocaleString('es-MX')} de ${input.available.toLocaleString('es-MX')} entidades`;
  }
  // ⚠ The noun agrees with the TOTAL, which is the number it follows:
  // "1 de 12 entidades", never "1 de 12 entidad". Same rule as
  // `$lib/biblioteca.resultsSummary`.
  const noun = input.total === 1 ? 'entidad' : 'entidades';
  if (!input.filtered || input.shown >= input.total) {
    return `${input.total.toLocaleString('es-MX')} ${noun}`;
  }
  return `${input.shown.toLocaleString('es-MX')} de ${input.total.toLocaleString('es-MX')} ${noun}`;
}

// ── The scope picker (platform admins only) ────────────────────────────────
//
// 🔴 SCOPE SELECTION, NEVER CONTENT (ADR §7.1). What follows lets a platform
// admin choose WHICH ecosistema `/grafo` is describing. It changes nothing
// about what is shown of it: same minimum-support threshold, same
// published-only scope, same rows a member of that ecosistema would see. There
// is deliberately no unprotected view, and this is not one.
//
// ⚠ WHY IT EXISTS AT ALL. `resolveEcosystem` answers "which ecosistemas am I a
// MEMBER of", and oversight is not membership (`/admin`'s header spells this
// out, and `refuseSelfAssignment` in the backend stops an admin joining one to
// work around it). Without a picker, an admin who belongs to nothing was shown
// "no perteneces a ningún ecosistema" on a page they are entitled to read for
// every tenant on the installation.

/**
 * Everything the picker needs. `null` on `GrafoPageData` ⇒ this caller is not a
 * platform admin and there is no picker — not "the picker is empty".
 */
export interface GraphScopePicker {
  /** Every ecosistema on the installation, or the current page of them. */
  rows: Ecosystem[];
  /** The backend's own total for the current filter. Survives the page cap. */
  total: number;
  /** `true` ⇒ `rows` is a prefix, so the search box has to reach the server. */
  truncated: boolean;
  /** `false` ⇒ the read failed. NOT "there are no ecosistemas". */
  ok: boolean;
  /** The search that produced `rows`, echoed back so the input can show it. */
  search: string;
  /**
   * Ids the caller is a MEMBER of.
   *
   * 🔴 A LABEL, NEVER A FILTER — the same rule `/admin`'s switcher states. You
   * may look at all of them; you belong to some of them. Showing which is what
   * keeps "reviewing a tenant" and "working in a tenant" from blurring together
   * in the reader's head.
   */
  mine: string[];
  /** `true` ⇒ `?eco=` named an ecosistema that does not exist. Say so. */
  notFound: boolean;
  /** `true` ⇒ the rows are the whole installation (platform admin). */
  admin: boolean;
  /** `true` ⇒ offer "Todos mis ecosistemas". See `canCombineEcosystems`. */
  combined: boolean;
}

/**
 * 🔴 THE COMBINED GRAPH ("Todos mis ecosistemas", owner 2026-10-21).
 *
 * `?eco=todos` asks for every ecosistema the caller belongs to (a platform
 * admin: every one). The BFF sends the word, never a list: the backend
 * derives the set from the caller's memberships (`authoriseCombined`).
 */
export const GRAPH_COMBINED_ECO = 'todos';
/** What the BFF sends the backend as `organization` for the combined graph. */
export const GRAPH_COMBINED_ORGANIZATION = 'all';
export const GRAPH_COMBINED_LABEL = 'Todos mis ecosistemas';
/** Fewest memberships that offer the combined graph to a non-admin. */
export const GRAPH_COMBINED_MIN_MEMBERSHIPS = 2;

/** Offered to a platform admin, or to anyone in two or more ecosistemas. */
export function canCombineEcosystems(memberships: number, admin: boolean): boolean {
  return admin || memberships >= GRAPH_COMBINED_MIN_MEMBERSHIPS;
}

/** The names of a merged node's ecosistemas, in id order; unknown ids skipped. */
export function entityEcosystemNames(
  entity: Pick<GraphEntity, 'ecosystems'>,
  names: Readonly<Record<string, string>>,
): string[] {
  return (entity.ecosystems ?? [])
    .map((id) => names[String(id)])
    .filter((n): n is string => typeof n === 'string' && n !== '');
}

/**
 * 🔴 WHERE "CAMBIAR DE ECOSISTEMA" GOES — AND WHAT IT DELIBERATELY DROPS.
 *
 * `?entidad=` and `?conexion=` are graph entity ids, and an entity id belongs to
 * exactly ONE ecosistema. Carrying them across a switch would ask the backend
 * for a stranger's id, which answers `not-found`, so the new ecosistema's graph
 * would open on *"eso ya no aparece en el grafo"* — a scary sentence about a
 * corpus that is perfectly fine. So the selection is dropped and the picker
 * lands on the ranked lists.
 *
 * `?q=` IS kept: it is the ecosistema search term, and losing it would close the
 * list someone is halfway through reading.
 */
export function graphEcosystemHref(id: string, search = ''): string {
  const qs = new URLSearchParams({ eco: id });
  const term = search.trim();
  if (term) qs.set('q', term);
  return `/grafo?${qs.toString()}`;
}

/**
 * 🔴 THE MIRROR OF `graphEcosystemHref`, AND THE BUG IT EXISTS TO PREVENT.
 *
 * Selecting an entity rebuilds the URL from scratch. Build it from `entidad`
 * and `conexion` alone and `?eco=` is DROPPED — so a platform admin viewing a
 * tenant they are not a member of would, on their first click, silently fall
 * back to their own default ecosistema and be shown a different graph than the
 * one they just clicked in. Nothing would error; the page would simply be about
 * something else.
 *
 * So the two directions have one rule each, and they are opposites on purpose:
 *  · switching ecosistema DROPS the entity selection (ids are per-ecosistema),
 *  · selecting an entity KEEPS the ecosistema scope.
 *
 * `conexion` is only meaningful with an `entidad`, and is dropped without one.
 */
export function graphEntityHref(
  entidad: string | null,
  conexion: string | null,
  scope: { eco?: string | null; q?: string | null } = {},
): string {
  const qs = new URLSearchParams();
  if (entidad) qs.set('entidad', entidad);
  if (entidad && conexion) qs.set('conexion', conexion);
  if (scope.eco) qs.set('eco', scope.eco);
  if (scope.q) qs.set('q', scope.q);
  const query = qs.toString();
  return query ? `/grafo?${query}` : '/grafo';
}

export const GRAPH_SWITCHER_LABEL = 'Estás viendo';
export const GRAPH_SWITCHER_NONE = 'Ninguno';
export const GRAPH_SWITCHER_OPEN = 'Cambiar de ecosistema';
export const GRAPH_SWITCHER_CLOSE = 'Cerrar';
export const GRAPH_SWITCHER_SEARCH_LABEL = 'Buscar ecosistema';
export const GRAPH_SWITCHER_SEARCH_PLACEHOLDER = 'Buscar por nombre o clave…';
export const GRAPH_SWITCHER_SEARCH_GO = 'Buscar';
export const GRAPH_SWITCHER_MEMBER_TAG = 'Eres miembro';

export const GRAPH_SWITCHER_NOT_FOUND =
  'El ecosistema que pediste no existe. Estás viendo otro; elígelo de la lista.';

export const GRAPH_SWITCHER_PARTIAL =
  'No pudimos leer la lista completa de ecosistemas. Puede faltar alguno.';

/** `Ningún ecosistema coincide con "…"`, or null when nothing was typed. */
export function switcherNoMatches(term: string): string {
  return `Ningún ecosistema coincide con “${term.trim()}”.`;
}

/**
 * The line under the search box.
 *
 * ⚠ THREE DIFFERENT SENTENCES, and the first is the only one the browser cannot
 * answer on its own: when the list is truncated, "12 de 90 coinciden" would be a
 * claim about 90 rows we never received. Same split `/admin`'s switcher makes.
 */
export function switcherCountCopy(input: {
  total: number;
  rows: number;
  matches: number;
  truncated: boolean;
  filtered: boolean;
}): string {
  const n = (v: number) => v.toLocaleString('es-MX');
  if (input.truncated) {
    return `Mostramos ${n(input.rows)} de ${n(input.total)} ecosistemas. Escribe y presiona Buscar para consultar el resto.`;
  }
  if (input.filtered) {
    return `${n(input.matches)} de ${n(input.rows)} ecosistemas coinciden.`;
  }
  const noun = input.rows === 1 ? 'ecosistema' : 'ecosistemas';
  return `${n(input.rows)} ${noun} en la plataforma.`;
}

// ── The ego network: deterministic radial geometry ──────────────────────────
//
// 🔴 NO PHYSICS, NO LAYOUT JITTER, NO CHARTING DEPENDENCY (ADR §7.2). The
// purpose of this picture is ANALYSIS: someone comes back tomorrow and needs to
// see the same shape they saw today, and needs to compare two entities by
// looking at them. A force-directed layout gives a different picture on every
// render and a hairball at 400 nodes; it is the wrong tool for both jobs.

/** One hop, and never more than this many neighbours (ADR §7.2). */
export const EGO_MAX_NEIGHBOURS = 20;

const EGO_RADIUS = 150;
/** Vertical fraction of the circle the columns use. < 1 keeps labels apart. */
const EGO_SPREAD = 0.92;
/** Room for a label on each side. */
const EGO_LABEL_GUTTER = 132;
const EGO_MARGIN = 30;
const EGO_NODE_MIN_R = 5;
const EGO_NODE_MAX_R = 11;
const EGO_HUB_R = 15;
/** Labels are truncated, not shrunk: 11px text stays legible, 8px does not. */
const EGO_LABEL_MAX = 20;
const EGO_HUB_LABEL_MAX = 24;

export interface EgoNode {
  id: string;
  label: string;
  /** `label`, truncated for the SVG. The full label lives in the list below it. */
  displayLabel: string;
  type: GraphViewType;
  support: number;
  relationType: GraphRelationType;
  direction: GraphEdgeDirection;
  x: number;
  y: number;
  r: number;
  labelX: number;
  labelY: number;
  labelAnchor: 'start' | 'end';
  /** Edge thickness, 1–3, by support. Thicker = more documents behind it. */
  strokeWidth: number;
}

export interface EgoLayout {
  width: number;
  height: number;
  hub: {
    x: number;
    y: number;
    r: number;
    label: string;
    displayLabel: string;
    labelY: number;
  };
  nodes: EgoNode[];
}

/** Round so the same input always produces byte-identical SVG output. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function truncateLabel(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * The neighbours the picture is allowed to draw: viewable types only, ranked,
 * capped at `EGO_MAX_NEIGHBOURS`.
 *
 * ⚠ The type filter is repeated here on purpose even though parsing already
 * applied it. It is one line, and it keeps the picture and the lists showing
 * the same set of types — a type drawn in one and missing from the other is the
 * bug this belt-and-braces exists to prevent, whichever way the set changes.
 */
export function egoNeighbours(neighbours: readonly GraphNeighbour[]): GraphNeighbour[] {
  return rankNeighbours(neighbours.filter((n) => isViewableEntityType(n.entity.type))).slice(
    0,
    EGO_MAX_NEIGHBOURS,
  );
}

/**
 * Lay a one-hop ego network out as two vertical arcs of one circle.
 *
 * ⚠ WHY NOT EVENLY SPACED AROUND THE WHOLE CIRCLE. Because the labels are
 * horizontal text. Twenty nodes at even angles crowd four or five of them into
 * the top and bottom of the circle, where their labels sit on top of each other
 * and the picture is unreadable at exactly the size we ship it. Splitting the
 * ranked neighbours alternately left/right, and choosing each angle so the
 * VERTICAL positions come out evenly spaced, keeps every node exactly on the
 * circle — still radial, still straight spokes — while guaranteeing no two
 * labels can collide, for any n up to the cap.
 *
 * The strongest neighbours land at the top of each column, so rank is readable
 * without counting.
 */
export function egoLayout(centre: GraphEntity, neighbours: readonly GraphNeighbour[]): EgoLayout {
  const rows = egoNeighbours(neighbours);
  const width = EGO_RADIUS * 2 + EGO_LABEL_GUTTER * 2;
  const height = EGO_RADIUS * 2 * EGO_SPREAD + EGO_MARGIN * 2;
  const cx = width / 2;
  const cy = height / 2;

  const supports = rows.map((n) => n.support);
  const maxSupport = supports.length ? Math.max(...supports) : 0;
  const minSupport = supports.length ? Math.min(...supports) : 0;
  const span = maxSupport - minSupport;
  const scale = (support: number): number => (span === 0 ? 0.5 : (support - minSupport) / span);

  // Alternate right/left so the two strongest sit at the top of each column.
  const sides: Array<{ dir: 1 | -1; rows: GraphNeighbour[] }> = [
    { dir: 1, rows: [] },
    { dir: -1, rows: [] },
  ];
  rows.forEach((n, i) => sides[i % 2]!.rows.push(n));

  const nodes: EgoNode[] = [];
  for (const side of sides) {
    const m = side.rows.length;
    side.rows.forEach((neighbour, i) => {
      // `frac` walks -1 → 1 down the column; a single node sits on the axis.
      const frac = m === 1 ? 0 : (i / (m - 1)) * 2 - 1;
      const sinT = frac * EGO_SPREAD;
      const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
      const r = EGO_NODE_MIN_R + (EGO_NODE_MAX_R - EGO_NODE_MIN_R) * scale(neighbour.support);
      const x = cx + side.dir * EGO_RADIUS * cosT;
      const y = cy + EGO_RADIUS * sinT;
      nodes.push({
        id: neighbour.entity.id,
        label: neighbour.entity.label,
        displayLabel: truncateLabel(neighbour.entity.label, EGO_LABEL_MAX),
        type: neighbour.entity.type,
        support: neighbour.support,
        relationType: neighbour.relationType,
        direction: neighbour.direction,
        x: round(x),
        y: round(y),
        r: round(r),
        labelX: round(x + side.dir * (r + 7)),
        labelY: round(y),
        labelAnchor: side.dir === 1 ? 'start' : 'end',
        strokeWidth: round(1 + 2 * scale(neighbour.support)),
      });
    });
  }

  return {
    width,
    height,
    hub: {
      x: round(cx),
      y: round(cy),
      r: EGO_HUB_R,
      label: centre.label,
      displayLabel: truncateLabel(centre.label, EGO_HUB_LABEL_MAX),
      labelY: round(cy + EGO_HUB_R + 16),
    },
    nodes,
  };
}

/** Screen-reader description of the picture. The SVG is `role="img"`. */
export function egoDescription(centre: GraphEntity, drawn: number): string {
  if (drawn === 0) return `${centre.label} no tiene conexiones que mostrar.`;
  const noun = drawn === 1 ? 'conexión' : 'conexiones';
  return `${centre.label}, ${supportCopy(centre.support)}, con ${drawn} ${noun} a un paso.`;
}

// ── The whole graph (backlog #3) ───────────────────────────────────────────
//
// Drawn by `force-graph` (2D canvas) and `3d-force-graph` (3D, lazy); the data
// and rules both share live in `components/graph/mapModel.ts`, which also says
// how the picture stays the same on every visit. Only the copy lives here.

/**
 * Screen-reader label of the whole-graph picture. Short on purpose (owner,
 * 2026-10-21): the counts and the "same as the list" sentence were dropped.
 */
export const OVERVIEW_DESCRIPTION = 'Mapa de conexiones';

/** Plain-Spanish labels for the colour key, one per drawn type. */
export function overviewLegend(
  present?: ReadonlySet<GraphViewType>,
): Array<{ type: GraphViewType; label: string }> {
  // Only the types on the map: a swatch for a colour nobody can find reads as missing data.
  return GRAPH_VIEW_TYPES.filter((t) => !present || present.has(t)).map((type) => ({ type, label: typeListLabel(type) }));
}

/** Legend entry for a co-mention edge. A label, not an explanation (owner). */
export const OVERVIEW_COMENTION_LEGEND = 'aparecen juntos';

export const OVERVIEW_ZOOM_IN = 'Acercar';
export const OVERVIEW_ZOOM_OUT = 'Alejar';
export const OVERVIEW_RESET = 'Ver todo';

// ── Supporting documents for an edge ───────────────────────────────────────

/**
 * The published documents in which BOTH entities appear.
 *
 * ⚠ AN APPROXIMATION, AND THE COPY SAYS SO (`GRAPH_EDGE_DOCS_HINT`). The
 * backend exposes documents per ENTITY, not per edge, so this intersection is a
 * superset of the documents that evidence the relation. It is the honest thing
 * the contract makes computable, and both inputs already passed published-only
 * and minimum support, so it can never show more than the two entity views
 * already do.
 *
 * Deterministic: the order of `a` is preserved, duplicates dropped.
 */
export function sharedDocuments(
  a: readonly GraphDocument[],
  b: readonly GraphDocument[],
): GraphDocument[] {
  const inB = new Set(b.map((d) => d.id));
  const seen = new Set<string>();
  return a.filter((d) => {
    if (!inB.has(d.id) || seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

// ── GraphRAG: the query expansion and the context block ────────────────────

/** Expansion terms kept, and the total characters they may add. */
export const MAX_EXPANSION_TERMS = 8;
export const MAX_EXPANSION_CHARS = 200;

/**
 * The condensed query, widened by the graph's neighbour labels.
 *
 * 🔴 RETURNS THE QUERY UNCHANGED WHEN NOTHING NEW SURVIVES, and the provider
 * then SKIPS the extra retrieve entirely. An expansion that adds no term is the
 * same query over the same corpus the vector leg already ran: identical
 * results, and the second `POST /v1/retrieve` bought nothing. ADR §8.4 puts the
 * bill for GraphRAG on local questions; not paying it twice for nothing is the
 * one saving available without changing the design.
 *
 * Terms already present in the query (accent-insensitively) are dropped for the
 * same reason.
 */
export function expandGraphQuery(query: string, terms: readonly string[]): string {
  const base = query.trim();
  const haystack = foldText(base);
  const seen = new Set<string>();
  const kept: string[] = [];
  let budget = MAX_EXPANSION_CHARS;
  for (const raw of terms) {
    const term = typeof raw === 'string' ? raw.trim() : '';
    if (!term) continue;
    const folded = foldText(term);
    if (!folded || seen.has(folded)) continue;
    if (haystack.includes(folded)) continue;
    if (term.length + 1 > budget) continue;
    seen.add(folded);
    kept.push(term);
    budget -= term.length + 1;
    if (kept.length >= MAX_EXPANSION_TERMS) break;
  }
  return kept.length === 0 ? base : `${base} ${kept.join(' ')}`;
}

/** How many entities and neighbours the context block names. */
export const CONTEXT_MAX_ENTITIES = 8;
export const CONTEXT_MAX_NEIGHBOURS = 3;

/**
 * 🔴 THE DETERMINISTIC SPANISH BLOCK — WHERE THE GLOBAL-QUESTION WIN COMES FROM
 * (ADR §8.1, G2).
 *
 * NO MODEL CALL. *"¿Qué temas se repiten entre los testimonios?"* is answered
 * by an aggregate over the whole published corpus that no top-8 chunk set
 * contains; the graph already holds that aggregate, so the honest thing is to
 * state it, not to ask a model to guess it back from five passages.
 *
 * ⚠ The counts are DOCUMENTS, not mentions, and the paragraph says so. A model
 * handed a bare number describes it as "frequency", and the reader then hears
 * "mentioned 12 times" about an entity that appears once in each of 12 files.
 *
 * ⚠ NO DOCUMENT TITLES. The block names entities, types, support counts and
 * neighbours — nothing else. Titles would add a per-turn re-identification
 * surface for nothing the aggregate does not already give.
 *
 * Returns `''` when there is nothing to say; the provider then contributes no
 * block at all rather than an empty header.
 */
export function graphContextParagraph(retrieval: GraphRetrieval): string {
  const entities = rankEntities(retrieval.entities).slice(0, CONTEXT_MAX_ENTITIES);
  if (entities.length === 0) return '';

  // 🔴 The index spans the SEEDS PLUS the edge endpoints. `edges` reaches one
  // hop out, so a neighbour is usually not a seed — see `GraphRetrieval.nodes`.
  const byId = new Map(
    [...retrieval.entities, ...(retrieval.nodes ?? [])].map((e) => [e.id, e]),
  );
  const neighboursOf = (id: string): Array<{ entity: GraphEntity; support: number }> => {
    // ⚠ DEDUPED BY ENTITY, not by edge. The same pair can be joined by two rows
    // — `A→B` and `B→A`, or two different relation types — and listing the
    // neighbour twice would both read as a mistake and burn two of the three
    // slots this block has. The strongest edge wins.
    const best = new Map<string, number>();
    for (const edge of retrieval.edges) {
      const otherId = edge.fromId === id ? edge.toId : edge.toId === id ? edge.fromId : null;
      if (!otherId) continue;
      const entity = byId.get(otherId);
      if (!entity) continue;
      const support = edge.support || entity.support;
      const seen = best.get(otherId);
      if (seen === undefined || support > seen) best.set(otherId, support);
    }
    return [...best.entries()]
      .map(([otherId, support]) => ({ entity: byId.get(otherId)!, support }))
      .sort((a, b) => b.support - a.support || a.entity.label.localeCompare(b.entity.label, 'es'))
      .slice(0, CONTEXT_MAX_NEIGHBOURS);
  };

  const lines = entities.map((e) => {
    const head = `- ${e.label} (${typeChipLabel(e.type)}): ${supportCopy(e.support)}.`;
    const near = neighboursOf(e.id);
    if (near.length === 0) return head;
    const rendered = near
      .map((n) => `${n.entity.label} (${typeChipLabel(n.entity.type)}, ${supportShort(n.support)})`)
      .join('; ');
    return `${head} Se conecta con: ${rendered}.`;
  });

  return [
    'Resumen del grafo de conocimiento del ecosistema, calculado sobre TODO el ' +
      'material publicado (no sobre los fragmentos de abajo). Las cifras cuentan ' +
      'documentos publicados distintos, no menciones. Solo aparecen entidades y ' +
      'conexiones que varios documentos respaldan.',
    '',
    ...lines,
    '',
    'Usa este resumen para responder preguntas generales sobre qué se repite en el ' +
      'corpus o qué aparece junto a qué. Para afirmaciones puntuales, apóyate en los ' +
      'fragmentos recuperados.',
  ].join('\n');
}
