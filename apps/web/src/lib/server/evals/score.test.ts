import { describe, expect, it } from 'vitest';

import { aggregate, citedClaims, isRefusal, numberedSources, parseVerdict, rankOf } from './score';
import type { ChatItemResult, PrivacyItemResult } from './types';

describe('citedClaims (port of scripts/cite-eval)', () => {
  it('one claim per cited number, markers stripped, document part only', () => {
    const answer =
      'Las ovitrampas bajaron en 2023 [1]. Hubo brigadas [1, 2].\n- Se limpiaron patios [3]\n\n' +
      'Fuera de los documentos: el dengue es viral [4].';
    expect(citedClaims(answer)).toEqual([
      { claim: 'Las ovitrampas bajaron en 2023 .', n: 1 },
      { claim: 'Hubo brigadas .', n: 1 },
      { claim: 'Hubo brigadas .', n: 2 },
      { claim: 'Se limpiaron patios', n: 3 },
    ]);
  });
  it('caps the judge calls', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Dato ${i} [${i + 1}].`).join(' ');
    expect(citedClaims(many, 5)).toHaveLength(5);
  });
});

describe('isRefusal', () => {
  it('a refusal cue and no citation in the document part', () => {
    expect(isRefusal('Los documentos no mencionan la capital de Australia.')).toBe(true);
    expect(isRefusal('Los documentos no mencionan eso, pero sí hablan de brigadas [1].')).toBe(false);
    expect(isRefusal('Canberra es la capital.')).toBe(false);
  });
});

describe('numberedSources + rankOf', () => {
  const tap = {
    matches: [
      { documentId: 'a', chunkId: 'c1', score: 1, corpus: 'eco-6', text: '<fuente>\nuno\n</fuente>', metadata: { docId: 1114 } },
      { documentId: 'b', chunkId: 'c2', score: 1, corpus: 'eco-6', text: '<fuente>\ndos\n</fuente>', metadata: { docId: 1125 } },
      { documentId: 'a', chunkId: 'c3', score: 1, corpus: 'eco-6', text: '<fuente>\ntres\n</fuente>', metadata: { docId: 1114 } },
    ],
    provenance: {
      chunks: [
        { chunkId: 'c1', documentId: 'a', score: 1, corpus: 'eco-6', metadata: { docId: 1114, title: 'Ovitrampas' } },
        { chunkId: 'c2', documentId: 'b', score: 1, corpus: 'eco-6', metadata: { docId: 1125, title: 'Chipitlán' } },
        { chunkId: 'edc:mapa', documentId: '', score: 0, corpus: '', metadata: { title: 'Mapa' }, text: 'resumen del grafo' },
      ],
    },
  };
  it('[N] is the regrouped provenance entry; its passage is every chunk of that document', () => {
    const { refs, passages } = numberedSources(tap);
    expect(refs.map((r) => r.docId)).toEqual(['1114', '1125', null]);
    expect(passages).toEqual(['uno\n\n…\n\ntres', 'dos', 'resumen del grafo']);
    expect(rankOf(refs, [1125])).toBe(2);
    expect(rankOf(refs, [9])).toBeNull();
    expect(rankOf(refs, [])).toBeNull();
  });
  it('no tap → no sources', () => {
    expect(numberedSources(null)).toEqual({ refs: [], passages: [] });
  });
});

describe('parseVerdict', () => {
  it('reads SI/NO and the reason', () => {
    expect(parseVerdict('SI')).toEqual({ ok: true, reason: '' });
    expect(parseVerdict('Sí: usa el modelo social.')).toEqual({ ok: true, reason: 'usa el modelo social.' });
    expect(parseVerdict('**NO** - no menciona derechos')).toEqual({ ok: false, reason: 'no menciona derechos' });
    expect(parseVerdict('Tal vez')).toMatchObject({ ok: false });
  });
});

describe('aggregate', () => {
  const q = (o: Partial<ChatItemResult>): ChatItemResult => ({
    itemId: '1', kind: 'pregunta', question: 'q', shouldRefuse: false, expectedDocIds: [1], answer: '', sources: [],
    rank: 1, refused: false, refusalOk: true, claims: [], style: null, costUsd: 0, model: null, ...o,
  });
  const p = (o: Partial<PrivacyItemResult>): PrivacyItemResult => ({
    itemId: '9', kind: 'privacidad', notes: '', status: 'ready', detector: 'd', model: null, terms: [], ...o,
  });
  it('computes every rate over what was measurable', () => {
    const m = aggregate([
      q({ rank: 1, claims: [{ n: 1, claim: 'a', ok: true }, { n: 2, claim: 'b', ok: false }], style: { ok: true, reason: '' } }),
      q({ rank: 4 }),
      q({ rank: null, refused: true, refusalOk: false }),
      q({ shouldRefuse: true, expectedDocIds: [], rank: null, refused: false, refusalOk: false }),
      q({ error: 'generate 502' }),
      p({ terms: [
        { term: 'Ana', cls: 'privado', before: 1, after: 1, ok: false },
        { term: 'Luis', cls: 'privado', before: 1, after: 0, ok: true },
        { term: 'DIF', cls: 'publico', before: 1, after: 1, ok: true },
        { term: 'X', cls: 'publico', before: 0, after: 0, ok: null },
      ] }),
      p({ status: 'hold', terms: [] }),
    ]);
    expect(m).toMatchObject({
      citationSupport: 0.5, claims: 2, refusalAccuracy: 0.5, falseRefusals: 1, missedRefusals: 1, questions: 4,
      hit1: 1 / 3, hit3: 1 / 3, hit5: 2 / 3, retrievalItems: 3,
      leakRate: 0.5, overRedaction: 0, privateTerms: 2, publicTerms: 1, holds: 1, privacyItems: 2,
      styleShown: 1, styleItems: 1, errors: 1,
    });
  });
  it('nothing measurable → null rates, not zero', () => {
    expect(aggregate([])).toMatchObject({ citationSupport: null, hit5: null, leakRate: null, styleShown: null });
  });
});
