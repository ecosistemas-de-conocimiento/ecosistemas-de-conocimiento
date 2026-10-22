import { describe, expect, it, vi } from 'vitest';

// The A–D blocks below were written for variant A's source rules, so this file
// pins the env default to A. The variant E block passes 'E' explicitly, and
// the "unset is E" test clears the value.
const testEnv = vi.hoisted(() => ({ CHAT_CITE_VARIANT: 'A' as string | undefined }));
vi.mock('$env/dynamic/private', () => ({ env: testEnv }));
import { provenanceToCitations } from '@edc/chat-engine/core';
import {
  MAX_SOURCES,
  NO_ANSWER_VARIANTS,
  citedBrowserProvenance,
  REFUSAL_CUES,
  hasRefusalCue,
  isNoAnswer,
  opensWithRefusal,
  splitGeneralKnowledge,
  toBrowserProvenance,
  toBrowserMessage,
} from './citationProvenance';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import { NO_ANSWER_REPLY } from '$lib/server/engine/prompt';
import { citationsWithOrdinals } from '$lib/citationOrdinals';
import { chatCitationHref } from '$lib/engine/client';

/**
 * Fable audit #8: chunk metadata `sessionId` and `authoredBy` (written by
 * `chunkMetadata`, apps/backend/src/lib/contentKind.ts) rode into citations
 * that every member's browser receives. The browser now gets an ALLOWLIST.
 */

/** A conversation turn ingested before the 2026-10-21 ruling: never a source. */
const assistantChunk = {
  chunkId: 'c1',
  documentId: 'uuid-1',
  score: 0.9,
  denseScore: 0.7,
  lexicalScore: 0.1,
  rerankScore: 0.9,
  corpus: 'eco-7',
  text: 'Antes dije que el faro existe.',
  metadata: {
    docId: 'msg-41',
    organizationId: '7',
    kind: 'conversacion',
    format: 'chat',
    publication: 'published',
    title: 'Conversación',
    authoredBy: 'assistant',
    sessionId: '77',
    path: 'graph',
  },
  someFutureField: 'x',
};

const userTurnChunk = {
  ...assistantChunk,
  chunkId: 'c0',
  text: '¿Qué dice el informe de riego?',
  metadata: { ...assistantChunk.metadata, docId: 'msg-40', authoredBy: 'user' },
};

const docChunk = {
  chunkId: 'c2',
  documentId: 'uuid-11',
  score: 0.5,
  corpus: 'eco-7-draft-1',
  text: 'Dato.',
  metadata: { docId: '11', publication: 'draft', title: 'informe.pdf', [DRAFT_PROVENANCE_FLAG]: true, lengua: 'mixe' },
};

const hasKeyDeep = (value: unknown, key: string): boolean =>
  JSON.stringify(value).includes(`"${key}"`);

describe('toBrowserProvenance', () => {
  const out = toBrowserProvenance({ chunks: [assistantChunk, docChunk] })!;

  it('🔴 drops every conversation turn (owner ruling 2026-10-21), question or answer', () => {
    const both = toBrowserProvenance({ chunks: [userTurnChunk, assistantChunk, docChunk] })!;
    expect(both.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(provenanceToCitations(both).map((c) => c.title)).not.toContain('Conversación');
  });

  it('🔴 never carries sessionId or authoredBy', () => {
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
  });

  it('stamps each chunk with its PROMPT ordinal before dropping, so [N] keeps its source', () => {
    // The turn was [1]; the document stays [2].
    expect(out.chunks.map((c) => [(c as { ordinal?: number }).ordinal, c.chunkId])).toEqual([[2, 'c2']]);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([[2, 'informe.pdf']]);
  });

  it('is an allowlist: unknown chunk and metadata keys are dropped', () => {
    const doc = toBrowserProvenance({ chunks: [{ ...docChunk, denseScore: 0.7, someFutureField: 'x' }] })!;
    expect(Object.keys(doc.chunks[0]!).sort()).toEqual(
      ['chunkId', 'corpus', 'denseScore', 'documentId', 'metadata', 'ordinal', 'score', 'text'],
    );
    expect(Object.keys(doc.chunks[0]!.metadata!).sort()).toEqual(
      ['docId', DRAFT_PROVENANCE_FLAG, 'publication', 'title'].sort(),
    );
  });

  it('keeps everything the citation card reads: title, passage, link and draft label', () => {
    const citations = citationsWithOrdinals(out);
    expect(citations.map((c) => [c.title, c.passageText])).toEqual([['informe.pdf', 'Dato.']]);
    expect(citations[0]!.metadata?.[DRAFT_PROVENANCE_FLAG]).toBe(true);
    const published = toBrowserProvenance({ chunks: [{ ...docChunk, metadata: { docId: '12', publication: 'published' } }] })!;
    expect(chatCitationHref(provenanceToCitations(published)[0]!)).not.toBeNull();
  });

  it('keeps docId only when it is a documents row id; a msg- id is a turn and is dropped', () => {
    const ids = toBrowserProvenance({
      chunks: [
        { ...docChunk, metadata: { docId: 'msg-41' } },
        { ...docChunk, metadata: { docId: 12 } },
        { ...docChunk, metadata: { docId: ' 13 ' } },
        { ...docChunk, metadata: { docId: 'abc' } },
      ],
    })!;
    expect(ids.chunks.map((c) => c.metadata?.docId)).toEqual(['12', '13', undefined]);
  });

  it('passes null through, and reads anything else as no provenance', () => {
    expect(toBrowserProvenance(null)).toBeNull();
    expect(toBrowserProvenance(undefined)).toBeNull();
    expect(toBrowserProvenance('x')).toBeNull();
    expect(toBrowserProvenance({ chunks: 'nope' })).toBeNull();
    expect(toBrowserProvenance({ chunks: [null, 3, { ...docChunk, metadata: null }] })).toEqual({
      chunks: [expect.objectContaining({ chunkId: 'c2', metadata: null, ordinal: 3 })],
    });
  });

  it('reads a bare array of chunks too (an older persisted shape)', () => {
    const arr = toBrowserProvenance([assistantChunk, docChunk]);
    expect(arr?.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(hasKeyDeep(arr, 'sessionId')).toBe(false);
  });
});

describe('citedBrowserProvenance — only the sources the answer cites (#35)', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const five = { chunks: [doc(1), doc(2), doc(3), doc(4), doc(5)] };

  it('keeps the cited chunks only, each with the ordinal the answer used', () => {
    const out = citedBrowserProvenance(five as never, 'El riego empezó en 2020 [3], según el acta [1, 3].')!;
    expect(out.chunks.map((c) => [(c as { ordinal?: number }).ordinal, c.chunkId])).toEqual([
      [3, 'd3'],
      [1, 'd1'],
    ]);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([
      [3, 'Doc 3'],
      [1, 'Doc 1'],
    ]);
  });

  it('a marker past the end is ignored, and still counts as citing: no fallback', () => {
    expect(citedBrowserProvenance(five as never, 'Dato [9].')).toBeNull();
  });

  it('🔴 a cited conversation turn is still dropped, and leaves no "Conversación" source', () => {
    const out = citedBrowserProvenance({ chunks: [userTurnChunk, docChunk] } as never, 'Según [1] y [2].')!;
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([[2, 'informe.pdf']]);
  });

  it('carries no `relevance` field to the browser', () => {
    expect(hasKeyDeep(citedBrowserProvenance(five as never, '[2]'), 'relevance')).toBe(false);
  });
});

// 🔴 Measured on dev: "dengue" (3 runs) answered with no [N] and showed 0
// sources. An answer with no marker at all lists the top retrieved ones.
describe('citedBrowserProvenance — an answer with no [N] lists the top sources', () => {
  const scored = (i: number, score: number, rerankScore?: number) => ({
    chunkId: `s${i}`,
    documentId: `uuid-${i}`,
    score,
    ...(rerankScore === undefined ? {} : { rerankScore }),
    corpus: 'eco-7',
    text: `Pasaje ${i}.`,
    metadata: { docId: String(i), title: `Doc ${i}`, publication: 'published' },
  });
  const ids = (p: ReturnType<typeof citedBrowserProvenance>) => (p?.chunks ?? []).map((c) => c.chunkId);
  const ords = (p: ReturnType<typeof citedBrowserProvenance>) =>
    (p?.chunks ?? []).map((c) => (c as { ordinal?: number }).ordinal);

  it('no [N]: the top 3 by rerank score, best first, each with its prompt ordinal', () => {
    const p = { chunks: [scored(1, 0.9, 0.1), scored(2, 0.1, 0.8), scored(3, 0.5, 0.5), scored(4, 0.3, 0.9), scored(5, 0.2, 0.2)] };
    const out = citedBrowserProvenance(p as never, 'El dengue se transmite por mosquitos.');
    expect(ids(out)).toEqual(['s4', 's2', 's3']);
    expect(ords(out)).toEqual([4, 2, 3]);
  });

  it('no rerank score: ranks by the retrieval score', () => {
    const p = { chunks: [scored(1, 0.2), scored(2, 0.9), scored(3, 0.5), scored(4, 0.7)] };
    expect(ids(citedBrowserProvenance(p as never, 'Sin marcas.'))).toEqual(['s2', 's4', 's3']);
  });

  it('fewer than 3 retrieved: lists them all; none retrieved: no sources', () => {
    expect(ids(citedBrowserProvenance({ chunks: [scored(1, 0.2)] } as never, 'Sin marcas.'))).toEqual(['s1']);
    expect(citedBrowserProvenance({ chunks: [] } as never, 'Sin marcas.')).toBeNull();
    expect(citedBrowserProvenance(null, 'Sin marcas.')).toBeNull();
  });

  it('🔴 the no-answer reply (the prompt constant) lists no sources', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8)] };
    expect(citedBrowserProvenance(p as never, NO_ANSWER_REPLY)).toBeNull();
    expect(citedBrowserProvenance(p as never, `  ${NO_ANSWER_REPLY} Puedo ayudarte con otra cosa.`)).toBeNull();
  });

  it('the no-answer reply with a title match: only the matched document, as before', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8)] };
    const out = citedBrowserProvenance(p as never, NO_ANSWER_REPLY, { id: '2', name: 'Doc 2' });
    expect(ids(out)).toEqual(['s2']);
  });

  it('a close variant of the reply lists no sources either', () => {
    const p = { chunks: [scored(1, 0.9)] };
    expect(citedBrowserProvenance(p as never, 'Los documentos no hablan de dengue.')).toBeNull();
  });

  it('with [N]: cited only, the fallback never adds a top chunk', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.1), scored(3, 0.5)] };
    expect(ids(citedBrowserProvenance(p as never, 'Dato [2].'))).toEqual(['s2']);
  });

  it('🔴 a conversation turn never takes a slot', () => {
    const p = { chunks: [{ ...userTurnChunk, score: 0.99 }, scored(2, 0.5), scored(3, 0.4), scored(4, 0.3), scored(5, 0.2)] };
    expect(ids(citedBrowserProvenance(p as never, 'Sin marcas.'))).toEqual(['s2', 's3', 's4']);
  });

  it('🔴 a testimonio: published chunks only, titled "Testimonio"', () => {
    const t = (id: string, publication: string, score: number) => ({
      ...scored(9, score),
      chunkId: id,
      text: publication === 'published' ? 'REDACTADO [Persona A]' : 'ORIGINAL Juana',
      metadata: { docId: '9', title: 'Carta de Juana', kind: 'testimonio', publication },
    });
    const p = { chunks: [t('t-draft', 'draft', 0.99), t('t-pub', 'published', 0.6), scored(2, 0.5)] };
    const out = citedBrowserProvenance(p as never, 'Sin marcas.')!;
    expect(ids(out)).toEqual(['t-pub', 's2']);
    expect(out.chunks[0]!.metadata).toMatchObject({ title: 'Testimonio' });
    expect(JSON.stringify(out)).not.toMatch(/Juana/);
  });

  describe('with a title match', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8), scored(3, 0.7), scored(4, 0.6), scored(5, 0.1)] };

    it('matched doc outside the top 3: the top 3 plus it, 4 at most', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '5', name: 'Doc 5', contentKind: 'documento' } as never);
      expect(ids(out)).toEqual(['s1', 's2', 's3', 's5']);
      expect(ords(out)).toEqual([1, 2, 3, 5]);
    });

    it('matched doc inside the top 3: listed once, no duplicate', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '2', name: 'Doc 2', contentKind: 'documento' } as never);
      expect(ids(out)).toEqual(['s1', 's2', 's3']);
    });

    it('matched doc not retrieved: the top 3 plus a document-level entry', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '77', name: 'Doc 77', contentKind: 'documento' } as never)!;
      expect(ids(out)).toEqual(['s1', 's2', 's3', 'document:77']);
      expect(new Set(ords(out)).size).toBe(4);
    });
  });
});

// 🔴 Measured on dev after 9285305: an off-topic question (3/3 runs) said the
// documents do not cover it, then cited [1, 2, 3, 4, 5], so 5 sources showed.
describe('citedBrowserProvenance — a no-answer reply shows no sources, cited or not', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const five = { chunks: [doc(1), doc(2), doc(3), doc(4), doc(5)] };

  it('🔴 the off-topic answer citing [1..5] after a no-answer phrase: no sources', () => {
    const answer =
      'Los documentos no hablan de la capital de Francia. Tratan de salud comunitaria [1, 2, 3, 4, 5].';
    expect(citedBrowserProvenance(five as never, answer)).toBeNull();
    expect(citedBrowserProvenance(five as never, `${NO_ANSWER_REPLY} [1, 2, 3, 4, 5]`)).toBeNull();
  });

  it('only the FIRST sentence counts: a later "no mencionan X" keeps its sources', () => {
    const partial = 'El riego empezó en 2020 [2]. Los documentos no mencionan el costo [3].';
    expect(isNoAnswer(partial)).toBe(false);
    expect(citedBrowserProvenance(five as never, partial)!.chunks.map((c) => c.chunkId)).toEqual(['d2', 'd3']);
    expect(isNoAnswer(`Lo siento. ${NO_ANSWER_REPLY}`)).toBe(false);
  });

  it('the first sentence after trimming fires, even with more sentences after it', () => {
    const answer = '\n  No encontré información sobre París. Los documentos tratan de salud [1, 2].';
    expect(isNoAnswer(answer)).toBe(true);
    expect(citedBrowserProvenance(five as never, answer)).toBeNull();
  });

  it('a title-matched document is still shown: the person named it', () => {
    const out = citedBrowserProvenance(five as never, `${NO_ANSWER_REPLY} [1, 2]`, { id: '4', name: 'Doc 4' })!;
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['d4']);
  });

  it.each([
    ...NO_ANSWER_VARIANTS,
    'LOS DOCUMENTOS NO MENCIONAN la capital.',
    'No encontré información sobre París.',
    'Lo siento, no hay información en los documentos sobre eso.',
    'Los  documentos\tno hablan de esto',
  ])('detects the variant %j, accent- and case-folded', (text) => {
    expect(isNoAnswer(text)).toBe(true);
  });

  it.each([
    'Los documentos describen el riego en 2020 [2].',
    'Según los documentos, el dengue se transmite por mosquitos.',
    'Los documentos hablan de tres comunidades.',
    'No hay vacuna; los documentos recomiendan eliminar criaderos [1].',
    'Encontré información sobre el riego en los documentos [3].',
  ])('a normal sentence that mentions "documentos" is not one: %j', (text) => {
    expect(isNoAnswer(text)).toBe(false);
  });
});

describe('citedBrowserProvenance — no [N] and a refusal cue anywhere: no fallback (round 2)', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const five = { chunks: [doc(1), doc(2), doc(3), doc(4), doc(5)] };

  it('🔴 a reworded refusal with no [N] lists no fallback sources (dev 5fe43ff, Francia #1)', () => {
    const answer = 'Los documentos de la Red Comunitaria de Salud no hablan de la capital de Francia.';
    expect(isNoAnswer(answer)).toBe(false); // the first-sentence net missed it
    expect(citedBrowserProvenance(five as never, answer)).toBeNull();
  });

  it('🔴 a hedge with no [N] lists no fallback sources (dev 5fe43ff, Educación Q1 #1)', () => {
    const answer =
      'Hay relatos de docentes y conserjes sobre la escuela. Los documentos disponibles no contienen ' +
      'testimonios directos de familias.';
    expect(citedBrowserProvenance(five as never, answer)).toBeNull();
  });

  it.each([...REFUSAL_CUES, 'NO ENCONTRÉ nada', 'Los textos no incluyen eso'])(
    'the cue %j fires anywhere, accent- and case-folded',
    (cue) => {
      expect(hasRefusalCue(`El tema es amplio. Aun así, ${cue}.`)).toBe(true);
    },
  );

  it('no cue and no [N]: the top-3 fallback still runs', () => {
    expect(hasRefusalCue('Las familias cuentan que la maestra llamaba cada semana.')).toBe(false);
    expect(citedBrowserProvenance(five as never, 'Las familias cuentan que la maestra llamaba.')!.chunks).toHaveLength(3);
  });

  it('WITH [N]: only the first sentence counts, a later cue keeps the cited sources', () => {
    const partial = 'Las familias valoran la llamada semanal [2]. Los documentos no mencionan el transporte.';
    expect(citedBrowserProvenance(five as never, partial)!.chunks.map((c) => c.chunkId)).toEqual(['d2']);
  });

  it('a title-matched document is still shown under a reworded refusal', () => {
    const out = citedBrowserProvenance(five as never, 'Los textos no tratan París.', { id: '4', name: 'Doc 4' })!;
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['d4']);
  });
});

describe('citedBrowserProvenance — at most 7 sources', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const twelve = { chunks: Array.from({ length: 12 }, (_, i) => doc(i + 1)) };
  const ords = (p: ReturnType<typeof citedBrowserProvenance>) =>
    (p?.chunks ?? []).map((c) => (c as { ordinal?: number }).ordinal);
  const cites12 = 'Uno [12]. Dos [3, 1]. Tres [5]. Cuatro [2, 7, 9]. Cinco [4]. Seis [6, 8]. Siete [10, 11].';

  it('an answer citing 12 shows 7, in citation order', () => {
    expect(MAX_SOURCES).toBe(7);
    expect(ords(citedBrowserProvenance(twelve as never, cites12))).toEqual([12, 3, 1, 5, 2, 7, 9]);
  });

  it('a title-matched document past the cap takes the last slot: still 7', () => {
    const out = citedBrowserProvenance(twelve as never, cites12, { id: '11', name: 'Doc 11' });
    expect(ords(out)).toEqual([12, 3, 1, 5, 2, 7, 11]);
  });

  it('a title-matched document inside the first 7 is not added twice', () => {
    const out = citedBrowserProvenance(twelve as never, cites12, { id: '3', name: 'Doc 3' });
    expect(ords(out)).toEqual([12, 3, 1, 5, 2, 7, 9]);
  });
});

describe('toBrowserMessage', () => {
  it('sanitises the provenance of a persisted message and leaves the rest alone', () => {
    const msg = { id: 3, role: 'assistant', content: 'hola', provenance: { chunks: [assistantChunk, docChunk] } };
    const out = toBrowserMessage(msg);
    expect(out).toMatchObject({ id: 3, role: 'assistant', content: 'hola' });
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Conversación');
  });

  it('leaves a message without provenance unchanged', () => {
    expect(toBrowserMessage({ id: 1, role: 'user', content: 'q' })).toEqual({ id: 1, role: 'user', content: 'q' });
  });
});

// Variant E (`CHAT_CITE_VARIANT=E`). Owner ruling 2026-10-21: "we can still
// have answers, either from the docs, the corpus, or the training weights".
// Source rule, fallback and no-answer guard, designed together.
describe('citedBrowserProvenance — variant E: general knowledge lists no sources', () => {
  const doc = (i: number, score = 0.5) => ({
    ...docChunk,
    chunkId: `d${i}`,
    score,
    metadata: { docId: String(i), title: `Doc ${i}` },
  });
  const five = { chunks: [doc(1, 0.1), doc(2, 0.9), doc(3, 0.5), doc(4, 0.7), doc(5, 0.2)] };
  const ids = (p: ReturnType<typeof citedBrowserProvenance>) => (p?.chunks ?? []).map((c) => c.chunkId);
  const E = (answer: string, titleMatch: { id: string; name: string } | null = null) =>
    citedBrowserProvenance(five as never, answer, titleMatch, 'E');

  it('🔴 off-topic: a general-knowledge answer shows 0 sources', () => {
    expect(E('Fuera de los documentos: la capital de Francia es París.')).toBeNull();
    expect(E('**Fuera de los documentos:** la capital de Francia es París.')).toBeNull();
    expect(E('## Respuesta\n\nFUERA DE LOS DOCUMENTOS — París.')).toBeNull();
  });

  it('🔴 a stray [N] inside the general-knowledge part never becomes a source', () => {
    expect(E('Fuera de los documentos: París es la capital [1, 2, 3, 4, 5].')).toBeNull();
    expect(ids(E('El riego empezó en 2020 [2].\n\nFuera de los documentos: el riego por goteo ahorra agua [4].'))).toEqual([
      'd2',
    ]);
  });

  it('documents first with [N], then general knowledge: only the cited sources', () => {
    const answer = 'Las familias valoran la llamada semanal [3].\n\nFuera de los documentos: suele ayudar a la asistencia.';
    expect(ids(E(answer))).toEqual(['d3']);
  });

  it('a passage-based answer that forgot [N] still gets the top-3 fallback', () => {
    expect(ids(E('El dengue se transmite por mosquitos.'))).toEqual(['d2', 'd4', 'd3']);
  });

  it('🔴 no [N] and a general-knowledge part: no fallback, so general knowledge is never attributed', () => {
    expect(E('Los documentos tratan de salud comunitaria.\n\nFuera de los documentos: París.')).toBeNull();
  });

  it('🔴 a refusal cue counts only in the FIRST sentence', () => {
    // Later "no hablan" keeps the fallback (A would hide it: cue anywhere).
    const later = 'Las familias cuentan que la maestra llamaba. Los documentos no hablan del transporte.';
    expect(opensWithRefusal(later)).toBe(false);
    expect(ids(E(later))).toEqual(['d2', 'd4', 'd3']);
    expect(citedBrowserProvenance(five as never, later, null, 'A')).toBeNull();
    // An opening refusal still lists nothing, with or without [N].
    expect(E('Los documentos no hablan de esto.')).toBeNull();
    expect(E('Los documentos no mencionan París. Tratan de salud [1, 2, 3].')).toBeNull();
    expect(opensWithRefusal('Los textos no tratan París. Pero sí el riego.')).toBe(true);
  });

  it('a title-matched document is still shown: the person named it', () => {
    expect(ids(E('Fuera de los documentos: París.', { id: '4', name: 'Doc 4' }))).toEqual(['d4']);
  });

  it('"fuera de los documentos" in prose, without a colon or dash, is not the lead', () => {
    expect(splitGeneralKnowledge('Lo que pasa fuera de los documentos, nadie lo sabe.').general).toBe(false);
    expect(splitGeneralKnowledge('Afuera de los documentos: no.').general).toBe(false);
    const { documents, general } = splitGeneralKnowledge('Dato [1].\nFuera de los documentos: otro.');
    expect(general).toBe(true);
    expect(documents).toBe('Dato [1].\n');
  });

  it('never lists a conversation turn, and caps at the source limit', () => {
    const p = { chunks: [{ ...assistantChunk }, doc(2)] };
    expect(ids(citedBrowserProvenance(p as never, 'Según [1] y [2].', null, 'E'))).toEqual(['d2']);
    expect(ids(citedBrowserProvenance(p as never, 'Sin marcas.', null, 'E'))).toEqual(['d2']);
  });

  it('A is unchanged: still refuses on a cue anywhere', () => {
    const answer = 'Hay relatos de docentes. Los documentos disponibles no contienen testimonios de familias.';
    expect(citedBrowserProvenance(five as never, answer, null, 'A')).toBeNull();
    expect(ids(E(answer))).toEqual(['d2', 'd4', 'd3']);
  });

  it('🔴 unset CHAT_CITE_VARIANT runs the E source rule', () => {
    const answer = 'Hay relatos de docentes. Los documentos disponibles no contienen testimonios de familias.';
    const saved = testEnv.CHAT_CITE_VARIANT;
    try {
      testEnv.CHAT_CITE_VARIANT = undefined;
      expect(ids(citedBrowserProvenance(five as never, answer))).toEqual(['d2', 'd4', 'd3']);
    } finally {
      testEnv.CHAT_CITE_VARIANT = saved;
    }
  });
});

// Dev A/B 2026-10-22, run 13 (variant E, Discapacidad Q2): "2 [n] groups, 0
// sources". The A/B kept only the first sentence (verbatim below), the group
// count (2) and the length (613 chars); the rest of this answer is rebuilt.
// Root cause: E checked the FIRST sentence for any REFUSAL_CUES cue before
// looking at [N], and "no contienen" is one, so a hedge that went on to answer
// with citations lost every source.
describe('citedBrowserProvenance — variant E: a hedging first sentence keeps its [N] sources', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const six = { chunks: [1, 2, 3, 4, 5, 6].map(doc) };
  const ids = (p: ReturnType<typeof citedBrowserProvenance>) => (p?.chunks ?? []).map((c) => c.chunkId);
  const FIRST =
    'Los documentos no contienen testimonios específicos sobre la experiencia de personas con discapacidad durante su etapa escolar.';
  const run13 =
    `${FIRST} Sí mencionan que algunas familias buscaron escuelas con apoyo para sus hijos y que la ` +
    'distancia a la escuela fue un obstáculo [2]. También cuentan que una promotora acompañaba a niñas ' +
    'y niños con discapacidad a sus consultas y hablaba con sus maestras [4, 5].';

  it('🔴 run 13: the exact first sentence plus 2 [N] groups lists the cited sources', () => {
    expect(ids(citedBrowserProvenance(six as never, run13, null, 'E'))).toEqual(['d2', 'd4', 'd5']);
  });

  it('the first sentence is a refusal cue but not a no-answer reply: the cue path was the culprit', () => {
    expect(opensWithRefusal(run13)).toBe(true);
    expect(isNoAnswer(run13)).toBe(false);
    expect(splitGeneralKnowledge(run13).general).toBe(false);
  });

  // These two pass with or without the fix: they rule the suspects out.
  it('ruled out: grouping formats "[1, 2]", "[1][2]" and "[1] [2]" all map to sources', () => {
    for (const marks of ['[2, 4]', '[2][4]', '[2] [4]', '[2,4]']) {
      expect(ids(citedBrowserProvenance(six as never, `Las familias cuentan algo ${marks}.`, null, 'E'))).toEqual(['d2', 'd4']);
    }
  });

  it('ruled out: ordinals are prompt positions, so [N] opens chunk N even after a dropped turn', () => {
    const p = { chunks: [{ ...assistantChunk }, doc(2), doc(3)] };
    const out = citedBrowserProvenance(p as never, 'Las familias cuentan algo [3].', null, 'E');
    expect(out?.chunks.map((c) => [c.chunkId, (c as { ordinal?: number }).ordinal])).toEqual([['d3', 3]]);
  });

  it('a true no-answer opening with [N] still lists nothing (A\'s rule)', () => {
    expect(citedBrowserProvenance(six as never, 'Los documentos no hablan de esto [1, 2].', null, 'E')).toBeNull();
    expect(citedBrowserProvenance(six as never, 'Los documentos no mencionan París. Tratan de salud [1].', null, 'E')).toBeNull();
  });

  it('without [N], an opening refusal cue still skips the fallback', () => {
    expect(citedBrowserProvenance(six as never, FIRST, null, 'E')).toBeNull();
  });
});
