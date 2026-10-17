import { describe, expect, it } from 'vitest';

import {
  documentIdsForLengua,
  lenguaFacetCopy,
  lenguaRetrievalFilter,
  lenguaSummaryLine,
  parseLengua,
  parseLenguaIndex,
  MAX_LENGUA_LENGTH,
  filterByLengua,
  lenguaTurn,
  withLengua,
} from './lengua';

describe('parseLengua — a filter value from a URL or a request body', () => {
  it('trims, and treats blank or non-string as "no filter"', () => {
    expect(parseLengua(' mixteco ')).toBe('mixteco');
    expect(parseLengua('')).toBe('');
    expect(parseLengua('   ')).toBe('');
    expect(parseLengua(null)).toBe('');
    expect(parseLengua(42)).toBe('');
  });

  it('caps the length — it ends up in a backend query', () => {
    expect(parseLengua('x'.repeat(500))).toHaveLength(MAX_LENGUA_LENGTH);
  });
});

describe('lenguaRetrievalFilter — ai-service metadata filter', () => {
  it('is `{ lengua }` when one is chosen and undefined otherwise', () => {
    expect(lenguaRetrievalFilter('zapoteco')).toEqual({ lengua: 'zapoteco' });
    expect(lenguaRetrievalFilter('')).toBeUndefined();
  });
});

describe('parseLenguaIndex — the backend /api/lenguas answer', () => {
  it('keeps well-formed facets and document pairs, drops junk', () => {
    const index = parseLenguaIndex({
      lenguas: [{ lengua: 'mixe', documentos: 3 }, { lengua: '', documentos: 1 }, 'junk'],
      documentos: [{ id: 5, lengua: 'mixe' }, { id: '6' }, null],
    });
    expect(index.lenguas).toEqual([{ lengua: 'mixe', documentos: 3 }]);
    expect(index.byDocument).toEqual({ '5': 'mixe' });
  });

  it('is empty for an unreadable body', () => {
    expect(parseLenguaIndex(null)).toEqual({ lenguas: [], byDocument: {} });
  });
});

describe('documentIdsForLengua', () => {
  it('lists the documentos in that language', () => {
    expect(documentIdsForLengua({ '1': 'mixe', '2': 'amuzgo', '3': 'mixe' }, 'mixe')).toEqual([
      '1',
      '3',
    ]);
  });
});

describe('lenguaSummaryLine — the deterministic answer to "which languages appear"', () => {
  it('names every language with its count, in one Spanish sentence', () => {
    const line = lenguaSummaryLine([
      { lengua: 'mixteco', documentos: 18 },
      { lengua: 'amuzgo', documentos: 1 },
    ]);
    expect(line).toContain('mixteco (18 documentos)');
    expect(line).toContain('amuzgo (1 documento)');
    // 🔴 It says WHAT the count covers, so the model does not present it as a
    // census of everyone in the ecosistema, testimonios included.
    expect(line).toMatch(/documentos publicados/);
    expect(line).toMatch(/testimonios/);
  });

  it('is empty when no documento records a language', () => {
    expect(lenguaSummaryLine([])).toBe('');
  });
});

describe('lenguaFacetCopy', () => {
  it('pluralises', () => {
    expect(lenguaFacetCopy({ lengua: 'mixe', documentos: 1 })).toBe('mixe · 1 documento');
    expect(lenguaFacetCopy({ lengua: 'mixe', documentos: 2 })).toBe('mixe · 2 documentos');
  });
});

describe('withLengua — keep the filter across in-page links', () => {
  it('adds, replaces and removes the parameter without touching the others', () => {
    expect(withLengua('/grafo?entidad=3&eco=7', 'mixe')).toBe('/grafo?entidad=3&eco=7&lengua=mixe');
    expect(withLengua('/grafo?lengua=amuzgo&entidad=3', 'mixe')).toBe('/grafo?lengua=mixe&entidad=3');
    expect(withLengua('/grafo?entidad=3&lengua=mixe', '')).toBe('/grafo?entidad=3');
    expect(withLengua('/grafo', '')).toBe('/grafo');
    expect(withLengua('/grafo', 'hñähñu (otomí)')).toBe('/grafo?lengua=h%C3%B1%C3%A4h%C3%B1u+%28otom%C3%AD%29');
  });
});

describe('filterByLengua', () => {
  const docs = [{ id: '1' }, { id: '2' }, { id: '3' }];
  it('keeps everything without a filter', () => {
    expect(filterByLengua(docs, { '1': 'mixe' }, '')).toEqual(docs);
  });
  it('keeps only the documentos in that language — a testimonio has none, so it goes', () => {
    expect(filterByLengua(docs, { '1': 'mixe', '3': 'amuzgo' }, 'mixe')).toEqual([{ id: '1' }]);
  });
});

describe('lenguaTurn — what a chat turn does with a lengua from the request body', () => {
  it('no lengua: no filter, graph allowed — the turn is unchanged', () => {
    expect(lenguaTurn(undefined)).toEqual({ lengua: '', graph: true });
    expect(lenguaTurn('  ')).toEqual({ lengua: '', graph: true });
  });

  // 🔴 The graph leg runs its own retrieve WITHOUT the filter and its block
  // counts the whole ecosistema; inside a "solo mixe" turn it would bring in
  // other languages and testimonios. So a filtered turn skips it.
  it('a lengua: metadata filter on, graph off', () => {
    expect(lenguaTurn(' mixe ')).toEqual({
      lengua: 'mixe',
      retrievalFilter: { lengua: 'mixe' },
      graph: false,
    });
  });
});
