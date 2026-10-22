/**
 * WHICH 3D LABELS SHOW. Pure, so it is unit-tested; `graph3d.ts` only projects
 * and places what this returns. The 2D view does not use it.
 *
 * Two steps:
 *   1. `labels3d` — CANDIDATES, by rank: per level (`MAP_LEVELS`), the most
 *      connected few, plus the selected and hovered node. Per level because
 *      topics, on top, hold most of the high degrees: a global cut labelled
 *      the top level densely and left the floors bare.
 *   2. `declutter3d` — WHAT IS DRAWN, by screen space, after projection: keep
 *      labels greedily by rank, skip any whose box meets one already kept, and
 *      stop at `LABELS_3D_PER_LEVEL` per level. Rank alone let labels pile up
 *      (dev, 10-21: 7 on the topic level, 4 overlapping pairs), because levels
 *      project onto each other and a label's neighbours in rank are often its
 *      neighbours on screen. Re-run on every camera move, so an orbit or a
 *      zoom can bring back a label the old angle hid.
 */
import { wantsLabel, type MapFocus, type MapNode } from './mapModel';

/** Labels DRAWN per level, at most, before hover or selection. */
export const LABELS_3D_PER_LEVEL = 5;
/**
 * Candidates per level: more than are drawn, so a label hidden by overlap can
 * give its place to the next one down in rank.
 */
export const LABELS_3D_CANDIDATES_PER_LEVEL = 12;
/** Hard cap on live HTML labels, whatever the focus. */
export const LABELS_3D_MAX = 60;

export interface Label3D {
  id: string;
  level: number;
  /** 0 for the level's most connected candidate; drives the scale. */
  rankInLevel: number;
  /** The selected or hovered node: always drawn, whatever it overlaps. */
  forced: boolean;
}

export function labels3d(
  nodes: readonly MapNode[],
  focus: MapFocus,
  hoverId: string | null,
  perLevel = LABELS_3D_CANDIDATES_PER_LEVEL,
): Label3D[] {
  const focused = focus.matches !== null || focus.selectedId !== null;
  const forced = new Set([focus.selectedId, hoverId].filter((id): id is string => id !== null));

  const byLevel = new Map<number, MapNode[]>();
  for (const n of nodes) {
    if (focused && !wantsLabel(n, focus, 1) && !forced.has(n.id)) continue;
    const list = byLevel.get(n.level) ?? [];
    list.push(n);
    byLevel.set(n.level, list);
  }

  const picked: Label3D[] = [];
  for (const [level, list] of byLevel) {
    list.sort((a, b) => a.degreeRank - b.degreeRank);
    let rank = 0;
    for (const n of list) {
      // The selected and hovered node always show, full size (rank 0). A
      // selection's neighbours and search matches keep the cap.
      if (forced.has(n.id)) picked.push({ id: n.id, level, rankInLevel: 0, forced: true });
      else if (rank < perLevel) picked.push({ id: n.id, level, rankInLevel: rank, forced: false });
      rank += 1;
    }
  }

  return picked.sort(byPriority).slice(0, LABELS_3D_MAX);
}

/** Forced first, then by rank in level; levels interleave at equal rank. */
function byPriority(a: Label3D, b: Label3D): number {
  return Number(b.forced) - Number(a.forced) || a.rankInLevel - b.rankInLevel;
}

/** Font scale by rank in level: the level's leader full size, the rest a bit smaller. */
export function labelScale3d(rankInLevel: number): number {
  return Math.max(0.8, 1 - 0.05 * rankInLevel);
}

/** A screen rectangle, in px from the label layer's top-left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Font of `.map3d-label` (`OverviewGraph.svelte`): 11 px, bold. ⚠ Keep in step
 * with that CSS. The box is an estimate from the text length, not a measure:
 * measuring would force a layout per label per frame.
 */
export const LABEL_3D_FONT_PX = 11;
/** Average bold glyph width over font size; a bit generous, so near misses count. */
const CHAR_EM = 0.62;
/** Line height over font size, plus the text shadow. */
const LINE_EM = 1.35;
/** Clear space kept around every label, px. */
const GAP = 2;

/**
 * The box of a label whose bottom-centre sits at (`x`, `y`): the anchor
 * `graph3d.ts` places it on (`translate(-50%, -100%)`).
 */
export function labelBox3d(text: string, x: number, y: number, scale = 1, fontPx = LABEL_3D_FONT_PX): Box {
  const w = (text.length * CHAR_EM * fontPx + 2 * GAP) * scale;
  const h = (LINE_EM * fontPx + 2 * GAP) * scale;
  return { x: x - w / 2, y: y - h, w, h };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface Placed3D {
  id: string;
  level: number;
  forced: boolean;
  /** `null`: no screen position (behind the camera, or not laid out yet). */
  box: Box | null;
}

/**
 * Which labels to draw. `placed` must come in priority order (as `labels3d`
 * returns it). Greedy: forced labels always; then each label in turn, if it is
 * on screen, its level has room, and its box meets no label already kept.
 * O(n × kept), and kept ≤ 5 per level: cheap enough for every camera frame.
 */
export function declutter3d(
  placed: readonly Placed3D[],
  view: { width: number; height: number },
  perLevel = LABELS_3D_PER_LEVEL,
): Set<string> {
  const kept: Box[] = [];
  const keep = new Set<string>();
  const perLevelCount = new Map<number, number>();
  for (const p of placed) {
    if (!p.forced) {
      const b = p.box;
      if (!b) continue;
      // Off screen: the layer clips it, so it would spend a place for nothing.
      if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= view.width || b.y >= view.height) continue;
      if ((perLevelCount.get(p.level) ?? 0) >= perLevel) continue;
      if (kept.some((k) => boxesOverlap(k, b))) continue;
    }
    keep.add(p.id);
    if (p.box) kept.push(p.box);
    perLevelCount.set(p.level, (perLevelCount.get(p.level) ?? 0) + 1);
  }
  return keep;
}
