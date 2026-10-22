import { describe, expect, it } from 'vitest';

import {
  COMMUNITY_FLOORS,
  Z_FLOORS,
  communities,
  defaultZAxis,
  readZAxis,
  writeZAxis,
  zAxisKey,
  zAxisOptions,
  zFloors,
  type ZLink,
  type ZNode,
} from './zAxis';

const n = (id: string, type = 'tema', support = 1, ecosystems?: number[]): ZNode => ({ id, type, support, ecosystems });
const l = (source: string, target: string): ZLink => ({ source, target });

/** Two 5-cliques joined by one edge, plus a triangle hanging off the second. */
function cliques(): { nodes: ZNode[]; links: ZLink[] } {
  const nodes: ZNode[] = [];
  const links: ZLink[] = [];
  const clique = (prefix: string, size: number) => {
    for (let i = 0; i < size; i++) nodes.push(n(`${prefix}${i}`));
    for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) links.push(l(`${prefix}${i}`, `${prefix}${j}`));
  };
  clique('a', 6);
  clique('b', 5);
  clique('c', 3);
  links.push(l('a0', 'b0'), l('b1', 'c0'));
  return { nodes, links };
}

/** A pseudo-random graph from a fixed seed (LCG), so the test is itself deterministic. */
function randomGraph(nodeCount: number, edgeCount: number, seed = 7): { nodes: ZNode[]; links: ZLink[] } {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const nodes = Array.from({ length: nodeCount }, (_, i) => n(`e${i}`, 'tema', 1 + Math.floor(rand() * 60)));
  const links = Array.from({ length: edgeCount }, () =>
    l(`e${Math.floor(rand() * nodeCount)}`, `e${Math.floor(rand() * nodeCount)}`),
  );
  return { nodes, links };
}

describe('z axis: options and defaults', () => {
  it('hides "ecosistemas compartidos" outside the combined view', () => {
    expect(zAxisOptions(false)).not.toContain('ecosistemas');
    expect(zAxisOptions(true)).toContain('ecosistemas');
    expect(zAxisOptions(false)).toEqual(['tipo', 'frecuencia', 'centralidad', 'comunidad']);
  });

  it('defaults to tipo in one ecosistema, ecosistemas compartidos combined', () => {
    expect(defaultZAxis(false)).toBe('tipo');
    expect(defaultZAxis(true)).toBe('ecosistemas');
  });
});

describe('z axis: remembered per view kind', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('keeps one choice for a single ecosistema and another for the combined view', () => {
    const s = memory();
    writeZAxis(() => s, false, 'comunidad');
    writeZAxis(() => s, true, 'frecuencia');
    expect(readZAxis(() => s, false)).toBe('comunidad');
    expect(readZAxis(() => s, true)).toBe('frecuencia');
    expect(zAxisKey(false)).not.toBe(zAxisKey(true));
  });

  it('never returns ecosistemas outside the combined view, even if stored', () => {
    const s = memory();
    s.setItem(zAxisKey(false), 'ecosistemas');
    expect(readZAxis(() => s, false)).toBe('tipo');
  });

  it('reads junk, a missing storage or a throwing one as the default', () => {
    const s = memory();
    s.setItem(zAxisKey(true), 'nope');
    expect(readZAxis(() => s, true)).toBe('ecosistemas');
    expect(readZAxis(() => null, false)).toBe('tipo');
    const throwing = () => {
      throw new Error('blocked');
    };
    expect(readZAxis(throwing, true)).toBe('ecosistemas');
    expect(() => writeZAxis(throwing, true, 'tipo')).not.toThrow();
  });
});

describe('z axis: floors', () => {
  it('tipo: places on the floor, topics at the top', () => {
    const f = zFloors([n('p', 'lugar'), n('o', 'organizacion'), n('e', 'evento'), n('t', 'tema')], [], 'tipo');
    expect([...f.values()]).toEqual([0, 1, 2, 3]);
  });

  it('ecosistemas: count minus one, capped, unique ids, missing reads as one', () => {
    const f = zFloors(
      [n('a', 'tema', 1, [3]), n('b', 'tema', 1, [3, 5]), n('c', 'tema', 1, [1, 2, 3, 4, 5, 6, 7]), n('d'), n('e', 'tema', 1, [2, 2])],
      [],
      'ecosistemas',
    );
    expect(Object.fromEntries(f)).toEqual({ a: 0, b: 1, c: Z_FLOORS - 1, d: 0, e: 0 });
  });

  it('frecuencia: log scale over the shown range, 1 on the ground, the max on top', () => {
    const f = zFloors([n('a', 'tema', 1), n('b', 'tema', 4), n('c', 'tema', 16), n('d', 'tema', 256)], [], 'frecuencia');
    expect(Object.fromEntries(f)).toEqual({ a: 0, b: 1, c: 2, d: 4 });
  });

  it('frecuencia: the scale starts at the shown minimum, so the ground is never empty', () => {
    const f = zFloors([n('a', 'tema', 4), n('b', 'tema', 8), n('c', 'tema', 64)], [], 'frecuencia');
    expect(Object.fromEntries(f)).toEqual({ a: 0, b: 1, c: 4 });
  });

  it('frecuencia: a flat graph sits on the ground', () => {
    const f = zFloors([n('a'), n('b')], [], 'frecuencia');
    expect([...f.values()]).toEqual([0, 0]);
  });

  it('centralidad: hubs rise; duplicate, reversed and self links count once or not at all', () => {
    const nodes = ['h', 'x1', 'x2', 'x3', 'x4'].map((id) => n(id));
    const links = [l('h', 'x1'), l('x1', 'h'), l('h', 'x2'), l('h', 'x3'), l('h', 'x4'), l('h', 'h'), l('h', 'zz')];
    const f = zFloors(nodes, links, 'centralidad');
    expect(f.get('h')).toBe(Z_FLOORS - 1);
    expect(f.get('x1')).toBe(0);
  });

  it('every option stays inside its bounds on a large random graph', () => {
    const { nodes, links } = randomGraph(500, 4000);
    for (const axis of ['tipo', 'ecosistemas', 'frecuencia', 'centralidad', 'comunidad'] as const) {
      const f = zFloors(nodes, links, axis);
      expect(f.size).toBe(nodes.length);
      const cap = axis === 'comunidad' ? COMMUNITY_FLOORS : Z_FLOORS;
      for (const v of f.values()) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(cap);
      }
    }
  });
});

describe('z axis: communities', () => {
  it('finds the cliques, largest on the ground', () => {
    const { nodes, links } = cliques();
    const c = communities(nodes, links);
    const of = (prefix: string) => new Set(nodes.filter((x) => x.id.startsWith(prefix)).map((x) => c.get(x.id)));
    expect(of('a')).toEqual(new Set([0]));
    expect(of('b')).toEqual(new Set([1]));
    expect(of('c')).toEqual(new Set([2]));
  });

  it('is deterministic: same result every run and whatever the input order', () => {
    const { nodes, links } = randomGraph(500, 4000);
    const first = communities(nodes, links);
    expect(communities(nodes, links)).toEqual(first);
    const shuffled = communities([...nodes].reverse(), [...links].reverse().map((x) => l(x.target, x.source)));
    expect(new Map([...shuffled].sort())).toEqual(new Map([...first].sort()));
  });

  it('gives isolated nodes their own cluster and does not throw on an empty graph', () => {
    expect(communities([], [])).toEqual(new Map());
    const c = communities([n('a'), n('b')], []);
    expect(new Set(c.values()).size).toBe(2);
  });

  it('caps the floors: small clusters share the top one', () => {
    // 12 disjoint pairs → 12 clusters, more than there are floors.
    const nodes = Array.from({ length: 24 }, (_, i) => n(`p${String(i).padStart(2, '0')}`));
    const links = Array.from({ length: 12 }, (_, i) => l(`p${String(2 * i).padStart(2, "0")}`, `p${String(2 * i + 1).padStart(2, "0")}`));
    const f = zFloors(nodes, links, 'comunidad');
    expect(Math.max(...f.values())).toBe(COMMUNITY_FLOORS - 1);
    expect(new Set(f.values()).size).toBe(COMMUNITY_FLOORS);
  });
});
