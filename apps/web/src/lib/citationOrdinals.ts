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

/**
 * Number the SHOWN sources 1..n in display order and rewrite the answer's
 * `[N]` markers to match.
 *
 * The prompt ordinals above are sparse: a source can be dropped (a
 * conversation turn, past `MAX_SOURCES`, a marker past the end) or never
 * cited, so a 4-source answer listed [1][2][3][5]. The reader now sees 1..n,
 * and every marker still opens the source it named before.
 *
 * Groups (`[2, 5]`) and runs (`[2][5]`) map number by number. A number with no
 * shown source is dropped; a group left empty is removed with the spaces
 * before it. Inline and fenced code are left alone.
 *
 * 🔴 SAME MARKER PATTERN AS THE SERVER. The engine's `parseCitedOrdinals`
 * (packages/chat-engine `core/relevance.ts`) reads `[ 7 ]` and `[7 ]` as a
 * citation of 7, so the server saves a source for them. This regex once
 * required no inner spaces: a `[ 7 ]` whose source was capped away stayed in
 * the text, raw, beside the dense `[7]` of another source. Kept in step on
 * purpose; {@link CITATION_MARKER} is the one copy the browser uses.
 *
 * Display-only: the saved answer and provenance keep prompt ordinals, so a
 * reload renumbers the same way.
 */
/** One `[N]` / `[N, M]` marker, inner spaces allowed. Group 1 is the digits. */
export const CITATION_MARKER = String.raw`\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]`;
const MARKER_RE = new RegExp(`[ \\t]*${CITATION_MARKER}`, 'g');
const CODE_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

export function denseCitations<T extends CitationLike>(
  content: string,
  citations: readonly T[],
): { content: string; citations: T[] } {
  const shown = [...citations].sort((a, b) => a.ordinal - b.ordinal);
  const map = new Map(shown.map((c, i) => [c.ordinal, i + 1]));
  const out = shown.map((c, i) => ({ ...c, ordinal: i + 1 }));
  if (!content) return { content, citations: out };
  const rewritten = content
    .split(CODE_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(MARKER_RE, (whole: string, group: string, at: number, all: string) => {
            const kept = group
              .split(',')
              .map((d) => map.get(Number(d.trim())))
              .filter((n): n is number => n !== undefined);
            const lead = whole.slice(0, whole.indexOf('['));
            // An emptied group keeps its space only when another marker follows it.
            if (kept.length === 0) return all[at + whole.length] === '[' ? lead : '';
            return `${lead}[${kept.join(', ')}]`;
          }),
    )
    .join('');
  return { content: rewritten, citations: out };
}
