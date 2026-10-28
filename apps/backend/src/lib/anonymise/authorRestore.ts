/**
 * KEEP A DOCUMENT'S ACTUAL AUTHOR — RESTORE AFTER THE FACT (owner ruling R60,
 * 2026-10-28, as clarified the same day).
 *
 * 🔴 WHO IS AN AUTHOR: the document's uploader, by their account display name
 * or their roster entry (`lib/publicFigures.ts` → `documentoGateOptions`).
 * NEVER a name read from the text: a byline is something anyone can type, so
 * a forged "Autora: Carla Méndez" line unhides nobody. `documents` has no
 * staff-recorded authors field, so the uploader is the only source.
 *
 * 🔴 SAME SHAPE AS PUBLIC FIGURES (`publicFigureRestore.ts`). The gate runs
 * exactly as before — every byline redacted in stage 1, every person in stage
 * 3, verify with its normal holds — and only a READY result reaches this
 * file. A hold never restores anything. Here a `[Persona X]` may be turned
 * back into the exact source text it replaced:
 *
 *   · The output aligns to the source in exactly ONE way (`alignPlaceholders`).
 *     The source is stage 1 re-run with `keepAuthors`, so a byline piece
 *     naming the author is in it as written.
 *   · Inside such a byline piece: always.
 *   · Elsewhere, every word of the replaced text is one author's name part, a
 *     title, a particle or one of that author's initials, with each name part
 *     capitalised; it names the author WHOLE ("Ana Ruiz", "Ruiz, Ana"), or by
 *     ONE part that is not their first (given) name ("Ruiz", never "Ana")
 *     and that no other person in the evidence carries — a
 *     finding, a verify span, a roster member, or a name stage 1 redacted —
 *     and it is not glued to another name ("Ana Ruiz Pérez", "Ana Ruiz y
 *     Pérez").
 *
 * Per placeholder, not per label: one ambiguous "Ruiz" stays `[Persona A]`
 * while "Ana Ruiz" beside it is shown. The label then reads as the author's,
 * which is the gate's own attribution and names no one else.
 */

import { NOT_A_PART, namePartsOf } from './nameParts'
import { normaliseName } from './pseudonyms'
import { alignPlaceholders, type RestoreEvidence } from './publicFigureRestore'
import { PLACEHOLDER_PATTERN } from './types'
import { wholeWord } from './wordBreaks'

/** Particles inside one name. */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'den'])

/** Words that join two people; like `publicFigureRestore.ts`, they CONTINUE a name for the glue check. */
const CONJUNCTIONS = new Set(['y', 'e', 'o', 'u', 'ni', 'con', 'and'])

interface Author {
  /** Folded name parts. */
  parts: ReadonlySet<string>
  /** The folded first part: a given name, never restored on its own. */
  first: string
  /** Folded one-letter initials of the name ("M." in "Ana M. Ruiz"). */
  initials: ReadonlySet<string>
}

const WORDS = /[\p{L}\p{M}]+/gu
const words = (s: string) => s.match(WORDS) ?? []
const partsOf = (s: string) => new Set(namePartsOf(s.replace(PLACEHOLDER_PATTERN, ' ')).map(normaliseName))

function authorOf(name: string): Author | null {
  const parts = partsOf(name)
  // 🔴 Two name parts at least: a one-word account name is anyone's word.
  if (parts.size < 2) return null
  const initials = new Set(words(name).filter((w) => [...w].length === 1).map(normaliseName))
  return { parts, first: [...parts][0] as string, initials }
}

/**
 * The author `text` names, and whether it names them whole. NULL unless
 * every word is that author's (each name part capitalised when `cased`).
 */
function namedBy(
  text: string,
  authors: readonly Author[],
  cased: boolean,
): { whole: boolean; part?: string; given?: true } | null {
  const ws = words(text)
  for (const author of authors) {
    const present = new Set<string>()
    const ok = ws.every((raw) => {
      const w = normaliseName(raw)
      if (author.parts.has(w)) {
        present.add(w)
        return !cased || /^\p{Lu}/u.test(raw)
      }
      return NOT_A_PART.has(w) || PARTICLES.has(w) || author.initials.has(w)
    })
    if (!ok || present.size === 0) continue
    if (present.size === author.parts.size) return { whole: true }
    if (present.size === 1) {
      const part = [...present][0] as string
      return { whole: false, part, ...(part === author.first ? { given: true } : {}) }
    }
  }
  return null
}

/** A capitalised word that may be a name: not a title, particle or conjunction. */
function nameWord(word: string): boolean {
  const f = normaliseName(word)
  return /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(word) && !NOT_A_PART.has(f) && !PARTICLES.has(f) && !CONJUNCTIONS.has(f)
}

/**
 * True when `[start, end)` runs on into another name: across spaces, a
 * hyphen or apostrophe, particles or a conjunction ("Ana Ruiz Pérez",
 * "Ruiz-Pérez", "Ana Ruiz de la Vega", "Ana Ruiz y Pérez"). Punctuation with
 * a space beside it, a line break or a lower-case word ends the scan.
 * 🔴 Fail closed on anything else that is not a letter or a space.
 */
function glued(source: string, start: number, end: number): boolean {
  const oneWay = (from: number, step: 1 | -1): boolean => {
    const at = (k: number) => (step === 1 ? source[k] : source[k - 1])
    let i = from
    for (;;) {
      let gap = false
      let c = at(i)
      while (c === ' ' || c === '\t' || c === ' ' || c === ' ' || c === ' ') {
        gap = true
        i += step
        c = at(i)
      }
      if (c === undefined || c === '\n' || c === '\r') return false
      if (/[-‐‑'’]/u.test(c)) return true
      if (/[.,;:!?…"“”«»()¿¡|]/u.test(c)) return !gap && /\p{L}/u.test(at(i + step) ?? '')
      if (!/[\p{L}\p{M}]/u.test(c)) return true
      let k = i
      while (/[\p{L}\p{M}]/u.test(at(k) ?? '')) k += step
      const word = step === 1 ? source.slice(i, k) : source.slice(k, i)
      if (nameWord(word)) return true
      const f = normaliseName(word)
      if (!PARTICLES.has(f) && !CONJUNCTIONS.has(f)) return false
      i = k
    }
  }
  return oneWay(end, 1) || oneWay(start, -1)
}

export interface AuthorRestoreEvidence extends RestoreEvidence {
  /** Every name stage 1 redacted (its `person` calls): a co-author, a forged byline. */
  structural: readonly string[]
}

/**
 * Restore a document's actual authors in a READY output. Returns the output
 * unchanged whenever any rule says no. `kept` is each distinct restored text.
 */
export function restoreAuthors(
  source: string,
  output: string,
  authorNames: readonly string[],
  evidence: AuthorRestoreEvidence,
  /** `[start, end)` of each byline piece stage 1 kept, in `source`. */
  bylines: ReadonlyArray<readonly [number, number]> = [],
): { text: string; kept: string[] } {
  const none = { text: output, kept: [] }
  const authors = authorNames.map(authorOf).filter((a): a is Author => a !== null)
  if (authors.length === 0) return none
  const aligned = alignPlaceholders(source, output, { sourcePlaceholders: true })
  if (aligned === null || aligned.length === 0) return none

  // Parts some OTHER person may carry. A finding naming an author whole or by
  // one part is the author; a roster member or a stage-1 name must name them
  // whole (one word there is a different, unnamed person).
  const shared = new Set<string>()
  const findings = [...evidence.stage3, ...evidence.verify, ...evidence.unlocated].map((f) => f.text)
  for (const t of findings) if (namedBy(t, authors, false) === null) for (const p of partsOf(t)) shared.add(p)
  for (const t of [...evidence.roster, ...evidence.structural]) {
    if (namedBy(t, authors, false)?.whole !== true) for (const p of partsOf(t)) shared.add(p)
  }

  const inByline = (start: number, end: number) => bylines.some(([s, e]) => start >= s && end <= e)
  const restorable = (start: number, end: number): boolean => {
    if (inByline(start, end)) return true
    const original = source.slice(start, end)
    if (/[\d\n\r[\]]/u.test(original) || !wholeWord(source, start, end) || glued(source, start, end)) return false
    const named = namedBy(original, authors, true)
    if (named === null) return false
    // 🔴 A bare GIVEN name is never restored (audit P1): "Ana" alone is as
    // likely a neighbour as the author. A bare surname is, unless shared.
    return named.whole || (named.given !== true && !shared.has(named.part as string))
  }

  let text = ''
  let last = 0
  const kept = new Set<string>()
  let i = 0
  for (const m of output.matchAll(PLACEHOLDER_PATTERN)) {
    const p = aligned[i++]
    if (p === undefined) return none
    text += output.slice(last, m.index)
    last = m.index + m[0].length
    if (p.label.startsWith('[Persona ') && restorable(p.start, p.end)) {
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
