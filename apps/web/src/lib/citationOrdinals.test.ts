import { describe, expect, it } from 'vitest';
import type { Provenance } from '@edc/chat-engine/core';
import { citationsWithOrdinals } from './citationOrdinals';
import { linkCitations } from './citationLinks';

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
