/**
 * KEEP CITED AUTHORS — RESTORE AFTER THE FACT (owner decision 2026-11-07,
 * `keepCitedAuthors`).
 *
 * Same shape as `publicFigureRestore.ts` and `authorRestore.ts`: the gate runs
 * exactly as with the switch off, and only a READY result reaches this file. A
 * hold never restores anything. Here a `[Persona X]` may be turned back into
 * the exact source text it replaced, and only when that text sits in a
 * CITATION SLOT, found by deterministic rules over the source:
 *
 *   · narrative       López (2020) · López, A. (2020) · según López (2020)
 *                     López y Pérez (2020) · López et al. (2020)
 *   · parenthetical   (López, 2020) · (López y Pérez, 2020; Ruiz et al., 2019)
 *   · references      a line under a "Referencias", "Bibliografía", "Obras
 *                     citadas" or "Referencias bibliográficas" heading that
 *                     opens with "López, A. (2020)" or "López, A., & Pérez, B. (2020)"
 *
 * A year is four digits from 1500 to 2099, optionally with one letter
 * ("2020a"), or "s. f." / "s.f."; a page ("2020, p. 34") may follow it.
 *
 * 🔴 WHAT A SLOT HOLDS: ONE capitalised surname word (a hyphen may join two:
 * "García-Márquez"), optionally followed by ", " and initials ("López, A.",
 * "López, A. B."). A given name never comes back: "Ana López (2020)" fails
 * because a capitalised word stands before "López", and "García Márquez
 * (1967)" fails for the same reason (over-redaction, accepted). A span with a
 * number, a line break or a bracket cannot match the slot shape.
 *
 * 🔴 PER LABEL, LIKE PUBLIC FIGURES: every placeholder carrying the label must
 * sit in a slot. "López (2020)" and "la maestra López dijo" share one label
 * when the gate thinks they are one person; restoring only the citation would
 * tell every reader who `[Persona A]` in the prose is.
 *
 * 🔴 THE MODEL DECIDES, the rules only narrow (`modelVerdict`): a slot comes
 * back only when the model called that exact text public. A roster name part
 * never comes back: a member of the ecosistema is redacted by stage 2 on
 * purpose (owner Q13 A), cited or not.
 *
 * Anything else, any unclear shape: the placeholder stays.
 */

import { normaliseName } from './pseudonyms'
import { alignPlaceholders, type RestoreEvidence } from './publicFigureRestore'
import type { DetectorFinding } from './types'
import { PLACEHOLDER_PATTERN } from './types'

const WORD = String.raw`\p{Lu}\p{Ll}+`
/** One surname word, or two joined by a hyphen. Never two words with a space. */
const NAME = String.raw`${WORD}(?:-${WORD})?`
const INITIALS = String.raw`\p{Lu}\.(?:[ -]?\p{Lu}\.){0,2}`
const AUTHOR = String.raw`${NAME}(?:, ${INITIALS})?`
const YEAR = String.raw`(?:(?:1[5-9]\d\d|20\d\d)[a-z]?|s\. ?f\.)`
const PAGE = String.raw`(?:, pp?\. \d{1,4}(?:[-–]\d{1,4})?)?`
const AUTHORS = String.raw`${AUTHOR}(?: et al\.|(?: y | e | & )${AUTHOR})?`

/** `López (2020)`, `López, A. y Pérez, B. (2020, p. 3)`. Group 1 is the authors. */
const NARRATIVE = new RegExp(String.raw`(${AUTHORS}) \(${YEAR}${PAGE}\)`, 'gu')
/** `(López, 2020; Pérez et al., 2019)`. Group 1 is the inside. */
const PARENTHETICAL = new RegExp(String.raw`\((${AUTHORS}, ${YEAR}${PAGE}(?:; ${AUTHORS}, ${YEAR}${PAGE})*)\)`, 'gu')
/** One citation inside a parenthetical; group 1 is its authors. */
const PAREN_ITEM = new RegExp(String.raw`(${AUTHORS}), ${YEAR}${PAGE}`, 'gu')

const ENTRY_AUTHOR = String.raw`${NAME}, ${INITIALS}`
/** A reference entry's opening: initials required. Group 1 is the authors. */
const ENTRY = new RegExp(
  String.raw`^[ \t]*(?:(?:[-*•]|\d{1,3}\.)[ \t]+)?(${ENTRY_AUTHOR}(?:(?:, | y |, y | & |, & )${ENTRY_AUTHOR}){0,5}(?:,? et al\.)?) \(${YEAR}\)`,
  'u',
)
const HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:referencias(?: bibliográficas)?|bibliografía|obras citadas)(?:\*\*)?[ \t]*:?[ \t]*$/iu
const MARKDOWN_HEADING = /^[ \t]*#{1,6}[ \t]/u

/** One author inside a matched author list; group 1 is the surname. */
const AUTHOR_IN_LIST = new RegExp(String.raw`(${NAME})(, ${INITIALS})?`, 'gu')

/** Words that may stand right before a narrative citation, any case. */
const LEADS = new Set(['según', 'como', 'véase', 'ver', 'cf', 'para', 'en'].map(normaliseName))
/** A lower-case word that joins names: "Ana Pérez y López (2020)" is refused. */
const JOINERS = new Set(['y', 'e', 'o', 'u', 'ni', 'and', 'con'].map(normaliseName))
/** Punctuation that may stand, then one space, before a narrative citation. */
const OPENERS = new Set(['.', ',', ';', ':', '(', '—', '–', '"', '“', '«', '¿', '¡'])

/**
 * True when what stands before `at` on its line lets a narrative citation
 * start there: the line start, an opening mark, punctuation then one space, or
 * one space after a lower-case word (not a joiner) or a lead word ("Según").
 * 🔴 Anything else fails closed: a capitalised word ("Ana López (2020)"), a
 * digit, a bracket, two spaces.
 */
function narrativeMayStart(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1
  const before = source.slice(lineStart, at)
  if (before === '') return true
  const last = before[before.length - 1] as string
  if (last === '(' || last === '"' || last === '“' || last === '«') return true
  if (last !== ' ') return false
  const head = before.slice(0, -1)
  if (head === '') return false
  const prev = head[head.length - 1] as string
  if (OPENERS.has(prev)) return true
  const word = /[\p{L}\p{M}]+$/u.exec(head)?.[0]
  if (!word) return false
  const folded = normaliseName(word)
  if (LEADS.has(folded)) return true
  if (/\p{Lu}|\p{Lt}|\p{Lo}/u.test(word)) return false
  return !JOINERS.has(folded)
}

/** `[start, end)` keys of every author span inside `list`, which starts at `offset`. */
function authorSlots(list: string, offset: number, into: Set<string>): void {
  for (const m of list.matchAll(AUTHOR_IN_LIST)) {
    const start = offset + (m.index as number)
    const surname = m[1] as string
    into.add(`${start}:${start + surname.length}`)
    if (m[2]) into.add(`${start}:${start + m[0].length}`)
  }
}

/**
 * Every citation slot in `source`, as `start:end` keys: the surname alone and,
 * when initials follow, the surname with them.
 */
export function citationSlots(source: string): Set<string> {
  const slots = new Set<string>()
  for (const m of source.matchAll(NARRATIVE)) {
    const at = m.index as number
    if (!narrativeMayStart(source, at)) continue
    // A letter, digit or hyphen glued before the match is a longer word.
    if (at > 0 && /[\p{L}\p{M}\p{N}\-‐‑'’]/u.test(source[at - 1] as string)) continue
    authorSlots(m[1] as string, at, slots)
  }
  for (const m of source.matchAll(PARENTHETICAL)) {
    const inner = m[1] as string
    const innerAt = (m.index as number) + 1
    for (const item of inner.matchAll(PAREN_ITEM)) {
      authorSlots(item[1] as string, innerAt + (item.index as number), slots)
    }
  }
  // References: every line under a heading, up to the next markdown heading.
  let offset = 0
  let inReferences = false
  for (const line of source.split('\n')) {
    if (HEADING.test(line)) inReferences = true
    else if (MARKDOWN_HEADING.test(line)) inReferences = false
    else if (inReferences) {
      const m = ENTRY.exec(line)
      if (m) authorSlots(m[1] as string, offset + line.indexOf(m[1] as string, 0), slots)
    }
    offset += line.length + 1
  }
  return slots
}

/** A span's comparable name parts: folded words of two letters or more. */
function partsOf(text: string): string[] {
  return (text.replace(PLACEHOLDER_PATTERN, ' ').match(/[\p{L}\p{M}]+/gu) ?? [])
    .map(normaliseName)
    .filter((w) => [...w].length >= 2)
}

/** A finding's key: folded, hyphens as spaces, whitespace collapsed. */
const keyOf = (t: string) => normaliseName(t.replace(/[-‐‑‒–—]/gu, ' '))

/**
 * 🔴 THE MODEL DECIDES (audit 2026-11-07, D5: "Ulloa (2020) me dijo que no
 * volviera al barrio" is a citation shape about a neighbour). A slot is only
 * where a cited name MAY come back; it does when the model called exactly that
 * text public (`public`, from `classifyPublic`) and nothing else it said is
 * private evidence against it:
 *
 *   · a stage-3 finding that is not a public `persona`, any verify or
 *     unlocated finding that does not echo a public text, and every roster
 *     name are private evidence;
 *   · a span sharing ANY name part (folded) with private evidence stays.
 *
 * Without an explicit public verdict the name stays redacted (fail closed).
 */
function modelVerdict(evidence: RestoreEvidence): (original: string) => boolean {
  const isPublic = (f: DetectorFinding) => f.type === 'persona' && f.public !== undefined
  const publicKeys = new Set(evidence.stage3.filter(isPublic).map((f) => keyOf(f.text)))
  const echo = (f: DetectorFinding) => isPublic(f) && publicKeys.has(keyOf(f.text))
  const privateTexts = [
    ...evidence.stage3.filter((f) => !isPublic(f)).map((f) => f.text),
    ...[...evidence.verify, ...evidence.unlocated].filter((f) => !echo(f)).map((f) => f.text),
    ...evidence.roster,
  ]
  const privateParts = new Set(privateTexts.flatMap(partsOf))
  return (original) => publicKeys.has(keyOf(original)) && partsOf(original).every((w) => !privateParts.has(w))
}

/**
 * Restore cited authors in a READY output. Returns the output unchanged and
 * nothing kept whenever any rule says no. `kept` is each distinct restored text.
 */
export function restoreCitedAuthors(
  source: string,
  output: string,
  evidence: RestoreEvidence,
): { text: string; kept: string[] } {
  const none = { text: output, kept: [] }
  const slots = citationSlots(source)
  if (slots.size === 0) return none
  // Stage 1's own placeholders ("[Dato omitido]", a byline) map to themselves.
  const aligned = alignPlaceholders(source, output, { sourcePlaceholders: true })
  if (aligned === null || aligned.length === 0) return none
  const modelSaysPublic = modelVerdict(evidence)

  const inSlot = (start: number, end: number): boolean =>
    slots.has(`${start}:${end}`) && modelSaysPublic(source.slice(start, end))
  const verdict = new Map<string, boolean>()
  for (const p of aligned) {
    const ok = p.label.startsWith('[Persona ') && inSlot(p.start, p.end)
    verdict.set(p.label, (verdict.get(p.label) ?? true) && ok)
  }

  let text = ''
  let last = 0
  let i = 0
  const kept = new Set<string>()
  for (const m of output.matchAll(PLACEHOLDER_PATTERN)) {
    const p = aligned[i++]
    if (p === undefined) return none
    text += output.slice(last, m.index)
    last = (m.index as number) + m[0].length
    if (verdict.get(p.label) === true) {
      const original = source.slice(p.start, p.end)
      text += original
      kept.add(original)
    } else {
      text += m[0]
    }
  }
  text += output.slice(last)
  return { text, kept: [...kept] }
}
