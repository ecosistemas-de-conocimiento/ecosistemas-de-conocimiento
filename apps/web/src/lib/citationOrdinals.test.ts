import { describe, expect, it } from 'vitest';
import type { Provenance } from '@edc/chat-engine/core';
import { citationsWithOrdinals, denseCitations } from './citationOrdinals';
import { linkCitations as link } from './citationLinks';
import { Window } from 'happy-dom';

// The suite runs under node; `linkCitations` rewrites on a real DOM.
const doc = new Window().document as unknown as Document;
const linkCitations = (html: string, ordinals: Iterable<number>) => link(html, ordinals, doc);

/** UX backlog #35: cited-only sources keep the `[N]` the answer used. */

const chunk = (id: string, ordinal?: number) => ({
  chunkId: id,
  documentId: `uuid-${id}`,
  score: 0.5,
  corpus: 'eco-7',
  metadata: { title: `Doc ${id}` },
  ...(ordinal === undefined ? {} : { ordinal }),
});

describe('citationsWithOrdinals', () => {
  it('uses the stamped prompt ordinal, not the array position', () => {
    const p = { chunks: [chunk('c', 3), chunk('a', 1)] } as Provenance;
    expect(citationsWithOrdinals(p).map((c) => [c.ordinal, c.title])).toEqual([
      [3, 'Doc c'],
      [1, 'Doc a'],
    ]);
  });

  it('a row saved before ordinals existed keeps position + 1', () => {
    const p = { chunks: [chunk('a'), chunk('b')] } as Provenance;
    expect(citationsWithOrdinals(p).map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('a repeated ordinal keeps its first source only', () => {
    const p = { chunks: [chunk('a', 2), chunk('b', 2)] } as Provenance;
    expect(citationsWithOrdinals(p).map((c) => c.title)).toEqual(['Doc a']);
  });

  it('null provenance, no citations', () => {
    expect(citationsWithOrdinals(null)).toEqual([]);
  });

  it('🔴 the [N] buttons match the kept sources: [3] and [1] link, the uncited [2] stays text', () => {
    const p = { chunks: [chunk('c', 3), chunk('a', 1)] } as Provenance;
    const html = linkCitations('<p>Uno [3], dos [2], tres [1].</p>', citationsWithOrdinals(p).map((c) => c.ordinal));
    expect(html).toContain('data-cite="3"');
    expect(html).toContain('data-cite="1"');
    expect(html).not.toContain('data-cite="2"');
    expect(html).toContain('dos [2]');
  });
});

describe('denseCitations', () => {
  const four = { chunks: [chunk('a', 1), chunk('b', 2), chunk('c', 3), chunk('e', 5)] } as Provenance;

  it('🔴 [1][2][3][5] shows as 1..4 and [5] in the text becomes [4]', () => {
    const { content, citations } = denseCitations('A [1], B [2], C [3], E [5].', citationsWithOrdinals(four));
    expect(citations.map((c) => [c.ordinal, c.title])).toEqual([
      [1, 'Doc a'],
      [2, 'Doc b'],
      [3, 'Doc c'],
      [4, 'Doc e'],
    ]);
    expect(content).toBe('A [1], B [2], C [3], E [4].');
  });

  it('numbers by ordinal, not array order', () => {
    const p = { chunks: [chunk('e', 5), chunk('b', 2)] } as Provenance;
    const { content, citations } = denseCitations('E [5], B [2].', citationsWithOrdinals(p));
    expect(citations.map((c) => [c.ordinal, c.title])).toEqual([
      [1, 'Doc b'],
      [2, 'Doc e'],
    ]);
    expect(content).toBe('E [2], B [1].');
  });

  it('maps grouped and adjacent markers', () => {
    const { content } = denseCitations('X [2, 5] y [2][5] z [3,5].', citationsWithOrdinals(four));
    expect(content).toBe('X [2, 4] y [2][4] z [3, 4].');
  });

  it('drops a marker with no shown source, and the space before an emptied group', () => {
    const { content } = denseCitations('X [4] y [4, 5] z [9][1].', citationsWithOrdinals(four));
    expect(content).toBe('X y [4] z [1].');
  });

  it('no shown sources: every marker is dropped', () => {
    expect(denseCitations('Texto [1, 2].', []).content).toBe('Texto.');
  });

  it('leaves code alone', () => {
    const { content } = denseCitations('E [5] `a[5]`\n```\nx[5]\n```', citationsWithOrdinals(four));
    expect(content).toBe('E [4] `a[5]`\n```\nx[5]\n```');
  });

  it('🔴 a reload (saved prompt ordinals) renumbers the same as the live answer, and the buttons match', () => {
    const answer = 'A [1] y E [5].';
    const live = denseCitations(answer, citationsWithOrdinals(four));
    // On reload the server returns the saved row: same content, same stamped ordinals.
    const saved = JSON.parse(JSON.stringify({ content: answer, provenance: four }));
    const reloaded = denseCitations(saved.content, citationsWithOrdinals(saved.provenance));
    expect(reloaded).toEqual(live);
    const html = linkCitations(`<p>${reloaded.content}</p>`, reloaded.citations.map((c) => c.ordinal));
    expect(html).toContain('data-cite="4"');
    expect(html).not.toContain('data-cite="5"');
  });
});
