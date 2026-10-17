// Outbound passage-text bound — ai-service guaranteeing its OWN chunk-size
// contract at the retrieve surface.
//
// The problem this closes: ingestion targets `chunk_size` tokens per chunk
// (`maxChunkChars`), but nothing enforced that bound on the way OUT. Retrieval
// returned `chunks.text` verbatim, so three classes of row could hand a
// consumer unbounded text:
//
//   1. rows ingested before the chunker had limits,
//   2. rows hand-inserted by a script or a migration,
//   3. a future ingester bug.
//
// Consumers were re-policing this defensively (chat trims retrieved passages
// before prompting). That is the wrong layer: a producer that publishes a
// contract has to honour it, otherwise every consumer pays for the same
// guarantee and each one guesses a different number.
//
// The bound is DERIVED, never re-declared: `maxChunkChars(corpus.chunkSize)` is
// the same function the ingester's splitters reach, so the in-bound and
// out-bound limits cannot drift apart.
//
// NON-BREAKING BY CONSTRUCTION: clamping only ever SHORTENS a passage. A
// consumer that could handle the old (unbounded) text can handle a prefix of
// it, and today's consumers already trim harder than this on their own side.

import { maxChunkChars } from './chunk.js';

/** Minimal logger seam — structurally compatible with Fastify's `app.log`. */
export interface PassageBoundLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Identifiers carried into the warn so an anomalous row can actually be found
 * and investigated. Without these the warn would say "something was too long"
 * and nobody could act on it.
 */
export interface PassageIdentity {
  corpusId: string;
  /** The corpus NAME as the caller asked for it (may be an alias). */
  corpus?: string;
  documentId: string;
  chunkId: string;
  ordinal: number;
}

/**
 * Truncate `text` to `maxChars` when — and only when — it exceeds the bound.
 *
 * Returns the input by REFERENCE when it is within bounds, so a normal chunk
 * passes through byte-identical (same string, not a copy).
 *
 * When the clamp fires it logs at `warn` with the document/chunk identifiers.
 * That log is the point of the feature as much as the truncation is: a stored
 * chunk longer than the ingestion maximum means one of the three anomalies
 * above is real in this database, and the warn is how it becomes visible
 * instead of silently reaching a consumer's prompt.
 *
 * Truncation is by UTF-16 code unit (`String.prototype.slice`), exactly as the
 * ingester's own hard-split is — matching the producer's units is what makes
 * "exactly the bound" mean the same thing on both sides.
 */
export function clampPassageText(
  text: string,
  maxChars: number,
  identity: PassageIdentity,
  logger?: PassageBoundLogger,
): string {
  if (text.length <= maxChars) return text;
  logger?.warn(
    {
      ...identity,
      storedChars: text.length,
      maxChars,
      overBy: text.length - maxChars,
    },
    'retrieve: stored chunk exceeds the ingestion chunk-size bound; truncating. ' +
      'This row was not produced by the current ingester — investigate it.',
  );
  return text.slice(0, maxChars);
}

/**
 * The outbound bound for one corpus: its own `chunk_size` in characters.
 *
 * Per-corpus rather than a single global 3,200: `corpora.chunk_size` is a
 * column (default 800, settable up to 100,000), so a corpus configured for
 * larger chunks would have every result truncated by a global constant. The
 * bound a corpus is held to is the one IT declared.
 */
export function corpusPassageBound(corpus: { chunkSize?: number | null }): number {
  return maxChunkChars(corpus.chunkSize ?? undefined);
}
