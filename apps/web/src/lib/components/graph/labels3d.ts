/**
 * WHICH 3D LABELS SHOW, AND HOW THEY STAGGER. Pure, so it is unit-tested;
 * `graph3d.ts` only places what this returns. The 2D view does not use it.
 *
 * Why per level: the 3D view stacks node types on levels (`MAP_LEVELS`), and
 * topics, on top, hold most of the high degrees. A global "most connected"
 * cut labelled the top level densely and left the floors bare, and the top
 * labels overlapped. So each level gets its own small top-N by degree; the
 * rest show on hover or selection.
 */
import { wantsLabel, type MapFocus, type MapNode } from './mapModel';

/** Labels per level before hover or selection. Small: the top level crowds. */
export const LABELS_3D_PER_LEVEL = 5;
/** Hard cap on live HTML labels, whatever the focus. */
export const LABELS_3D_MAX = 40;

export interface Label3D {
  id: string;
  level: number;
  /** 0 for the level's most connected labelled node; drives the stagger. */
  rankInLevel: number;
}

export function labels3d(
  nodes: readonly MapNode[],
  focus: MapFocus,
  hoverId: string | null,
  perLevel = LABELS_3D_PER_LEVEL,
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
      // The selected and hovered node always show, full size (rank 0 for the
      // stagger). A selection's neighbours and search matches keep the cap.
      if (forced.has(n.id)) picked.push({ id: n.id, level, rankInLevel: 0 });
      else if (rank < perLevel) picked.push({ id: n.id, level, rankInLevel: rank });
      rank += 1;
    }
  }

  return picked
    .sort((a, b) => Number(forced.has(b.id)) - Number(forced.has(a.id)) || a.rankInLevel - b.rankInLevel)
    .slice(0, LABELS_3D_MAX);
}

/** Font scale by rank in level: the level's leader full size, the rest a bit smaller. */
export function labelScale3d(rankInLevel: number): number {
  return Math.max(0.75, 1 - 0.06 * rankInLevel);
}

/** Extra upward offset in px, cycling over three rows, so near labels do not share a baseline. */
export function labelLift3d(rankInLevel: number): number {
  return (rankInLevel % 3) * 12;
}
