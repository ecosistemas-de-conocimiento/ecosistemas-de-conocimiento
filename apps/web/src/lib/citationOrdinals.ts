/**
 * Provenance → the citation card's `CitationLike[]`, keeping each source's
 * PROMPT ordinal (UX backlog #35).
 *
 * The engine's `provenanceToCitations` numbers sources by array position. Chat
 * now saves only the sources an answer cites, each stamped with the `[N]` the
 * model wrote (`$lib/server/citationProvenance`). Renumbering them 1..k would
 * make `[3]` in the answer open the wrong source, or none. So the stamped
 * `ordinal` wins; a row saved before it existed keeps position + 1, which is
 * what it meant then. `linkCitations` (`$lib/citationLinks`) turns exactly
 * these ordinals into buttons.
 *
 * A repeated ordinal keeps its first source, so the card's keyed lists stay
 * valid even on a malformed row.
 */
import { provenanceToCitations, type CitationLike, type Provenance } from '@edc/chat-engine/core';

export function citationsWithOrdinals(provenance: Provenance | null | undefined): CitationLike[] {
  const chunks = provenance?.chunks ?? [];
  const seen = new Set<number>();
  const out: CitationLike[] = [];
  provenanceToCitations(provenance).forEach((c, i) => {
    const stamped = (chunks[i] as { ordinal?: unknown } | undefined)?.ordinal;
    const ordinal =
      typeof stamped === 'number' && Number.isInteger(stamped) && stamped > 0 ? stamped : c.ordinal;
    if (seen.has(ordinal)) return;
    seen.add(ordinal);
    out.push({ ...c, ordinal });
  });
  return out;
}
