import { describe, expect, it } from 'vitest';
import { documentListText, isCorpusOverview, LIST_MAX_TITLES, withoutRetrieval } from './overview';
import type { AIClient } from '@edc/chat-engine/core';

describe('isCorpusOverview', () => {
  it.each([
    'dame un resumen del grafo',
    'Dame un resumen del corpus',
    '¿De qué trata el corpus?',
    'Resume el ecosistema, por favor',
    'Quiero una visión general de la colección',
    'Háblame del corpus como conjunto',
    '¿Qué temas hay en el ecosistema?',
  ])('overview: %s', (q) => expect(isCorpusOverview(q)).toBe(true));

  it.each([
    '¿Qué dicen los documentos sobre el ex convento de Corpus Christi?',
    'Dame un resumen del ex convento de Corpus Christi',
    'Dame un resumen del corpus sobre educación especial',
    'resumen de los testimonios sobre la escuela',
    '¿qué dicen sobre la partería tradicional?',
    'el corpus christi',
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
      100,
    );
    expect(text).toBe(
      'Material publicado en el ecosistema: 2 documentos y 1 testimonio.\n\nDocumentos:\n- Diccionario LSM.pdf\n- Ley general.pdf',
    );
    expect(text).not.toContain('Juana');
  });

  it('a full scan says "al menos"; titles past the cap are counted', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `D${i}` }));
    const text = documentListText(docs, 100);
    expect(text).toContain('al menos 100 documentos');
    expect(text).toContain(`- … y ${100 - LIST_MAX_TITLES} más.`);
  });

  it('nothing published: no source', () => expect(documentListText([], 100)).toBe(''));
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
