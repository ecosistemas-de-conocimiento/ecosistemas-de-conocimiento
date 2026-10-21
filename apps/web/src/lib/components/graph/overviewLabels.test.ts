import { describe, expect, it } from 'vitest';
import { placeLabels, type LabelNode } from './overviewLabels';

const node = (id: string, rank: number, x: number, y: number, label = 'Parteras'): LabelNode => ({
  id,
  displayLabel: label,
  rank,
  x,
  y,
  r: 4,
});

describe('placeLabels', () => {
  const all = () => true;

  it('keeps the stronger of two overlapping labels', () => {
    const nodes = [node('weak', 1, 105, 100), node('strong', 0, 100, 100)];
    expect([...placeLabels(nodes, 1, all)]).toEqual(['strong']);
  });

  it('keeps both when they are apart', () => {
    const nodes = [node('a', 0, 100, 100), node('b', 1, 400, 100)];
    expect(placeLabels(nodes, 1, all)).toEqual(new Set(['a', 'b']));
  });

  it('zooming in makes room: labels shrink against the layout', () => {
    const nodes = [node('a', 0, 100, 100), node('b', 1, 150, 100)];
    expect(placeLabels(nodes, 1, all).has('b')).toBe(false);
    expect(placeLabels(nodes, 4, all).has('b')).toBe(true);
  });

  it('a forced (hovered or selected) label always shows and wins its spot', () => {
    const nodes = [node('strong', 0, 100, 100), node('hover', 5, 102, 100)];
    expect([...placeLabels(nodes, 1, all, new Set(['hover']))]).toEqual(['hover']);
  });

  it('draws only the wanted ones', () => {
    const nodes = [node('a', 0, 100, 100), node('b', 1, 400, 100)];
    expect([...placeLabels(nodes, 1, (n) => n.rank === 1)]).toEqual(['b']);
  });

  it('is deterministic whatever the input order', () => {
    const nodes = [node('c', 2, 110, 100), node('a', 0, 100, 100), node('b', 1, 400, 100)];
    expect(placeLabels(nodes, 1, all)).toEqual(placeLabels([...nodes].reverse(), 1, all));
  });
});
