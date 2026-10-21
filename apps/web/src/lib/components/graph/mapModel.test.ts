import { describe, expect, it } from 'vitest';

import type { GraphEntity, GraphViewEdge, GraphViewType } from '$lib/graph';
import {
  MAP_ALWAYS_LABELLED,
  MAP_LEVELS,
  buildMapData,
  escapeHtml,
  focusNeighbours,
  linkDash,
  linkState,
  nodeDim,
  nodeTooltipHtml,
  spiralSeed,
  wantsLabel,
  type MapFocus,
} from './mapModel';

const entity = (id: string, type: GraphViewType, label: string, support: number): GraphEntity => ({
  id,
  type,
  label,
  support,
});
const rel = (fromId: string, toId: string, support = 2): GraphViewEdge => ({
  fromId,
  toId,
  support,
  kind: 'relation',
  coMentions: support,
  relationType: 'relacionado_con',
  direction: 'out',
});
const co = (fromId: string, toId: string, support = 1): GraphViewEdge => ({
  fromId,
  toId,
  support,
  kind: 'co-mention',
  coMentions: support,
});

const rows = [
  entity('a', 'tema', 'Agua', 9),
  entity('b', 'lugar', 'Oaxaca', 5),
  entity('c', 'evento', 'Sequía', 5),
  entity('d', 'persona', 'Aislada', 7),
];
const none: MapFocus = { selectedId: null, matches: null, neighbourIds: null };

describe('buildMapData — the same input, the same picture', () => {
  it('draws relation and co-mention edges, one per pair, between listed nodes only', () => {
    const data = buildMapData(rows, [rel('a', 'b'), co('b', 'a'), co('a', 'c'), co('a', 'zz'), rel('c', 'c')]);
    expect(data.links.map((l) => [l.key, l.kind])).toEqual([
      ['a|b', 'relation'],
      ['a|c', 'co-mention'],
    ]);
  });

  it('keeps hiding degree-0 nodes (owner, chosen (review)); co-mentions connect most', () => {
    const data = buildMapData(rows, [rel('a', 'b'), co('a', 'c')]);
    expect(data.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders nodes by support, then label, then id — a total order', () => {
    const tied = [entity('z', 'tema', 'Mismo', 3), entity('y', 'tema', 'Mismo', 3), entity('x', 'tema', 'Antes', 3)];
    const data = buildMapData(tied, [co('z', 'y'), co('y', 'x')]);
    expect(data.nodes.map((n) => n.id)).toEqual(['x', 'y', 'z']);
    // Input order does not matter.
    expect(buildMapData([...tied].reverse(), [co('y', 'x'), co('z', 'y')]).nodes).toEqual(data.nodes);
  });

  it('seeds every node on a spiral by rank, no two on the same spot', () => {
    const many = Array.from({ length: 600 }, (_, i) => spiralSeed(i));
    expect(new Set(many.map((p) => `${p.x},${p.y}`)).size).toBe(600);
    const data = buildMapData(rows, [rel('a', 'b'), co('a', 'c')]);
    data.nodes.forEach((n, i) => expect({ x: n.x, y: n.y }).toEqual(spiralSeed(i)));
  });

  it('is deterministic, and its signature names the layout input', () => {
    const edges = [rel('a', 'b'), co('a', 'c')];
    expect(buildMapData(rows, edges)).toEqual(buildMapData(rows, edges));
    expect(buildMapData(rows, edges).signature).not.toBe(buildMapData(rows, [rel('a', 'b')]).signature);
  });

  it('draws a co-mention thin and dashed, a relation solid and wider with more documents', () => {
    const data = buildMapData(rows, [rel('a', 'b', 6), rel('b', 'c', 1), co('a', 'c', 9)]);
    const [strong, weak, comention] = data.links;
    expect(strong!.width).toBeGreaterThan(weak!.width);
    expect(comention!.width).toBeLessThan(weak!.width);
    expect(linkDash('co-mention')).toEqual([3, 3]);
    expect(linkDash('relation')).toBeNull();
  });

  it('pins z by type, "del suelo a las ideas"', () => {
    expect(MAP_LEVELS.lugar).toBe(0);
    expect(MAP_LEVELS.persona).toBe(MAP_LEVELS.organizacion);
    expect(MAP_LEVELS.evento).toBeGreaterThan(MAP_LEVELS.persona);
    expect(MAP_LEVELS.tema).toBeGreaterThan(MAP_LEVELS.evento);
  });
});

describe('focus: dimming and edge states, the same in 2D and 3D', () => {
  const data = buildMapData(rows, [rel('a', 'b'), co('a', 'c'), co('b', 'c')]);

  it('a selection lights itself, its map neighbours and the panel’s', () => {
    const neighbourIds = focusNeighbours(data, 'b', ['d']);
    expect([...neighbourIds!].sort()).toEqual(['a', 'c', 'd']);
    const focus: MapFocus = { selectedId: 'b', matches: null, neighbourIds };
    expect(nodeDim('b', focus)).toBe(false);
    expect(nodeDim('a', focus)).toBe(false);
    expect(linkState('a', 'b', focus)).toBe('active');
    expect(linkState('a', 'c', focus)).toBe('dim');
  });

  it('a search dims what it does not match', () => {
    const focus: MapFocus = { selectedId: null, matches: new Set(['a']), neighbourIds: null };
    expect(nodeDim('b', focus)).toBe(true);
    expect(linkState('a', 'c', focus)).toBe('normal');
    expect(linkState('b', 'c', focus)).toBe('dim');
  });

  it('nothing is dimmed with no focus', () => {
    expect(nodeDim('a', none)).toBe(false);
    expect(linkState('a', 'b', none)).toBe('normal');
  });
});

describe('labels: level of detail', () => {
  const many = Array.from({ length: 40 }, (_, i) => entity(`e${i}`, 'tema', `Entidad ${i}`, 40 - i));
  const hub = Array.from({ length: 39 }, (_, i) => co('e0', `e${i + 1}`));
  const data = buildMapData(many, hub);

  it('shows the most connected before any zoom, and everything zoomed in', () => {
    const shown = data.nodes.filter((n) => wantsLabel(n, none, 1));
    expect(shown).toHaveLength(MAP_ALWAYS_LABELLED);
    expect(shown[0]!.id).toBe('e0');
    expect(data.nodes.filter((n) => wantsLabel(n, none, 10))).toHaveLength(40);
  });

  it('with a selection, only it and its neighbours', () => {
    const focus: MapFocus = { selectedId: 'e5', matches: null, neighbourIds: focusNeighbours(data, 'e5', []) };
    expect(data.nodes.filter((n) => wantsLabel(n, focus, 1)).map((n) => n.id).sort()).toEqual(['e0', 'e5']);
  });
});

describe('🔴 labels never reach HTML unescaped', () => {
  it('escapes markup, quotes and ampersands', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });

  it('the tooltip is escaped text', () => {
    const html = nodeTooltipHtml({ label: '<b>Agua</b>', type: 'tema', support: 1 });
    expect(html).not.toContain('<b>');
    expect(html).toBe('&lt;b&gt;Agua&lt;/b&gt; — tema — 1 documento');
  });
});
