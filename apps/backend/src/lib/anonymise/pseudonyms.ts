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

import { ADDRESS_PLACEHOLDER_PREFIX, PERSON_PLACEHOLDER_PREFIX } from './types'

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

/**
 * Fold an ADDRESS to its bucket key.
 *
 * ⚠ HARSHER THAN {@link normaliseName}, and it has to be. An address is written
 * a different way every time it is said: `C.P. 06700` / `CP 06700`,
 * `Calle Morelos No. 45` / `calle morelos no 45`, with and without the commas a
 * transcriber guessed at. Punctuation is therefore dropped entirely, not just
 * folded — otherwise the same house collects three labels and the redacted text
 * says the person moved twice.
 *
 * ⚠ One-way and lossy, exactly like the name fold. Nothing here reconstructs an
 * address; it only decides whether two strings are the same place.
 */
export function normaliseAddress(address: string): string {
  return address
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export interface PseudonymAllocator {
  /** The label for this name in THIS document. Stable within it, only within it. */
  labelFor(name: string): string
  /**
   * The label for this ADDRESS in THIS document. Same contract as
   * {@link labelFor}, separate sequence — `[Domicilio A]` and `[Persona A]` are
   * unrelated and both start at `A`.
   *
   * 🔴 A SEPARATE COUNTER, NOT A SHARED ONE. Sharing the sequence would let the
   * count of `[Persona X]` labels leak how many addresses were found and vice
   * versa, and would make the report's `pseudonyms` number — which an admin
   * reads as "how many people are in this testimony" — silently wrong.
   */
  addressLabelFor(address: string): string
  /** How many distinct people have been labelled so far. Goes in the report. */
  readonly count: number
  /** How many distinct addresses have been labelled so far. Goes in the report. */
  readonly addressCount: number
}

/**
 * A fresh allocator. 🔴 Call this ONCE PER DOCUMENT and let it be garbage
 * collected — see the header. Reusing one across documents would manufacture
 * exactly the cross-document stability this design exists to prevent.
 */
export function createPseudonymAllocator(): PseudonymAllocator {
  const assigned = new Map<string, string>()
  const addresses = new Map<string, string>()

  /**
   * One bucket-and-label loop, so the two namespaces cannot drift apart.
   * `sameAs` may map a NEW key onto an existing label; `labels` counts distinct
   * labels, so an alias neither skips a letter nor inflates the count.
   */
  const labeller = (
    into: Map<string, string>,
    prefix: string,
    fold: (raw: string) => string,
    sameAs: (key: string) => string | undefined = () => undefined,
  ) => {
    const labels = new Set<string>()
    const labelFor = (raw: string): string => {
      const key = fold(raw)
      const existing = into.get(key) ?? sameAs(key)
      if (existing !== undefined) {
        into.set(key, existing)
        return existing
      }
      // Built from the constants in `types.ts` so the gate's "is this string one
      // of OUR placeholders?" check in stage 4 can never drift out of step with
      // the strings this allocator actually emits.
      const label = `${prefix}${labelSuffix(labels.size)}]`
      labels.add(label)
      into.set(key, label)
      return label
    }
    return { labelFor, size: () => labels.size }
  }

  /**
   * 🔴 "Don Fernando Vázquez" AND "Fernando Vázquez" ARE ONE PERSON. The model
   * includes a leading title in its span (see the detector prompt), so the same
   * name arrives with and without words in front. A key that ENDS WITH another
   * key of at least two words, at a word boundary, shares its label.
   *
   * ⚠ No title list: any leading words count. Two words minimum, so a bare
   * "López" or "Fernando" never merges two people who share one name.
   *
   * 🔴 "LA ESPOSA DE MI PRIMO" IS NOT "MI PRIMO" (owner ruling Q6, 2026-10-21).
   * It ends with the same words, but its head is another person: Spanish says
   * "X of Y" as "X de Y". So when the leading words hold the preposition
   * `de` / `del`, the long span names someone RELATED to the short one, and it
   * gets its own label. A title ("Don", "doña", "Lic.") never holds a `de`.
   *
   * ⚠ This is grammar, not a vocabulary list: no kinship word appears here, and
   * the owner forbids one (2026-10-17). A `de` INSIDE the shared tail
   * ("Don José de la Cruz" / "José de la Cruz") is not in the leading words, so
   * that titled pair still merges.
   *
   * ⚠ A COMPOUND FIRST NAME IS NOT A CHAIN (audit 2026-10-21). "María del
   * Carmen López" is "Carmen López". The tell is the word right before the
   * `de`: a capitalised word is part of a name ("María del", "José de"); a
   * lowercase one is a common noun heading another person ("esposa de",
   * "hijo de"). Case is read from the span as written, because the key is
   * already lower-cased. ⚠ An all-lowercase transcription of a compound name
   * therefore splits; that errs toward two labels, never a false merge.
   */
  const written = new Map<string, string[]>()
  const isChain = (long: string, short: string): boolean => {
    const words = written.get(long) ?? long.split(' ')
    const leading = words.length - short.split(' ').length
    for (let i = 0; i < leading; i += 1) {
      const w = normaliseName(words[i])
      if (w !== 'de' && w !== 'del') continue
      if (i > 0 && !/^\p{Lu}/u.test(words[i - 1])) return true
    }
    return false
  }
  const titledAlias = (key: string): string | undefined => {
    for (const [other, label] of assigned) {
      const [short, long] = other.length < key.length ? [other, key] : [key, other]
      if (short.split(' ').length < 2 || !long.endsWith(` ${short}`)) continue
      if (isChain(long, short)) continue
      return label
    }
    return undefined
  }

  // Remember each key's first written form, for the case test in `isChain`.
  // Same lifetime as `assigned`: one document, never persisted.
  const foldName = (raw: string): string => {
    const key = normaliseName(raw)
    if (!written.has(key)) written.set(key, raw.trim().split(/\s+/))
    return key
  }

  const people = labeller(assigned, PERSON_PLACEHOLDER_PREFIX, foldName, titledAlias)
  const places = labeller(addresses, ADDRESS_PLACEHOLDER_PREFIX, normaliseAddress)

  return {
    labelFor: people.labelFor,
    addressLabelFor: places.labelFor,
    get count(): number {
      return people.size()
    },
    get addressCount(): number {
      return places.size()
    },
  }
}
