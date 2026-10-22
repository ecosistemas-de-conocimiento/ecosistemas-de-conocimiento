/**
 * WHAT THE HEIGHT MEANS IN THE 3D MAP (owner ruling 2026-10-21, chosen
 * (review)). Pure, so it is unit-tested; `graph3d.ts` turns a floor into a
 * height and `OverviewGraph.svelte` holds the selector.
 *
 * Every option maps a node to a FLOOR: a small integer, 0 = the ground. The 3D
 * label declutter (`labels3d.ts`) groups labels by floor (about five drawn per
 * floor), so every option must give a few discrete floors, never a continuum.
 *
 *   tipo         `MAP_LEVELS`, "del suelo a las ideas": lugar 0, persona and
 *                organización 1, evento 2, tema 3.
 *   ecosistemas  How many of the included ecosistemas the entity appears in,
 *                minus one: 1 → 0, 2 → 1 … capped at `Z_FLOORS` - 1 (5+).
 *                Local on the floor, shared at the top. ⚠ Offered ONLY in the
 *                combined (cross-ecosistema) view; elsewhere every node has 1.
 *   frecuencia   `support` (documents that mention it), on a log scale over
 *                the SHOWN range: floor = round(4 · ln(v/min) / ln(max/min)),
 *                so the least-mentioned node is floor 0, the most floor 4.
 *   centralidad  Degree in the SHOWN edges, same log scale: hubs rise.
 *   comunidad    One floor per cluster (Louvain on the shown edges), the
 *                largest cluster on the ground. Past `COMMUNITY_FLOORS` - 1
 *                clusters, the small ones share the top floor.
 *
 * ⚠ DETERMINISTIC. Nodes are processed in sorted-id order and every tie breaks
 * to the lowest index, so the same graph gives the same floors on every visit.
 */
import { MAP_LEVELS } from './mapModel';

export type ZAxis = 'tipo' | 'ecosistemas' | 'frecuencia' | 'centralidad' | 'comunidad';

/** The input, declared structurally so it accepts a `GraphEntity` with or without `ecosystems`. */
export interface ZNode {
  id: string;
  type: string;
  support: number;
  /** Ids of the included ecosistemas this entity appears in (combined view only). */
  ecosystems?: number[];
}

export interface ZLink {
  source: string;
  target: string;
}

export const Z_AXIS_LABELS: Record<ZAxis, string> = {
  tipo: 'Tipo',
  ecosistemas: 'Ecosistemas compartidos',
  frecuencia: 'Frecuencia',
  centralidad: 'Centralidad',
  comunidad: 'Comunidad',
};

/** The selector's name and tooltip. */
export const Z_AXIS_TITLE = 'Altura';

/** Floors for the continuous options (frecuencia, centralidad) and the ecosistema count. */
export const Z_FLOORS = 5;
/** Floors for comunidad: the 7 largest clusters, then one shared floor. */
export const COMMUNITY_FLOORS = 8;

const ALL: ZAxis[] = ['tipo', 'ecosistemas', 'frecuencia', 'centralidad', 'comunidad'];

/** What the selector offers. `ecosistemas` only in the combined view. */
export function zAxisOptions(combined: boolean): ZAxis[] {
  return combined ? ALL : ALL.filter((a) => a !== 'ecosistemas');
}

export function defaultZAxis(combined: boolean): ZAxis {
  return combined ? 'ecosistemas' : 'tipo';
}

/** One remembered choice per view kind: a single ecosistema, or the combined view. */
export function zAxisKey(combined: boolean): string {
  return `edc.grafo.altura.${combined ? 'combinada' : 'una'}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The stored choice if it is offered here, else the default. Any storage throw reads as the default. */
export function readZAxis(storage: () => StorageLike | null | undefined, combined: boolean): ZAxis {
  try {
    const v = storage()?.getItem(zAxisKey(combined));
    return zAxisOptions(combined).find((a) => a === v) ?? defaultZAxis(combined);
  } catch {
    return defaultZAxis(combined);
  }
}

export function writeZAxis(storage: () => StorageLike | null | undefined, combined: boolean, axis: ZAxis): void {
  try {
    storage()?.setItem(zAxisKey(combined), axis);
  } catch {
    // Not remembered; the selector still works for this visit.
  }
}

/** Node id → floor (0 = ground), for every node in `nodes`. */
export function zFloors(nodes: readonly ZNode[], links: readonly ZLink[], axis: ZAxis): Map<string, number> {
  switch (axis) {
    case 'tipo':
      return new Map(nodes.map((n) => [n.id, (MAP_LEVELS as Record<string, number>)[n.type] ?? 0]));
    case 'ecosistemas':
      return new Map(
        nodes.map((n) => [n.id, Math.min(Z_FLOORS, Math.max(1, new Set(n.ecosystems ?? []).size)) - 1]),
      );
    case 'frecuencia':
      return logFloors(new Map(nodes.map((n) => [n.id, n.support])));
    case 'centralidad':
      return logFloors(degrees(nodes, links));
    case 'comunidad':
      return communityFloors(nodes, links);
  }
}

/** Distinct shown neighbours per node; links to unknown ids and self-loops ignored. */
function degrees(nodes: readonly ZNode[], links: readonly ZLink[]): Map<string, number> {
  const out = new Map(nodes.map((n) => [n.id, 0]));
  for (const [a, b] of edgePairs(out, links)) {
    out.set(a, out.get(a)! + 1);
    out.set(b, out.get(b)! + 1);
  }
  return out;
}

/** Unique unordered pairs of known, distinct ids. */
function edgePairs(known: Map<string, unknown>, links: readonly ZLink[]): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const l of links) {
    if (l.source === l.target || !known.has(l.source) || !known.has(l.target)) continue;
    const [a, b] = l.source < l.target ? [l.source, l.target] : [l.target, l.source];
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
  }
  return out;
}

/**
 * round((Z_FLOORS - 1) · ln(v / min) / ln(max / min)) over the shown values:
 * the least goes on the ground, the most on the top floor. From the shown
 * minimum, not from 1: with co-mention edges no node has degree 1, and a
 * scale from 1 left the ground floor empty (measured, local org 1, 2026-10-21).
 */
function logFloors(values: Map<string, number>): Map<string, number> {
  let min = Infinity;
  let max = 1;
  for (const v of values.values()) {
    min = Math.min(min, Math.max(1, v));
    max = Math.max(max, v);
  }
  const span = Math.log(max / min);
  const top = Z_FLOORS - 1;
  const out = new Map<string, number>();
  for (const [id, v] of values) {
    out.set(id, span > 0 ? Math.round((top * Math.log(Math.max(1, v) / min)) / span) : 0);
  }
  return out;
}

function communityFloors(nodes: readonly ZNode[], links: readonly ZLink[]): Map<string, number> {
  const groups = communities(nodes, links);
  const out = new Map<string, number>();
  for (const [id, c] of groups) out.set(id, Math.min(c, COMMUNITY_FLOORS - 1));
  return out;
}

/**
 * Clusters by Louvain (modularity, unweighted, on the shown edges): local
 * moves, then each cluster folds into one node, repeated until nothing moves.
 * Returns node id → cluster index, 0 = the largest (ties: the one holding the
 * lowest sorted id). O(edges) per sweep; a few sweeps per level.
 *
 * Cost, measured 2026-10-21 on the local org 1 graph (507 nodes, 4,199 edges,
 * 7 clusters) under vitest/node on an i9-9900K at load 8–18: median 5–20 ms,
 * first (cold) call 16–107 ms. Runs only when 3D is on.
 */
export function communities(nodes: readonly ZNode[], links: readonly ZLink[]): Map<string, number> {
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs = edgePairs(index, links)
    .map(([a, b]) => [index.get(a)!, index.get(b)!] as const)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // Current (folded) graph: symmetric weights, a self-loop holds twice the
  // weight inside the folded cluster, so k_i = Σ_j A_ij throughout.
  let adj: Array<Map<number, number>> = ids.map(() => new Map());
  const add = (row: Map<number, number>, j: number, w: number) => row.set(j, (row.get(j) ?? 0) + w);
  for (const [a, b] of pairs) {
    add(adj[a]!, b, 1);
    add(adj[b]!, a, 1);
  }
  /** Original node → node of the current folded graph. */
  let membership = ids.map((_, i) => i);

  for (let level = 0; level < 20; level++) {
    const { community, moved } = localMoves(adj);
    if (!moved) break;
    // Renumber clusters by first appearance, so the folded graph is ordered too.
    const renum = new Map<number, number>();
    for (const c of community) if (!renum.has(c)) renum.set(c, renum.size);
    const to = community.map((c) => renum.get(c)!);
    const folded: Array<Map<number, number>> = Array.from({ length: renum.size }, () => new Map());
    adj.forEach((row, i) => {
      for (const [j, w] of row) add(folded[to[i]!]!, to[j]!, w);
    });
    membership = membership.map((m) => to[m]!);
    adj = folded;
  }

  // Index clusters by size, largest first; ties by lowest member index.
  const size = new Map<number, number>();
  const first = new Map<number, number>();
  membership.forEach((c, i) => {
    size.set(c, (size.get(c) ?? 0) + 1);
    if (!first.has(c)) first.set(c, i);
  });
  const order = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)! || first.get(a)! - first.get(b)!);
  const rank = new Map(order.map((c, i) => [c, i]));
  return new Map(ids.map((id, i) => [id, rank.get(membership[i]!)!]));
}

/** Louvain phase 1 on one graph: move each node to the neighbouring cluster with the best gain. */
function localMoves(adj: Array<Map<number, number>>): { community: number[]; moved: boolean } {
  const k = adj.map((row) => {
    let s = 0;
    for (const w of row.values()) s += w;
    return s;
  });
  const m2 = k.reduce((a, b) => a + b, 0);
  const community = adj.map((_, i) => i);
  const tot = [...k];
  let moved = false;
  if (m2 === 0) return { community, moved };

  for (let sweep = 0; sweep < 50; sweep++) {
    let changed = false;
    adj.forEach((row, i) => {
      const own = community[i]!;
      const ki = k[i]!;
      // Weights from i to each neighbouring cluster, in first-seen order.
      const toCluster = new Map<number, number>();
      for (const [j, w] of row) {
        if (j === i) continue;
        const c = community[j]!;
        toCluster.set(c, (toCluster.get(c) ?? 0) + w);
      }
      tot[own] = tot[own]! - ki;
      // Staying wins a tie; among the others, the lowest cluster id.
      let best = own;
      let bestGain = (toCluster.get(own) ?? 0) - (tot[own]! * ki) / m2;
      for (const [c, w] of toCluster) {
        const gain = w - (tot[c]! * ki) / m2;
        const tie = Math.abs(gain - bestGain) <= 1e-12;
        if ((!tie && gain > bestGain) || (tie && best !== own && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      tot[best] = tot[best]! + ki;
      if (best !== own) {
        community[i] = best;
        changed = true;
        moved = true;
      }
    });
    if (!changed) break;
  }
  return { community, moved };
}
