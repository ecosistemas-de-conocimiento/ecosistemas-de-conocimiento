/**
 * ENTITY IDENTITY, AND THE ONE PLACE IT IS DECIDED.
 *
 * Graph identity is `(organization, type, canonicalKey)` (ADR §4.1, D5), so
 * this function decides which surface forms are THE SAME NODE and which are two
 * nodes. Getting it wrong in one direction scatters an entity across a dozen
 * near-duplicates; getting it wrong in the other silently merges two different
 * things and every count computed over them is a lie.
 *
 * Pure, synchronous, no I/O. Unit-tested next door.
 *
 * ── 🔴 WHY `ñ` SURVIVES, AND ACCENTS DO NOT ────────────────────────────────
 *
 * The ADR says "NFD, strip combining marks, lowercase, collapse whitespace,
 * trim". Applied literally that also folds `ñ` to `n`, because `ñ` decomposes
 * to `n` + U+0303 COMBINING TILDE. **We deliberately do not do that**, and the
 * reason is that the two marks are not the same kind of thing in Spanish:
 *
 *   · An ACCENT on a vowel (á é í ó ú) and the diéresis (ü) are DIACRITICS.
 *     They are routinely dropped by people typing quickly, lost by OCR, and
 *     absent from transcription output. `Mexico` and `México` are the same
 *     place, and folding them is a real de-duplication win with almost no cost:
 *     Spanish minimal pairs that differ ONLY by an accent are rare and are
 *     nearly always different inflections of one lemma anyway.
 *
 *   · `ñ` IS A SEPARATE LETTER OF THE SPANISH ALPHABET, not an accented `n`.
 *     It has its own dictionary section. Nobody "forgets" it the way they forget
 *     an accent — a text either has it or is not Spanish. Folding it merges
 *     genuinely distinct words, and the collisions are not hypothetical:
 *
 *         campaña (campaign)  ≠  campana (bell)
 *         caña    (cane)      ≠  cana    (grey hair)
 *         año     (year)      ≠  ano     (anus)
 *
 *     In a corpus about community processes, `campaña` and `año` are exactly
 *     the kind of words that become temas. Merging them produces a node whose
 *     support count is the sum of two unrelated things, and the graph view
 *     ranks by that count.
 *
 * So: fold every combining mark EXCEPT the tilde on `n`. The cost of the choice
 * is that a document written `campana` when it meant `campaña` stays a separate
 * node. That is a spelling error, and the right fix for it is an alias, not a
 * normalisation rule that also merges "year" with "anus".
 */

/**
 * A character that cannot appear in real text, used to hold `ñ`'s place through
 * the decompose-and-strip pass. U+0001 START OF HEADING: not a Unicode letter,
 * not whitespace, and unaffected by `normalize()` or `toLowerCase()`.
 */
const N_TILDE_SENTINEL = '\u0001'

/** Unicode combining diacritical marks — what NFD splits an accent out into. */
const COMBINING_MARKS = /[\u0300-\u036f]/g

/** Straight, curly and angle double quotes. */
const DOUBLE_QUOTES = /["“”„«»]/g

/**
 * The stored identity of an entity label.
 *
 * NFC → protect `ñ` → NFD → strip combining marks → restore `ñ` → lowercase →
 * drop double quotes → collapse internal whitespace → trim.
 *
 * ⚠ CHANGING THIS CHANGES IDENTITY. Rows already stored keep the key they were
 * written with; a re-extraction (`lib/graph/backfill.ts`) writes the new key.
 *
 * ⚠ THE LEADING `normalize('NFC')` IS NOT DECORATION. Text arriving from a
 * transcript, a PDF extractor or a macOS filesystem may already be decomposed,
 * in which case `ñ` is present as `n` + U+0303 and the sentinel swap would miss
 * it — the tilde would then be stripped by the very pass it is meant to survive.
 * Composing first makes the input shape irrelevant.
 *
 * Returns `''` for input that is empty or whitespace-only. Callers treat an
 * empty key as "not an entity" and drop the row.
 */
export function canonicalKey(label: string | null | undefined): string {
  if (typeof label !== 'string') return ''
  return label
    .normalize('NFC')
    .replace(/[ñÑ]/g, N_TILDE_SENTINEL)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(new RegExp(N_TILDE_SENTINEL, 'g'), 'ñ')
    .toLowerCase()
    // ⚠ DOUBLE QUOTES ARE PUNCTUATION, NOT PART OF THE NAME. `Escuela Primaria
    // "Miguel Hidalgo"` and `Escuela Primaria Miguel Hidalgo` were two nodes in
    // the demo corpus (backlog #16). Apostrophes stay: `O'Higgins`.
    .replace(DOUBLE_QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Tidy a display label without changing its identity.
 *
 * Only whitespace: the stored `label` keeps its accents, its capitalisation and
 * its `ñ`, because it is what a member reads in the graph view. Identity is
 * `canonicalKey`'s job and nothing else's.
 */
export function displayLabel(label: string | null | undefined): string {
  if (typeof label !== 'string') return ''
  return label.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/**
 * Append a surface form to an entity's alias list.
 *
 * ⚠ ALIASES ARE SURFACE FORMS, NOT KEYS. They exist so a member searching for
 * "el CIDE" finds the node labelled "CIDE", and so the label a later document
 * used is not lost when the first document's label wins. Two forms that fold to
 * the same `canonicalKey` are still both worth keeping — that is the whole
 * point of the field.
 *
 * De-duplicated case-insensitively against `label` and against each other, so a
 * document re-extracted ten times does not grow ten copies. Capped at
 * {@link MAX_ALIASES} because this is a jsonb column read on every graph query
 * and an unbounded list is a slow read nobody asked for.
 */
export const MAX_ALIASES = 25

export function mergeAliases(
  existing: readonly string[] | null | undefined,
  label: string,
  incoming: readonly string[] | null | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>([displayLabel(label).toLowerCase()])

  for (const candidate of [...(existing ?? []), ...(incoming ?? [])]) {
    const form = displayLabel(candidate)
    if (!form) continue
    const key = form.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(form)
    if (out.length >= MAX_ALIASES) break
  }

  return out
}
