/**
 * KEEP PUBLIC FIGURES — RESTORE AFTER THE FACT (third audit, 2026-10-27).
 *
 * 🔴 SAFE BY CONSTRUCTION, NOT BY SHIELDING. Three audits found ways past a
 * shield that hid public names BEFORE redaction. So the gate now runs exactly
 * as with the option off — stage 2, stage 3 redacting every person, verify
 * with its normal hold rules — and only a `ready` result reaches this file.
 * Here a placeholder may be turned back into the exact original text of a
 * `publica` finding. Nothing else changes:
 *
 *   option-ON output = option-OFF output, except at restored placeholders,
 *   and every restored span is a public finding's exact original text.
 *
 * ── WHEN A PLACEHOLDER IS RESTORED ──────────────────────────────────────────
 *
 *   · The output aligns to the source in exactly ONE way (`alignPlaceholders`);
 *     otherwise nothing is restored.
 *   · The finding passed the demotion rules (`restorableFindings`).
 *   · The placeholder replaced EXACTLY that finding's text, as whole words.
 *   · The original is not glued to another name word, a hyphen or a name
 *     joiner on either side (`gluedToNeighbour`).
 *   · EVERY placeholder carrying that label qualifies. One that does not —
 *     a bare part, a relative, a variant — means the label covers someone the
 *     model did not call public, and the whole label stays redacted.
 */

import { NOT_A_PART } from './nameParts'
import { normaliseName } from './pseudonyms'
import type { DetectorFinding, KeptPublicFigure } from './types'
import { PLACEHOLDER_PATTERN } from './types'
import { wholeWord } from './wordBreaks'

/** Words that may sit INSIDE one person's name: "Fernando de la Cruz". */
const NAME_JOINERS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der'])

/** Words that join two people, in any case: "Y", "con", "AND". */
const CONJUNCTIONS = new Set(['y', 'e', 'o', 'u', 'ni', 'con', 'and'])

/**
 * Most capitalised name words one restorable span may hold. ⚠ Over-redaction
 * accepted: a four-word full name ("María José López Pérez") is never
 * restored, because "Ramiro Saldaña Tadeo Villaseñor" may be two people.
 */
export const MAX_NAME_WORDS = 3

/** A word that is a name word: capitalised, not a title or function word. */
function nameWord(word: string): boolean {
  const folded = normaliseName(word)
  return /^\p{Lu}/u.test(word) && !NOT_A_PART.has(folded) && !CONJUNCTIONS.has(folded)
}

/**
 * The name groups of a span, and how many name words it holds.
 *
 * A group is a run of name words joined only by single spaces and
 * `NAME_JOINERS`. Anything else closes it: any punctuation, a tab, a line
 * break, a conjunction in ANY case ("y", "Y", "Con", "AND"), or any other
 * lower-case word. A title ("Don", "Dr", "El") neither opens nor closes one.
 */
export function nameShape(span: string): { groups: number; nameWords: number } {
  let groups = 0
  let nameWords = 0
  let open = false
  let last = 0
  for (const m of span.matchAll(/[\p{L}\p{M}]+/gu)) {
    const gap = span.slice(last, m.index)
    last = m.index + m[0].length
    if (/[^ ]/u.test(gap)) open = false
    const word = m[0]
    const folded = normaliseName(word)
    if (CONJUNCTIONS.has(folded)) {
      open = false
    } else if (nameWord(word)) {
      if (!open) groups += 1
      open = true
      nameWords += 1
    } else if (!(NAME_JOINERS.has(folded) || NOT_A_PART.has(folded))) {
      open = false
    }
  }
  if (/[^\p{L}\p{M} ]/u.test(span.slice(last))) open = false
  return { groups, nameWords }
}

/** How many name groups a span holds. */
export function nameGroups(span: string): number {
  return nameShape(span).groups
}

/** A span's words for the shared-part test: folded, any case, hyphens and whitespace split. */
function comparableParts(span: string): Set<string> {
  return new Set(
    (span.replace(PLACEHOLDER_PATTERN, ' ').match(/[\p{L}\p{M}]+/gu) ?? [])
      .map(normaliseName)
      .filter((w) => [...w].length >= 2 && !NOT_A_PART.has(w) && !CONJUNCTIONS.has(w)),
  )
}

export interface RestoreEvidence {
  /** Stage 3's findings, as returned (generic places included). */
  stage3: readonly DetectorFinding[]
  /** Every verify round's findings. */
  verify: readonly DetectorFinding[]
  /** Spans the detector reported that could not be placed in the text. */
  unlocated: readonly DetectorFinding[]
  /** Roster member names, any case. */
  roster: readonly string[]
}

/**
 * 🔴 WHICH `publica` FINDINGS MAY BE RESTORED. A candidate is a stage-3
 * person with `publica` + `motivo`, ONE name group and at most
 * {@link MAX_NAME_WORDS} name words. It is demoted when it shares ANY name
 * part (folded) with: a stage-3 finding that is not a candidate, a verify
 * finding that is not a candidate's text, an unlocated span, a roster name,
 * or another demoted candidate (to a fixpoint). No exceptions.
 */
export function restorableFindings(evidence: RestoreEvidence): DetectorFinding[] {
  const candidates = evidence.stage3.filter((f) => {
    if (f.type !== 'persona' || !f.public) return false
    const shape = nameShape(f.text)
    return shape.groups === 1 && shape.nameWords <= MAX_NAME_WORDS
  })
  // A span's key: folded, hyphens as spaces, whitespace collapsed.
  const key = (t: string) => normaliseName(t.replace(/[-‐‑‒–—]/gu, ' '))
  const candidateTexts = new Set(candidates.map((f) => key(f.text)))
  // ⚠ A later finding (verify, or a span that could not be placed) that IS a
  // candidate's text AND is called public again is the model naming the same
  // public figure. Called private, it is a disagreement: private evidence.
  const echo = (f: DetectorFinding) => f.type === 'persona' && f.public !== undefined && candidateTexts.has(key(f.text))
  const sources: string[] = [
    ...evidence.stage3.filter((f) => !candidates.includes(f)).map((f) => f.text),
    ...[...evidence.verify, ...evidence.unlocated].filter((f) => !echo(f)).map((f) => f.text),
    ...evidence.roster,
  ]
  let kept = candidates
  for (;;) {
    const privateParts = new Set(sources.flatMap((t) => [...comparableParts(t)]))
    const next = kept.filter((f) => [...comparableParts(f.text)].every((w) => !privateParts.has(w)))
    if (next.length === kept.length) return next
    sources.push(...kept.filter((f) => !next.includes(f)).map((f) => f.text))
    kept = next
  }
}

/** One placeholder of the output, placed in the source. */
export interface AlignedPlaceholder {
  label: string
  /** Offsets into the SOURCE of the text this placeholder replaced. */
  start: number
  end: number
}

/**
 * Where each placeholder of `output` sits in `source`, or NULL when that is
 * not certain.
 *
 * The output is the source with disjoint, non-empty stretches replaced by
 * placeholders. Its literal pieces are placed leftmost-first and
 * rightmost-first; every valid placement lies between the two, so when they
 * agree the placement is the only one. When they do not, or the source itself
 * holds placeholder-shaped text, nothing is restored.
 */
export function alignPlaceholders(source: string, output: string): AlignedPlaceholder[] | null {
  if (new RegExp(PLACEHOLDER_PATTERN.source).test(source)) return null
  const labels: string[] = []
  const literals: string[] = []
  let last = 0
  for (const m of output.matchAll(PLACEHOLDER_PATTERN)) {
    literals.push(output.slice(last, m.index))
    labels.push(m[0])
    last = m.index + m[0].length
  }
  literals.push(output.slice(last))
  const n = labels.length
  if (n === 0) return source === output ? [] : null
  const first = literals[0] as string
  const tail = literals[n] as string
  if (!source.startsWith(first) || !source.endsWith(tail)) return null
  const tailAt = source.length - tail.length

  // Leftmost: each literal as early as it can go, after a non-empty stretch.
  const left: number[] = [0]
  let pos = first.length
  for (let i = 1; i < n; i++) {
    const at = source.indexOf(literals[i] as string, pos + 1)
    if (at === -1) return null
    left.push(at)
    pos = at + (literals[i] as string).length
  }
  if (tailAt < pos + 1) return null
  left.push(tailAt)

  // Rightmost: each literal as late as it can go, before a non-empty stretch.
  const right: number[] = new Array(n + 1)
  right[n] = tailAt
  right[0] = 0
  let end = tailAt
  for (let i = n - 1; i >= 1; i--) {
    const lit = literals[i] as string
    const at = source.lastIndexOf(lit, end - 1 - lit.length)
    if (at === -1 || at + lit.length > end - 1) return null
    right[i] = at
    end = at
  }
  if (end < first.length + 1) return null

  for (let i = 0; i <= n; i++) if (left[i] !== right[i]) return null

  const out: AlignedPlaceholder[] = []
  for (let i = 0; i < n; i++) {
    const start = (left[i] as number) + (literals[i] as string).length
    out.push({ label: labels[i] as string, start, end: left[i + 1] as number })
  }
  return out
}

/** Whitespace of every kind, and invisible format characters (zero-width space…). */
const GAP = /[\s\p{Z}\p{Cf}]/u
/** Hyphens and dashes of every kind, the soft hyphen, apostrophes. Checked BEFORE `GAP`. */
const HYPHENS = /[\p{Pd}­'’]/u
/** Plain sentence punctuation: a run of it followed by whitespace (or the text's end) ends the scan. */
const SENTENCE_PUNCT = /[.,;:!?…"“”‘«»()[\]¿¡]/u
const LETTER = /[\p{L}\p{M}]/u

/**
 * One direction of `gluedToNeighbour`. `step` is +1 (forward) or -1.
 *
 * 🔴 FAIL CLOSED ON EVERY CHARACTER CLASS (final audit 2026-10-27: a no-break
 * space, a thin space, an underscore or a slash between "Ramiro Saldaña" and
 * "Pérez" stopped the old scan, and the son's name was restored). Walking
 * away from the span:
 *
 *   · whitespace and format characters (`GAP`) are skipped;
 *   · a hyphen or dash (`HYPHENS`) followed, after any gap, by a word: glue;
 *   · a run of plain sentence punctuation with whitespace (or the text's
 *     edge) on either side: the scan stops, no glue ("(Ramiro Saldaña)
 *     firmó", "Ayer. Ramiro Saldaña"); glued on both sides
 *     ("Saldaña.Pérez", "Saldaña;Pérez"): glue;
 *   · any other non-letter ("_", "/", "·", "−", a digit): glue;
 *   · a word: a capitalised name word is glue; a joiner ("de la") or a
 *     conjunction ("y") continues the scan to the next word ("Ramiro Saldaña
 *     y Pérez" is glue); any other word stops it.
 */
function gluedOneWay(source: string, from: number, step: 1 | -1): boolean {
  const at = (k: number) => (step === 1 ? source[k] : source[k - 1]) as string | undefined
  const done = (k: number) => (step === 1 ? k >= source.length : k <= 0)
  let i = from
  for (;;) {
    let hyphen = false
    let gap = false
    // Gaps, hyphens and punctuation runs.
    for (;;) {
      if (done(i)) return false
      const c = at(i) as string
      if (HYPHENS.test(c)) {
        hyphen = true
        i += step
      } else if (GAP.test(c)) {
        gap = true
        i += step
      } else if (SENTENCE_PUNCT.test(c) && !hyphen) {
        // Plain punctuation when whitespace touches the run on either side.
        let k = i
        while (!done(k) && SENTENCE_PUNCT.test(at(k) as string)) k += step
        return !(gap || done(k) || GAP.test(at(k) as string))
      } else if (LETTER.test(c)) {
        break
      } else {
        return true
      }
    }
    if (hyphen) return true
    // The word.
    let k = i
    while (!done(k) && LETTER.test(at(k) as string)) k += step
    const word = step === 1 ? source.slice(i, k) : source.slice(k, i)
    if (nameWord(word)) return true
    const folded = normaliseName(word)
    if (!NAME_JOINERS.has(folded) && !CONJUNCTIONS.has(folded)) return false
    i = k
  }
}

/**
 * True when `[start, end)` of `source` touches another name on either side
 * ("Ramiro Saldaña Pérez", "Saldaña-Pérez", "Saldaña Pérez", "Saldaña
 * de la Garza", "Saldaña y Pérez", "Tomás Ramiro Saldaña"). See
 * {@link gluedOneWay}. ⚠ Also at a sentence start: "Tomás Ramiro Saldaña"
 * may be one three-word name the model reported in part. Over-redaction
 * accepted, including a dash aside ("—Ramiro Saldaña— dijo").
 */
export function gluedToNeighbour(source: string, start: number, end: number): boolean {
  return gluedOneWay(source, end, 1) || gluedOneWay(source, start, -1)
}

/**
 * Restore public figures in a READY output. Returns the output unchanged and
 * nothing kept whenever any rule says no.
 */
export function restorePublicFigures(
  source: string,
  output: string,
  evidence: RestoreEvidence,
): { text: string; kept: KeptPublicFigure[] } {
  const none = { text: output, kept: [] }
  const publics = restorableFindings(evidence)
  if (publics.length === 0) return none
  const aligned = alignPlaceholders(source, output)
  if (aligned === null) return none

  const matchFor = (p: AlignedPlaceholder): DetectorFinding | undefined => {
    if (!p.label.startsWith('[Persona ')) return undefined
    const original = source.slice(p.start, p.end)
    const f = publics.find((c) => c.text === original)
    if (!f || !wholeWord(source, p.start, p.end) || gluedToNeighbour(source, p.start, p.end)) return undefined
    return f
  }
  const verdict = new Map<string, boolean>()
  for (const p of aligned) {
    const ok = matchFor(p) !== undefined
    verdict.set(p.label, (verdict.get(p.label) ?? true) && ok)
  }

  let text = ''
  const kept = new Map<string, string>()
  // `aligned` is in output order; rebuild the output from its own pieces.
  const outLiterals: string[] = []
  let last = 0
  for (const m of output.matchAll(PLACEHOLDER_PATTERN)) {
    outLiterals.push(output.slice(last, m.index))
    last = m.index + m[0].length
  }
  outLiterals.push(output.slice(last))
  aligned.forEach((p, i) => {
    text += outLiterals[i]
    if (verdict.get(p.label)) {
      const f = matchFor(p) as DetectorFinding
      text += source.slice(p.start, p.end)
      if (!kept.has(f.text)) kept.set(f.text, f.public?.motivo ?? '')
    } else {
      text += p.label
    }
  })
  text += outLiterals[aligned.length]
  return { text, kept: [...kept].map(([name, motivo]) => ({ name, motivo })) }
}
