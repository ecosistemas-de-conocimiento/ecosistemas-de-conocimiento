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
 *   · Outside a byline piece, it is not glued to another name or placeholder
 *     ("Ana Ruiz Pérez", "Ana Ruiz y Pérez", "Ana Ruiz\nPérez", "Pérez, Ana Ruiz").
 *
 * ⚠ HOMONYMS: this compares text, not people. Someone else with exactly the
 * author's name is shown too (`proteccion-de-datos.md` §3.5).
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

/** Closing words that sit right above a signature ("Atentamente,\nAna Ruiz"): capitalised, never a name. */
const SIGN_OFFS = new Set(['atentamente', 'cordialmente', 'respetuosamente', 'sinceramente', 'saludos', 'saludo', 'abrazos', 'gracias', 'firma'])

/** A capitalised word that may be a name: not a title, particle, conjunction or sign-off. */
function nameWord(word: string): boolean {
  const f = normaliseName(word)
  return /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(word) && !NOT_A_PART.has(f) && !PARTICLES.has(f) && !CONJUNCTIONS.has(f) && !SIGN_OFFS.has(f)
}

/**
 * True when `[start, end)` runs on into another name or a placeholder: across
 * spaces, one line break, a comma or semicolon, a hyphen or apostrophe,
 * particles or a conjunction ("Ana Ruiz Pérez", "Ana Ruiz\nPérez",
 * "Pérez, Ana Ruiz", "Ruiz-Pérez", "Ana Ruiz de la Vega", "Ana Ruiz y Pérez",
 * "[Persona B], Ana Ruiz"). Other punctuation with a space beside it, a blank
 * line or a lower-case word ends the scan.
 * 🔴 Fail closed on anything else that is not a letter or a space. Past a comma
 * or semicolon only a name or placeholder counts: "Ana Ruiz, 2024" and "Ana
 * Ruiz, con Pérez" are free.
 * ⚠ A blank line ends the scan on purpose: "Autora: Ana Ruiz\n\nAna Ruiz habló"
 * is the ordinary document, so a surname alone in the next paragraph is not seen.
 */
function glued(source: string, start: number, end: number): boolean {
  const oneWay = (from: number, step: 1 | -1): boolean => {
    const at = (k: number) => (step === 1 ? source[k] : source[k - 1])
    let i = from
    let pastSeparator = false
    for (;;) {
      const gapFrom = i
      let c = at(i)
      while (c === ' ' || c === '\t' || c === '\u00a0' || c === '\u202f' || c === '\u2009' || c === '\n' || c === '\r') {
        i += step
        c = at(i)
      }
      const gap = i !== gapFrom
      if (c === undefined) return false
      const space = step === 1 ? source.slice(gapFrom, i) : source.slice(i, gapFrom)
      if ((space.match(/\r\n|\n|\r/g) ?? []).length >= 2) return false
      if (/[-‐‑'’]/u.test(c)) return true
      if (c === ',' || c === ';') {
        if (!gap && /\p{L}/u.test(at(i + step) ?? '')) return true
        pastSeparator = true
        i += step
        continue
      }
      if (/[.:!?…"“”«»()¿¡|]/u.test(c)) return !gap && /\p{L}/u.test(at(i + step) ?? '')
      if (!/[\p{L}\p{M}]/u.test(c)) return !pastSeparator || c === '[' || c === ']'
      let k = i
      while (/[\p{L}\p{M}]/u.test(at(k) ?? '')) k += step
      const word = step === 1 ? source.slice(i, k) : source.slice(k, i)
      if (nameWord(word)) return true
      const f = normaliseName(word)
      // ", y Pérez" and ", con Pérez" are a next person, not more of this name.
      if (!PARTICLES.has(f) && (pastSeparator || !CONJUNCTIONS.has(f))) return false
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
