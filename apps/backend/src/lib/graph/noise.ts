/**
 * LABELS THAT ARE NEVER A GRAPH NODE: LANGUAGES AND REDACTION PLACEHOLDERS.
 *
 * Owner decision 2026-10-21, on the /grafo whole-graph view: no node for a
 * language (`náhuatl`, `amuzgo`, `español`, …) and no node for a placeholder
 * the anonymisation gate wrote (`[Persona A]`, `Domicilio 1`, `[Dato omitido]`).
 * 🔴 This SUPERSEDES the 2026-09-04 / 2026-10-16 rule that kept the 11
 * indigenous languages as `tema` (see `extract.ts` `GRAPH_WORD_CLASSES`).
 *
 * ── TWO ENFORCEMENT POINTS, ONE PATTERN ────────────────────────────────────
 *
 *   1. EXTRACTION — `extract.ts` `dropNoiseEntities` drops these labels from
 *      every parsed window, with their relations, whatever the type.
 *   2. READ — `queries.ts` puts {@link GRAPH_NOISE_KEY_PATTERN} in SQL on
 *      `graph_entities.canonical_key`, so rows already stored vanish the moment
 *      this code is deployed, without a re-extraction.
 *   3. (cleanup) `scripts/purge-graph-noise.ts` deletes the stored rows.
 *
 * ⚠ ONE REGEX, RUN BY BOTH JAVASCRIPT AND POSTGRES. It is matched against the
 * CANONICAL KEY (`normalise.ts`: lowercased, accents folded, `ñ` kept), so the
 * fold is the writer's own and case/accent handling cannot drift between the
 * two sides. The pattern uses only constructs whose meaning is identical in a
 * JS `RegExp` and a Postgres ARE (`~`): `^ $ | ? (?:) [] [^] {m,n} \( \) \[ \]`.
 * `noise.test.ts` checks the JS side; `queries.pg.test.ts` the Postgres side.
 */

import {
  ADDRESS_PLACEHOLDER_PREFIX,
  OMITTED_PLACEHOLDER,
  PERSON_PLACEHOLDER_PREFIX,
} from '@/lib/anonymise/types'

import { canonicalKey } from './normalise'

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Language names, as written. Folded through `canonicalKey` before use, so
 * `náhuatl` covers `nahuatl` and `hñähñu` covers `hñahñu`.
 *
 * The corpus's 11 (`collections/Documents.ts` `lengua`), the corpus language,
 * and the other Mexican languages whose bare name is first of all a language.
 * ⚠ Left out on purpose: `mayo` (the month), `mexicano` (the demonym),
 * `yaqui` (also a river and a people), `nahua` (the people, not the language).
 */
export const GRAPH_LANGUAGE_NAMES = [
  'español', 'castellano', 'inglés',
  'náhuatl', 'mixteco', 'mazateco', 'zapoteco', 'totonaco', 'tlahuica',
  'tlapaneco', "me'phaa", 'me’phaa', 'mephaa', 'amuzgo', 'hñähñu', 'otomí',
  'tsotsil', 'tzotzil', 'mixe', 'ayuuk', 'tseltal', 'tzeltal', 'maya',
  'purépecha', 'mazahua', 'chinanteco', 'triqui', 'chol', "ch'ol", 'tojolabal',
  'huasteco', 'tének', 'chatino', 'cuicateco', 'popoluca', 'huave',
] as const

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const LANGUAGE_ALT = [...new Set(GRAPH_LANGUAGE_NAMES.map((w) => canonicalKey(w)))]
  .map(escapeRe)
  .join('|')

/**
 * A key that IS a language: `náhuatl`, `el náhuatl`, `lengua náhuatl`,
 * `idioma español`, `tlapaneco (me'phaa)`, `hñähñu (otomí)`.
 *
 * ⚠ ONLY THE WHOLE LABEL. A label with a qualifier is a subject, not a
 * language, and stays: `traducción del zapoteco al español`, `lengua de señas
 * mexicana`, `lenguas indígenas`.
 */
export const GRAPH_LANGUAGE_KEY_PATTERN =
  `^(?:(?:la |el )?(?:lengua|lenguas|idioma|idiomas) )?(?:el |la )?(?:${LANGUAGE_ALT})(?: \\([^)]*\\))?$`

// ---------------------------------------------------------------------------
// Redaction placeholders
// ---------------------------------------------------------------------------

/** `'[Persona '` → `persona`, `'[Dato omitido]'` → `dato omitido`. */
const placeholderWord = (prefix: string): string => canonicalKey(prefix.replace(/[[\]]/g, ''))

/**
 * The labels the gate writes (`anonymise/types.ts`): `[Persona X]`,
 * `[Domicilio X]` with a bijective base-26 suffix (A … Z, AA …), and
 * `[Dato omitido]`. Plus `lugar`, which the owner named (`[Lugar B]`) and the
 * generator does not emit today — kept so a model that paraphrases a
 * `[Domicilio B]` into `[Lugar B]` is still caught.
 *
 * Suffix: one or two letters, or up to three digits (`Domicilio 1`).
 */
const LABELLED = [
  placeholderWord(PERSON_PLACEHOLDER_PREFIX),
  placeholderWord(ADDRESS_PLACEHOLDER_PREFIX),
  'lugar',
].map(escapeRe).join('|')

const PLACEHOLDER_CORE =
  `(?:(?:${LABELLED}) (?:[a-z]{1,2}|[0-9]{1,3})|${escapeRe(placeholderWord(OMITTED_PLACEHOLDER))})`

/**
 * A key that is a placeholder, with or without its brackets (`persona a`,
 * `[persona a]`), or that CONTAINS a bracketed one (`casa de [persona a]`).
 * Unbracketed, only the whole label counts: `persona sorda` is a subject.
 */
export const GRAPH_PLACEHOLDER_KEY_PATTERN =
  `^\\[?${PLACEHOLDER_CORE}\\]?$|\\[${PLACEHOLDER_CORE}\\]`

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

/** Both rules as ONE pattern — what `queries.ts` binds into SQL. */
export const GRAPH_NOISE_KEY_PATTERN =
  `(?:${GRAPH_LANGUAGE_KEY_PATTERN})|(?:${GRAPH_PLACEHOLDER_KEY_PATTERN})`

const LANGUAGE_RE = new RegExp(GRAPH_LANGUAGE_KEY_PATTERN)
const PLACEHOLDER_RE = new RegExp(GRAPH_PLACEHOLDER_KEY_PATTERN)

export function isLanguageLabel(label: string): boolean {
  return LANGUAGE_RE.test(canonicalKey(label))
}

export function isPlaceholderLabel(label: string): boolean {
  return PLACEHOLDER_RE.test(canonicalKey(label))
}

/** True when the label must never become (or stay) a graph node. Type-blind. */
export function isGraphNoiseLabel(label: string): boolean {
  return isLanguageLabel(label) || isPlaceholderLabel(label)
}
