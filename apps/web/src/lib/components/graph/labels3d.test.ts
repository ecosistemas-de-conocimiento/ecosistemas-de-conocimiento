import { describe, expect, it } from 'vitest';

import {
  LABELS_3D_CANDIDATES_PER_LEVEL,
  LABELS_3D_PER_LEVEL,
  boxesOverlap,
  declutter3d,
  labelBox3d,
  labelScale3d,
  labels3d,
  type Placed3D,
} from './labels3d';
import type { MapFocus, MapNode } from './mapModel';

const node = (id: string, level: number, degreeRank: number): MapNode =>
  ({ id, level, degreeRank }) as MapNode;
const none: MapFocus = { selectedId: null, matches: null, neighbourIds: null };

// 12 topics on the top level (3), 3 places on the floor (0). The topics hold
// the best degree ranks, so a global top-N would starve the floor.
const topics = Array.from({ length: 12 }, (_, i) => node(`t${i}`, 3, i));
const places = [node('p0', 0, 20), node('p1', 0, 30), node('p2', 0, 40)];
const nodes = [...places, ...topics];

describe('3D labels: top-N by degree per level', () => {
  it('labels at most N nodes per level, the most connected first', () => {
    const picked = labels3d(nodes, none, null, 3);
    expect(picked.filter((l) => l.level === 3).map((l) => l.id)).toEqual(['t0', 't1', 't2']);
    expect(picked.filter((l) => l.level === 0).map((l) => l.id)).toEqual(['p0', 'p1', 'p2']);
    expect(picked).toHaveLength(6);
  });

  it('gives each label its rank inside its level', () => {
    const picked = labels3d(nodes, none, null, 3);
    expect(picked.find((l) => l.id === 't2')!.rankInLevel).toBe(2);
    expect(picked.find((l) => l.id === 'p0')!.rankInLevel).toBe(0);
  });

  it('offers more candidates per level than are drawn, so overlap has spares', () => {
    const top = labels3d(nodes, none, null).filter((l) => l.level === 3);
    expect(top).toHaveLength(Math.min(12, LABELS_3D_CANDIDATES_PER_LEVEL));
    expect(LABELS_3D_CANDIDATES_PER_LEVEL).toBeGreaterThan(LABELS_3D_PER_LEVEL);
    expect(LABELS_3D_PER_LEVEL).toBeLessThanOrEqual(5);
  });

  it('marks the hovered and selected node as forced, and puts them first', () => {
    const focus: MapFocus = { selectedId: 'p2', matches: null, neighbourIds: null };
    const picked = labels3d(nodes, focus, null);
    expect(picked[0]).toMatchObject({ id: 'p2', forced: true });
    expect(picked.filter((l) => l.forced)).toHaveLength(1);
  });

  it('always labels the hovered and the selected node, past the cap', () => {
    const focus: MapFocus = { selectedId: 't10', matches: null, neighbourIds: new Set(['t0']) };
    const ids = labels3d(nodes, focus, 't11', 1).map((l) => l.id);
    expect(ids).toContain('t10');
    expect(ids).toContain('t11');
    expect(ids).toContain('t0');
    // Forced labels show full size, whatever their degree rank.
    expect(labels3d(nodes, focus, 't11', 1).find((l) => l.id === 't11')!.rankInLevel).toBe(0);
  });

  it('with a selection, labels only the selection and its neighbours', () => {
    const focus: MapFocus = { selectedId: 't5', matches: null, neighbourIds: new Set(['p2', 't6']) };
    expect(labels3d(nodes, focus, null, 5).map((l) => l.id).sort()).toEqual(['p2', 't5', 't6']);
  });

  it('with a search, labels only matches, still capped per level', () => {
    const focus: MapFocus = { selectedId: null, matches: new Set(['t3', 't4', 't7', 'p1']), neighbourIds: null };
    const ids = labels3d(nodes, focus, null, 2).map((l) => l.id);
    expect(ids.sort()).toEqual(['p1', 't3', 't4']);
  });

  it('lists each node once', () => {
    const focus: MapFocus = { selectedId: 't0', matches: null, neighbourIds: null };
    const ids = labels3d(nodes, focus, 't0', 3).map((l) => l.id);
    expect(ids.filter((id) => id === 't0')).toHaveLength(1);
  });
});

describe('3D label scale', () => {
  it('shrinks lower-ranked labels, never below a floor', () => {
    expect(labelScale3d(0)).toBe(1);
    expect(labelScale3d(1)).toBeLessThan(1);
    expect(labelScale3d(99)).toBeGreaterThanOrEqual(0.75);
  });
});

describe('3D label boxes', () => {
  it('sits the box on its bottom-centre anchor, wider for longer text', () => {
    const b = labelBox3d('agua', 100, 50);
    expect(b.x + b.w / 2).toBeCloseTo(100);
    expect(b.y + b.h).toBeCloseTo(50);
    expect(labelBox3d('agua potable', 100, 50).w).toBeGreaterThan(b.w);
    expect(labelBox3d('agua', 100, 50, 0.5).w).toBeCloseTo(b.w / 2);
  });

  it('overlap: touching edges do not count, any shared area does', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(boxesOverlap(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(boxesOverlap(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
    expect(boxesOverlap(a, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
    expect(boxesOverlap(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
  });
});

describe('3D declutter: greedy by rank, by screen overlap', () => {
  const view = { width: 800, height: 600 };
  const at = (id: string, level: number, x: number, y: number, forced = false): Placed3D => ({
    id,
    level,
    forced,
    box: labelBox3d(id, x, y),
  });

  it('skips a label whose box meets one already kept, and keeps the next', () => {
    const placed = [at('aaaa', 3, 100, 100), at('bbbb', 3, 105, 102), at('cccc', 3, 300, 100)];
    expect([...declutter3d(placed, view)]).toEqual(['aaaa', 'cccc']);
  });

  it('the higher-ranked label wins: order decides, not position', () => {
    const placed = [at('bbbb', 3, 105, 102), at('aaaa', 3, 100, 100)];
    expect([...declutter3d(placed, view)]).toEqual(['bbbb']);
  });

  it('checks overlap across levels, which project onto each other', () => {
    const placed = [at('tema', 3, 200, 200), at('lugar', 0, 202, 204)];
    expect([...declutter3d(placed, view)]).toEqual(['tema']);
  });

  it('draws at most N per level, a spare filling a hidden place', () => {
    const row = Array.from({ length: 9 }, (_, i) => at(`t${i}`, 3, 40 + i * 80, 100));
    // t1 sits on t0, so t5 takes its place.
    row[1] = at('t1', 3, 42, 100);
    const kept = [...declutter3d(row, view, 5)];
    expect(kept).toEqual(['t0', 't2', 't3', 't4', 't5']);
  });

  it('keeps no two overlapping boxes, whatever the input', () => {
    // A dense, deterministic scatter.
    const placed = Array.from({ length: 200 }, (_, i) =>
      at(`n${i}-${'x'.repeat(i % 15)}`, i % 4, (i * 97) % 800, (i * 61) % 600),
    );
    const kept = declutter3d(placed, view);
    const boxes = placed.filter((p) => kept.has(p.id)).map((p) => p.box!);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i]!, boxes[j]!)).toBe(false);
    for (const level of [0, 1, 2, 3]) {
      expect(placed.filter((p) => p.level === level && kept.has(p.id)).length).toBeLessThanOrEqual(5);
    }
  });

  it('always keeps forced labels, even overlapping, and lets them block others', () => {
    const placed = [at('sel', 3, 100, 100, true), at('aaaa', 3, 102, 100), at('hov', 3, 101, 100, true)];
    expect([...declutter3d(placed, view)].sort()).toEqual(['hov', 'sel']);
  });

  it('skips labels off screen or without a position, without spending a place', () => {
    const placed: Placed3D[] = [
      at('left', 3, -200, 100),
      at('below', 3, 100, 900),
      { id: 'behind', level: 3, forced: false, box: null },
      ...Array.from({ length: 5 }, (_, i) => at(`t${i}`, 3, 60 + i * 120, 300)),
    ];
    expect([...declutter3d(placed, view)]).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });
});
