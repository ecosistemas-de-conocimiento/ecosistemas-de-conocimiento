/**
 * KEEP A DOCUMENT'S OWN AUTHORS — RESTORE AFTER THE FACT (owner ruling R60,
 * 2026-10-28: "don't redact authors").
 *
 * 🔴 SAME SHAPE AS PUBLIC FIGURES (`publicFigureRestore.ts`). The gate runs
 * exactly as before: stage 2 redacts roster members, stage 3 redacts every
 * person, verify holds what is left. Only a READY result reaches this file,
 * and here a `[Persona X]` may be turned back into the exact source text it
 * replaced, when that text is one of the authors stage 1 read from a CLEAN
 * byline (`parseByline` in `structural.ts`):
 *
 *   output = gate output, except at restored placeholders, and every restored
 *   span is the exact source text of an author's name.
 *
 * ── WHEN A PLACEHOLDER IS RESTORED ──────────────────────────────────────────
 *
 *   · The output aligns to the source in exactly ONE way (`alignPlaceholders`).
 *   · Every word of the replaced text is a part of ONE author, a title or
 *     particle, a byline key, or one of that author's own initials. So
 *     "Ana Ruiz y Pedro Gómez" in one span is never restored.
 *   · The text names that author WHOLE (all their parts, any order: "Ruiz,
 *     Ana"), or is ONE part of them ("Ruiz") that no other evidence shares —
 *     no finding, roster member or verify span that is not this author.
 *   · The text is whole words, not glued to another name ("Ana Ruiz Pérez").
 *
 * Per placeholder, not per label: one ambiguous "Ruiz" stays `[Persona A]`
 * while "Ana Ruiz" beside it is shown. The label then reads as Ana's, which
 * is the gate's own attribution and names no one else.
 */

import { NOT_A_PART, namePartsOf } from './nameParts'
import { normaliseName } from './pseudonyms'
import { alignPlaceholders, type RestoreEvidence } from './publicFigureRestore'
import { BYLINE_KEY_WORDS } from './structural'
import { PLACEHOLDER_PATTERN } from './types'
import { wholeWord } from './wordBreaks'

/** Particles inside one name. */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'den'])

interface Author {
  /** Folded name parts. */
  parts: ReadonlySet<string>
  /** Folded one-letter initials written in the byline ("M." in "Ana M. Ruiz"). */
  initials: ReadonlySet<string>
}

const words = (s: string) => s.match(/[\p{L}\p{M}]+/gu) ?? []
const partsOf = (s: string) => new Set(namePartsOf(s.replace(PLACEHOLDER_PATTERN, ' ')).map(normaliseName))

function authorOf(name: string): Author | null {
  const parts = partsOf(name)
  if (parts.size === 0) return null
  const initials = new Set(words(name).filter((w) => [...w].length === 1).map(normaliseName))
  return { parts, initials }
}

/** The author `text` names, and whether it names them whole. NULL when it is not only one author's words. */
function namedBy(text: string, authors: readonly Author[]): { author: Author; whole: boolean; part?: string } | null {
  const ws = words(text).map(normaliseName)
  for (const author of authors) {
    const present = new Set<string>()
    const ok = ws.every((w) => {
      if (author.parts.has(w)) {
        present.add(w)
        return true
      }
      return NOT_A_PART.has(w) || PARTICLES.has(w) || BYLINE_KEY_WORDS.has(w) || author.initials.has(w)
    })
    if (!ok || present.size === 0) continue
    // A one-word author is never "whole": "Ruiz" alone may be anyone's Ruiz.
    if (present.size === author.parts.size && author.parts.size >= 2) return { author, whole: true }
    if (present.size === 1) return { author, whole: false, part: [...present][0] as string }
  }
  return null
}

/** Every word of `text` is a part, a title, a particle, a key or an initial of `author`. */
function namedByAll(text: string, author: Author): boolean {
  const ws = words(text).map(normaliseName)
  return (
    ws.some((w) => author.parts.has(w)) &&
    ws.every((w) => author.parts.has(w) || NOT_A_PART.has(w) || PARTICLES.has(w) || BYLINE_KEY_WORDS.has(w) || author.initials.has(w))
  )
}

/** A capitalised word that may be a name: not a title, particle or conjunction. */
function nameWord(word: string): boolean {
  const f = normaliseName(word)
  return /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(word) && !NOT_A_PART.has(f) && !PARTICLES.has(f)
}

/**
 * True when `[start, end)` runs on into another name: across spaces, a
 * hyphen or apostrophe, or particles ("Ana Ruiz Pérez", "Ruiz-Pérez", "Ana
 * Ruiz de la Vega"). Punctuation, a line break, a conjunction ("y") or a
 * lower-case word ends the scan: "Ana Ruiz y Luis Gómez" is two names.
 * 🔴 Fail closed on anything else that is not a letter or a space.
 */
function glued(source: string, start: number, end: number): boolean {
  const oneWay = (from: number, step: 1 | -1): boolean => {
    const at = (k: number) => (step === 1 ? source[k] : source[k - 1])
    let i = from
    for (;;) {
      let gap = false
      let c = at(i)
      while (c === ' ' || c === '\t' || c === ' ') {
        gap = true
        i += step
        c = at(i)
      }
      if (c === undefined || c === '\n' || c === '\r') return false
      if (/[-‐‑'’]/u.test(c)) return true
      if (/[.,;:!?…"“”«»()¿¡|]/u.test(c)) return !gap && /[\p{L}]/u.test(at(i + step) ?? '')
      if (!/[\p{L}\p{M}]/u.test(c)) return true
      let k = i
      while (/[\p{L}\p{M}]/u.test(at(k) ?? '')) k += step
      const word = step === 1 ? source.slice(i, k) : source.slice(k, i)
      if (nameWord(word)) return true
      if (!PARTICLES.has(normaliseName(word))) return false
      i = k
    }
  }
  return oneWay(end, 1) || oneWay(start, -1)
}

/**
 * Restore a document's own authors in a READY output. Returns the output
 * unchanged whenever any rule says no.
 */
export function restoreAuthors(
  source: string,
  output: string,
  authorNames: readonly string[],
  evidence: RestoreEvidence,
  /** `[start, end)` of each kept byline in `source` (`structuralPass`). */
  bylines: ReadonlyArray<readonly [number, number]> = [],
): { text: string; kept: string[] } {
  const none = { text: output, kept: [] }
  const authors = authorNames.map(authorOf).filter((a): a is Author => a !== null)
  if (authors.length === 0) return none
  const aligned = alignPlaceholders(source, output, { sourcePlaceholders: true })
  if (aligned === null || aligned.length === 0) return none

  // Parts some OTHER person may carry: from any span that does not name an
  // author whole or by one part (findings), or whole (roster: a roster member
  // named by one word is a different, unnamed person).
  const shared = new Set<string>()
  const spans = [...evidence.stage3, ...evidence.verify, ...evidence.unlocated].map((f) => f.text)
  for (const t of spans) if (namedBy(t, authors) === null) for (const p of partsOf(t)) shared.add(p)
  for (const r of evidence.roster) if (namedBy(r, authors)?.whole !== true) for (const p of partsOf(r)) shared.add(p)

  // Inside a kept byline every name word is an author's by construction
  // (`parseByline`), so any part of any author there comes back, shared or not.
  const anyAuthor: Author = {
    parts: new Set(authors.flatMap((a) => [...a.parts])),
    initials: new Set(authors.flatMap((a) => [...a.initials])),
  }
  const inByline = (start: number, end: number) => bylines.some(([s, e]) => start >= s && end <= e)

  const restorable = (start: number, end: number): boolean => {
    const original = source.slice(start, end)
    if (/[\d\n\r[\]]/u.test(original) || !wholeWord(source, start, end)) return false
    if (inByline(start, end) && namedByAll(original, anyAuthor)) return true
    if (glued(source, start, end)) return false
    const named = namedBy(original, authors)
    if (named === null) return false
    return named.whole || !shared.has(named.part as string)
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
