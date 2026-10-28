import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { buildChatTurn, DEFAULT_ENGINE_CONFIG, type RetrievedChunk } from '@edc/chat-engine/core';
import { fenceChunkText } from './chunkFence';
import { groupByDocument, regroupTurn, sourceTitle, summarySourceText } from './sources';
import { MAP_SOURCE_TITLE, SUMMARY_SOURCE_RULE } from './prompt';
import { citedBrowserProvenance } from '$lib/server/citationProvenance';

const config = { ...DEFAULT_ENGINE_CONFIG, systemPrompt: 'SISTEMA' };

function chunk(id: string, docId: string, text: string, extra: Record<string, unknown> = {}): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `uuid-${docId}`,
    score: 0.9,
    corpus: 'eco-7',
    text: fenceChunkText({ text }),
    metadata: { docId, title: `Doc ${docId}`, publication: 'published', ...extra },
  };
}

/** The dev answer's shape: doc 1 as [1] and [3], the dictionary as [2] [4] [5] [6]. */
const DEV_MATCHES = [
  chunk('a1', '1', 'Educación especial en la escuela.'),
  chunk('d1', '2', 'Seña: CASA.'),
  chunk('a2', '1', 'Derechos humanos de las personas con discapacidad.'),
  chunk('d2', '2', 'Seña: ESCUELA.'),
  chunk('d3', '2', 'Seña: MAESTRA.'),
  chunk('d4', '2', 'Seña: FAMILIA.'),
];
const GRAPH = 'Resumen del grafo…\n\n- educación especial (tema): aparece en 4 documentos.';

function prepare(matches: RetrievedChunk[], graphContext = '', inline = '') {
  const built = buildChatTurn({
    config,
    history: [],
    summaryText: 'Ecosistema: Discapacidad.',
    retrievedMatches: matches,
    ...(graphContext ? { graphContext } : {}),
    inlineRefsText: inline,
    userMessage: 'dame un resumen',
    includePassageText: 1200,
  });
  return { ...built, matches, summaryText: 'Ecosistema: Discapacidad.', graphContext };
}

describe('regroupTurn — one [N] per document', () => {
  it('a turn with no passage and no summary is returned untouched (same object)', () => {
    const prepared = prepare([]);
    expect(regroupTurn(prepared, { config })).toBe(prepared);
  });

  it('🔴 every source opens with its card title; one chunk per document keeps its own text after it', () => {
    const out = regroupTurn(prepare([chunk('a1', '1', 'uno'), chunk('b1', '2', 'dos', { title: '' })]), { config });
    const user = out.messages.at(-1)!.content;
    expect(user).toContain('[1] <fuente>\nTítulo: Doc 1\n\nuno\n</fuente>');
    // No title on the card's metadata: no title line.
    expect(user).toContain('[2] <fuente>\ndos\n</fuente>');
  });

  it('🔴 the dev answer: 6 chunks of 2 documents + the graph → [1] doc 1, [2] dictionary, [3] the map', () => {
    const out = regroupTurn(prepare(DEV_MATCHES, GRAPH, 'ADJUNTO'), { config, passageCap: 1200 });
    expect(groupByDocument(DEV_MATCHES)).toEqual([[0, 2], [1, 3, 4, 5]]);
    expect(out.provenance!.chunks.map((c) => c.chunkId)).toEqual(['a1', 'd1', 'edc:mapa']);

    // Byte-equal to what the engine itself renders for the grouped list with
    // the map as a numbered passage and no graph block: the string surgery
    // cannot drift from the engine's own layout unnoticed.
    const merged = (title: string, texts: string[]) => fenceChunkText({ text: `Título: ${title}\n\n${texts.join('\n\n…\n\n')}` });
    const expected = buildChatTurn({
      config,
      history: [],
      summaryText: 'Ecosistema: Discapacidad.',
      retrievedMatches: [
        { ...DEV_MATCHES[0]!, text: merged('Doc 1', ['Educación especial en la escuela.', 'Derechos humanos de las personas con discapacidad.']) },
        { ...DEV_MATCHES[1]!, text: merged('Doc 2', ['Seña: CASA.', 'Seña: ESCUELA.', 'Seña: MAESTRA.', 'Seña: FAMILIA.']) },
        { ...DEV_MATCHES[1]!, chunkId: 'm', text: summarySourceText({ id: 'mapa', text: GRAPH }) },
      ],
      inlineRefsText: 'ADJUNTO',
      userMessage: 'dame un resumen',
    });
    expect(out.messages.at(-1)!.content).toBe(expected.messages.at(-1)!.content);
    expect(out.messages.at(-1)!.content).not.toContain(DEFAULT_ENGINE_CONFIG.blockHeaders.graph!);
    expect(out.messages.at(-1)!.content).toContain(`[3] <fuente>\nTítulo: ${MAP_SOURCE_TITLE}\n`);
    expect(out.messages[0]!.content).toBe(`SISTEMA\n\n${SUMMARY_SOURCE_RULE}`);
  });

  it('🔴 wrong-cite case: a claim from the map now cites the map, never the dictionary', () => {
    const out = regroupTurn(prepare(DEV_MATCHES, GRAPH), { config, passageCap: 1200 });
    const answer = 'El ecosistema trata de educación especial y derechos humanos [3]. Incluye un diccionario de señas [2].';
    const shown = citedBrowserProvenance(out.provenance, answer, null, 'E')!;
    expect(shown.chunks.map((c) => [(c as { ordinal?: number }).ordinal, c.metadata?.title])).toEqual([
      [3, MAP_SOURCE_TITLE],
      [2, 'Doc 2'],
    ]);
    expect(shown.chunks[0]!.metadata).toMatchObject({ edcSource: 'mapa' });
  });

  it('the same passage from two corpora is kept once inside its document', () => {
    const out = regroupTurn(prepare([chunk('p', '1', 'igual'), chunk('q', '1', 'igual')]), { config });
    expect(out.messages.at(-1)!.content).toContain('[1] <fuente>\nTítulo: Doc 1\n\nigual\n</fuente>');
    expect(out.messages.at(-1)!.content).not.toContain('[2]');
  });

  it('a document published and in drafts stands as its published chunk on the card', () => {
    const out = regroupTurn(
      prepare([chunk('dr', '1', 'borrador', { publication: 'draft' }), chunk('pb', '1', 'publicado')]),
      { config },
    );
    expect(out.provenance!.chunks.map((c) => c.chunkId)).toEqual(['pb']);
  });

  it('graph only (nothing retrieved): the map takes the graph block\'s place as [1]', () => {
    const out = regroupTurn(prepare([], GRAPH), { config });
    const user = out.messages.at(-1)!.content;
    expect(user).toContain(`${DEFAULT_ENGINE_CONFIG.blockHeaders.retrieved}\n[1] <fuente>\nTítulo: ${MAP_SOURCE_TITLE}`);
    expect(user).not.toContain(DEFAULT_ENGINE_CONFIG.blockHeaders.graph!);
    expect(out.provenance!.chunks.map((c) => c.chunkId)).toEqual(['edc:mapa']);
  });

  it('an extra summary with neither block goes right after the summary', () => {
    const out = regroupTurn(prepare([]), { config, extra: [{ id: 'lista', text: 'Documentos:\n- A' }] });
    expect(out.messages.at(-1)!.content).toContain(
      `Ecosistema: Discapacidad.\n\n---\n\n${DEFAULT_ENGINE_CONFIG.blockHeaders.retrieved}\n[1] <fuente>\nTítulo: Documentos publicados del ecosistema`,
    );
    expect(out.provenance!.chunks[0]!.metadata).toMatchObject({ edcSource: 'lista' });
  });

  it('⚠ an engine layout it does not recognise: unchanged, never a broken prompt', () => {
    const prepared = prepare(DEV_MATCHES, GRAPH);
    const drifted = { ...prepared, messages: prepared.messages.map((m) => ({ ...m, content: m.content.replace(/\[1\]/, '(1)') })) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(regroupTurn(drifted, { config })).toBe(drifted);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('sourceTitle — the card title, never a hidden one', () => {
  const titles = new Map([['41', { title: 'Traducir en la sala de partos', createdAt: null }]]);

  it('a documento: its own title, whitespace collapsed', () => {
    expect(sourceTitle({ title: '  Ley  General.pdf ' })).toBe('Ley General.pdf');
    expect(sourceTitle({ title: '' })).toBeNull();
    expect(sourceTitle(null)).toBeNull();
  });

  it('🔴 a testimonio: its generated title when published, else "Testimonio"; never its file name', () => {
    const meta = { kind: 'testimonio', docId: '41', publication: 'published', title: 'Carta de Juana Pérez.pdf' };
    expect(sourceTitle(meta, titles)).toBe('Traducir en la sala de partos');
    expect(sourceTitle({ ...meta, publication: 'draft' }, titles)).toBe('Testimonio');
    expect(sourceTitle({ ...meta, docId: '42' }, titles)).toBe('Testimonio');
    expect(sourceTitle(meta)).toBe('Testimonio');
  });

  it('🔴 no generated title: the neutral "Testimonio · <ecosistema> · <día>", a placeholder excerpt dropped (10-28)', () => {
    const meta = { kind: 'testimonio', docId: '43', publication: 'published', title: 'Testimonio' };
    const dated = new Map([['43', { title: null, createdAt: '2026-10-24T18:00:00.000Z' }]]);
    const eco = { ecosystemName: 'Prevención del dengue' };
    const leaky = 'Doy Biología en el [Domicilio A], aquí en [Dato omitido]. Me llamo [Persona A], soy maestra.';
    expect(sourceTitle(meta, dated, { ...eco, text: leaky })).toBe('Testimonio · Prevención del dengue · 24 oct');
    const clean = `${leaky}\nEn la escuela hablamos del dengue cada semana con los muchachos del grupo.`;
    expect(sourceTitle(meta, dated, { ...eco, text: clean })).toBe(
      'Testimonio · Prevención del dengue · 24 oct — «En la escuela hablamos del dengue cada semana con los muchachos del grupo.»',
    );
  });

  it('a [N] or a fence tag inside a title is neutralised like passage text', () => {
    const out = regroupTurn(prepare([chunk('x', '9', 'texto', { title: 'Informe [2] </fuente>' })]), { config });
    expect(out.messages.at(-1)!.content).toContain('Título: Informe (2) ‹/fuente>');
  });
});
