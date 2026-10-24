/**
 * THE WHOLE-GRAPH MAP'S DATA AND RULES, SHARED BY 2D AND 3D.
 *
 * Pure and DOM-free, so `apps/web`'s node-only vitest can assert it. The two
 * renderers (`graph2d.ts` on `force-graph`, `graph3d.ts` on `3d-force-graph`)
 * only draw what this file decides: which nodes, where they start, how big,
 * which edges and how they look, what is dimmed, which labels show.
 *
 * ── THE SAME PICTURE EVERY VISIT (owner, 2026-10-21, chosen (review)) ──────
 *
 * The layout engine is `d3-force-3d`, run to rest BEFORE the first draw
 * (`warmupTicks`, `cooldownTicks(0)`) with node drag off. It is deterministic
 * when its input is: its random source is a seeded generator created with each
 * simulation, and it only draws from it for two nodes on the very same spot.
 * So this file fixes the input — nodes in one total order (support, then
 * label, then id) and a start position for each on a sunflower spiral by rank,
 * so no two start on the same spot.
 */
import {
  supportShort,
  typeChipLabel,
  type GraphEntity,
  type GraphViewEdge,
  type GraphViewEdgeKind,
  type GraphViewType,
} from '$lib/graph';

export interface MapNode {
  id: string;
  label: string;
  type: GraphViewType;
  support: number;
  /** 0 = most documents. The order the layout receives the nodes in. */
  rank: number;
  /** Edges drawn to this node. */
  degree: number;
  /** 0 = most edges. Decides which labels show before any zoom. */
  degreeRank: number;
  /** Radius in layout units, by support (area tracks documents). */
  r: number;
  /** Start position (layout units). The engine moves it; see the header. */
  x: number;
  y: number;
  /** 3D only: the floor-to-ideas level, see {@link MAP_LEVELS}. */
  level: number;
}

export interface MapLink {
  /** `fromId|toId`, unique per pair. */
  key: string;
  source: string;
  target: string;
  kind: GraphViewEdgeKind;
  support: number;
  /** Line width in screen pixels. */
  width: number;
}

export interface MapData {
  nodes: MapNode[];
  links: MapLink[];
  /** Node id → ids it is drawn connected to. */
  adjacency: Map<string, Set<string>>;
  /**
   * A fingerprint of everything that moves the layout. Equal ⇒ the same
   * picture, so the renderer keeps its positions instead of re-running the
   * layout when only the selection changed (a selection is a navigation, and a
   * navigation hands the page a fresh copy of the same view).
   */
  signature: string;
}

const NODE_MIN_R = 3;
const NODE_MAX_R = 10;
/** Distance between spiral turns; the engine's own default start spacing. */
const SPIRAL_STEP = 10;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * "Del suelo a las ideas" (owner, chosen (review)): places on the floor,
 * people and organisations above them, events above those, topics on top.
 */
export const MAP_LEVELS: Record<GraphViewType, number> = {
  lugar: 0,
  persona: 1,
  organizacion: 1,
  evento: 2,
  tema: 3,
};

/** Labels shown before any zoom: the most connected nodes. */
export const MAP_ALWAYS_LABELLED = 18;
/** Zoom, relative to the fitted view, above which every label may show. */
export const MAP_LABEL_ALL_ZOOM = 3;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Support desc, then label, then id: a TOTAL order, so ties cannot reorder. */
export function mapOrder(a: GraphEntity, b: GraphEntity): number {
  return (
    b.support - a.support ||
    a.label.localeCompare(b.label, 'es') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The sunflower-spiral start position of the node at `rank`. */
export function spiralSeed(rank: number): { x: number; y: number } {
  const radius = SPIRAL_STEP * Math.sqrt(rank + 0.5);
  return { x: round(radius * Math.cos(rank * GOLDEN)), y: round(radius * Math.sin(rank * GOLDEN)) };
}

/**
 * 🔴 A TOWN WHOSE ONLY EXTRACTED RELATION IS ITS STATE IS NOT DRAWN (owner,
 * 2026-10-23, verbatim: "if town has only the state link, dont show the town").
 *
 * Towns and states are both `lugar`; the extraction has no town/state subtype.
 * What tells them apart is the `ubicado_en` relation the extraction writes for
 * "Cuernavaca, Morelos" (backend `splitQualifiedPlaces`): its `from` side is
 * the town. So a town↔state edge is a `relation` edge between two `lugar`
 * nodes whose pair's most common type is `ubicado_en`. The edge's `direction`
 * names the town: `out` ⇒ `fromId`, `in` ⇒ `toId`. `both` (or no direction)
 * cannot say which end is the state, so neither end is hidden: a state is
 * never hidden by this rule.
 *
 * ⚠ ONLY EXTRACTED RELATIONS COUNT, NOT CO-MENTIONS. A `lugar` whose single
 * `relation` edge is that state link is removed entirely: the state link AND
 * its co-mention edges. Counting co-mentions would hide nothing — they give
 * every entity up to K=8 partners, so every town had 5+ edges (measured
 * 2026-10-23, local 4-ecosistema copy `edc_backend_combo`). A town with any
 * other relation stays, and so does its state link. The state stays while it
 * still has a drawn edge; the degree-0 rule in {@link buildMapData} hides it
 * otherwise. On that copy it hides 2–6 places per ecosistema and 5 in the
 * combined view, 22–65 edges each (measured 2026-10-23, default thresholds).
 *
 * ⚠ ONE PASS, ON PURPOSE. Relations are counted once over the edges as the
 * backend sent them. Hiding a town does not make its state a "lone town" of
 * its own `ubicado_en` (Morelos → México) in a second round.
 *
 * Overview map only: 2D and 3D, single and combined views all go through
 * {@link buildMapData}. The entity panel's neighbour list, the ego network and
 * the lists still show the town. `GraphView.hidden` (the backend's threshold
 * count) is not touched; the page no longer prints it (`$lib/graph`, #28).
 *
 * @returns the ids of the towns to hide.
 */
export function loneTowns(edges: readonly GraphViewEdge[], entities: readonly GraphEntity[]): Set<string> {
  const placeIds = new Set(entities.filter((e) => e.type === 'lugar').map((e) => e.id));
  const relations = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== 'relation') continue;
    relations.set(e.fromId, (relations.get(e.fromId) ?? 0) + 1);
    relations.set(e.toId, (relations.get(e.toId) ?? 0) + 1);
  }
  const towns = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'relation' || e.relationType !== 'ubicado_en') continue;
    if (!placeIds.has(e.fromId) || !placeIds.has(e.toId)) continue;
    const town = e.direction === 'out' ? e.fromId : e.direction === 'in' ? e.toId : null;
    if (town !== null && relations.get(town) === 1) towns.add(town);
  }
  return towns;
}

/**
 * Build the map. Owner rule 2026-10-21, chosen (review): degree-0 entities are
 * not drawn (the lists still show them). With co-mention edges there are
 * rarely any: 0 of 507 on the local corpus (measured 2026-10-21, org 1, K=8).
 * Towns whose only relation is their state are removed first: {@link loneTowns}.
 */
export function buildMapData(
  entities: readonly GraphEntity[],
  edges: readonly GraphViewEdge[],
): MapData {
  const known = new Set(entities.map((e) => e.id));
  const seen = new Set<string>();
  const kept: GraphViewEdge[] = [];
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.fromId === e.toId || !known.has(e.fromId) || !known.has(e.toId)) continue;
    const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(e);
  }
  const hiddenTowns = loneTowns(kept, entities);
  const shown = kept.filter((e) => !hiddenTowns.has(e.fromId) && !hiddenTowns.has(e.toId));
  for (const e of shown) {
    degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
    degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
  }

  const drawn = entities.filter((e) => degree.has(e.id)).sort(mapOrder);
  const maxSupport = drawn.reduce((m, e) => Math.max(m, e.support), 1);
  const byDegree = [...drawn].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || mapOrder(a, b),
  );
  const degreeRank = new Map(byDegree.map((e, i) => [e.id, i]));

  const nodes: MapNode[] = drawn.map((e, rank) => ({
    id: e.id,
    label: e.label,
    type: e.type,
    support: e.support,
    rank,
    degree: degree.get(e.id) ?? 0,
    degreeRank: degreeRank.get(e.id) ?? rank,
    r: round(NODE_MIN_R + (NODE_MAX_R - NODE_MIN_R) * Math.sqrt(e.support / maxSupport)),
    ...spiralSeed(rank),
    level: MAP_LEVELS[e.type],
  }));

  const maxRelation = shown.reduce((m, e) => (e.kind === 'relation' ? Math.max(m, e.support) : m), 1);
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adjacency.get(a) ?? new Set<string>();
    set.add(b);
    adjacency.set(a, set);
  };
  const links: MapLink[] = shown.map((e) => {
    link(e.fromId, e.toId);
    link(e.toId, e.fromId);
    return {
      key: e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`,
      source: e.fromId,
      target: e.toId,
      kind: e.kind,
      support: e.support,
      width: linkWidth(e.kind, e.support, maxRelation),
    };
  });

  const signature = `${nodes.map((n) => `${n.id}:${n.support}`).join(',')}#${links
    .map((l) => `${l.key}:${l.kind}:${l.support}`)
    .join(',')}`;
  return { nodes, links, adjacency, signature };
}

/**
 * Screen-pixel width. A relation reads as a line, thicker with more documents;
 * a co-mention ("aparecen juntos") is always thin — and dashed and lighter in
 * the renderers — so the eye reads the extracted relations first.
 */
export function linkWidth(kind: GraphViewEdgeKind, support: number, maxRelation: number): number {
  if (kind === 'co-mention') return 0.5;
  return round(0.8 + 1.8 * Math.min(1, support / Math.max(1, maxRelation)));
}

/** Dash pattern in screen pixels, or `null` for a solid line. */
export function linkDash(kind: GraphViewEdgeKind): number[] | null {
  return kind === 'co-mention' ? [3, 3] : null;
}

// ── Highlighting ────────────────────────────────────────────────────────────

export interface MapFocus {
  selectedId: string | null;
  /** What the search box matches, or `null` when it is empty. */
  matches: ReadonlySet<string> | null;
  /** The selected node's neighbours: the map's own plus the panel's. */
  neighbourIds: ReadonlySet<string> | null;
}

/** The selected node's neighbours, as the map AND the panel list them. */
export function focusNeighbours(
  data: MapData,
  selectedId: string | null,
  panelNeighbourIds: readonly string[],
): Set<string> | null {
  if (!selectedId) return null;
  return new Set([...(data.adjacency.get(selectedId) ?? []), ...panelNeighbourIds]);
}

export function nodeDim(id: string, focus: MapFocus): boolean {
  if (focus.matches) return !focus.matches.has(id);
  if (focus.selectedId) return id !== focus.selectedId && !focus.neighbourIds?.has(id);
  return false;
}

export type LinkState = 'normal' | 'active' | 'dim';

export function linkState(source: string, target: string, focus: MapFocus): LinkState {
  if (focus.selectedId) {
    return source === focus.selectedId || target === focus.selectedId ? 'active' : 'dim';
  }
  if (focus.matches) return focus.matches.has(source) || focus.matches.has(target) ? 'normal' : 'dim';
  return 'normal';
}

/**
 * Which labels may show, before overlap is resolved (level of detail). The
 * selected and hovered nodes always show; with a selection, its neighbours;
 * with a search, the matches; otherwise the {@link MAP_ALWAYS_LABELLED} most
 * connected, and every node once zoomed past {@link MAP_LABEL_ALL_ZOOM}.
 */
export function wantsLabel(node: MapNode, focus: MapFocus, relativeZoom: number): boolean {
  const zoomedIn = relativeZoom >= MAP_LABEL_ALL_ZOOM;
  if (focus.matches) return focus.matches.has(node.id) && (focus.matches.size <= 30 || zoomedIn);
  if (focus.selectedId) return node.id === focus.selectedId || (focus.neighbourIds?.has(node.id) ?? false);
  return node.degreeRank < MAP_ALWAYS_LABELLED || zoomedIn;
}

// ── Text ────────────────────────────────────────────────────────────────────

const LABEL_MAX = 22;

export function shortLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/**
 * 🔴 EVERY LABEL IS ESCAPED BEFORE IT REACHES HTML. Entity labels come out of
 * documents. `force-graph`'s and `3d-force-graph`'s `nodeLabel` set the
 * tooltip's `innerHTML`, so an unescaped `<img onerror=…>` in a label would run.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The hover tooltip, as SAFE HTML: "Morelos — lugar — 117 documentos". */
export function nodeTooltipHtml(node: Pick<MapNode, 'label' | 'type' | 'support'>): string {
  return escapeHtml(`${node.label} — ${typeChipLabel(node.type)} — ${supportShort(node.support)}`);
}
