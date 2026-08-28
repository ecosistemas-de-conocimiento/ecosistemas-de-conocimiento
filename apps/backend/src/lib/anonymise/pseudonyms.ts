/**
 * PSEUDONYMS — the thing a person's name becomes, and the reason that thing is
 * deliberately forgotten the moment the document is done.
 *
 * ── 🔴 THE MAP LIVES FOR ONE DOCUMENT AND IS NEVER PERSISTED ─────────────────
 *
 * `createPseudonymAllocator()` returns a closure over a plain in-memory `Map`.
 * It is created per document, thrown away with the request, and written to no
 * database, no log line and no {@link import('./types').GateReport}.
 *
 * That is not an implementation detail we could tighten later — it is the
 * safety property itself, and it has two halves:
 *
 *   · A STORED MAP IS A RE-IDENTIFICATION MAP. `"María López" → "[Persona A]"`
 *     is precisely the table an attacker needs to undo the anonymisation. A
 *     redacted corpus plus that table is worse than never redacting, because
 *     everyone downstream now believes the text is safe.
 *   · STABLE PSEUDONYMS ACROSS DOCUMENTS RE-IDENTIFY WITHOUT ANY TABLE AT ALL.
 *     If "Persona A" meant the same human in every testimony, a reader could
 *     follow them across the corpus — this one resigned in March, that one runs
 *     the clinic, the third has a sister in Oaxaca — and assemble a profile from
 *     behaviour alone. Names are the obvious identifier; a stable handle across
 *     a corpus is the quiet one, and it *looks* anonymised.
 *
 * So the labels are stable WITHIN a document (otherwise the text stops making
 * sense — "[Persona A] told [Persona B]" has to hold across two paragraphs) and
 * deliberately meaningless BETWEEN documents. Two testimonies naming the same
 * woman both call her `[Persona A]` only by coincidence of ordering.
 *
 * ── WHY MATCHING IS NORMALISED RATHER THAN EXACT ─────────────────────────────
 *
 * ⚠ A testimony is transcribed speech. The same person shows up as
 * "María López", "maria lopez" and "MARÍA  LÓPEZ" (double space, shouted by the
 * transcriber's caps lock) in one file. Exact-match keying would hand those
 * three `[Persona A]`, `[Persona B]` and `[Persona C]`, which reads as three
 * different people — a redaction that CORRUPTS the testimony instead of
 * protecting it. Case-folding, accent-folding and whitespace collapse are what
 * keep the anonymised text true to the original.
 *
 * ⚠ The normalisation is one-way and lossy on purpose: it exists to bucket
 * variants, never to reconstruct the original spelling. Nothing here can be run
 * backwards.
 */

import { PERSON_PLACEHOLDER_PREFIX } from './types'

/** Alphabet for the label suffix. After `Z` it rolls over to `AA`, `AB`, … */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * `0 → A`, `25 → Z`, `26 → AA`, `27 → AB`, …
 *
 * ⚠ This is a bijective base-26 numeral (spreadsheet columns), NOT plain
 * base-26. Plain base-26 would emit `BA` after `Z` because it has no digit for
 * "nothing", which is a cosmetic bug in a report but a confusing one to debug at
 * document 27 of a long transcript.
 */
function labelSuffix(index: number): string {
  let n = index
  let out = ''
  do {
    out = LETTERS[n % 26] + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Fold a name to its bucket key: lower-cased, accent-stripped, whitespace
 * collapsed.
 *
 * ⚠ NFD + combining-mark strip, not a hand-written á→a table. A hand table
 * always misses one — `ñ`, `ü`, `Í` — and the miss shows up as a duplicate
 * person in exactly the documents that matter most.
 */
export function normaliseName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export interface PseudonymAllocator {
  /** The label for this name in THIS document. Stable within it, only within it. */
  labelFor(name: string): string
  /** How many distinct people have been labelled so far. Goes in the report. */
  readonly count: number
}

/**
 * A fresh allocator. 🔴 Call this ONCE PER DOCUMENT and let it be garbage
 * collected — see the header. Reusing one across documents would manufacture
 * exactly the cross-document stability this design exists to prevent.
 */
export function createPseudonymAllocator(): PseudonymAllocator {
  const assigned = new Map<string, string>()

  return {
    labelFor(name: string): string {
      const key = normaliseName(name)
      const existing = assigned.get(key)
      if (existing !== undefined) return existing
      // Built from the constant in `types.ts` so the gate's "is this string one of
      // OUR placeholders?" check in stage 4 can never drift out of step with the
      // strings this allocator actually emits.
      const label = `${PERSON_PLACEHOLDER_PREFIX}${labelSuffix(assigned.size)}]`
      assigned.set(key, label)
      return label
    },
    get count(): number {
      return assigned.size
    },
  }
}
