/**
 * Which overview-map labels to draw, so no two overlap (`OverviewGraph.svelte`).
 *
 * Greedy and deterministic: `forced` labels (selected, hovered) go first, then
 * the wanted ones strongest first (`rank` 0 = strongest). A label whose box
 * would cross one already placed is skipped. Boxes are estimated from the
 * character count, so no DOM measuring: O(placed²), a few hundred at most.
 */
export interface LabelNode {
  id: string;
  displayLabel: string;
  rank: number;
  x: number;
  y: number;
  r: number;
}

/** Average glyph width as a share of the font size (bold body font, estimated). */
const CHAR_WIDTH = 0.62;
/** Line box as a share of the font size: ascenders, descenders and the halo stroke. */
const LINE_HEIGHT = 1.3;

/** The label's font size at zoom `k`, in layout units. */
export function labelFontSize(k: number): number {
  return 12 / Math.sqrt(k);
}

export function placeLabels(
  nodes: readonly LabelNode[],
  k: number,
  wanted: (node: LabelNode) => boolean,
  forced: ReadonlySet<string> = new Set(),
): Set<string> {
  const fs = labelFontSize(k);
  const order = nodes
    .filter((n) => forced.has(n.id) || wanted(n))
    .sort((a, b) => Number(forced.has(b.id)) - Number(forced.has(a.id)) || a.rank - b.rank);
  const boxes: Array<[number, number, number, number]> = [];
  const shown = new Set<string>();
  for (const n of order) {
    const w = n.displayLabel.length * fs * CHAR_WIDTH;
    const bottom = n.y - n.r - 4 / k;
    const box: [number, number, number, number] = [n.x - w / 2, bottom - fs * LINE_HEIGHT, n.x + w / 2, bottom + fs * 0.3];
    const hits = boxes.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3]);
    if (hits && !forced.has(n.id)) continue;
    boxes.push(box);
    shown.add(n.id);
  }
  return shown;
}
