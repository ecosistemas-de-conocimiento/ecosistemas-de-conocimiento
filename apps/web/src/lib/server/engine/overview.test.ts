import { describe, expect, it } from 'vitest';
import { documentListText, isCorpusOverview, LIST_MAX_TITLES, withoutRetrieval } from './overview';
import type { AIClient } from '@edc/chat-engine/core';

describe('isCorpusOverview', () => {
  it.each([
    'dame un resumen del grafo',
    'Dame un resumen del corpus',
    'dame un resumen del grafo / corpus de este proyecto',
    'me interesa conocer el corpus como conjunto',
    '¿De qué trata el corpus?',
    '¿De qué tratan los documentos del ecosistema?',
    'Resume el ecosistema, por favor',
    'Quiero una visión general de la colección',
    'Háblame del corpus como conjunto',
    '¿Qué temas hay en el ecosistema?',
  ])('overview: %s', (q) => expect(isCorpusOverview(q)).toBe(true));

  // 🔴 Audit 2026-10-28: the first four are the audit's own examples; the
  // unanchored match read 11 of 13 such questions as overviews.
  it.each([
    'Describe el ecosistema de manglares de la costa',
    '¿Qué contiene la colección de leyes de 1917?',
    'Dame un resumen de los documentos del ecosistema que hablan de discapacidad',
    '¿Qué temas hay en el corpus legal de la SCJN?',
    'Resume el corpus de testimonios de Oaxaca',
    'Dame un resumen del grafo de la escuela inclusiva',
    '¿De qué trata la biblioteca de la comunidad?',
    'Haz un panorama del ecosistema escolar en Morelos',
    'Describe la colección del museo de antropología',
    '¿Qué hay en el corpus lingüístico del náhuatl?',
    'resumen del ecosistema educativo y sus actores',
    'Dame una visión general de la colección de fotografías',
    '¿Qué contiene el corpus 2024?',
    '¿Qué dicen los documentos sobre el ex convento de Corpus Christi?',
    'Dame un resumen del ex convento de Corpus Christi',
    'Dame un resumen del corpus sobre educación especial',
    '¿qué dicen sobre la partería tradicional?',
    '',
    `dame un resumen del corpus ${'x'.repeat(300)}`,
  ])('not an overview: %s', (q) => expect(isCorpusOverview(q)).toBe(false));
});

describe('documentListText', () => {
  it('counts by kind and names documentos only, never a testimonio', () => {
    const text = documentListText(
      [
        { id: '1', name: 'Diccionario LSM.pdf', contentKind: 'documento' },
        { id: '2', name: 'Testimonio de Juana Pérez', contentKind: 'testimonio' },
        { id: '3', name: 'Ley general.pdf' },
      ],
      false,
    );
    expect(text).toBe(
      'Material publicado en el ecosistema: 2 documentos y 1 testimonio.\n\nDocumentos:\n- Diccionario LSM.pdf\n- Ley general.pdf',
    );
    expect(text).not.toContain('Juana');
  });

  it('a truncated read says "al menos"; titles past the cap are counted', () => {
    const docs = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `D${i}` }));
    expect(documentListText(docs, true)).toContain('al menos 60 documentos');
    expect(documentListText(docs, false)).toContain(': 60 documentos');
    expect(documentListText(docs, false)).toContain(`- … y ${60 - LIST_MAX_TITLES} más.`);
  });

  it('nothing published: no source', () => expect(documentListText([], false)).toBe(''));
});

describe('withoutRetrieval', () => {
  it('retrieves nothing, generates through the base client', async () => {
    const calls: string[] = [];
    const base: AIClient = {
      generateSync: async () => (calls.push('gen'), { text: 'ok' }) as never,
      retrieve: async () => (calls.push('ret'), { matches: [{ chunkId: 'x' }] }) as never,
      ingest: async () => ({}) as never,
      retrieveMulti: async () => (calls.push('multi'), { matches: [], corpora: [] }),
    };
    const c = withoutRetrieval(base);
    expect((await c.retrieve({} as never)).matches).toEqual([]);
    expect((await c.retrieveMulti!({} as never)).matches).toEqual([]);
    await c.generateSync({} as never);
    expect(calls).toEqual(['gen']);
  });
});
