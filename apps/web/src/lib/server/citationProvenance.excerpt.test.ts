/**
 * Chat sources for a testimonio (owner ruling 2026-10-23): "Testimonio ·
 * <ecosistema>" plus an excerpt cut SERVER-side from the chunk's own passage,
 * which in the `published` corpus is the gate's redacted text.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { CHAT_CITE_VARIANT: 'A' } }));
import { citedBrowserProvenance, toBrowserMessage, toBrowserProvenance } from './citationProvenance';
import { citationsWithOrdinals } from '$lib/citationOrdinals';
import { chatSourceTitle } from '$lib/biblioteca';

const voz = {
  chunkId: 'v1',
  documentId: 'uuid-5',
  score: 0.8,
  corpus: 'eco-7',
  text: 'P: Aquella mañana en Cuautla [Persona A] me enseñó a curar con hierbas del monte.\nMás texto.',
  metadata: { docId: '5', kind: 'testimonio', publication: 'published', title: 'Testimonio', format: 'audio' },
};

const doc = {
  chunkId: 'd1',
  documentId: 'uuid-9',
  score: 0.7,
  corpus: 'eco-7',
  text: 'El informe dice que el agua llegó tarde a todas las colonias del municipio.',
  metadata: { docId: '9', kind: 'documento', publication: 'published', title: 'informe.pdf' },
};

function meta(p: ReturnType<typeof toBrowserProvenance>, i = 0) {
  return p!.chunks[i]!.metadata as Record<string, unknown>;
}

describe('testimonio chat source', () => {
  it('carries an excerpt from the published passage, speaker label dropped', () => {
    const m = meta(toBrowserProvenance({ chunks: [voz] }));
    expect(m.title).toBe('Testimonio');
    expect(m.excerpt).toBe('Aquella mañana en Cuautla [Persona A] me enseñó a curar con hierbas del monte.');
  });

  it('🔴 a draft-corpus testimonio chunk gets no excerpt (may be unredacted)', () => {
    const draft = { ...voz, metadata: { ...voz.metadata, publication: 'draft' } };
    expect(meta(toBrowserProvenance({ chunks: [draft] })).excerpt).toBeUndefined();
  });

  it('🔴 a testimonio is titled "Testimonio" even if its metadata says otherwise', () => {
    const named = { ...voz, metadata: { ...voz.metadata, title: 'Voz de Juana Pérez.m4a' } };
    const out = toBrowserProvenance({ chunks: [named] });
    expect(meta(out).title).toBe('Testimonio');
    expect(JSON.stringify(out)).not.toContain('Juana');
  });

  it('a documento source is unchanged: own title, no excerpt', () => {
    const m = meta(toBrowserProvenance({ chunks: [doc] }));
    expect(m.title).toBe('informe.pdf');
    expect(m.excerpt).toBeUndefined();
  });

  it('🔴 a documento PDF titled "Testimonio" gets no excerpt and no testimonio label', () => {
    const pdf = { ...doc, metadata: { ...doc.metadata, title: 'Testimonio' } };
    const out = toBrowserProvenance({ chunks: [pdf] });
    expect(meta(out).excerpt).toBeUndefined();
    expect(meta(out).kind).toBeUndefined();
    const [c] = citationsWithOrdinals(out);
    expect(chatSourceTitle(c!.title, c!.metadata, 'Discapacidad')).toBe('Testimonio');
  });

  it('a turn saved before `kind` was kept: title stays, no excerpt', () => {
    const legacy = { ...voz, metadata: { docId: '5', publication: 'published', title: 'Testimonio' } };
    const m = meta(toBrowserProvenance({ chunks: [legacy] }));
    expect(m.title).toBe('Testimonio');
    expect(m.excerpt).toBeUndefined();
  });

  it('`kind` leaves only as "testimonio"', () => {
    expect(meta(toBrowserProvenance({ chunks: [voz] })).kind).toBe('testimonio');
    expect(meta(toBrowserProvenance({ chunks: [doc] })).kind).toBeUndefined();
  });

  it('never trusts a stored excerpt: it is recomputed from the passage', () => {
    const forged = { ...doc, metadata: { ...doc.metadata, excerpt: 'Juana Pérez' } };
    expect(JSON.stringify(toBrowserProvenance({ chunks: [forged] }))).not.toContain('Juana');
  });

  it('survives the save → read round trip (persisted provenance)', () => {
    const saved = citedBrowserProvenance({ chunks: [voz, doc] } as never, 'Respuesta [1] y [2].');
    const read = toBrowserMessage({ id: 'm1', provenance: saved });
    const cites = citationsWithOrdinals(read.provenance as never);
    const titles = cites.map((c) => chatSourceTitle(c.title, c.metadata, 'Discapacidad'));
    expect(titles).toEqual([
      'Testimonio · Discapacidad — «Aquella mañana en Cuautla [Persona A] me enseñó a curar con hierbas del monte.»',
      'informe.pdf',
    ]);
  });
});
