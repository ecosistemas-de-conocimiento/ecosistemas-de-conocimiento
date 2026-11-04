/**
 * KEEP A DOCUMENT'S ACTUAL AUTHOR — RESTORE AFTER THE FACT (owner ruling R60,
 * 2026-10-28, as clarified the same day).
 *
 * 🔴 WHO IS AN AUTHOR: the document's uploader, by their membership's
 * `personName` (`lib/publicFigures.ts` → `documentoGateOptions`), never their
 * self-edited `displayName`. NEVER a name read from the text: a byline is something anyone can type, so
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
 *   · 🔴 THE REPLACED TEXT IS THE WHOLE `personName`, AS WRITTEN THERE. With
 *     "Ana María López": "Ana María López" comes back; "María", "López",
 *     "Ana López", "López, Ana María", "ANA MARÍA LÓPEZ" and "Dra. Ana María
 *     López" never do, in a byline or anywhere else. A part of a name is
 *     anyone's: "María" may be the person the document is about.
 *   · It holds no number of any kind (`\p{N}`: "٣", "②"), line break or bracket.
 *   · Outside a byline piece, it is not glued to another name ("Ana Ruiz
 *     Pérez", "Ana Ruiz y Pérez").
 *
 * Per placeholder, not per label: a bare "Ruiz" stays `[Persona A]` while
 * "Ana Ruiz" beside it is shown. The label then reads as the author's, which
 * is the gate's own attribution and names no one else.
 */

import { NOT_A_PART, namePartsOf } from './nameParts'
import { normaliseName } from './pseudonyms'
import { alignPlaceholders } from './publicFigureRestore'
import { PLACEHOLDER_PATTERN } from './types'
import { wholeWord } from './wordBreaks'

/** Particles inside one name. */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'den'])

/** Words that join two people; like `publicFigureRestore.ts`, they CONTINUE a name for the glue check. */
const CONJUNCTIONS = new Set(['y', 'e', 'o', 'u', 'ni', 'con', 'and'])

/** 🔴 Two distinct name parts at least: a one-word account name is anyone's word. */
const isFullName = (name: string) =>
  new Set(namePartsOf(name.replace(PLACEHOLDER_PATTERN, ' ')).map(normaliseName)).size >= 2

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

/**
 * Restore a document's actual authors in a READY output. Returns the output
 * unchanged whenever any rule says no. `kept` is each distinct restored text.
 */
export function restoreAuthors(
  source: string,
  output: string,
  authorNames: readonly string[],
  /** `[start, end)` of each byline piece stage 1 kept, in `source`. */
  bylines: ReadonlyArray<readonly [number, number]> = [],
): { text: string; kept: string[] } {
  const none = { text: output, kept: [] }
  const names = new Set(authorNames.filter(isFullName))
  if (names.size === 0) return none
  const aligned = alignPlaceholders(source, output, { sourcePlaceholders: true })
  if (aligned === null || aligned.length === 0) return none

  const inByline = (start: number, end: number) => bylines.some(([s, e]) => start >= s && end <= e)
  const restorable = (start: number, end: number): boolean => {
    const original = source.slice(start, end)
    if (!names.has(original.trim()) || /[\p{N}\n\r[\]]/u.test(original)) return false
    // A kept byline piece stands beside its co-authors ("Ana Ruiz y Pedro Gómez").
    return inByline(start, end) || (wholeWord(source, start, end) && !glued(source, start, end))
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
      kept.add(original.trim())
    } else {
      text += m[0]
    }
  }
  text += output.slice(last)
  return { text, kept: [...kept] }
}
