/**
 * Text normalisation for MECHANICAL scoring.
 *
 * 🔴 THIS FILE IS THE INSTRUMENT. Everything the evaluation claims rests on
 * `contains()` being a fair test of "did the answer name this fact". It is
 * deliberately dumb — accent-folded, case-folded, quote-normalised substring
 * matching — because the alternative (an LLM judge) would be a model grading a
 * graph built by the same family of model on a task defined by the people who
 * built it. See `sprint0/01-quality-test.md`.
 *
 * The consequence, stated once and repeated in the report: mechanical scoring
 * UNDERCOUNTS. An answer that paraphrases a place instead of naming it scores
 * zero. That bias applies to BOTH arms identically, which is why a DIFFERENCE
 * between arms is still readable even though an absolute recall number is not.
 */

/**
 * Fold a string to its comparison form: lowercase, accents stripped, curly
 * quotes flattened, whitespace collapsed.
 *
 * ⚠ Curly quotes matter more than they look. `MANIFEST.csv` writes
 * `Hospital ... "José G. Parres"` with straight quotes; the generated corpus
 * text writes the same name with typographic quotes. Without this line, 71 of
 * 191 documents falsely read as "does not mention its own anchor site" and the
 * whole ground truth is wrong in the graph's favour or against it at random.
 */
export function fold(input: string): string {
  return input
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―]/g, '-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Does `haystack` contain `needle`, under {@link fold}? */
export function contains(haystack: string, needle: string): boolean {
  const n = fold(needle)
  if (!n) return false
  return fold(haystack).includes(n)
}

/**
 * Does `haystack` contain ANY of `needles`?
 *
 * A fact is one concept with several legitimate surface forms — the corpus
 * writes `PILARES "Carlos Monsiváis" de la colonia Portales`, an answer may
 * write `PILARES Carlos Monsiváis`. Both are the same fact and both count.
 */
export function containsAny(haystack: string, needles: readonly string[]): boolean {
  const h = fold(haystack)
  return needles.some((needle) => {
    const n = fold(needle)
    return n.length > 0 && h.includes(n)
  })
}
