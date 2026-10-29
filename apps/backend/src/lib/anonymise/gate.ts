/**
 * THE GATE ITSELF — four stages, one allocator, and exactly two possible
 * answers.
 *
 * ── 🔴 THERE IS NO "INGEST ANYWAY" AND NO PARTIAL SUCCESS ───────────────────
 *
 * `@edc/ai-client` HAS NO PER-DOCUMENT DELETE. Retirement closes a validity
 * window (`admin.setDocumentValidity`); the chunk and its embedding stay in the
 * corpus forever, and a retrieve that forgets `asOf` still sees them (see
 * `lib/publishDocument.ts`). So a document ingested with a name still in it is,
 * for practical purposes, PERMANENT. There is no button that fixes it later and
 * no migration that unsays it.
 *
 * That is why this function returns `ready | hold` and nothing in between. Not
 * "ready with warnings", not a `force` flag, not a confidence score the caller
 * can decide to ignore at 5pm on a Friday. Every uncertain outcome — a model
 * that would not answer, JSON that would not parse, a name still standing after
 * the scrub — ends in `hold`, which means the content was NOT ingested and a
 * human has to look. `hold` is a REFUSAL, not an error: nothing is broken, we
 * simply do not know that the text is safe, and "we do not know" must never
 * resolve to "ship it".
 *
 * ── THE FOUR STAGES, AND WHY THE ORDER IS THIS ORDER ────────────────────────
 *
 *   1 structural     dates coarsened, uuids and author markers stripped
 *   2 deterministic  emails, phones, CURP/RFC, C.P., urls, roster members
 *   3 content        the model DETECTS; this file REPLACES
 *   4 verify         the same detector, re-run over the REDACTED text; by
 *                    default it only judges (leftover → hold). Opt-in
 *                    rounds redact leftovers and verify again
 *
 * The two cheap deterministic stages run first so the text the model sees is
 * already smaller and so their removals are never charged to the model's
 * accuracy. Stage 4 is the only stage that can fail on something the earlier
 * ones produced, which is exactly why it is last and why it is not optional.
 *
 * ── ONE ALLOCATOR, THREADED THROUGH ALL OF IT ───────────────────────────────
 *
 * 🔴 Stage 2 and stage 3 share the SAME {@link createPseudonymAllocator}
 * instance. A member matched from the roster in stage 2 and named again in a
 * sentence the model catches in stage 3 must come out as the same
 * `[Persona A]`. Two allocators would restart at `A` and silently merge two
 * different people into one pseudonym — a redaction that fabricates a
 * relationship that never existed.
 *
 * ── 🔴 WHAT THE REPORT MAY CONTAIN ──────────────────────────────────────────
 *
 * COUNTS AND RULE LABELS ONLY. Never a matched string, never a pseudonym→name
 * mapping, never a quoted excerpt — not in `removed`, not in `note`, and not in
 * a hold `reason`. Putting the matched strings in the report would recreate,
 * under a friendlier name, precisely the re-identification map this whole design
 * refuses to keep: `GateReport` is stored and shown in an admin panel, so a
 * report that quoted the names would put the names back in the database the
 * moment the gate finished removing them. The verify reason therefore says HOW
 * MANY findings survived and nothing else.
 */

import { clearFoldCache, foldedMatches, looseMatches, positiveIntFromEnv } from './detector'
import { deterministicPass } from './deterministic'
import { isGenericPlace } from './genericPlaces'
import { createNamePartRegistry, gluedToAnotherName, namePartsOf, type NamePartRegistry, sentenceStart } from './nameParts'
import { createPseudonymAllocator, normaliseName } from './pseudonyms'
import { structuralPass } from './structural'
import { restorePublicFigures } from './publicFigureRestore'
import { isTownLevelPlace } from './townPlaces'
import type {
  DetectorFinding,
  GateInput,
  GateReport,
  GateResult,
  GateStage,
  GateStageReport,
  PersonDetector,
  RedactionCount,
  SurvivorSpan,
} from './types'
import { OMITTED_PLACEHOLDER, PLACEHOLDER_PATTERN } from './types'
import { wholeWord } from './wordBreaks'

export interface GateDeps {
  detector: PersonDetector
  /** Verify rounds. Default: `ANONYMISE_VERIFY_ROUNDS`, else {@link DEFAULT_VERIFY_ROUNDS}. */
  verifyRounds?: number
}

/** Env var name, so docs and tests never hand-type a string that can drift. */
export const ANONYMISE_VERIFY_ROUNDS_VAR = 'ANONYMISE_VERIFY_ROUNDS'

/**
 * Verify passes at most, per document. Each pass that finds leftovers redacts
 * them and hands the text to the next pass; the LAST pass only judges.
 *
 * 🔴 DEFAULT 1: verify only judges, and any leftover HOLDS the document. That
 * is fail-closed: a human reads every text verify was unsure about.
 *
 * More rounds are an opt-in (`ANONYMISE_VERIFY_ROUNDS=3`), not the default,
 * because they let whole names through. Measured 2026-10-17 (UTC 22:27-23:08),
 * host `torre`, local stack, real model, up to 3 rounds, 1,195 / 4,866 / 9,454
 * words: 2 of 18 runs reached `ready` with a whole name still in it ("el Chacho
 * Melgarejo", "Lucrecia"), both on the 4,866-word text (2 of 12 in the last two
 * batches). A later round that finds nothing does not prove an earlier round
 * redacted everything. Raw rows: `scripts/measurements/anonymise-gate-2026-10-17-
 * rounds-batch{1,2,3}.jsonl`.
 *
 * At the default — measured 2026-10-21 (UTC 22:54-23:03), host `torre`, load
 * average 3-19, same harness and sizes, 2 runs each, GATE_VARY=1: 6 of 6 runs
 * held at verify, 0 reached `ready`; $0.236 in total. Raw rows:
 * `scripts/measurements/anonymise-gate-2026-10-21-1round.jsonl`. Each extra
 * round costs about what stage 3 costs (inferred: same chunks, same prompt).
 */
export const DEFAULT_VERIFY_ROUNDS = 1

/**
 * Every placeholder this pipeline can emit.
 *
 * ⚠ Used by stage 4 to tell "the model found a name we missed" from "the model
 * found the word `Persona` inside our own placeholder". Without this the gate
 * would HOLD on every document it successfully redacted — the safest possible
 * failure, and a completely useless product.
 */
const PLACEHOLDER = PLACEHOLDER_PATTERN

/**
 * What every refusal tells the person reading the queue. Plain Spanish, no
 * "ingerir": the reader is a community reviewer, not an engineer.
 */
const NOT_ADDED = 'Todavía no se agregó a la búsqueda.'

/** `1 dato que podría` / `7 datos que podrían`. The count is the number of HIGHLIGHTS. */
function survivorsSentence(count: number): string {
  return count === 1
    ? 'Quedó 1 dato que podría identificar a alguien.'
    : `Quedaron ${count} datos que podrían identificar a alguien.`
}

/**
 * Drop findings that are only a common place noun ("la escuela").
 *
 * ⚠ Applied to stage 3 AND stage 4 alike. Dropping in one stage only would
 * either leave a phrase verify then holds on, or redact one verify ignores.
 * See `genericPlaces.ts` for how narrow the rule is.
 */
function withoutGenericPlaces(findings: readonly DetectorFinding[]): DetectorFinding[] {
  return findings.filter((f) => !isGenericPlace(f))
}

function countsByLabel(entries: Iterable<string>): RedactionCount[] {
  const tally = new Map<string, number>()
  for (const label of entries) tally.set(label, (tally.get(label) ?? 0) + 1)
  return [...tally].map(([label, count]) => ({ label, count }))
}

/** Character ranges in `text` occupied by placeholders we inserted. */
function placeholderSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const m of text.matchAll(PLACEHOLDER)) {
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

export { nameGroups } from './publicFigureRestore'

/**
 * True when every occurrence of `needle` sits inside a placeholder.
 *
 * 🔴 OCCURRENCES IN ANY SPELLING (audit 2026-10-28, item 3): case, accents,
 * whitespace, hyphens and apostrophes ignored (`looseMatches`). An exact
 * `indexOf` called "nicefora tlapalcoyotl" covered when the text said
 * "Nicéfora\nTlapalcoyotl", and verify returned `ready`.
 *
 * ⚠ NO OCCURRENCE AT ALL COUNTS AS COVERED only because the gate has already
 * held on every span it cannot place (`unlocatable`, fail closed). What is left
 * with no occurrence is an echo of a span our own redaction removed.
 */
function coveredByPlaceholder(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  needle: string,
): boolean {
  return looseMatches(text, needle).every(([at, end]) => spans.some(([s, e]) => at >= s && end <= e))
}

/**
 * 🔴 THE SPANS THE DETECTOR REPORTED THAT ARE IN NONE OF `texts`, in any
 * spelling, not even inside a placeholder (audit 2026-10-28, item 3: FAIL
 * CLOSED). Both the findings and the detector's own `unlocated` list count.
 * A span we cannot place is personal data we cannot see: a human decides.
 *
 * `texts` is the text the detector read, then the texts a span may legitimately
 * come from instead: our redacted output (a word of our own placeholders) and
 * the original document (an echo of a span our redaction already removed —
 * every occurrence of it was rewritten, so it is not a leak).
 *
 * ⚠ Not counted: spans under two characters (the detector discards those) and
 * spans made only of our placeholders (`onlyPlaceholders`, they name nobody).
 *
 * ⚠ ONE TEXT AT A TIME, the later ones only for the misses: the loose fold
 * caches one text, so alternating would re-fold a long document per span.
 */
function unlocatable(
  texts: readonly string[],
  found: readonly DetectorFinding[],
  unlocated: readonly DetectorFinding[],
): number {
  let missing = [...found, ...unlocated].filter((f) => f.text.trim().length >= 2 && !onlyPlaceholders(f.text))
  for (const text of texts) missing = missing.filter((f) => looseMatches(text, f.text).length === 0)
  return missing.length
}

function unlocatableSentence(count: number): string {
  return count === 1
    ? 'La revisión automática señaló un dato que no se pudo ubicar en el texto. Una persona tiene que revisarlo.'
    : `La revisión automática señaló ${count} datos que no se pudieron ubicar en el texto. Una persona tiene que revisarlo.`
}

/**
 * Replace every occurrence of `needle` that does not cut into a placeholder.
 * Returns null when nothing was replaced.
 *
 * 🔴 MEASURED 2026-10-17, 9,454 words: stage 2 had written `[Domicilio E]`, the
 * model then returned part of it as a finding, and a plain split/join turned
 * every such placeholder into `[[Domicilio AH]E]`. Verify held on 13 of them.
 * An occurrence that lies inside a placeholder, or straddles its edge, is
 * skipped; one that wholly CONTAINS a placeholder is replaced (that only
 * removes more text).
 *
 * Literal `indexOf` rather than a built RegExp: the finding is arbitrary user
 * text and `new RegExp(finding.text)` would either throw on a stray `(` or,
 * worse, silently match something else entirely.
 *
 * `folded`: replace every case and accent spelling ("LUCRECIA" for "Lucrecia"),
 * and WHOLE WORDS ONLY, exact matches included: "Ana" never takes the "Ana" in
 * "Anabel" nor the "ana" in "mañana". Stage 3 and verify rounds both pass it.
 */
function replaceOutsidePlaceholders(
  text: string,
  needle: string,
  replacement: (at: number, end: number) => string,
  folded = false,
  accept: (at: number) => boolean = () => true,
): string | null {
  const spans = placeholderSpans(text)
  const ranges: Array<[number, number]> = []
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if ((!folded || wholeWord(text, at, at + needle.length)) && accept(at)) ranges.push([at, at + needle.length])
  }
  if (folded) ranges.push(...foldedMatches(text, needle).filter(([s, e]) => wholeWord(text, s, e) && accept(s)))
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let result = ''
  let copied = 0
  for (const [at, end] of ranges) {
    // Overlaps one already replaced.
    if (at < copied) continue
    const cuts = spans.some(([s, e]) => at < e && end > s && !(at <= s && end >= e))
    if (cuts) continue
    result += text.slice(copied, at) + replacement(at, end)
    copied = end
  }
  // `copied` only moves on a replacement, and a needle is never empty.
  return copied === 0 ? null : result + text.slice(copied)
}

/**
 * Replace findings, LONGEST FIRST.
 *
 * 🔴 THE ORDER IS A REAL BUG FIX, NOT TIDINESS. Models routinely return both
 * "María" and "María López". Shortest-first turns the full name into
 * `[Persona A] López` — the surname survives, glued to a pseudonym, which is
 * worse than leaving the whole name alone because the document now LOOKS
 * redacted. Longest-first consumes the full name, and the later "María" simply
 * finds nothing left to replace.
 */
function applyFindings(
  text: string,
  findings: readonly DetectorFinding[],
  allocate: (name: string) => string,
  allocateAddress: (address: string) => string,
  names: NamePartRegistry,
  folded = false,
): { text: string; labels: string[] } {
  const ordered = [...findings].sort((a, b) => b.text.length - a.text.length)
  const labels: string[] = []
  let out = text
  // 🔴 A one-word person finding that is a part of ONE redacted name takes that
  // name's label: "Fausto" beside "Fausto Arellano" is the same person.
  const personLabel = (span: string) => allocate(names.ownerOf(span, allocate) ?? span)

  for (const finding of ordered) {
    /**
     * 🔴 `lugar` GETS A LABEL, NOT A BAR, and it comes from the SAME allocator
     * stage 2 used. A testimony that says the family moved out of one place and
     * back into it is telling you something; `[Dato omitido]` twice erases
     * whether it was the same place, and a second allocator would restart at `A`
     * and claim it was not. Same argument as people, one namespace down.
     *
     * ⚠ The model's `lugar` covers "domicilios y lugares identificables", so a
     * school can land under `[Domicilio X]`. That reads slightly wrong and is
     * accepted: both are places whose identity we are removing, and splitting
     * them would need the model to make a distinction its prompt never asked for.
     */
    // ⚠ LAZY: a finding that replaces nothing must not use up a label, or the
    // report counts a person who is not in the text and the letters skip.
    // 🔴 A ONE-WORD person finding that belongs to a redacted name takes that
    // name's label, EXCEPT where it is glued to another capitalised name: the
    // same rule `spreadPart` applies (audit 2026-10-27: both "Fausto" and
    // "Fausto Arellano" reported gave "Fausto Martínez" Arellano's label).
    const source = out
    const owner = finding.type === 'persona' ? names.ownerOf(finding.text, allocate) : null
    const ownParts = owner === null ? null : new Set(namePartsOf(owner).map(normaliseName))
    const replacement = (at: number, end: number) =>
      finding.type === 'persona'
        ? ownParts !== null && gluedToAnotherName(source, at, end, ownParts)
          ? allocate(finding.text)
          : personLabel(finding.text)
        : finding.type === 'lugar'
          ? allocateAddress(finding.text)
          : OMITTED_PLACEHOLDER
    let next = replaceOutsidePlaceholders(out, finding.text, replacement, folded)
    // 🔴 THE CONTRACTION RESCUE (measured 2026-10-28, Spark, 4/4 runs): the
    // model copies "del centro de salud de San Gregorio" as "el centro de salud
    // de San Gregorio". "del" and "al" fuse "de"/"a" with "el", so the span is
    // not a whole word in the text and nothing was replaced: the place shipped
    // in clear. Each occurrence of the rest right after "del" or "al" is
    // replaced too, the contraction kept: "del [Domicilio A]".
    // ⚠ A person's `replacement` reads offsets in `source`, so for a person
    // the rescue runs only when the literal pass changed nothing.
    const contracted = /^el\s+/i.exec(finding.text)
    if (contracted !== null && (next === null || finding.type !== 'persona')) {
      const rest = finding.text.slice(contracted[0].length)
      const base = next ?? out
      const afterContraction = (at: number) => /(?:^|[^\p{L}])(?:del|al)\s+$/iu.test(base.slice(Math.max(0, at - 8), at))
      if (/\p{L}/u.test(rest)) next = replaceOutsidePlaceholders(base, rest, replacement, folded, afterContraction) ?? next
    }
    if (next === null) continue
    labels.push(finding.type)
    out = next
    if (finding.type === 'persona') names.add(finding.text)
  }

  // 🔴 THEN EVERY NAME PART, ALONE (dev, 2026-10-26; owner's Q5). See
  // `nameParts.ts`: "Fausto Arellano" reported once also takes every bare
  // "Fausto" and "Arellano", capitalised, with the same label.
  for (const { part, siblings } of names.parts()) {
    const spread = spreadPart(out, part, siblings, allocate, personLabel)
    if (spread === null) continue
    labels.push('persona')
    out = spread
  }

  // ⚠ No title clean-up here: the model owns span boundaries and includes a
  // leading title in the name (detector prompt). If it does not, "la maestra
  // [Persona F]" is published as it stands (owner, 2026-10-21, Q1).
  return { text: out, labels }
}

/**
 * Replace every capitalised whole-word occurrence of `part`, accent-blind,
 * that does not touch a placeholder. Null when nothing was replaced.
 *
 * ⚠ The label is chosen PER OCCURRENCE: one glued to another capitalised name
 * ("Fausto Martínez") takes the part's own label, never the owner's. See
 * `nameParts.ts`.
 */
function spreadPart(
  text: string,
  part: string,
  siblings: ReadonlySet<string>,
  allocate: (name: string) => string,
  personLabel: (span: string) => string,
): string | null {
  const spans = placeholderSpans(text)
  let result = ''
  let copied = 0
  for (const [at, end] of foldedMatches(text, part)) {
    if (at < copied) continue
    if (!wholeWord(text, at, end) || !/\p{Lu}/u.test(text.charAt(at))) continue
    if (spans.some(([s, e]) => at < e && end > s)) continue
    const label = gluedToAnotherName(text, at, end, siblings) ? allocate(part) : personLabel(part)
    result += text.slice(copied, at) + label
    copied = end
  }
  if (copied === 0) return null
  // A spelling the full span missed ("Lucia  Mendez", two spaces) comes out as
  // one placeholder per part: "[Persona A]  [Persona A]" is one mention.
  return (result + text.slice(copied)).replace(/(\[Persona [A-Z]+\])(?:[ \t]+\1)+/g, '$1')
}

/**
 * True when `finding` holds at least one of our placeholders and nothing else
 * but punctuation and spaces: "[Domicilio AP], [Domicilio AQ]".
 *
 * 🔴 ANY LETTER OR DIGIT OUTSIDE A PLACEHOLDER MAKES IT A LEFTOVER, so
 * "[Persona A] López" and "la maestra [Persona A]" are never dismissed here.
 */
function onlyPlaceholders(finding: string): boolean {
  if (!finding.match(PLACEHOLDER)) return false
  return !/[\p{L}\p{N}]/u.test(finding.replace(PLACEHOLDER, ''))
}

/** The placeholder family a finding type is redacted into, if it has one. */
const FAMILY: Partial<Record<DetectorFinding['type'], RegExp>> = {
  persona: /^\[Persona [A-Z]+\]$/,
  lugar: /^\[Domicilio [A-Z]+\]$/,
}

/** Edge punctuation and spaces, trimmed from what is left around a placeholder. */
const EDGE = /^[\s\p{P}]+|[\s\p{P}]+$/gu

/**
 * A fragment cut out from between placeholders is redacted GLOBALLY, as a
 * literal string, so it must look like a name: at least 3 characters and a
 * capital letter. 🔴 Measured in the 2026-10-21 audit: "[Persona A] de
 * [Persona B]" reduced to "de", and every "de" in the text was replaced.
 */
const MIN_FRAGMENT = 3
function safeFragment(piece: string): boolean {
  return piece.length >= MIN_FRAGMENT && /\p{Lu}/u.test(piece)
}

/**
 * Turn one verify leftover into what to redact, without ever writing inside a
 * placeholder. `{ unsafe: true }` means it cannot be redacted safely: the
 * round HOLDS instead.
 *
 * ⚠ THREE SHAPES:
 *
 *   · No placeholder in it ("Jiutepec"): redact it as it is.
 *   · It extends ONE placeholder of its own family ("[Persona A] López",
 *     "[Domicilio C], Oaxaca"): the leftover is more of THAT entity, so the
 *     whole span becomes that same placeholder. A fresh label would split one
 *     person into two.
 *   · Anything else that touches a placeholder ("Domicilio A], Ana", two
 *     placeholders and a word): only the text OUTSIDE the placeholders is
 *     redacted, piece by piece. A placeholder fragment at either edge is
 *     dropped first, so `[Domicilio A]` is never rewritten into
 *     `[[Domicilio AH]A]`.
 */
function resolveLeftover(
  f: DetectorFinding,
): { absorbInto: string } | { findings: DetectorFinding[] } | { unsafe: true } {
  const inside = f.text.match(PLACEHOLDER) ?? []
  const only = inside[0]
  if (inside.length === 1 && only !== undefined && FAMILY[f.type]?.test(only)) {
    return { absorbInto: only }
  }
  // No placeholder, whole or cut: a plain finding, redacted as it is.
  if (!/[[\]]/.test(f.text)) return { findings: [f] }
  const parts = f.text.split(PLACEHOLDER)
  const pieces = parts
    .map((piece, i) => {
      let p = piece
      // A placeholder cut by the model's span: "A]" or "Domicilio A]" at the
      // start, "[Persona" at the end.
      if (i === 0) p = p.replace(/^[^[\]]*\]/, '')
      if (i === parts.length - 1) p = p.replace(/\[[^[\]]*$/, '')
      return p.replace(EDGE, '')
    })
    .filter((p) => /[\p{L}\p{N}]/u.test(p))
  // 🔴 One weak fragment and the whole leftover holds: redacting the strong
  // pieces only would report a round as clean that left the weak one in.
  if (!pieces.every(safeFragment)) return { unsafe: true }
  return { findings: pieces.map((text) => ({ text, type: f.type })) }
}

/**
 * A BARE TITLE, by shape: verify marked it `identifica: false`, it has no digit,
 * and no capitalised word except one that starts a sentence. "El doctor",
 * "la maestra", "la maestra [Persona A]" (placeholders do not count).
 *
 * 🔴 OWNER'S RULING, 2026-10-21 (Q4, "do process the doc, dont freeze it"): such
 * a finding is not a leftover. Accepted risk: a lower-case nickname ("la
 * güera") passes as a bare title. "Chacho Melgarejo" mid-sentence still holds,
 * and so does every occurrence check: ONE mid-sentence capital anywhere in the
 * text is enough to count. Stage 3 still redacts every finding.
 */
function bareTitle(f: DetectorFinding, text: string): boolean {
  return titleVerdict(f, text) !== 'leftover'
}

/**
 * ONE CAPITALISED WORD: a bare title by shape that is redacted, not passed.
 *
 * 🔴 OWNER'S RULING, 2026-10-21 (Q5, "names get anonimized, independently of
 * num of words"): "Lucrecia llegó." and a "LUCRECIA:" speaker label pass the
 * Q4 shape test only because the capital starts a sentence. Such a finding is
 * redacted, in every spelling, even on the last round: that only removes text.
 * Accepted: a one-word title ("Doctor:") is redacted too.
 */
function titleVerdict(f: DetectorFinding, text: string): 'leftover' | 'pass' | 'redact' {
  if (!bareTitleShape(f, text)) return 'leftover'
  // A placeholder is two words ("Persona", "A"), so "Don [Persona A]" is not one word.
  const oneWord = (f.text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length === 1
  return oneWord && /\p{Lu}/u.test(f.text) ? 'redact' : 'pass'
}

function bareTitleShape(f: DetectorFinding, text: string): boolean {
  // 🔴 Only a person can be a bare title (final audit 2026-10-21): a place,
  // contact or identifier marked false is still a leftover.
  if (f.identifying !== false || f.type !== 'persona') return false
  if (/\p{N}/u.test(f.text.replace(PLACEHOLDER, ''))) return false
  const capitals: number[] = []
  for (const m of f.text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (!/\p{Lu}/u.test(m[0])) continue
    // Inside one of our placeholders: not a word of the finding.
    if ([...f.text.matchAll(PLACEHOLDER)].some((p) => m.index >= p.index && m.index < p.index + p[0].length)) continue
    capitals.push(m.index)
  }
  for (let at = text.indexOf(f.text); at !== -1; at = text.indexOf(f.text, at + 1)) {
    if (!capitals.every((k) => sentenceStart(text, at + k))) return false
  }
  return true
}

/**
 * True when `leftover` adds a name word to `placeholder` that no registered
 * multi-word owner of that label has: "Pérez, [Persona A]" for "María López".
 */
function conflictsWithOwner(
  leftover: string,
  placeholder: string,
  names: NamePartRegistry,
  peek: (name: string) => string | undefined,
): boolean {
  if (!/^\[Persona /.test(placeholder)) return false
  const extra = namePartsOf(leftover.replace(PLACEHOLDER, ' ')).map(normaliseName)
  if (extra.length === 0) return false
  const owners = names.partsWithLabel(placeholder, peek)
  return owners.length > 0 && owners.every((parts) => extra.some((w) => !parts.has(w)))
}

/**
 * Redact one round's leftovers with the document's allocator, so a name caught
 * late gets the label it already had.
 *
 * 🔴 EVERY SPELLING. A leftover is redacted case- and accent-blind as a whole
 * word, the way `locateSpan` finds it. Re-audit 2026-10-21: with rounds=3,
 * "Lucrecia" was redacted, "LUCRECIA" stayed, the next round was silent and
 * the text went `ready`. Exact occurrences are whole words too. Returns the labels actually applied, or
 * null when any leftover cannot be redacted safely (the round then holds).
 */
function redactLeftovers(
  text: string,
  leftovers: readonly DetectorFinding[],
  allocate: (name: string) => string,
  allocateAddress: (address: string) => string,
  names: NamePartRegistry,
  peek: (name: string) => string | undefined,
): { text: string; labels: string[] } | null {
  const labels: string[] = []
  const plain: DetectorFinding[] = []
  let out = text
  // Longest first, for the reason on `applyFindings`.
  for (const f of [...leftovers].sort((a, b) => b.text.length - a.text.length)) {
    const resolved = resolveLeftover(f)
    if ('unsafe' in resolved) return null
    if ('findings' in resolved) {
      plain.push(...resolved.findings)
      continue
    }
    // 🔴 TWO PEOPLE, TWO LABELS (audit 2026-10-27). "[Persona A] López" is
    // more of A; "Pérez, [Persona A]" is NOT when A is "María López": Pérez is
    // a name A never had, so the span is someone else sharing a part, and it
    // gets a label of its own. A title or a one-word owner still absorbs.
    const label = conflictsWithOwner(f.text, resolved.absorbInto, names, peek)
      ? allocate(f.text)
      : resolved.absorbInto
    const next = replaceOutsidePlaceholders(out, f.text, () => label, true)
    if (next === null) continue
    labels.push(f.type)
    out = next
  }
  const applied = applyFindings(out, plain, allocate, allocateAddress, names, true)
  return { text: applied.text, labels: [...labels, ...applied.labels] }
}

/**
 * Every place a survivor occurs in the output, as offsets.
 *
 * ⚠ EVERY occurrence, not the first. A name the model missed usually appears
 * more than once, and a reviewer who fixes only the highlighted one and approves
 * would release the others.
 */
function survivorSpans(text: string, survivors: readonly DetectorFinding[]): SurvivorSpan[] {
  const spans: SurvivorSpan[] = []
  for (const finding of survivors) {
    if (finding.text.length === 0) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(finding.text, from)
      if (at === -1) break
      spans.push({ start: at, end: at + finding.text.length, type: finding.type })
      from = at + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Failure CLASS of a thrown detector error. ⚠ Never the message, never the text. */
/**
 * 🔴 DID THE MODEL NEVER ANSWER? Then the hold is RETRYABLE, not a finding.
 * Only an explicit `infrastructure: true` from `detector.ts` counts; anything
 * else (a parse failure, a bug) stays an ordinary hold — fail closed.
 */
function isInfrastructureFailure(err: unknown): boolean {
  return (err as { infrastructure?: unknown } | null)?.infrastructure === true
}

function failureClassOf(err: unknown): string {
  const named = err as { failureClass?: unknown; name?: unknown }
  if (typeof named?.failureClass === 'string') return named.failureClass
  if (typeof named?.name === 'string') return named.name
  return 'desconocido'
}

export async function runAnonymisationGate(
  input: GateInput,
  deps: GateDeps,
): Promise<GateResult> {
  try {
    return await runGate(input, deps)
  } finally {
    clearFoldCache()
  }
}

async function runGate(input: GateInput, deps: GateDeps): Promise<GateResult> {
  // 🔴 ONE allocator for the whole document, created here and dropped when this
  // function returns. See `pseudonyms.ts`: its lifetime IS the safety property.
  const allocator = createPseudonymAllocator()
  // Same lifetime, same reason: name parts → people, for this document only.
  const names = createNamePartRegistry()
  const stages: GateStageReport[] = []

  // 🔴 KEEP PUBLIC FIGURES (third audit 2026-10-27): the gate runs EXACTLY as
  // with the option off. The model is also asked to classify people, and only
  // a READY result may have public figures restored, after the fact
  // (`publicFigureRestore.ts`). A hold is the option-off hold, unchanged.
  // A `documento` only, never a testimonio or a conversation.
  const keep = input.keepPublicFigures === true && input.contentKind === 'documento'
  const classify = keep ? { classifyPublic: true as const } : {}
  // 🔴 A roster entry in ANY case is a roster entry (third audit): name parts
  // are read from its capitalised form.
  const rosterNames = (input.roster ?? [])
    .filter((e) => !e.includes('@'))
    .map((e) => e.replace(/(^|[\s-])(\p{Ll})/gu, (_m, before: string, ch: string) => before + ch.toUpperCase()))
    .filter((e) => namePartsOf(e).length > 0)
  /** Everything the detector said, for the restore's evidence. */
  const evidence = { stage3: [] as DetectorFinding[], verify: [] as DetectorFinding[], unlocated: [] as DetectorFinding[] }
  const unlocatedOf = (found: unknown): DetectorFinding[] => {
    const u = (found as { unlocated?: unknown } | null)?.unlocated
    return Array.isArray(u) ? u.filter((f): f is DetectorFinding => typeof (f as DetectorFinding)?.text === 'string') : []
  }

  const report = (): GateReport => ({
    stages,
    pseudonyms: allocator.count,
    addresses: allocator.addressCount,
    model: deps.detector.name,
  })

  /**
   * ⚠ `redactedText` ON A HOLD IS FOR A HUMAN TO READ, NOT FOR A CORPUS. See
   * `GateHold` — storing it in a row's `redactedText` column would hand the
   * publish path exactly the text this refusal was about.
   */
  const hold = (
    stage: GateStage,
    reason: string,
    extra?: { redactedText?: string; survivors?: SurvivorSpan[]; retryable?: true },
  ): GateResult => ({
    status: 'hold',
    stage,
    reason,
    report: report(),
    ...(extra ?? {}),
  })
  const ready = (redactedText: string): GateResult => {
    if (!keep) return { status: 'ready', redactedText, report: report() }
    const restored = restorePublicFigures(structural.text, redactedText, { ...evidence, roster: rosterNames })
    return { status: 'ready', redactedText: restored.text, report: report(), keptPublic: restored.kept }
  }

  // ── 1. STRUCTURAL ─────────────────────────────────────────────────────────
  // 🔴 NFC FIRST, so the roster pass, the model and every matcher see one
  // spelling of "é" (final audit 2026-10-21: decomposed "José" was missed).
  // A byline's author takes a label from the SAME allocator, and its name parts
  // are registered, so "Autor: Juan Pérez" and a bare "Pérez" in the body come
  // out as one `[Persona X]` even when the model never reports the name.
  const original = input.text.normalize('NFC')
  const structural = structuralPass(original, {
    person: (name) => {
      names.add(name)
      return allocator.labelFor(name)
    },
  })
  stages.push({ stage: 'structural', removed: structural.removed })

  if (structural.text.trim().length === 0) {
    // ⚠ HOLD, NOT "ready with an empty string". An empty body would ingest a
    // chunk that matches nothing and can never be found or corrected — a silent
    // permanent hole in the corpus. It also almost always means the extraction
    // upstream failed, which is a thing a human should see.
    return hold(
      'structural',
      `El documento no tenía texto que se pudiera leer. ${NOT_ADDED}`,
    )
  }

  // ── 2. DETERMINISTIC ──────────────────────────────────────────────────────
  const deterministic = deterministicPass({
    text: structural.text,
    roster: input.roster,
    allocate: (name) => allocator.labelFor(name),
    // 🔴 THE SAME ALLOCATOR STAGE 3 WILL USE. See the header — one allocator per
    // document is the invariant, and addresses obey it exactly like people do.
    allocateAddress: (address) => allocator.addressLabelFor(address),
  })
  stages.push({ stage: 'deterministic', removed: deterministic.removed })

  // ── 3. CONTENT ────────────────────────────────────────────────────────────
  let found: DetectorFinding[]
  let stage3Raw: DetectorFinding[]
  try {
    const raw = await deps.detector.detect({
      text: deterministic.text,
      contentKind: input.contentKind,
      ...classify,
    })
    evidence.stage3.push(...raw)
    evidence.unlocated.push(...unlocatedOf(raw))
    stage3Raw = raw
    found = withoutGenericPlaces(raw)
  } catch (err) {
    // 🔴 A detector that could not run is NOT "nothing to redact". See
    // `detector.ts`: the whole reason it throws instead of returning `[]` is to
    // land here.
    // The deterministic output is real work already done and a reviewer can act
    // on it, so it travels with the refusal even though the model never ran.
    return hold(
      'content',
      `La revisión automática no pudo terminar (${failureClassOf(err)}). ${NOT_ADDED}`,
      {
        redactedText: deterministic.text,
        ...(isInfrastructureFailure(err) ? { retryable: true as const } : {}),
      },
    )
  }

  // 🔴 EVERY FINDING IS REDACTED, whatever `identifica` says, exactly as on
  // main. Re-audit 2026-10-21: trusting `false` unless the span held a
  // mid-sentence capital let "la güera", "Lucrecia" at a sentence start and a
  // "LUCRECIA:" speaker label through. A bare "el doctor" the model reports
  // becomes `[Persona X]`: over-redaction, accepted.
  // 🔴 EVERY SPELLING, WHOLE WORDS (owner, 2026-10-21, Q2): "Lucrecia" also
  // takes "LUCRECIA" and "lucrecia", with the same label.
  // 🔴 OWNER'S RULING Q10 A (2026-10-23), "the model decides": stage 3 redacts
  // EVERY finding, towns included. Towns stay visible because the prompt says
  // they are not personal data (`DETECT_SYSTEM_PROMPT`), not because code
  // second-guesses a model that reported one. The town rule (`townPlaces.ts`)
  // only decides verify's hold, below, and the place-hold re-run.
  //
  // 🔴 ROSTER NAME PARTS are spread like a finding's. In a `documento`, every
  // member's (owner Q13 A, 2026-10-27: "Itzel" alone for "Itzel Barragán").
  // Elsewhere, the members stage 2 actually caught (audit 2026-10-27): a
  // conversation does not spread the first names of members it never named.
  for (const member of rosterNames) {
    if (input.contentKind === 'documento' || deterministic.text.includes(allocator.labelFor(member))) {
      names.add(member)
    }
  }
  const applied = applyFindings(
    deterministic.text,
    found,
    (name) => allocator.labelFor(name),
    (address) => allocator.addressLabelFor(address),
    names,
    true,
  )
  stages.push({ stage: 'content', removed: countsByLabel(applied.labels) })
  // 🔴 FAIL CLOSED (audit 2026-10-28, item 3): a span the model reported that is
  // nowhere in the text is held, never dropped as a hallucination. The COUNT,
  // never the strings: the reason is stored on the row. Not retryable: the
  // same text gets the same answer.
  const lost = unlocatable([deterministic.text, applied.text, original], stage3Raw, unlocatedOf(stage3Raw))
  if (lost > 0) return hold('content', `${unlocatableSentence(lost)} ${NOT_ADDED}`, { redactedText: applied.text })

  // ── 4. VERIFY, IN ROUNDS ──────────────────────────────────────────────────
  //
  // The same detector, over the OUTPUT. This is the only check in the pipeline
  // that can catch stage 3 having missed something, and it is the reason stage 3
  // was built as a detector rather than a rewriter — you cannot verify a
  // rewriter by running it twice.
  //
  // 🔴 A round that finds leftovers REDACTS them, with the same allocator, and
  // the next round verifies again. The LAST round only judges: what it finds is
  // held, never redacted, because nothing would verify that redaction. A
  // detector error in any round is a hold.
  const rounds =
    deps.verifyRounds !== undefined && deps.verifyRounds >= 1
      ? Math.floor(deps.verifyRounds)
      : positiveIntFromEnv(ANONYMISE_VERIFY_ROUNDS_VAR, DEFAULT_VERIFY_ROUNDS)
  let current = applied.text

  for (let round = 1; ; round++) {
    let survivors: DetectorFinding[]
    let lostNow: number
    try {
      const raw = await deps.detector.detect({ text: current, contentKind: input.contentKind, ...classify })
      evidence.verify.push(...raw)
      evidence.unlocated.push(...unlocatedOf(raw))
      lostNow = unlocatable([current, original], raw, unlocatedOf(raw))
      survivors = withoutGenericPlaces(raw)
    } catch (err) {
      return hold(
        'verify',
        `La segunda revisión automática no pudo terminar (${failureClassOf(err)}). ${NOT_ADDED}`,
        {
          redactedText: current,
          ...(isInfrastructureFailure(err) ? { retryable: true as const } : {}),
        },
      )
    }

    // 🔴 FAIL CLOSED, every round (audit 2026-10-28, item 3): see stage 3.
    if (lostNow > 0) {
      stages.push({ stage: 'verify', round, removed: [], note: `Ronda ${round}: ${unlocatableSentence(lostNow)}` })
      return hold('verify', `${unlocatableSentence(lostNow)} ${NOT_ADDED}`, { redactedText: current })
    }

    const spans = placeholderSpans(current)
    // ⚠ `onlyPlaceholders`: a finding made of our placeholders and punctuation
    // ("[Domicilio AP], [Domicilio AQ]") names nobody.
    // 🔴 `identifica: false` COUNTS ONLY ON A BARE TITLE (`bareTitle`, owner's
    // Q4). Anything else is a leftover whatever the model said about it (audit
    // 2026-10-21: "Chacho Melgarejo" came back marked non-identifying).
    // 🔴 `isTownLevelPlace`: a town, municipality, city or state is SHOWN (owner,
    // 2026-10-21, #12), so it never holds — the prompt says so and the model
    // still marked towns in 31 of 38 dev holds. Colonias, streets, numbers, C.P.,
    // ranchos, parajes and house references still hold. See `townPlaces.ts`.
    const standing = survivors.filter(
      (f) =>
        !coveredByPlaceholder(current, spans, f.text) &&
        !onlyPlaceholders(f.text) &&
        !isTownLevelPlace(f, current),
    )
    const real = standing.filter((f) => !bareTitle(f, current))
    // 🔴 Q5: a one-word name at a sentence start, redacted on ANY round.
    const forced = standing.filter((f) => titleVerdict(f, current) === 'redact')

    if (real.length === 0 && forced.length > 0) {
      const done = redactLeftovers(
        current,
        forced,
        (name) => allocator.labelFor(name),
        (address) => allocator.addressLabelFor(address),
        names,
        (name) => allocator.peekLabel(name),
      )
      // 🔴 A redaction that changed nothing (null, or the same text) is not a
      // redaction: fall through and HOLD (final audit 2026-10-21, B1).
      if (done !== null && done.text !== current) {
        stages.push({
          stage: 'verify',
          round,
          removed: countsByLabel(done.labels),
          note: `Ronda ${round}: se tacharon ${forced.length} nombre(s) de una palabra al inicio de una oración.`,
        })
        return ready(done.text)
      }
    }

    if (real.length === 0 && forced.length === 0) {
      stages.push({
        stage: 'verify',
        round,
        removed: [],
        note: `Ronda ${round}: la segunda revisión no encontró datos personales en el texto ya tachado.`,
      })
      return ready(current)
    }

    const redacted =
      round < rounds
        ? redactLeftovers(
            current,
            [...real, ...forced],
            (name) => allocator.labelFor(name),
            (address) => allocator.addressLabelFor(address),
            names,
            (name) => allocator.peekLabel(name),
          )
        : null

    // ⚠ A round that changed nothing would only see the same leftovers again:
    // hold now instead of paying for that.
    if (redacted === null || redacted.text === current) {
      // 🔴 ONE NUMBER FOR THE WHOLE SCREEN. The queue badge and the detail chips
      // count highlighted OCCURRENCES (`survivors.length`, see `holdReview.ts`),
      // so the reason counts the same thing. Counting distinct findings here
      // showed "7 datos señalados" next to "encontró 4" on dev, 2026-10-21.
      // Q5 names are highlighted too, so the reviewer sees them.
      const located = survivorSpans(current, [...real, ...forced])
      stages.push({
        stage: 'verify',
        round,
        removed: [],
        note: `Ronda ${round}: ${survivorsSentence(located.length)}`,
      })
      // ⚠ THE COUNT, NEVER THE STRINGS. This reason is stored on the row and
      // shown in the admin panel; quoting the surviving names would put them
      // straight back into the database the gate just kept them out of. Whoever
      // reviews the hold reads `redactedText` below, with `survivors` marking
      // where the model saw something — ⚠ NOT the original, which
      // `lib/holdReview.ts` deliberately never returns.
      return hold('verify', `${survivorsSentence(located.length)} ${NOT_ADDED}`, {
        redactedText: current,
        // 🔴 OFFSETS, NEVER THE STRINGS — and they only mean anything against
        // the `redactedText` on this same object. See `SurvivorSpan`.
        survivors: located,
      })
    }

    stages.push({
      stage: 'verify',
      round,
      removed: countsByLabel(redacted.labels),
      note: `Ronda ${round}: la segunda revisión encontró ${real.length} dato(s) personal(es); se tacharon y se revisa de nuevo.`,
    })
    current = redacted.text
  }
}
