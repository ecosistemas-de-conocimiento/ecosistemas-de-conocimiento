import { describe, expect, it } from 'vitest';

import {
  CONTENT_KINDS,
  CONTEXT_MAX_ENTITIES,
  CONTEXT_MAX_NEIGHBOURS,
  contentKindLabel,
  EGO_MAX_NEIGHBOURS,
  egoDescription,
  egoLayout,
  egoNeighbours,
  emptyGraphCopy,
  expandGraphQuery,
  filterEntities,
  GRAPH_EMPTY_NOTHING_PUBLISHED,
  GRAPH_EMPTY_THRESHOLD,
  GRAPH_ENTITY_TYPES,
  GRAPH_NO_RESULTS,
  GRAPH_RELATION_TYPES,
  GRAPH_VIEW_TYPES,
  graphContextParagraph,
  groupByType,
  hiddenCopy,
  isGraphEntityType,
  isViewableEntityType,
  MAX_EXPANSION_CHARS,
  MAX_EXPANSION_TERMS,
  parseGraphDocument,
  parseGraphEdge,
  parseGraphEntity,
  parseGraphEntityDetail,
  parseGraphNeighbour,
  parseGraphRetrieval,
  parseGraphView,
  rankEntities,
  rankNeighbours,
  relationLabel,
  resultsSummary,
  sharedDocuments,
  supportCopy,
  supportShort,
  truncateLabel,
  typeChipLabel,
  typeListLabel,
  type ContentKind,
  type EgoLayout,
  type GraphDocument,
  type GraphEntity,
  type GraphNeighbour,
  type GraphRelationType,
  type GraphRetrieval,
  type GraphViewType,
} from './graph';

// ── Fixtures ───────────────────────────────────────────────────────────────

const entity = (
  id: string,
  type: GraphViewType,
  label: string,
  support: number,
): GraphEntity => ({ id, type, label, support });

const neighbour = (
  e: GraphEntity,
  support: number = e.support,
  relationType: GraphRelationType = 'relacionado_con',
): GraphNeighbour => ({ entity: e, relationType, support });

const doc = (id: string, title = `Documento ${id}`): GraphDocument => ({
  id,
  title,
  contentKind: null,
});

/** A raw response row for the type the view refuses to show. */
const PERSONA_ROW = { id: 'p1', type: 'persona', label: 'Ana Ruiz Mendoza', support: 12 };

/** `n` neighbours with strictly decreasing support, so ranking is unambiguous. */
const manyNeighbours = (n: number): GraphNeighbour[] =>
  Array.from({ length: n }, (_, i) =>
    neighbour(
      entity(`n${i}`, GRAPH_VIEW_TYPES[i % GRAPH_VIEW_TYPES.length]!, `Vecino ${i}`, n - i),
      n - i,
    ),
  );

/** Every number a layout produces, so a NaN cannot hide in one corner of it. */
const layoutNumbers = (l: EgoLayout): number[] => [
  l.width,
  l.height,
  l.hub.x,
  l.hub.y,
  l.hub.r,
  l.hub.labelY,
  ...l.nodes.flatMap((n) => [n.x, n.y, n.r, n.labelX, n.labelY, n.strokeWidth]),
];

// ── The person rule ────────────────────────────────────────────────────────

describe('🔴 the person rule — persona never reaches the view', () => {
  // The single most load-bearing assertion in this file. ADR §7.3: a ranked
  // list of people across an ecosistema's corpus is the re-identification
  // surface the whole design exists to avoid. Every entry point into the view
  // is checked, because a name excluded from one and shown in another is
  // excluded from neither.
  it('drops a persona at parseGraphEntity', () => {
    expect(parseGraphEntity(PERSONA_ROW)).toBeNull();
  });

  it('drops a persona out of a view list', () => {
    const view = parseGraphView({
      entities: [PERSONA_ROW, { id: 't1', type: 'tema', label: 'Agua', support: 3 }],
    });
    expect(view.entities.map((e) => e.id)).toEqual(['t1']);
  });

  it('drops a persona neighbour, wrapped or flat', () => {
    expect(
      parseGraphNeighbour({ entity: PERSONA_ROW, relationType: 'participa_en', support: 5 }),
    ).toBeNull();
    expect(parseGraphNeighbour(PERSONA_ROW)).toBeNull();
  });

  it('refuses a persona as the subject of a detail', () => {
    expect(
      parseGraphEntityDetail({ entity: PERSONA_ROW, neighbours: [], documents: [] }),
    ).toBeNull();
  });

  // The ego network is the other half of the same rule: the picture must not
  // draw a name the list refuses to print.
  it('drops a persona from a detail’s neighbours', () => {
    const detail = parseGraphEntityDetail({
      entity: { id: 'e1', type: 'evento', label: 'Asamblea', support: 4 },
      neighbours: [
        { entity: PERSONA_ROW, relationType: 'participa_en', support: 9 },
        { entity: { id: 'l1', type: 'lugar', label: 'Ejido Norte', support: 2 } },
      ],
      documents: [],
    });
    expect(detail).not.toBeNull();
    expect(detail!.neighbours.map((n) => n.entity.id)).toEqual(['l1']);
  });

  it('drops a persona from the GraphRAG retrieval', () => {
    const retrieval = parseGraphRetrieval({
      entities: [PERSONA_ROW, { id: 't1', type: 'tema', label: 'Agua', support: 3 }],
      edges: [{ from: 't1', to: 'p1', relationType: 'participa_en', support: 2 }],
      documents: [],
      terms: [],
    });
    expect(retrieval.entities.map((e) => e.id)).toEqual(['t1']);
    // ⚠ The edge survives — it is only a pair of ids — but the paragraph
    // resolves endpoints against `entities`, so the name never surfaces.
    expect(graphContextParagraph(retrieval)).not.toContain('Ana Ruiz');
  });

  it('repeats the filter inside egoNeighbours, so the picture is safe on its own', () => {
    const persona = {
      entity: { id: 'p1', type: 'persona', label: 'Ana Ruiz Mendoza', support: 30 },
      relationType: 'participa_en',
      support: 30,
    } as unknown as GraphNeighbour;
    const drawn = egoNeighbours([persona, neighbour(entity('t1', 'tema', 'Agua', 2))]);
    expect(drawn.map((n) => n.entity.id)).toEqual(['t1']);
  });
});

describe('isViewableEntityType', () => {
  it.each(GRAPH_VIEW_TYPES)('shows %s', (type) => {
    expect(isViewableEntityType(type)).toBe(true);
  });

  // 🔴 Fails CLOSED. A category the backend adds tomorrow does not appear in
  // this product until somebody decides it should — least of all `persona`.
  it.each(['persona', 'Tema', 'concepto', '', null, undefined, 42, {}])(
    'refuses %p',
    (raw) => {
      expect(isViewableEntityType(raw)).toBe(false);
    },
  );

  // The backend's vocabulary is wider than the view's, on purpose. Conflating
  // the two predicates is exactly how `persona` would come back.
  it('is strictly narrower than the backend vocabulary', () => {
    expect(isGraphEntityType('persona')).toBe(true);
    expect(isViewableEntityType('persona')).toBe(false);
    expect(GRAPH_ENTITY_TYPES.length).toBe(GRAPH_VIEW_TYPES.length + 1);
  });
});

// ── Tolerant parsing ───────────────────────────────────────────────────────

describe('parseGraphView', () => {
  // ⚠ The graph is best-effort (ADR §8.2). A page that will not load is a
  // bigger failure than a graph missing a row, so junk degrades to empty.
  it.each([null, undefined, 42, 'nope', [], {}, { entities: 'nope' }])(
    'returns an empty view for %p instead of throwing',
    (raw) => {
      expect(parseGraphView(raw)).toEqual({
        entities: [],
        hidden: 0,
        minSupport: null,
        // ⚠ `null`, not `0`. "We do not know how much is published" and "nothing
        // is published" are the two states this field exists to separate.
        publishedDocuments: null,
      });
    },
  );

  it('reads hidden and minSupport', () => {
    const view = parseGraphView({ entities: [], hidden: 7, minSupport: 3 });
    expect(view.hidden).toBe(7);
    expect(view.minSupport).toBe(3);
  });

  // `0` is "the backend did not name a threshold", not "the threshold is zero".
  // The copy must then say "muy pocos" rather than "menos de 0 documentos".
  it('reads minSupport 0 as unknown, not as a threshold of zero', () => {
    expect(parseGraphView({ minSupport: 0 }).minSupport).toBeNull();
    expect(parseGraphView({ minSupport: -4 }).minSupport).toBeNull();
    expect(parseGraphView({ minSupport: 'tres' }).minSupport).toBeNull();
  });

  it('drops only the rows it cannot read', () => {
    const view = parseGraphView({
      entities: [
        { id: 't1', type: 'tema', label: 'Agua', support: 3 },
        { id: 't2', type: 'tema' },
        { type: 'tema', label: 'Sin id' },
        null,
        'nope',
        { id: 'l1', type: 'lugar', name: 'Ejido Norte', documentCount: 9 },
      ],
    });
    expect(view.entities.map((e) => e.id)).toEqual(['l1', 't1']);
    expect(view.entities[0]!.support).toBe(9);
  });

  it('returns the list already ranked', () => {
    const view = parseGraphView({
      entities: [
        { id: 'a', type: 'tema', label: 'Agua', support: 1 },
        { id: 'b', type: 'tema', label: 'Bosque', support: 5 },
      ],
    });
    expect(view.entities.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('parseGraphEdge', () => {
  // ⚠ Built in a parallel lane against a written contract, so the parser
  // accepts the contract's spelling and the obvious neighbouring ones.
  it.each([
    ['fromId/toId', { fromId: 'a', toId: 'b' }],
    ['from/to', { from: 'a', to: 'b' }],
    ['source/target', { source: 'a', target: 'b' }],
    ['object endpoints', { from: { id: 'a' }, to: { id: 'b' } }],
    ['mixed', { source: { id: 'a' }, toId: 'b' }],
  ])('accepts %s', (_name, raw) => {
    expect(parseGraphEdge(raw)).toEqual({
      fromId: 'a',
      toId: 'b',
      relationType: 'relacionado_con',
      support: 0,
    });
  });

  // A self-loop draws a spoke from a node to itself: no information, and it
  // would make the ego picture claim a connection that is not one.
  it('rejects a self-loop', () => {
    expect(parseGraphEdge({ from: 'a', to: 'a' })).toBeNull();
    expect(parseGraphEdge({ from: { id: 'a' }, to: 'a' })).toBeNull();
  });

  it.each([{ from: 'a' }, { to: 'b' }, { from: 'a', to: null }, {}, null, 'nope'])(
    'rejects %p, which has no usable pair of endpoints',
    (raw) => {
      expect(parseGraphEdge(raw)).toBeNull();
    },
  );

  it('reads the relation under either spelling and falls back to relacionado_con', () => {
    expect(parseGraphEdge({ from: 'a', to: 'b', relationType: 'ocurre_en' })!.relationType).toBe(
      'ocurre_en',
    );
    expect(parseGraphEdge({ from: 'a', to: 'b', type: 'ubicado_en' })!.relationType).toBe(
      'ubicado_en',
    );
    expect(parseGraphEdge({ from: 'a', to: 'b', type: 'inventada' })!.relationType).toBe(
      'relacionado_con',
    );
  });
});

describe('parseGraphDocument', () => {
  it('needs an id and nothing else', () => {
    expect(parseGraphDocument({ id: 'd1' })).toEqual({
      id: 'd1',
      title: 'Documento sin título',
      contentKind: null,
    });
    expect(parseGraphDocument({ title: 'Sin id' })).toBeNull();
  });

  // ⚠ The fallback is a generic noun, never a file name reconstructed from
  // somewhere else. A missing title stays a missing title.
  it.each([undefined, null, '', '   ', 42.5])('falls back for a title of %p', (title) => {
    expect(parseGraphDocument({ id: 'd1', title })!.title).not.toBe('');
    if (typeof title !== 'number') {
      expect(parseGraphDocument({ id: 'd1', title })!.title).toBe('Documento sin título');
    }
  });

  it('reads `name` before giving up on a title', () => {
    expect(parseGraphDocument({ id: 'd1', name: 'Acta de asamblea' })!.title).toBe(
      'Acta de asamblea',
    );
  });

  // 🔴 A PRIVACY CONTROL, NOT A LABEL (ADR §0, §3). An unrecognised value must
  // not be guessed into one of the three: `null` renders as "Documento", the
  // most conservative of the three readings.
  it.each(CONTENT_KINDS)('accepts the real contentKind %s', (kind) => {
    expect(parseGraphDocument({ id: 'd1', contentKind: kind })!.contentKind).toBe(kind);
  });

  it.each(['testimony', 'TESTIMONIO', 'audio', 'otro', '', null, undefined, 3, {}])(
    'reads the invented contentKind %p as null',
    (kind) => {
      expect(parseGraphDocument({ id: 'd1', contentKind: kind })!.contentKind).toBeNull();
    },
  );
});

describe('🔴 a document title is taken, never improved', () => {
  // The backend hands back ALREADY-NEUTRALISED titles. Nothing here looks up
  // the "real" name of a document and nothing may tidy one up: the original
  // file name is free text that never passed the anonymisation gate, so any
  // "improvement" here is a guess about a string we deliberately do not hold.
  it('passes an awkward title through verbatim', () => {
    const title = '«Acta» 3/4 (2024) — Ñoño & Co. <sin firmar> 100% #2';
    expect(parseGraphDocument({ id: 'd1', title })!.title).toBe(title);
  });

  it('does not case-fold, capitalise or re-punctuate', () => {
    for (const title of ['acta sin mayúscula', 'ACTA A GRITOS', 'a', '¿?', '2024-05-03']) {
      expect(parseGraphDocument({ id: 'd1', title })!.title).toBe(title);
    }
  });

  it('carries the title through a whole detail response untouched', () => {
    const title = '  Grabación · sesión 12  ';
    const detail = parseGraphEntityDetail({
      entity: { id: 't1', type: 'tema', label: 'Agua', support: 2 },
      documents: [{ id: 'd1', title }],
    });
    // Only the surrounding whitespace goes; the string itself is untouched.
    expect(detail!.documents[0]!.title).toBe(title.trim());
  });
});

describe('parseGraphNeighbour', () => {
  it('accepts the wrapped and the flat shape', () => {
    const wrapped = parseGraphNeighbour({
      entity: { id: 't1', type: 'tema', label: 'Agua', support: 4 },
      relationType: 'ocurre_en',
      support: 6,
    });
    expect(wrapped).toEqual({
      entity: entity('t1', 'tema', 'Agua', 4),
      relationType: 'ocurre_en',
      support: 6,
    });
    expect(parseGraphNeighbour({ id: 't1', type: 'tema', label: 'Agua', support: 4 })).toEqual({
      entity: entity('t1', 'tema', 'Agua', 4),
      relationType: 'relacionado_con',
      support: 4,
    });
  });

  it('borrows the entity’s support when the edge does not carry one', () => {
    expect(
      parseGraphNeighbour({ entity: { id: 't1', type: 'tema', label: 'Agua', support: 4 } })!
        .support,
    ).toBe(4);
  });
});

describe('parseGraphRetrieval', () => {
  it.each([null, undefined, 'nope', 7, {}])('returns an empty payload for %p', (raw) => {
    expect(parseGraphRetrieval(raw)).toEqual({
      entities: [],
      edges: [],
      documents: [],
      terms: [],
      nodes: [],
    });
  });

  it('keeps only the terms that are usable strings', () => {
    expect(parseGraphRetrieval({ terms: ['agua', '  río  ', '', '   ', null, 42, {}] }).terms).toEqual(
      ['agua', 'río', '42'],
    );
  });
});

// ── Ranking and search ─────────────────────────────────────────────────────

describe('rankEntities', () => {
  it('puts the best-supported first', () => {
    const ranked = rankEntities([
      entity('a', 'tema', 'Agua', 2),
      entity('b', 'tema', 'Bosque', 9),
      entity('c', 'tema', 'Cerro', 5),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  // ⚠ NOT COSMETIC. Two entities with the same support must come back in the
  // same order on every render, or the "ranked list" the ADR promises
  // reshuffles itself while somebody is reading it.
  it('breaks a tie A→Z so the same input always gives the same order', () => {
    const tied = [
      entity('c', 'tema', 'Cerro', 4),
      entity('a', 'tema', 'Agua', 4),
      entity('b', 'tema', 'Bosque', 4),
    ];
    expect(rankEntities(tied).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(rankEntities(tied)).toEqual(rankEntities(tied));
    // Shuffling the input must not move anything: the keys decide, not arrival.
    expect(rankEntities([...tied].reverse()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  // Spanish collation, not code points: a naive compare puts `Á` (U+00C1)
  // after `Z`, which sends every accented label to the bottom of the list.
  it('collates in Spanish, so an accented label is not exiled to the end', () => {
    const ranked = rankEntities([
      entity('z', 'lugar', 'Zacatecas', 1),
      entity('a', 'lugar', 'Álamos', 1),
      entity('b', 'lugar', 'Bosque', 1),
    ]);
    expect(ranked.map((e) => e.label)).toEqual(['Álamos', 'Bosque', 'Zacatecas']);
  });

  it('does not mutate the array it was given', () => {
    const input = [entity('a', 'tema', 'Agua', 1), entity('b', 'tema', 'Bosque', 9)];
    rankEntities(input);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('rankNeighbours', () => {
  it('ranks by edge support, then entity support, then label', () => {
    const ranked = rankNeighbours([
      neighbour(entity('c', 'tema', 'Cerro', 1), 3),
      neighbour(entity('a', 'tema', 'Agua', 9), 3),
      neighbour(entity('b', 'tema', 'Bosque', 7), 8),
    ]);
    expect(ranked.map((n) => n.entity.id)).toEqual(['b', 'a', 'c']);
  });

  it('is stable across calls and independent of input order', () => {
    const rows = [
      neighbour(entity('c', 'tema', 'Cerro', 2), 4),
      neighbour(entity('a', 'tema', 'Agua', 2), 4),
      neighbour(entity('b', 'tema', 'Bosque', 2), 4),
    ];
    expect(rankNeighbours(rows).map((n) => n.entity.id)).toEqual(['a', 'b', 'c']);
    expect(rankNeighbours([...rows].reverse())).toEqual(rankNeighbours(rows));
  });
});

describe('filterEntities', () => {
  const rows = [
    entity('a', 'tema', 'Migración', 5),
    entity('b', 'evento', 'Sesión del consejo', 4),
    entity('c', 'lugar', 'Ejido Norte', 3),
  ];

  // ⚠ Not a nicety in a Spanish product. People in a hurry type without
  // accents, and a filter that silently returns nothing reads as
  // "eso no está en el grafo" — a false statement about the corpus.
  it.each([
    ['migracion', 'a'],
    ['MIGRACIÓN', 'a'],
    ['MIGRACION', 'a'],
    ['Migración', 'a'],
    ['SESION', 'b'],
    ['sesión', 'b'],
    ['  norte  ', 'c'],
  ])('finds the right row for %p', (query, id) => {
    expect(filterEntities(rows, query).map((e) => e.id)).toEqual([id]);
  });

  it('matches anywhere in the label, not just the start', () => {
    expect(filterEntities(rows, 'consejo').map((e) => e.id)).toEqual(['b']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterEntities(rows, 'zzz')).toEqual([]);
  });

  it.each(['', '   '])('returns everything for the empty query %p', (query) => {
    expect(filterEntities(rows, query)).toEqual(rows);
  });

  // A copy, not the same array: callers sort and slice the result, and a
  // shared reference would reorder the caller's own source list.
  it('returns a copy even when it filters nothing out', () => {
    const out = filterEntities(rows, '');
    expect(out).not.toBe(rows);
    expect(filterEntities(rows, 'a')).not.toBe(rows);
  });
});

describe('groupByType', () => {
  // ⚠ ALL FOUR, ALWAYS, IN ADR ORDER. An empty list is information — "your
  // ecosistema has no organizaciones yet" — and a group that disappears makes
  // the page's shape change between ecosistemas for no stated reason.
  it('returns the four ADR lists in order, empty ones included', () => {
    expect(groupByType([]).map((g) => g.type)).toEqual([
      'tema',
      'lugar',
      'evento',
      'organizacion',
    ]);
    expect(groupByType([]).every((g) => g.entities.length === 0)).toBe(true);
  });

  it('files each entity under its own type', () => {
    const grouped = groupByType([
      entity('t', 'tema', 'Agua', 1),
      entity('o', 'organizacion', 'Colectivo Sur', 1),
      entity('t2', 'tema', 'Bosque', 1),
    ]);
    expect(grouped.map((g) => g.entities.map((e) => e.id))).toEqual([['t', 't2'], [], [], ['o']]);
  });
});

// ── Copy ───────────────────────────────────────────────────────────────────

describe('the Spanish vocabulary', () => {
  // ⚠ Written as exhaustive maps on purpose: adding a member to the exported
  // `as const` array without adding its Spanish word fails this file rather
  // than shipping an undefined label.
  const LIST_LABELS: Record<GraphViewType, string> = {
    tema: 'Temas',
    lugar: 'Lugares',
    evento: 'Eventos',
    organizacion: 'Organizaciones',
  };
  const CHIP_LABELS: Record<GraphViewType, string> = {
    tema: 'tema',
    lugar: 'lugar',
    evento: 'evento',
    organizacion: 'organización',
  };
  const RELATION_LABELS: Record<GraphRelationType, string> = {
    ocurre_en: 'ocurre en',
    participa_en: 'participa en',
    ubicado_en: 'está en',
    parte_de: 'es parte de',
    afecta_a: 'afecta a',
    relacionado_con: 'se relaciona con',
  };

  // Plural, because it names a list.
  it.each(GRAPH_VIEW_TYPES)('heads the %s list in plural Spanish', (type) => {
    expect(typeListLabel(type)).toBe(LIST_LABELS[type]);
  });

  // Singular, because it names a thing.
  it.each(GRAPH_VIEW_TYPES)('chips one %s in singular Spanish', (type) => {
    expect(typeChipLabel(type)).toBe(CHIP_LABELS[type]);
  });

  // The relation is read aloud in a sentence, so it must not leak the stored
  // snake_case value onto the page.
  it.each(GRAPH_RELATION_TYPES)('reads %s as a Spanish phrase', (relation) => {
    expect(relationLabel(relation)).toBe(RELATION_LABELS[relation]);
    expect(relationLabel(relation)).not.toContain('_');
  });
});

describe('supportCopy and supportShort', () => {
  // ⚠ Singular/plural is decided here rather than in a template because
  // "1 documentos" reads fine right up until the day it does not.
  it('agrees in number', () => {
    expect(supportCopy(0)).toBe('sin documentos que lo respalden');
    expect(supportCopy(1)).toBe('aparece en 1 documento');
    expect(supportCopy(12)).toBe('aparece en 12 documentos');
    expect(supportShort(0)).toBe('0 documentos');
    expect(supportShort(1)).toBe('1 documento');
    expect(supportShort(12)).toBe('12 documentos');
  });

  // 🔴 DOCUMENTS, NOT MENTIONS. The number is distinct published documents;
  // saying "menciones" would inflate a single testimonio into a pattern.
  it('never says menciones', () => {
    for (const n of [0, 1, 12, 400]) {
      expect(supportCopy(n)).not.toMatch(/menci/i);
      expect(supportShort(n)).not.toMatch(/menci/i);
    }
  });

  it('survives a negative or fractional count', () => {
    expect(supportCopy(-3)).toBe('sin documentos que lo respalden');
    expect(supportCopy(1.8)).toBe('aparece en 1 documento');
    expect(supportShort(-3)).toBe('0 documentos');
  });
});

describe('contentKindLabel', () => {
  // 🔴 A TESTIMONIO AND A DOCUMENTO MUST NOT LOOK THE SAME. A reader weighing
  // a connection needs to know whether its evidence is a file somebody wrote
  // or a person's words, gathered and anonymised, without having to guess.
  it('gives a testimonio its own word and its own tone', () => {
    expect(contentKindLabel('testimonio')).toEqual({ label: 'Voz', tone: 'voice' });
  });

  it('labels the other kinds as documents', () => {
    expect(contentKindLabel('documento')).toEqual({ label: 'Documento', tone: 'document' });
    expect(contentKindLabel('conversacion')).toEqual({
      label: 'Conversación',
      tone: 'document',
    });
  });

  // An unreadable kind is the conservative reading, not a missing chip.
  it('reads an unknown kind as a plain Documento', () => {
    expect(contentKindLabel(null)).toEqual({ label: 'Documento', tone: 'document' });
  });

  it.each(CONTENT_KINDS)('gives %s a non-empty label and exactly one voice tone', (kind) => {
    const out = contentKindLabel(kind as ContentKind);
    expect(out.label.length).toBeGreaterThan(0);
    expect(out.tone).toBe(kind === 'testimonio' ? 'voice' : 'document');
  });
});

describe('hiddenCopy', () => {
  // Nothing hidden means the caller renders nothing — not a reassuring
  // "0 ocultas" line that only draws attention to a non-event.
  it.each([0, -1, 0.4])('says nothing for %p', (hidden) => {
    expect(hiddenCopy(hidden, 3)).toBeNull();
  });

  // ⚠ A number we hold and do not show is a number that makes an empty screen
  // look like a bug. The threshold is stated, and so is the reason for it.
  it('names the threshold when the backend named one', () => {
    const copy = hiddenCopy(4, 3)!;
    expect(copy).toContain('4 entidades que no se muestran');
    expect(copy).toContain('menos de 3 documentos publicados');
    expect(copy).toMatch(/a propósito/i);
  });

  // Without a threshold it must not invent one — "menos de 0 documentos" is
  // both false and unreadable.
  it.each([null, 1])('says "muy pocos" rather than inventing a number for %p', (minSupport) => {
    const copy = hiddenCopy(4, minSupport)!;
    expect(copy).toContain('muy pocos documentos publicados');
    expect(copy).not.toMatch(/menos de/);
  });

  it('agrees in number', () => {
    expect(hiddenCopy(1, null)!).toContain('Hay 1 entidad que no se muestra ');
    expect(hiddenCopy(2, null)!).toContain('Hay 2 entidades que no se muestran ');
  });

  // The whole point of the threshold, said in the sentence that reports it.
  it('says who the threshold protects', () => {
    expect(hiddenCopy(1, null)!).toMatch(/protege a quien contó algo una sola vez/);
  });
});

describe('resultsSummary', () => {
  // Two different empty screens. "No hay nada publicado" while a filter is on
  // is simply a false statement about the ecosistema.
  it('separates an empty graph from an empty filter result', () => {
    expect(resultsSummary({ total: 0, shown: 0, filtered: false })).toBe(GRAPH_EMPTY_THRESHOLD);
    expect(resultsSummary({ total: 0, shown: 0, filtered: true })).toBe(GRAPH_NO_RESULTS);
  });

  it('counts the whole list when nothing is filtered', () => {
    expect(resultsSummary({ total: 1, shown: 1, filtered: false })).toBe('1 entidad');
    expect(resultsSummary({ total: 12, shown: 12, filtered: false })).toBe('12 entidades');
    expect(resultsSummary({ total: 12, shown: 3, filtered: false })).toBe('12 entidades');
  });

  it('says how many of how many when a filter is on', () => {
    expect(resultsSummary({ total: 12, shown: 3, filtered: true })).toBe('3 de 12 entidades');
  });

  it('drops the "de N" when the filter matched everything', () => {
    expect(resultsSummary({ total: 12, shown: 12, filtered: true })).toBe('12 entidades');
  });
});

// ── The ego network ────────────────────────────────────────────────────────

describe('egoNeighbours', () => {
  // 🔴 ONE HOP, TWENTY NEIGHBOURS (ADR §7.2). The cap is what keeps the
  // picture readable; without it a hub entity draws a hairball.
  it('caps the drawn neighbours at EGO_MAX_NEIGHBOURS, keeping the strongest', () => {
    const drawn = egoNeighbours(manyNeighbours(60));
    expect(drawn).toHaveLength(EGO_MAX_NEIGHBOURS);
    expect(drawn.map((n) => n.entity.id)).toEqual(
      Array.from({ length: EGO_MAX_NEIGHBOURS }, (_, i) => `n${i}`),
    );
  });
});

describe('egoLayout', () => {
  const centre = entity('c', 'tema', 'Agua', 30);

  // 🔴 NO PHYSICS, NO JITTER (ADR §7.2). The purpose of the picture is
  // ANALYSIS: somebody comes back tomorrow and needs the same shape they saw
  // today, and needs to compare two entities by looking at them.
  it('is deterministic — the same input twice gives a deep-equal layout', () => {
    const rows = manyNeighbours(13);
    expect(egoLayout(centre, rows)).toEqual(egoLayout(centre, rows));
  });

  it('ranks before it draws, so the input order cannot move a node', () => {
    const rows = manyNeighbours(13);
    expect(egoLayout(centre, [...rows].reverse())).toEqual(egoLayout(centre, rows));
    const shuffled = [rows[7]!, rows[0]!, rows[12]!, ...rows.filter((_, i) => ![0, 7, 12].includes(i))];
    expect(egoLayout(centre, shuffled)).toEqual(egoLayout(centre, rows));
  });

  // 🔴 The type filter is repeated inside the layout on purpose: the picture
  // cannot draw a person even if a future response shape slips one past the
  // parser. See the person-rule block above.
  it('never draws more than the cap, and never draws a persona', () => {
    const persona = {
      entity: { id: 'p1', type: 'persona', label: 'Ana Ruiz Mendoza', support: 999 },
      relationType: 'participa_en',
      support: 999,
    } as unknown as GraphNeighbour;
    const layout = egoLayout(centre, [persona, ...manyNeighbours(40)]);
    expect(layout.nodes).toHaveLength(EGO_MAX_NEIGHBOURS);
    expect(layout.nodes.map((n) => n.id)).not.toContain('p1');
    expect(layout.nodes.map((n) => n.label)).not.toContain('Ana Ruiz Mendoza');
  });

  // "Radial" is the claim the picture makes: straight spokes of equal length
  // from one hub. If a node drifts off the circle the spokes stop reading as
  // one relation each, and the eye starts inferring distance = strength.
  it('puts every node on the same circle around the hub', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    const radii = layout.nodes.map((n) => Math.hypot(n.x - layout.hub.x, n.y - layout.hub.y));
    for (const r of radii) expect(Math.abs(r - radii[0]!)).toBeLessThan(0.05);
    expect(radii[0]!).toBeGreaterThan(0);
  });

  // ⚠ THE REASON THE LAYOUT IS NOT EVENLY SPACED AROUND THE WHOLE CIRCLE.
  // Labels are horizontal text; two nodes at the same height on the same side
  // put their labels on top of each other, at exactly the size we ship.
  it('gives every node on a side its own y, with room for a label', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    for (const anchor of ['start', 'end'] as const) {
      const ys = layout.nodes
        .filter((n) => n.labelAnchor === anchor)
        .map((n) => n.y)
        .sort((a, b) => a - b);
      expect(ys.length).toBe(EGO_MAX_NEIGHBOURS / 2);
      expect(new Set(ys).size).toBe(ys.length);
      const gaps = ys.slice(1).map((y, i) => y - ys[i]!);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(25);
    }
  });

  it('keeps the label gap at a full cap, which is the tightest case', () => {
    // Fewer neighbours can only spread further apart, so the cap is the bound.
    for (const n of [4, 10, 16, EGO_MAX_NEIGHBOURS]) {
      const layout = egoLayout(centre, manyNeighbours(n));
      for (const anchor of ['start', 'end'] as const) {
        const ys = layout.nodes
          .filter((node) => node.labelAnchor === anchor)
          .map((node) => node.y)
          .sort((a, b) => a - b);
        const gaps = ys.slice(1).map((y, i) => y - ys[i]!);
        if (gaps.length) expect(Math.min(...gaps)).toBeGreaterThanOrEqual(25);
      }
    }
  });

  // The label has to run AWAY from the hub, or it crosses its own spoke.
  it('anchors each label on the outside of its own node', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    for (const node of layout.nodes) {
      if (node.x > layout.hub.x) {
        expect(node.labelAnchor).toBe('start');
        expect(node.labelX).toBeGreaterThan(node.x);
      } else {
        expect(node.labelAnchor).toBe('end');
        expect(node.labelX).toBeLessThan(node.x);
      }
      expect(node.labelY).toBe(node.y);
    }
  });

  it('keeps every node inside the viewBox', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(layout.width);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(layout.height);
    }
    expect(layout.hub.x).toBeCloseTo(layout.width / 2, 5);
    expect(layout.hub.y).toBeCloseTo(layout.height / 2, 5);
  });

  // Rank has to be readable without counting, so the strongest lands first and
  // at the top. A reader scanning top-to-bottom is then reading the ranking.
  it('puts the strongest neighbour first, at the top of its column', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    const first = layout.nodes[0]!;
    expect(first.id).toBe('n0');
    expect(first.support).toBe(EGO_MAX_NEIGHBOURS);
    const sameSide = layout.nodes.filter((n) => n.labelAnchor === first.labelAnchor);
    expect(first.y).toBe(Math.min(...sameSide.map((n) => n.y)));
    // The second-strongest heads the other column, so the two are level and
    // the ranking reads down both sides at once.
    const otherSide = layout.nodes.filter((n) => n.labelAnchor !== first.labelAnchor);
    const otherTop = otherSide.reduce((best, n) => (n.y < best.y ? n : best));
    expect(otherTop.id).toBe('n1');
    expect(otherTop.y).toBe(first.y);
    // Each column is itself ranked top-to-bottom.
    for (const side of [sameSide, otherSide]) {
      const byY = [...side].sort((a, b) => a.y - b.y);
      expect(byY.map((n) => n.support)).toEqual(
        [...byY.map((n) => n.support)].sort((a, b) => b - a),
      );
    }
  });

  it('draws a thicker spoke for a better-supported connection', () => {
    const layout = egoLayout(centre, manyNeighbours(EGO_MAX_NEIGHBOURS));
    for (const node of layout.nodes) {
      expect(node.strokeWidth).toBeGreaterThanOrEqual(1);
      expect(node.strokeWidth).toBeLessThanOrEqual(3);
      expect(node.r).toBeGreaterThan(0);
    }
    expect(layout.nodes[0]!.strokeWidth).toBeGreaterThan(
      layout.nodes[layout.nodes.length - 1]!.strokeWidth,
    );
  });

  // 🔴 THE DIVIDE-BY-ZERO. A single node makes `i / (m - 1)` a 0/0 if written
  // naively, and one NaN coordinate silently blanks the whole SVG.
  it.each([0, 1, 2, 3])('produces no NaN for %i neighbours', (n) => {
    const layout = egoLayout(centre, manyNeighbours(n));
    expect(layout.nodes).toHaveLength(n);
    for (const value of layoutNumbers(layout)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('sits a lone neighbour level with the hub', () => {
    const layout = egoLayout(centre, manyNeighbours(1));
    expect(layout.nodes[0]!.y).toBe(layout.hub.y);
    expect(layout.nodes[0]!.labelAnchor).toBe('start');
  });

  it('still draws the hub when there is nothing around it', () => {
    const layout = egoLayout(centre, []);
    expect(layout.nodes).toEqual([]);
    expect(layout.hub.label).toBe('Agua');
    expect(layout.hub.r).toBeGreaterThan(0);
  });

  // ⚠ Labels are TRUNCATED, not shrunk: 11px text stays legible, 8px does not.
  // The full label is still on the page, in the list under the picture.
  it('truncates a long label but keeps the full one on the node', () => {
    const long = 'Consejo Consultivo de Participación Ciudadana del Municipio';
    const layout = egoLayout(entity('c', 'tema', long, 3), [
      neighbour(entity('n', 'organizacion', long, 2)),
    ]);
    expect(layout.nodes[0]!.label).toBe(long);
    expect(layout.nodes[0]!.displayLabel).not.toBe(long);
    expect(layout.nodes[0]!.displayLabel.endsWith('…')).toBe(true);
    expect(layout.hub.label).toBe(long);
    expect(layout.hub.displayLabel.endsWith('…')).toBe(true);
  });

  it('leaves a short label alone', () => {
    const layout = egoLayout(centre, [neighbour(entity('n', 'lugar', 'Ejido Norte', 2))]);
    expect(layout.nodes[0]!.displayLabel).toBe('Ejido Norte');
    expect(layout.hub.displayLabel).toBe('Agua');
  });
});

describe('truncateLabel', () => {
  it('leaves a label that fits, including one exactly at the limit', () => {
    expect(truncateLabel('Agua', 20)).toBe('Agua');
    expect(truncateLabel('abcdefghij', 10)).toBe('abcdefghij');
  });

  it('never returns more characters than the limit', () => {
    expect(truncateLabel('abcdefghijk', 10)).toBe('abcdefghi…');
    expect(truncateLabel('a'.repeat(80), 20)).toHaveLength(20);
  });

  // "Palabra …" with a hanging space before the ellipsis reads as a typo.
  it('does not leave a space before the ellipsis', () => {
    expect(truncateLabel('abcdefgh ijk', 10)).toBe('abcdefgh…');
  });

  it('survives an absurdly small limit', () => {
    expect(truncateLabel('abc', 1)).toBe('a…');
    expect(truncateLabel('abc', 0)).toBe('a…');
  });
});

describe('egoDescription', () => {
  const centre = entity('c', 'tema', 'Agua', 12);

  // The SVG is `role="img"`; this sentence IS the picture for anyone using a
  // screen reader, so it carries the same three facts the picture shows.
  it('describes an empty picture as empty rather than saying nothing', () => {
    expect(egoDescription(centre, 0)).toBe('Agua no tiene conexiones que mostrar.');
  });

  it('agrees in number and names the support', () => {
    expect(egoDescription(centre, 1)).toBe('Agua, aparece en 12 documentos, con 1 conexión a un paso.');
    expect(egoDescription(centre, 7)).toBe(
      'Agua, aparece en 12 documentos, con 7 conexiones a un paso.',
    );
  });
});

// ── Supporting documents for an edge ───────────────────────────────────────

describe('sharedDocuments', () => {
  it('keeps only the documents in both lists, in the order of the first', () => {
    const a = [doc('3'), doc('1'), doc('2')];
    const b = [doc('2'), doc('3')];
    expect(sharedDocuments(a, b).map((d) => d.id)).toEqual(['3', '2']);
  });

  // Deterministic output for the same pair of entity views: the list under an
  // edge must not reorder itself between two visits to the same connection.
  it('is stable across calls', () => {
    const a = [doc('3'), doc('1'), doc('2')];
    const b = [doc('2'), doc('3')];
    expect(sharedDocuments(a, b)).toEqual(sharedDocuments(a, b));
  });

  it('drops a duplicate rather than listing the same document twice', () => {
    const a = [doc('1'), doc('1'), doc('2')];
    expect(sharedDocuments(a, [doc('1'), doc('2')]).map((d) => d.id)).toEqual(['1', '2']);
  });

  it('returns nothing when the lists do not meet', () => {
    expect(sharedDocuments([doc('1')], [doc('2')])).toEqual([]);
  });

  it.each([
    ['both empty', [], []],
    ['left empty', [], [doc('1')]],
    ['right empty', [doc('1')], []],
  ])('is safe with %s', (_name, a, b) => {
    expect(sharedDocuments(a, b)).toEqual([]);
  });

  it('returns the rows from the first list, keeping its titles', () => {
    const out = sharedDocuments([doc('1', 'Acta A')], [doc('1', 'Acta B')]);
    expect(out[0]!.title).toBe('Acta A');
  });
});

// ── GraphRAG ───────────────────────────────────────────────────────────────

describe('expandGraphQuery', () => {
  // 🔴 THE SKIP SIGNAL. The provider compares the result to the query and
  // SKIPS the second `POST /v1/retrieve` when they are equal. An expansion
  // that adds no term is the same query over the same corpus the vector leg
  // already ran: identical results, for a second paid call.
  it('returns the query untouched when there are no terms', () => {
    expect(expandGraphQuery('agua en el ejido', [])).toBe('agua en el ejido');
  });

  it.each([
    ['', 'blank'],
    ['   ', 'whitespace'],
  ])('ignores a %p term (%s) and stays unchanged', (term) => {
    expect(expandGraphQuery('agua', [term])).toBe('agua');
  });

  it('ignores a term that is not a string', () => {
    const terms = [null, undefined, 42, {}, []] as unknown as string[];
    expect(expandGraphQuery('agua', terms)).toBe('agua');
  });

  // The same reason, one step subtler: a term the reader already typed adds
  // nothing to the retrieve, accents or no accents.
  it('returns the query unchanged when every term is already in it', () => {
    expect(expandGraphQuery('migracion y sesion del consejo', ['Migración', 'Sesión'])).toBe(
      'migracion y sesion del consejo',
    );
    expect(expandGraphQuery('Migración', ['migracion'])).toBe('Migración');
  });

  it('appends the terms that do add something', () => {
    expect(expandGraphQuery('agua', ['Ejido Norte', 'Consejo'])).toBe('agua Ejido Norte Consejo');
  });

  // Accent-insensitive dedupe: `Migración` and `migracion` are one term, and
  // sending both would only pay for the same recall twice.
  it('dedupes terms accent- and case-insensitively, keeping the first spelling', () => {
    expect(expandGraphQuery('agua', ['Migración', 'migracion', 'MIGRACION'])).toBe(
      'agua Migración',
    );
  });

  it('keeps at most MAX_EXPANSION_TERMS terms', () => {
    const terms = Array.from({ length: MAX_EXPANSION_TERMS + 6 }, (_, i) => `t${i}`);
    const out = expandGraphQuery('cabildo', terms);
    expect(out.split(' ')).toHaveLength(MAX_EXPANSION_TERMS + 1);
    expect(out).toBe(`cabildo ${terms.slice(0, MAX_EXPANSION_TERMS).join(' ')}`);
  });

  // ⚠ A budget, not a term count: eight long entity labels would push a query
  // past what the retrieve usefully embeds.
  it('respects MAX_EXPANSION_CHARS across the terms it adds', () => {
    const query = 'agua';
    const out = expandGraphQuery(query, ['a'.repeat(150), 'b'.repeat(100), 'c'.repeat(40)]);
    expect(out.length - query.length).toBeLessThanOrEqual(MAX_EXPANSION_CHARS);
    // The oversized middle term is skipped; a later one that still fits is not.
    expect(out).toBe(`${query} ${'a'.repeat(150)} ${'c'.repeat(40)}`);
  });

  it('adds nothing at all when no single term fits the budget', () => {
    expect(expandGraphQuery('agua', ['x'.repeat(MAX_EXPANSION_CHARS + 1)])).toBe('agua');
  });

  it('trims the query it was handed', () => {
    expect(expandGraphQuery('  agua  ', [])).toBe('agua');
  });
});

describe('graphContextParagraph', () => {
  const empty: GraphRetrieval = { entities: [], edges: [], documents: [], terms: [] };

  // Nothing to say means no block at all — not an empty header the model then
  // has to interpret as "the graph is broken".
  it('says nothing when there are no entities', () => {
    expect(graphContextParagraph(empty)).toBe('');
    expect(graphContextParagraph({ ...empty, documents: [doc('d1', 'Acta 44-B')] })).toBe('');
  });

  it('names each entity, its Spanish type word and its support count', () => {
    const out = graphContextParagraph({
      ...empty,
      entities: [entity('t1', 'tema', 'Escasez de agua', 12), entity('o1', 'organizacion', 'Colectivo Sur', 1)],
    });
    expect(out).toContain('- Escasez de agua (tema): aparece en 12 documentos.');
    expect(out).toContain('- Colectivo Sur (organización): aparece en 1 documento.');
  });

  // ⚠ THE COUNTS ARE DOCUMENTS, NOT MENTIONS, AND THE PARAGRAPH SAYS SO. A
  // model handed a bare number describes it as "frequency", and the reader
  // then hears "mentioned 12 times" about an entity that appears once in each
  // of 12 files.
  it('tells the model the numbers are distinct published documents', () => {
    const out = graphContextParagraph({ ...empty, entities: [entity('t1', 'tema', 'Agua', 3)] });
    expect(out).toContain('documentos publicados distintos, no menciones');
    expect(out).toMatch(/TODO el material publicado/);
  });

  // 🔴 NO DOCUMENT TITLES, EVER. A title in the prompt is a per-turn
  // re-identification surface, bought for nothing the aggregate does not
  // already give. The retrieval carries documents; the block must ignore them.
  it('never puts a document title into the prompt', () => {
    const documents: GraphDocument[] = [
      { id: 'd1', title: 'Acta 44-B, colonia Nueva Esperanza', contentKind: 'documento' },
      { id: 'd2', title: 'Grabación del 3 de mayo con la señora R.', contentKind: 'testimonio' },
      { id: 'd3', title: 'informe_final_Ramirez_v2.pdf', contentKind: 'conversacion' },
    ];
    const out = graphContextParagraph({
      ...empty,
      entities: [entity('t1', 'tema', 'Escasez de agua', 12), entity('l1', 'lugar', 'Ejido Norte', 5)],
      edges: [{ fromId: 't1', toId: 'l1', relationType: 'ocurre_en', support: 4 }],
      documents,
    });
    expect(out).toContain('Escasez de agua');
    for (const d of documents) {
      expect(out).not.toContain(d.title);
      expect(out).not.toContain(d.id);
    }
    for (const fragment of ['Nueva Esperanza', 'señora R.', 'Ramirez', '.pdf', 'Acta']) {
      expect(out).not.toContain(fragment);
    }
  });

  // An edge is undirected as far as a reader is concerned: "A ocurre en B"
  // also tells you what happens in B. Reading it one way would drop half the
  // graph's neighbours from the block for no reason.
  it('follows an edge in both directions', () => {
    const out = graphContextParagraph({
      ...empty,
      entities: [entity('a', 'tema', 'Escasez de agua', 5), entity('b', 'lugar', 'Ejido Norte', 4)],
      edges: [{ fromId: 'a', toId: 'b', relationType: 'ocurre_en', support: 3 }],
    });
    const lines = out.split('\n');
    expect(lines.find((l) => l.startsWith('- Escasez de agua'))).toContain(
      'Se conecta con: Ejido Norte (lugar, 3 documentos).',
    );
    expect(lines.find((l) => l.startsWith('- Ejido Norte'))).toContain(
      'Se conecta con: Escasez de agua (tema, 3 documentos).',
    );
  });

  // An endpoint we cannot resolve is an endpoint we must not name — this is
  // also the last line of defence for a `persona` id riding in on an edge.
  it('ignores an edge whose other endpoint is not among the entities', () => {
    const out = graphContextParagraph({
      ...empty,
      entities: [entity('a', 'tema', 'Escasez de agua', 5)],
      edges: [
        { fromId: 'a', toId: 'p1', relationType: 'participa_en', support: 9 },
        { fromId: 'zz', toId: 'yy', relationType: 'ocurre_en', support: 9 },
      ],
    });
    expect(out).toContain('- Escasez de agua (tema): aparece en 5 documentos.');
    expect(out).not.toContain('Se conecta con');
  });

  // ⚠ A cap, not a dump. The block is prepended to every local turn, so its
  // size is a per-turn token bill and an unbounded one grows with the corpus.
  it('names at most CONTEXT_MAX_ENTITIES entities, the best-supported first', () => {
    const entities = Array.from({ length: CONTEXT_MAX_ENTITIES + 5 }, (_, i) =>
      entity(`e${i}`, 'tema', `Tema ${i}`, 100 - i),
    );
    const out = graphContextParagraph({ ...empty, entities: [...entities].reverse() });
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(CONTEXT_MAX_ENTITIES);
    expect(bullets[0]).toContain('Tema 0');
    expect(out).not.toContain(`Tema ${CONTEXT_MAX_ENTITIES}`);
  });

  it('names at most CONTEXT_MAX_NEIGHBOURS neighbours per entity', () => {
    const centre = entity('c', 'tema', 'Escasez de agua', 50);
    const others = Array.from({ length: 6 }, (_, i) => entity(`o${i}`, 'lugar', `Ejido ${i}`, 10 - i));
    const out = graphContextParagraph({
      ...empty,
      entities: [centre, ...others],
      edges: others.map((o, i) => ({
        fromId: 'c',
        toId: o.id,
        relationType: 'ocurre_en' as const,
        support: 9 - i,
      })),
    });
    const line = out.split('\n').find((l) => l.startsWith('- Escasez de agua'))!;
    expect(line.match(/Ejido \d/g)).toHaveLength(CONTEXT_MAX_NEIGHBOURS);
    // Strongest edges first, so the cap keeps the connections worth naming.
    expect(line).toContain('Ejido 0 (lugar, 9 documentos)');
    expect(line).not.toContain('Ejido 3');
  });

  // 🔴 NO MODEL CALL, SO THE SAME QUESTION GIVES THE SAME BLOCK. The whole
  // global-question win (ADR §8.1, G2) rests on this being an aggregate we
  // state, not one a model guesses back from five passages.
  it('is deterministic across calls and independent of input order', () => {
    const entities = [
      entity('a', 'tema', 'Escasez de agua', 5),
      entity('b', 'lugar', 'Ejido Norte', 5),
      entity('c', 'evento', 'Asamblea', 5),
    ];
    const edges = [
      { fromId: 'a', toId: 'b', relationType: 'ocurre_en' as const, support: 2 },
      { fromId: 'c', toId: 'a', relationType: 'relacionado_con' as const, support: 2 },
    ];
    const first = graphContextParagraph({ ...empty, entities, edges });
    expect(graphContextParagraph({ ...empty, entities, edges })).toBe(first);
    expect(graphContextParagraph({ ...empty, entities: [...entities].reverse(), edges })).toBe(
      first,
    );
  });

  it('tells the model what the block is for', () => {
    const out = graphContextParagraph({ ...empty, entities: [entity('t1', 'tema', 'Agua', 3)] });
    expect(out).toMatch(/preguntas generales/);
    expect(out).toMatch(/afirmaciones puntuales, apóyate en los fragmentos/);
  });
});

// ── Regressions ────────────────────────────────────────────────────────────
//
// Four defects an adversarial read found after this module was written. Every
// one of them produced output that was WRONG BUT PLAUSIBLE — which is the exact
// failure mode this file exists for, because nothing here renders in a test
// environment and nobody re-reads a paragraph a machine assembled.

describe('regressions', () => {
  const empty: GraphRetrieval = { entities: [], edges: [], documents: [], terms: [] };

  // 🔴 The same pair can be joined by two rows — `A→B` and `B→A`, or two
  // different relation types. Naming the neighbour twice reads as a mistake AND
  // burns two of the three slots the block has for that entity.
  it('names a neighbour once, however many edges join the pair', () => {
    const entities = [
      entity('a', 'tema', 'Escasez de agua', 9),
      entity('b', 'lugar', 'Ejido Norte', 4),
      entity('c', 'evento', 'Asamblea', 3),
      entity('d', 'organizacion', 'Comisariado', 2),
    ];
    const edges = [
      { fromId: 'a', toId: 'b', relationType: 'ocurre_en' as const, support: 2 },
      // Same pair, other direction and other relation. One neighbour, not two.
      { fromId: 'b', toId: 'a', relationType: 'relacionado_con' as const, support: 5 },
      { fromId: 'a', toId: 'c', relationType: 'relacionado_con' as const, support: 3 },
      { fromId: 'a', toId: 'd', relationType: 'participa_en' as const, support: 1 },
    ];
    const line = graphContextParagraph({ ...empty, entities, edges })
      .split('\n')
      .find((l) => l.startsWith('- Escasez de agua'))!;

    expect(line.match(/Ejido Norte/g)).toHaveLength(1);
    // The stronger of the two rows wins, so the count is not understated.
    expect(line).toContain('Ejido Norte (lugar, 5 documentos)');
    // And the freed slot goes to a real third neighbour.
    expect(line).toContain('Comisariado');
  });

  // ⚠ "1 de 12 entidad" is the seam that makes careful copy read as machine
  // output. The noun agrees with the number it follows, which is the TOTAL.
  it('agrees the noun with the total, not with how many are shown', () => {
    expect(resultsSummary({ total: 12, shown: 1, filtered: true })).toBe('1 de 12 entidades');
    expect(resultsSummary({ total: 1, shown: 1, filtered: false })).toBe('1 entidad');
  });

  // ⚠ Same defect, in the sentence that explains the threshold — the one piece
  // of copy that has to be believed for an empty graph not to read as a bug.
  it('agrees the verb with the hidden count', () => {
    expect(hiddenCopy(1, 3)).toContain('Hay 1 entidad que no se muestra porque aparece en');
    expect(hiddenCopy(4, 3)).toContain('entidades que no se muestran porque aparecen en');
  });

  // ⚠ ABSENT AND ZERO ARE DIFFERENT. A support the backend actually sent is
  // taken as sent; only a missing one falls back to the entity's own count.
  // Redrawing a 0 as the entity's full count puts a fat spoke on a thin edge,
  // which is the one thing the picture's line weight is there to say.
  it('does not redraw an explicit support of 0 as the entity count', () => {
    const row = { entity: { id: 'x', type: 'tema', label: 'Agua', support: 40 }, support: 0 };
    expect(parseGraphNeighbour(row)?.support).toBe(0);
    const { support: _dropped, ...noSupport } = row;
    expect(parseGraphNeighbour(noSupport)?.support).toBe(40);
  });

  // 🔴 `edges` reaches ONE HOP OUT of the matched seeds, so an edge's far
  // endpoint is usually NOT in `entities`. Indexing neighbours from `entities`
  // alone resolved almost none of them, and the block lost the clause it exists
  // for — while still looking perfectly well-formed. Verified against the real
  // backend shape (`apps/backend/src/lib/graph/queries.ts`: `GraphEdge` carries
  // whole entities in `from`/`to`).
  it('names a neighbour that is not itself a matched seed', () => {
    const raw = {
      entities: [{ id: '1', type: 'tema', label: 'Escasez de agua', support: 9 }],
      edges: [
        {
          from: { id: '1', type: 'tema', label: 'Escasez de agua', support: 9 },
          to: { id: '2', type: 'lugar', label: 'Ejido Norte', support: 6 },
          relationType: 'ocurre_en',
          support: 4,
        },
        // ⚠ A persona endpoint is dropped like any other: the person rule holds
        // in the prompt block too, not just on screen.
        {
          from: { id: '1', type: 'tema', label: 'Escasez de agua', support: 9 },
          to: { id: '3', type: 'persona', label: 'Ana Ruiz Mendoza', support: 8 },
          relationType: 'participa_en',
          support: 7,
        },
      ],
      documents: [],
      terms: [],
    };
    const retrieval = parseGraphRetrieval(raw);
    expect(retrieval.nodes?.map((n) => n.id)).toEqual(['1', '2']);

    const out = graphContextParagraph(retrieval);
    expect(out).toContain('Ejido Norte (lugar, 4 documentos)');
    expect(out).not.toContain('Ana Ruiz Mendoza');
  });

  // 🔴 "Nobody has published anything" and "everything is below the threshold"
  // look identical on screen and are fixed by different actions. The backend
  // sends `publishedDocuments` precisely so the page can tell them apart.
  it('tells the two empty graphs apart', () => {
    const nothing = parseGraphView({ entities: [], hidden: 0, publishedDocuments: 0 });
    expect(nothing.publishedDocuments).toBe(0);
    expect(emptyGraphCopy(nothing).title).toBe(GRAPH_EMPTY_NOTHING_PUBLISHED);

    const below = parseGraphView({ entities: [], hidden: 11, publishedDocuments: 4 });
    expect(emptyGraphCopy(below).title).toBe(GRAPH_EMPTY_THRESHOLD);

    // ⚠ Unknown falls back to the threshold wording rather than accusing an
    // ecosistema of being empty when we simply did not ask.
    const unknown = parseGraphView({ entities: [], hidden: 0 });
    expect(unknown.publishedDocuments).toBeNull();
    expect(emptyGraphCopy(unknown).title).toBe(GRAPH_EMPTY_THRESHOLD);
  });
});
