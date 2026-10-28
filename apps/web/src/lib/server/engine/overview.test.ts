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
    // Owner request 2026-10-28.
    '¿Cuáles son los temas principales del corpus?',
    'Explícame el grafo',
    'síntesis de los documentos publicados',
    'resumen general de todo lo que hay aquí',
    '¿De qué tratan todos los documentos?',
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

  // A compound question or a negation is a normal turn.
  it.each([
    'Háblame de la partería en Oaxaca y luego dame un resumen del corpus',
    'No quiero un resumen del corpus',
    'Compara a Freire con Vygotsky y describe el ecosistema',
    'Qué opinas de la inclusión. Resume el grafo',
    'resumen del corpus de este proyecto de salud',
  ])('compound, not an overview: %s', (q) => expect(isCorpusOverview(q)).toBe(false));

  it.each([
    '¿Me puedes dar un panorama general del corpus?',
    'Hazme un resumen de todo el material publicado',
    '¿Qué contiene esta biblioteca?',
    'Resume toda la colección',
    'Cuéntame de qué va el corpus',
    '¿Qué hay en este ecosistema?',
    'Hazme un resumen del corpus completo',
    'Dame un resumen del ecosistema en su conjunto',
    'resume el grafo por favor',
    'que hay en el grafo',
    'Describe el mapa de conexiones',
  ])('whole-corpus probe: %s', (q) => expect(isCorpusOverview(q)).toBe(true));

  // 🔴 The coordinator's 34 topical probes (2026-10-28): 0 matches.
  it.each([
    'Resume el corpus de Chiapas',
    'Dame un resumen del grafo de actores',
    '¿De qué trata el corpus de entrevistas?',
    'Describe el ecosistema de salud mental',
    '¿Qué temas hay en la biblioteca digital de la UNAM?',
    'Panorama del corpus jurídico',
    'Resume la colección Lumholtz',
    '¿Qué hay en el material publicado por la SEP?',
    'Dame un resumen del corpus en lengua maya',
    'Visión general de la biblioteca escolar',
    'Resume el ecosistema de innovación del Bajío',
    '¿De qué trata el grafo de citas del artículo?',
    'Resume el corpus de 2023',
    'Dame un resumen del corpus del INAH',
    '¿De qué trata la colección Palafox?',
    '¿Qué contiene el corpus del español de México?',
    'Resúmeme la biblioteca Vasconcelos',
    'Resume el corpus de la Ley General de Educación',
    '¿Qué temas hay en la colección de testimonios de mujeres sordas?',
    'Haz un resumen del ecosistema de la Ciudad de México',
    'Dame un panorama del mapa de conexiones entre escuelas y familias',
    'Resume el corpus, en particular lo de salud',
    'Resume el corpus de discapacidad visual',
    '¿De qué trata el ecosistema Corpus Christi?',
    'Dame un resumen del grafo de Corpus Christi',
    'Resume el corpus Christi',
    '¿Qué temas hay en el corpus Christi?',
    'Resume el ecosistema actual de la educación inclusiva',
    'Describe la biblioteca completa de Alejandría',
    'resumen del corpus entero de Juan Rulfo',
    '¿Qué contiene el grafo? ¿Y qué dice sobre salud?',
    'Describe el ecosistema en general de la Amazonia',
    'Resume los documentos del ecosistema de Oaxaca',
    'Dame una vista general del corpus de lenguas indígenas',
  ])('topical probe, not an overview: %s', (q) => expect(isCorpusOverview(q)).toBe(false));
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
