/**
 * NAME PARTS — a person finding's given names and surnames, redacted wherever
 * they stand alone.
 *
 * 🔴 MEASURED ON DEV, 2026-10-26 (self-hosted detector, 0
 * fallbacks): two staff documentos went `ready` with a collaborator's bare
 * first name left in, 7 and 12 times. The surname was redacted everywhere.
 * Stage 3 redacts only the spellings of what the model REPORTED, so a full name
 * reported once never touched the first name used alone elsewhere, and verify —
 * the same model — had the same blind spot. Owner ruling Q5: "names get
 * anonymized, independently of number of words".
 *
 * So every person finding registers its NAME PARTS here, and the gate redacts
 * each part wherever it occurs as a whole word, with the finding's own label.
 *
 * ── WHAT A PART IS ──────────────────────────────────────────────────────────
 *
 * A word of the span AS THE MODEL WROTE IT that starts with a capital, has two
 * letters or more, is not an abbreviation ("Dr.", "Lic.") and is not in
 * {@link NOT_A_PART}. "la maestra Nicasia Olvera" → Nicasia, Olvera.
 * "Don Fernando de la Cruz" → Fernando, Cruz.
 *
 * ── 🔴 WHICH OCCURRENCES ARE REDACTED ──────────────────────────────────────
 *
 * Whole words, accent-blind, whose FIRST LETTER IS A CAPITAL: "Fausto",
 * "FAUSTO", "Fáusto". A lower-case occurrence stays: many names are also words
 * ("Rosa" / "una flor rosa", "Paz" / "queremos paz", "Flores", "Cruz"), and no
 * list of them would ever be complete. A capitalised common word at a sentence
 * start ("Rosa es el color…") IS redacted: over-redaction, accepted. A name
 * transcribed in lower case is left to verify, exactly as before this file.
 *
 * ── 🔴 WHICH LABEL ──────────────────────────────────────────────────────────
 *
 * The label of the ONE person the part belongs to. Two rules keep that from
 * fabricating a relationship (`pseudonyms.ts`, header):
 *
 *   · A part shared by people with different labels ("María López", "María
 *     Pérez") gets a label OF ITS OWN: the bare "María" could be either.
 *   · An occurrence glued to another capitalised word that is not part of the
 *     same name ("Fausto Martínez" when the finding was "Fausto Arellano") also
 *     gets the part's own label: it is probably someone else. A word that
 *     starts the sentence ("Ayer Fausto llegó") is not glued.
 *
 * ⚠ Both errs toward a SECOND label for one person, never one label for two.
 */

import { normaliseName } from './pseudonyms'
import { PLACEHOLDER_PATTERN } from './types'

/**
 * Words of a name span that are never spread across the document.
 *
 * ⚠ Function words, because they are not names ("de la Cruz"). TITLES, because
 * spreading one would glue every other titled person to this one: "Don" from
 * "Don Fernando Vázquez" would turn "Don Pedro" into "[Persona A] Pedro", and
 * verify would then absorb Pedro into Fernando's label. This list only decides
 * what is NOT spread; the model still owns span boundaries (owner, 2026-10-23),
 * and stage 3 still redacts the whole span it reported. A title missing here
 * is over-redacted where it stands capitalised; never under-redacted.
 */
export const NOT_A_PART: ReadonlySet<string> = new Set(
  [
    // function words
    'de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'o', 'u', 'a', 'en', 'con',
    'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'san', 'santa', 'santo',
    // titles and forms of address
    'don', 'dona', 'sr', 'sra', 'srta', 'senor', 'senora', 'senorita',
    'dr', 'dra', 'doctor', 'doctora', 'lic', 'licenciado', 'licenciada',
    'ing', 'ingeniero', 'ingeniera', 'mtro', 'mtra', 'maestro', 'maestra',
    'prof', 'profa', 'profe', 'profesor', 'profesora', 'padre', 'madre', 'fray', 'sor',
  ].map(normaliseName),
)

const WORD = /[\p{L}\p{M}]+/gu

const EDGE_CHAR = /^[\s\p{P}]$/u

/**
 * `s.replace(/[\s\p{P}]+$/u, '')`, exactly, in linear time.
 *
 * 🔴 WHY NOT THE REGEX (audit 5, 2026-10-28): an end-anchored `+$` is tried
 * at every position, and inside a long run of spaces that is NOT at the end
 * each try reads the whole run before failing: N². A byline name with 60k
 * spaces inside took seconds in the gate.
 */
export function trimEdgeEnd(s: string): string {
  let end = s.length
  while (end > 0) {
    const low = s.charCodeAt(end - 1)
    const width = end >= 2 && low >= 0xdc00 && low <= 0xdfff ? 2 : 1 // one code point
    if (!EDGE_CHAR.test(s.slice(end - width, end))) break
    end -= width
  }
  return s.slice(0, end)
}

/** `s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')`, exactly, in linear time ({@link trimEdgeEnd}). */
export function trimEdges(s: string): string {
  let start = 0
  for (const c of s) {
    if (!EDGE_CHAR.test(c)) break
    start += c.length
  }
  return trimEdgeEnd(s.slice(start))
}

/** The name parts of one person span, as written. */
export function namePartsOf(raw: string): string[] {
  // 🔴 Trailing punctuation off first (audit 2026-10-27): "Fausto Arellano."
  // read "Arellano" as an abbreviation and never spread it. An abbreviation
  // INSIDE the span ("Pbro. Juan Soto") is still skipped.
  const span = trimEdgeEnd(raw)
  const inPlaceholder = [...span.matchAll(PLACEHOLDER_PATTERN)].map((m) => [m.index, m.index + m[0].length])
  const parts: string[] = []
  for (const m of span.matchAll(WORD)) {
    const word = m[0]
    const end = m.index + word.length
    if (inPlaceholder.some(([s, e]) => m.index >= (s as number) && m.index < (e as number))) continue
    if (!/^\p{Lu}/u.test(word)) continue
    if ([...word.normalize('NFD').replace(/\p{M}/gu, '')].length < 2) continue
    if (span[end] === '.') continue
    if (NOT_A_PART.has(normaliseName(word))) continue
    parts.push(word)
  }
  return parts
}

/** True when `word` is spread-able at all: used to tell a glued neighbour. */
function nameLike(word: string): boolean {
  return /^\p{Lu}/u.test(word) && !NOT_A_PART.has(normaliseName(word))
}

/** Opening marks a sentence may start with: `¿El doctor?`, `«La maestra…`. */
const OPENERS = /[\s"'“‘«¿¡(—–-]/u

/** True when `at` starts a sentence: text start, or after `.`, `!`, `?`, `…` or a line break. */
export function sentenceStart(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && text[i] !== '\n' && OPENERS.test(text[i] as string)) i--
  return i < 0 || /[\n.!?…]/u.test(text[i] as string)
}

/**
 * True when the occurrence `[start, end)` sits in a run of capitalised words
 * that are not all parts of `own`: "Fausto Martínez" for "Fausto Arellano".
 */
export function gluedToAnotherName(
  text: string,
  start: number,
  end: number,
  own: ReadonlySet<string>,
): boolean {
  const foreign = (word: string) => nameLike(word) && !own.has(normaliseName(word))
  const next = /^[ \t]+([\p{L}\p{M}]+)/u.exec(text.slice(end, end + 80))
  if (next && foreign(next[1] as string)) return true
  const before = text.slice(Math.max(0, start - 80), start)
  const prev = /([\p{L}\p{M}]+)[ \t]+$/u.exec(before)
  if (!prev) return false
  const prevAt = start - before.length + prev.index
  return foreign(prev[1] as string) && !sentenceStart(text, prevAt)
}

/**
 * One document's name parts. 🔴 Same lifetime as the pseudonym allocator: one
 * document, never persisted (a part → label table is a re-identification map).
 */
export interface NamePartRegistry {
  /**
   * Record a person span that was redacted with a label. `single` lets a
   * one-word span own its part: a byline author written as one word
   * ("Autores: Colectivo Norte y Ruiz") IS that person, and without it a bare
   * "Ruiz" in the body was never redacted (byline audit, 2026-10-28).
   */
  add(span: string, options?: { single?: boolean }): void
  /** Every registered part, longest first, each with the folded parts of its owners. */
  parts(): Array<{ part: string; siblings: ReadonlySet<string> }>
  /**
   * The span whose label a name (a part, or a one-word finding) should take:
   * its single owner, or null when it has none or several.
   */
  ownerOf(name: string, labelOf: (span: string) => string): string | null
  /** The folded name parts of every registered span that carries `label`. */
  partsWithLabel(label: string, labelOf: (span: string) => string | undefined): Array<ReadonlySet<string>>
}

export function createNamePartRegistry(): NamePartRegistry {
  // folded part → owner spans (as written), first spelling of the part
  const owners = new Map<string, Set<string>>()
  const spelling = new Map<string, string>()
  const siblings = new Map<string, Set<string>>()
  return {
    add(span, options) {
      const parts = namePartsOf(span)
      // A one-word span is not an owner: "Fausto" would make "Fausto" ambiguous
      // with "Fausto Arellano". It takes its owner's label through `ownerOf`.
      // ⚠ Except a byline author (`single`): there the one word IS the person.
      if (parts.length === 0 || (!options?.single && (span.match(WORD) ?? []).length < 2)) return
      const folded = new Set(parts.map(normaliseName))
      for (const part of parts) {
        const key = normaliseName(part)
        if (!owners.has(key)) owners.set(key, new Set())
        owners.get(key)?.add(span)
        if (!spelling.has(key)) spelling.set(key, part)
        const sib = siblings.get(key) ?? new Set<string>()
        for (const f of folded) sib.add(f)
        siblings.set(key, sib)
      }
    },
    parts() {
      return [...spelling.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, part]) => ({ part, siblings: siblings.get(key) ?? new Set() }))
    },
    partsWithLabel(label, labelOf) {
      const spans = new Set([...owners.values()].flatMap((set) => [...set]))
      return [...spans]
        .filter((span) => labelOf(span) === label)
        .map((span) => new Set(namePartsOf(span).map(normaliseName)))
    },
    ownerOf(name, labelOf) {
      const set = owners.get(normaliseName(name))
      if (!set || set.size === 0) return null
      const spans = [...set]
      // Owners are people already redacted, so `labelOf` returns their
      // existing labels; "Don Fernando Vázquez" / "Fernando Vázquez" share one.
      const labels = new Set(spans.map(labelOf))
      return labels.size === 1 ? (spans[0] as string) : null
    },
  }
}
