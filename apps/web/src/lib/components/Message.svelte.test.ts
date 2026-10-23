import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { CHAT_CITE_VARIANT: 'E' } }));

import { render } from 'svelte/server';
import Message from './Message.svelte';
import { citedBrowserProvenance, toBrowserMessage, MAX_SOURCES } from '$lib/server/citationProvenance';
import { citationsWithOrdinals, denseCitations } from '$lib/citationOrdinals';
import { linkCitations } from '$lib/citationLinks';
import type { Message as Msg } from '$lib/types';

/**
 * 🔴 The Discapacidad case measured on dev at 8984fec (runbook edc-1 §4zf,
 * check 4): the answer cites [1]–[8], the 7-source cap (`MAX_SOURCES`) keeps
 * prompt ordinals {1–6, 8}, so the raw payload has no source 7. What the
 * reader sees must still be sources 1..7 with no gap, every marker on its
 * own source, and the uncovered marker gone, on the live final render AND
 * on a reload of the saved message.
 *
 * Markdown renders '' under SSR (DOMPurify needs `window`), so the body is
 * checked through the same `denseCitations` + `linkCitations` the component
 * feeds it, and the source list through the rendered `CitationCard`.
 */

const chunk = (i: number) => ({
  chunkId: `c${i}`,
  documentId: `uuid-${i}`,
  score: 0.9,
  corpus: 'published',
  text: `Pasaje ${i}.`,
  metadata: { docId: String(i), title: `Doc ${i}`, publication: 'published' },
});

const retrieved = { chunks: Array.from({ length: 10 }, (_, i) => chunk(i + 1)) };

// [7] is cited LAST, so the cap drops it; [8] stays. One spaced marker too:
// the engine reads `[ 7 ]` as a citation of 7, so it must be dropped as well.
const ANSWER =
  'Uno [1]. Dos [2]. Tres [3, 4]. Cinco [5][6]. Ocho [8]. Siete [7]. Otra vez [ 7 ] y [8 ].';

/** Source ordinals in the card's "Fuentes consultadas" list, in order. */
function listedOrdinals(body: string): number[] {
  return [...body.matchAll(/citation-source-ord[^>]*>\[(\d+)\]/g)].map((m) => Number(m[1]));
}

/** Titles in the same list, in order. */
function listedTitles(body: string): string[] {
  return [...body.matchAll(/Doc \d+/g)].map((m) => m[0]).filter((t, i, a) => a.indexOf(t) === i);
}

function view(msg: Msg) {
  const { body } = render(Message, { props: { msg } });
  const shown = denseCitations(msg.content, citationsWithOrdinals(msg.provenance ?? null));
  const html = linkCitations(`<p>${shown.content}</p>`, shown.citations.map((c) => c.ordinal));
  return { body, content: shown.content, html };
}

describe('🔴 source numbering: 8 cited markers, 7 shown sources, no source 7', () => {
  const provenance = citedBrowserProvenance(retrieved as never, ANSWER, null, 'E');

  it('the raw payload has the gap (prompt ordinals), capped at MAX_SOURCES', () => {
    expect(MAX_SOURCES).toBe(7);
    expect(provenance?.chunks.map((c) => (c as { ordinal?: number }).ordinal)).toEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  const live: Msg = {
    id: '901',
    role: 'assistant',
    content: ANSWER,
    createdAt: 0,
    pending: false,
    provenance,
  };
  // A reload: the BFF GET returns the saved row through `toBrowserMessage`.
  const saved = toBrowserMessage(JSON.parse(JSON.stringify({ ...live, pending: undefined })));
  const reloaded: Msg = { ...live, ...saved, provenance: saved.provenance };

  for (const [name, msg] of [
    ['live final render', live],
    ['reload of the saved message', reloaded],
  ] as const) {
    describe(name, () => {
      const v = view(msg);

      it('lists sources 1..7, no gap, in [N] order', () => {
        expect(listedOrdinals(v.body)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(listedTitles(v.body)).toEqual(['Doc 1', 'Doc 2', 'Doc 3', 'Doc 4', 'Doc 5', 'Doc 6', 'Doc 8']);
      });

      it('[8] becomes [7] (Doc 8); every [7] with no source is dropped, spaced or not', () => {
        expect(v.content).toBe(
          'Uno [1]. Dos [2]. Tres [3, 4]. Cinco [5][6]. Ocho [7]. Siete. Otra vez y [7].',
        );
      });

      it('every button opens a listed source, and no listed source is unreachable', () => {
        const cited = [...v.html.matchAll(/data-cite="(\d+)"/g)].map((m) => Number(m[1]));
        expect(new Set(cited)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
        expect(v.html).not.toMatch(/\[\s*\d+\s*\](?![^<]*<\/button>)/);
      });
    });
  }

  it('a still-streaming answer lists no sources yet', () => {
    const { body } = render(Message, {
      props: { msg: { ...live, pending: true, provenance: null, content: 'Uno [1]' } },
    });
    expect(listedOrdinals(body)).toEqual([]);
  });
});
