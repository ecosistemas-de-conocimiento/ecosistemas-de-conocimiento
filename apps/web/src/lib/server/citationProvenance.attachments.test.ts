import { describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => ({
  CHAT_CITE_VARIANT: undefined as string | undefined,
  CHAT_FALLBACK_MIN_RERANK: undefined as string | undefined,
}));
vi.mock('$env/dynamic/private', () => ({ env: testEnv }));

import { citedBrowserProvenance, MAX_SOURCES, toBrowserProvenance } from './citationProvenance';
import type { TurnAttachment } from './titleMatch';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import { NO_ANSWER_REPLY } from '$lib/server/engine/prompt';
import { citationsWithOrdinals, denseCitations } from '$lib/citationOrdinals';
import { chatCitationHref } from '$lib/engine/client';

/**
 * Owner ruling 2026-10-24 (direct): a document attached to a turn gets a
 * source card when the answer uses it without citing. Attached = it rode the
 * prompt fenced `<fuente tipo="adjunto">`, with no number (1284a13): an
 * `@`-mention, the title-named document, a pinned upload.
 *
 * "Uses it" (`usedAttachments`):
 *   · the person named it this turn (`named`): always, as the title match
 *     already was (owner's overnight rule 2026-10-21);
 *   · a pinned document: when the answer names its title, outside a
 *     no-answer, a refusal opening, or an all-general-knowledge answer.
 */

const chunk = (i: number, extra: Record<string, unknown> = {}) => ({
  chunkId: `c${i}`,
  documentId: `uuid-${i}`,
  score: 0.5,
  corpus: 'eco-7',
  text: `Pasaje ${i}.`,
  metadata: { docId: String(i), title: `Doc ${i}`, publication: 'published' },
  ...extra,
});
const three = { chunks: [chunk(1), chunk(2), chunk(3)] };

const pinned = (over: Partial<TurnAttachment> = {}): TurnAttachment => ({
  id: '266',
  name: 'nota de voz.webm',
  contentKind: 'documento',
  publication: 'draft',
  named: false,
  ...over,
});

type Out = ReturnType<typeof citedBrowserProvenance>;
const rows = (p: Out) =>
  (p?.chunks ?? []).map((c) => [(c as { ordinal?: number }).ordinal, c.metadata?.docId]);

describe('citedBrowserProvenance — an attachment the answer uses gets a card', () => {
  it('🔴 a pinned upload the answer names, with no [N]: a card past every prompt ordinal', () => {
    const answer = 'Según la nota de voz, la milpa se siembra en mayo.';
    const out = citedBrowserProvenance({ chunks: [] } as never, answer, [pinned()], 'E')!;
    expect(rows(out)).toEqual([[1, '266']]);
    expect(out.chunks[0]!.metadata).toMatchObject({
      title: 'nota de voz.webm',
      publication: 'draft',
      [DRAFT_PROVENANCE_FLAG]: true,
    });
    // A draft has no excerpt and no passage, and no library link.
    expect(out.chunks[0]!.text).toBeUndefined();
    expect(out.chunks[0]!.metadata).not.toHaveProperty('excerpt');
    expect(chatCitationHref(citationsWithOrdinals(out)[0]!)).toBeNull();
  });

  it('the file name with its extension counts too, any case and accents', () => {
    const answer = 'El archivo NOTA DE VOZ.WEBM dice que la milpa se siembra en mayo.';
    expect(rows(citedBrowserProvenance(null, answer, [pinned()], 'E'))).toEqual([[1, '266']]);
  });

  it('🔴 a pinned upload the answer does NOT name gets no card (it rides every turn)', () => {
    const answer = 'El dengue se transmite por mosquitos [1].';
    expect(rows(citedBrowserProvenance(three as never, answer, [pinned()], 'E'))).toEqual([[1, '1']]);
  });

  it('🔴 cited sources first, dense 1..n as before; the attachment after, never renumbering a marker', () => {
    const answer = 'La milpa se siembra en mayo [3], según la nota de voz y otro texto [1].';
    const out = citedBrowserProvenance(three as never, answer, [pinned()], 'E')!;
    expect(rows(out)).toEqual([[3, '3'], [1, '1'], [4, '266']]);
    const dense = denseCitations(answer, citationsWithOrdinals(out));
    expect(dense.content).toBe('La milpa se siembra en mayo [2], según la nota de voz y otro texto [1].');
    expect(dense.citations.map((c) => [c.ordinal, c.title])).toEqual([
      [1, 'Doc 1'],
      [2, 'Doc 3'],
      [3, 'nota de voz.webm'],
    ]);
  });

  it('🔴 dedupe: an attachment also cited as a retrieved passage shows once, as the cited source', () => {
    const p = { chunks: [chunk(1), chunk(266, { corpus: 'eco-7-draft-1' })] };
    const out = citedBrowserProvenance(p as never, 'Según la nota de voz, en mayo [2].', [pinned()], 'E')!;
    expect(rows(out)).toEqual([[2, '266']]);
    expect(out.chunks[0]!.text).toBe('Pasaje 266.');
  });

  it('an attachment retrieved but not cited: its passage, with an ordinal past every prompt chunk', () => {
    const p = { chunks: [chunk(1), chunk(266)] };
    const out = citedBrowserProvenance(p as never, 'Dato [1]. La nota de voz lo confirma.', [pinned()], 'E')!;
    expect(rows(out)).toEqual([[1, '1'], [3, '266']]);
    expect(out.chunks[1]!.text).toBe('Pasaje 266.');
  });

  it.each([
    ['the no-answer reply', `${NO_ANSWER_REPLY} La nota de voz habla de otra cosa.`],
    ['a refusal opening', 'Los documentos no hablan de París; la nota de voz trata de la milpa.'],
    ['an all-general-knowledge answer', 'Fuera de los documentos: París es la capital, no la nota de voz.'],
  ])('🔴 %s: no card for a pinned upload, even when it names it', (_label, answer) => {
    expect(citedBrowserProvenance(three as never, answer, [pinned()], 'E')).toBeNull();
  });

  it('a title named only inside the general-knowledge part does not count', () => {
    const answer = 'La milpa se siembra en mayo [1]. Fuera de los documentos: la nota de voz es un formato.';
    expect(rows(citedBrowserProvenance(three as never, answer, [pinned()], 'E'))).toEqual([[1, '1']]);
  });

  it('🔴 a document the person named this turn (@-mention, title match) shows even on a refusal', () => {
    const named = pinned({ named: true });
    expect(rows(citedBrowserProvenance(three as never, NO_ANSWER_REPLY, [named], 'E'))).toEqual([[4, '266']]);
    expect(rows(citedBrowserProvenance(three as never, 'La milpa crece.', [named], 'A'))).toEqual([
      [1, '1'],
      [2, '2'],
      [3, '3'],
      [4, '266'],
    ]);
  });

  it('🔴 every [N] matches nothing: no RETRIEVED source; a used attachment still shows', () => {
    // Variant A: an answer whose markers all point past the end lists nothing…
    expect(citedBrowserProvenance(three as never, 'Dato [9].', null, 'A')).toBeNull();
    // …and the attachment's card does not depend on markers.
    const out = citedBrowserProvenance(three as never, 'Dato [9], según la nota de voz.', [pinned()], 'A');
    expect(rows(out)).toEqual([[4, '266']]);
    expect(rows(citedBrowserProvenance(three as never, 'Dato [9].', [pinned({ named: true })], 'E'))).toEqual([
      [4, '266'],
    ]);
  });

  it('a short or one-word title never matches prose ("Acta", a testimonio label)', () => {
    const acta = pinned({ name: 'Acta.pdf' });
    const testimonio = pinned({ name: 'Testimonio', contentKind: 'testimonio' });
    const answer = 'El acta dice que el testimonio de la comunidad fue leído.';
    expect(citedBrowserProvenance(null, answer, [acta, testimonio], 'E')).toBeNull();
  });

  it('🔴 a testimonio attachment: no draft passage, titled "Testimonio", no name, no excerpt', () => {
    const t = pinned({ id: '41', name: 'Testimonio', contentKind: 'testimonio', named: true, publication: 'published' });
    const draftChunk = chunk(41, {
      text: 'ORIGINAL Juana',
      corpus: 'eco-7-draft-1',
      metadata: { docId: '41', title: 'Carta de Juana', kind: 'testimonio', publication: 'draft' },
    });
    const out = citedBrowserProvenance({ chunks: [draftChunk] } as never, 'Cuenta su llegada.', [t], 'E')!;
    expect(rows(out)).toEqual([[2, '41']]);
    expect(out.chunks[0]!.metadata).toMatchObject({ title: 'Testimonio', publication: 'published' });
    expect(JSON.stringify(out)).not.toMatch(/Juana/);
  });

  it('a published attachment card links to the library', () => {
    const pub = pinned({ id: '31', name: 'Diagnóstico Comunitario de Salud.pdf', publication: 'published' });
    const out = citedBrowserProvenance(null, 'El Diagnóstico Comunitario de Salud cuenta 3 brotes.', [pub], 'E');
    expect(chatCitationHref(citationsWithOrdinals(out)[0]!)).toBe('/biblioteca/31');
  });

  it('two attachments with the same id show once; the cap is still MAX_SOURCES', () => {
    const many = { chunks: Array.from({ length: 10 }, (_, i) => chunk(i + 1)) };
    const cites = 'A [1]. B [2]. C [3]. D [4]. E [5]. F [6]. G [7]. H [8].';
    const named = (id: string) => pinned({ id, name: `Adjunto ${id}`, named: true });
    const out = citedBrowserProvenance(many as never, cites, [named('90'), named('90'), named('91')], 'E');
    expect(rows(out)).toEqual([[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [11, '90'], [12, '91']]);
    expect(out!.chunks).toHaveLength(MAX_SOURCES);
  });

  it('an attachment whose cited chunk the cap trims comes back as a card, keeping its [N]', () => {
    const many = { chunks: Array.from({ length: 10 }, (_, i) => chunk(i + 1)) };
    const cites = 'A [1]. B [2]. C [3]. D [4]. E [5]. F [6]. G [7].';
    const out = citedBrowserProvenance(many as never, cites, [
      pinned({ id: '7', name: 'Doc 7', named: true }),
      pinned({ id: '90', name: 'Adjunto 90', named: true }),
    ], 'E');
    expect(rows(out)).toEqual([[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [7, '7'], [12, '90']]);
  });

  it('a cited answer keeps its first cited source, however many attachments', () => {
    const named = Array.from({ length: 8 }, (_, i) => pinned({ id: String(90 + i), name: `Adjunto ${i}`, named: true }));
    const out = citedBrowserProvenance(three as never, 'Dato [2].', named, 'E')!;
    expect(out.chunks).toHaveLength(MAX_SOURCES);
    expect(rows(out)[0]).toEqual([2, '2']);
  });

  it('🔴 reload: the saved cards survive the browser allowlist unchanged', () => {
    const out = citedBrowserProvenance(three as never, 'Dato [1], según la nota de voz.', [pinned()], 'E');
    expect(toBrowserProvenance(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
});
