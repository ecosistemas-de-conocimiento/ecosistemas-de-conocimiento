import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CitationCard from './CitationCard.svelte';
import type { CitationLike } from '@edc/chat-engine/core';

/**
 * Decision D1 (0.6.0): the citation card renders NO relevance number, in either
 * app. `CitationLike.score` is data only — its scale depends on the retrieve
 * mode: cosine (0.55 → "55%") in dense mode, an RRF value (0.04 → "4%") in
 * hybrid mode, a cross-encoder sigmoid under rerank. A hybrid passage the model
 * rightly cited read as "4%" relevant.
 *
 * Asserted on the server-rendered markup, both surfaces: the expanded card and
 * the source list. The deprecated `labels.relevance` is still passed, so a
 * consumer that has not dropped it yet keeps compiling and shows nothing.
 */

const labels = {
  sourcesTitle: 'Fuentes consultadas',
  openSource: 'Abrir documento',
  relevance: 'Relevancia',
  untitledSource: 'Fuente sin título',
};

const citations: CitationLike[] = [
  { ordinal: 1, title: 'Reglamento de tránsito', passageText: 'Artículo 12. Velocidad máxima.', score: 0.04 },
  { ordinal: 2, title: 'Plan municipal', passageText: 'Eje 3. Movilidad.', score: 0.55 },
];

function renderCard(): string {
  return render(CitationCard, {
    props: { citations, labels, initiallyExpanded: [1, 2], idSeed: 'm1' },
  }).body;
}

/** Visible text only: drop tags and comments, so attribute values cannot match. */
function textOf(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ');
}

describe('CitationCard renders no relevance number (D1)', () => {
  it('shows no "Relevancia" label and no percentage, at score 0.04 and 0.55', () => {
    const html = renderCard();
    expect(html).not.toContain('Relevancia');
    expect(textOf(html)).not.toMatch(/\d+\s*%/);
  });

  it('still renders title, passage and ordinal on the card and in the source list', () => {
    const html = renderCard();
    const text = textOf(html);
    // Both cards are expanded: each passage is quoted once.
    expect(html.match(/data-testid="citation-card"/g)).toHaveLength(2);
    expect(text).toContain('Artículo 12. Velocidad máxima.');
    expect(text).toContain('Eje 3. Movilidad.');
    // Title + ordinal appear on the card head AND in the source list.
    expect(text.match(/Reglamento de tránsito/g)).toHaveLength(2);
    expect(text.match(/Plan municipal/g)).toHaveLength(2);
    expect(text.match(/\[1\]/g)).toHaveLength(2);
    expect(text.match(/\[2\]/g)).toHaveLength(2);
  });

  it('renders without the deprecated label at all', () => {
    const { relevance: _dropped, ...withoutRelevance } = labels;
    const html = render(CitationCard, {
      props: { citations, labels: withoutRelevance, initiallyExpanded: [1] },
    }).body;
    expect(textOf(html)).toContain('Artículo 12. Velocidad máxima.');
    expect(textOf(html)).not.toMatch(/\d+\s*%/);
  });
});
