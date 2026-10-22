import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendFetch: vi.fn() }));

import {
  canCombineEcosystems,
  entityEcosystemNames,
  graphEcosystemHref,
  graphEntityHref,
  GRAPH_COMBINED_ECO,
  parseEcosystems,
  parseGraphEntity,
  parseGraphView,
} from '$lib/graph';
import { mergeLenguaIndexes } from '$lib/server/graph';

describe('the combined view on the wire (`ecosystems`)', () => {
  it('sets `ecosystems` sorted ascending with the aligned supports', () => {
    const e = parseGraphEntity({
      id: 11,
      type: 'tema',
      label: 'Agua',
      support: 5,
      ecosystems: [3, 1, '2', 3],
      ecosystemSupport: [1, 2, 2, 0],
    });
    expect(e).toEqual({
      id: '11',
      type: 'tema',
      label: 'Agua',
      support: 5,
      ecosystems: [1, 2, 3],
      ecosystemSupport: [2, 2, 1],
    });
  });

  it('leaves a single-ecosistema entity without the field', () => {
    const e = parseGraphEntity({ id: 1, type: 'lugar', label: 'Morelos', support: 2 });
    expect(e).not.toHaveProperty('ecosystems');
  });

  it('drops junk ids', () => {
    expect(parseEcosystems([0, -1, 'x', 1.5, 4], [])).toEqual([{ id: 4, support: 0 }]);
    expect(parseEcosystems(undefined, undefined)).toBeNull();
  });

  it('keeps edges between merged nodes', () => {
    const view = parseGraphView({
      entities: [
        { id: 11, type: 'tema', label: 'Agua', support: 4, ecosystems: [1, 2], ecosystemSupport: [2, 2] },
        { id: 12, type: 'lugar', label: 'Morelos', support: 4, ecosystems: [1, 2], ecosystemSupport: [2, 2] },
      ],
      edges: [{ from: 11, to: 12, kind: 'relation', support: 3, coMentions: 3, relationType: 'afecta_a', direction: 'out' }],
    });
    expect(view.entities.every((e) => e.ecosystems?.length === 2)).toBe(true);
    expect(view.edges).toHaveLength(1);
  });
});

describe('who is offered "Todos mis ecosistemas"', () => {
  it('a member of two or more, or a platform admin', () => {
    expect(canCombineEcosystems(0, false)).toBe(false);
    expect(canCombineEcosystems(1, false)).toBe(false);
    expect(canCombineEcosystems(2, false)).toBe(true);
    expect(canCombineEcosystems(0, true)).toBe(true);
  });

  it('keeps the combined scope while selecting entities, and drops the selection on a switch', () => {
    expect(graphEntityHref('11', null, { eco: GRAPH_COMBINED_ECO })).toBe('/grafo?entidad=11&eco=todos');
    expect(graphEcosystemHref(GRAPH_COMBINED_ECO)).toBe('/grafo?eco=todos');
  });

  it('names a merged node’s ecosistemas, skipping unknown ids', () => {
    expect(entityEcosystemNames({ ecosystems: [1, 2, 9] }, { '1': 'Dengue', '2': 'Discapacidad' })).toEqual([
      'Dengue',
      'Discapacidad',
    ]);
    expect(entityEcosystemNames({}, { '1': 'Dengue' })).toEqual([]);
  });
});

describe('mergeLenguaIndexes', () => {
  it('adds facet counts and unions the document map', () => {
    expect(
      mergeLenguaIndexes([
        { lenguas: [{ lengua: 'náhuatl', documentos: 2 }], byDocument: { '1': 'náhuatl' } },
        {
          lenguas: [
            { lengua: 'mixteco', documentos: 1 },
            { lengua: 'náhuatl', documentos: 2 },
          ],
          byDocument: { '5': 'mixteco', '6': 'náhuatl' },
        },
      ]),
    ).toEqual({
      lenguas: [
        { lengua: 'náhuatl', documentos: 4 },
        { lengua: 'mixteco', documentos: 1 },
      ],
      byDocument: { '1': 'náhuatl', '5': 'mixteco', '6': 'náhuatl' },
    });
  });
});
