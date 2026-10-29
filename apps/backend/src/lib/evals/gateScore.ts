/**
 * PRIVACY-GATE SCORER for the evals dashboard. A TypeScript port of the Q24
 * scorer (`scripts/measurements/q24/score.py`), with one rule made stricter.
 *
 *   · a PRIVATE term (must leave the text) LEAKS when any whole-word occurrence
 *     survives. Q24 counted a term "kept" only when every occurrence survived;
 *     for a leak, one survivor is already a leak.
 *   · a PUBLIC term (must stay) is HIDDEN when fewer whole-word occurrences
 *     survive than the input had — Q24's `count_out >= count_in`, inverted.
 *   · a term the input does not contain is `absent`: it scores nothing and the
 *     item should be fixed.
 *
 * Whole word = not preceded or followed by a letter or a digit (the measurement script's
 * `count` checks letters only; a digit too here, so "Fresno 18" is not found in
 * "Fresno 180"), case-sensitive like Q24.
 *
 * 🔴 A HELD run is not published, so nothing in it leaks: the caller scores
 * only a `ready` result and reports a hold as a hold.
 */

export type GateTermClass = 'privado' | 'publico'

export interface GateTermVerdict {
  term: string
  cls: GateTermClass
  /** Occurrences in the input. */
  before: number
  /** Occurrences in the gate's output. */
  after: number
  /** `true` = the gate did the right thing for this term. `null` = absent from the input. */
  ok: boolean | null
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-word occurrences of `term` in `hay`. */
export function countTerm(hay: string, term: string): number {
  if (!term) return 0
  return hay.split(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'u')).length - 1
}

export function scoreGateTerms(
  input: string,
  output: string,
  privateNames: readonly string[],
  publicNames: readonly string[],
): GateTermVerdict[] {
  const one = (term: string, cls: GateTermClass): GateTermVerdict => {
    const before = countTerm(input, term)
    const after = countTerm(output, term)
    const ok = before === 0 ? null : cls === 'privado' ? after === 0 : after >= before
    return { term, cls, before, after, ok }
  }
  return [...privateNames.map((t) => one(t, 'privado')), ...publicNames.map((t) => one(t, 'publico'))]
}
