/**
 * STAGE 2 — THE DETERMINISTIC PASS. Regexes and the roster.
 *
 * ── ⚠ READ THIS BEFORE YOU TRUST THIS STAGE: FOR A TESTIMONY IT IS CLOSE TO
 *    USELESS, AND THAT IS NOT A BUG ────────────────────────────────────────────
 *
 * This is the owner's explicit correction to an earlier design that leaned on
 * dictionary matching. Stating it plainly, because the code below LOOKS like the
 * anonymiser and is not:
 *
 *   · In a CONVERSACIÓN the speakers are members of the ecosistema. We hold a
 *     roster of their names and emails, so `persona-roster` does real work.
 *   · In a TESTIMONIO the people named — the speaker, their mother, a neighbour,
 *     the official who turned them away — ARE NOT USERS OF THIS SYSTEM. No
 *     roster contains them and no roster ever will. Passing `roster: []` for a
 *     testimony is the CORRECT call, not a shortcut someone forgot to finish.
 *
 * 🔴 SO FOR A VOZ, THE MECHANISM IS STAGE 3 (`detector.ts`). What survives here
 * is the structured stuff that has a shape rather than a dictionary: emails,
 * phones, CURP, RFC, URLs, handles, long digit runs, postal codes. Street
 * addresses are free-form and go to the model (owner, Q3). Real, worth removing,
 * cheap — and nowhere near sufficient on its own. Do not ship testimony
 * redaction on this file.
 *
 * ── ⚠ ORDER IS LOAD-BEARING: SPECIFIC BEFORE GREEDY ─────────────────────────
 *
 * Every rule here replaces its match with a placeholder, so whichever pattern
 * runs first WINS the characters. Two concrete failures this ordering prevents:
 *
 *   · `numero-largo` (`\d{8,}`) run before `email` eats the digits out of
 *     `ana1998765@correo.mx`, leaving `ana[Dato omitido]@correo.mx`. The email
 *     rule then never fires — its match no longer exists — and the report proudly
 *     says one `numero-largo` was removed while the DOMAIN and the local part,
 *     which are the identifying half, are still sitting in the corpus.
 *   · `url` run before `email` claims `correo.mx` out of the same address, with
 *     the same result from the other end.
 *
 * And the roster runs FIRST of all, TOGETHER with `email`, `url` and `arroba`
 * (`rosterAndAddresses`), on purpose: a roster entry that happens to be an
 * email address must become that member's `[Persona X]` label — which keeps the
 * sentence readable — rather than an anonymous `[Dato omitido]` that loses the
 * fact that the same person appears twice. And a member's name INSIDE an
 * address must go with the address, as one `[Dato omitido]`.
 *
 * ── PLACEHOLDERS ARE INERT BY CONSTRUCTION ──────────────────────────────────
 *
 * `[Dato omitido]` and `[Persona A]` contain no digits, no `@` and no dots, so
 * no later rule in this file can match inside one. That is why a single left-to-
 * right sequence of `String.replace` calls is safe here and does not need the
 * span-tracking machinery stage 3 uses.
 */

import { createPseudonymAllocator } from './pseudonyms'
import type { RedactionCount } from './types'
import { OMITTED_PLACEHOLDER, PLACEHOLDER_PATTERN } from './types'
import { breakAt, wholeWord } from './wordBreaks'

/**
 * The rule names that appear in {@link RedactionCount.label}.
 *
 * 🔴 These are RULE names, never matched text. See the note in `types.ts`: a
 * report carrying the strings would be the re-identification map this design
 * refuses to keep.
 */
export const DETERMINISTIC_LABELS = {
  rosterPerson: 'persona-roster',
  email: 'email',
  telefono: 'telefono',
  curp: 'curp',
  rfc: 'rfc',
  url: 'url',
  arroba: 'arroba',
  numeroLargo: 'numero-largo',
  /** `C.P. 06700`. The only address shape this stage takes (owner, Q3). */
  codigoPostal: 'codigo-postal',
} as const

/** Every Unicode mark, not only U+0300–036F: "Ana" + VS16 or U+20DD is still Ana. */
const MARKS = '\\p{M}'

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A regex that matches `entry` case- and accent-insensitively, on word
 * boundaries.
 *
 * ⚠ WHY THE TEXT IS DECOMPOSED (NFD) RATHER THAN THE ACCENTS TABLE-MAPPED. The
 * roster says "María López"; the transcript says "Maria Lopez", "MARÍA LÓPEZ",
 * or "María  López" with the double space a transcriber left behind. Matching
 * only the exact bytes leaves a member's real name in the shared corpus, which
 * is the exact failure this stage exists to prevent. Decomposing turns `í` into
 * `i` + U+0301, so every letter can carry `\p{M}*` (any mark) and the accents
 * become optional without a hand-written variant table that always misses `ñ`.
 *
 * ⚠ `\b` IS NOT USED, AND NEITHER IS A LOOKAROUND. Word edges are decided by
 * `wordBreaks.ts`, the same rules stage 3 uses (Rodrigo's ruling 2026-10-21):
 * a digit and a lower-to-upper change end a word ("maria88", "MaríaLópez"), an
 * accent mark never does ("Mañana" keeps its "ana"). A space in the entry may
 * be absent in the text only where the text has a word break there.
 *
 * Each space in the entry becomes a capture group, read back with the `d` flag
 * by {@link replaceRoster}.
 */
function rosterPattern(entry: string): RegExp {
  const base = entry.normalize('NFD').replace(new RegExp(`[${MARKS}]`, 'gu'), '')
  // ⚠ A run of spaces is ONE gap. Two `(\s*)` side by side can split the same
  // whitespace every possible way, and a failed match then backtracks through
  // all of them: 12 spaces took minutes on 300 characters (re-audit).
  const body = base
    .trim()
    .split(/\s+/)
    .map((word) => [...word].map((ch) => `${escapeRegExp(ch)}[${MARKS}]*`).join(''))
    .join('(\\s*)')
  return new RegExp(body, 'giud')
}

/** A stretch of the decomposed text that one placeholder replaces. */
interface Span {
  start: number
  end: number
  /** A `DETERMINISTIC_LABELS` rule for an address; the member's label for a person. */
  rule: string
  person?: boolean
}

/**
 * Join overlapping spans into one. The span that starts first names the rule
 * (on a tie, the longer one): a URL that carries an email stays a `url`.
 *
 * ⚠ Sorts ONCE. Call it once per text, never inside a loop over matches: the
 * audit measured 92 s on 500 KB when every partial overlap re-merged the list.
 */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start || y.end - x.end)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s.start < last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Characters an email's local part and domain may hold. See {@link EMAIL}. */
const LOCAL_CHAR = /[\p{L}\p{M}\p{N}._%+-]/u
const DOMAIN_CHAR = /[\p{L}\p{M}\p{N}.-]/u

/**
 * Every email in `text`, each one WHOLE.
 *
 * {@link EMAIL} is bounded (64 / 255) so a failed search stays linear. A real
 * text can still hold a longer part, and the bounded match then covers only
 * the end of it: "mariagonz" was left before the placeholder (audit). So each
 * match grows LEFT over local-part characters and RIGHT over domain
 * characters, minus a trailing `.` or `-` (the full stop after an address).
 *
 * Linear: the search resumes where the grown match ends, and growing left
 * stops at the `@` before it (not a local-part character), so a character is
 * crossed by at most one later match. Overlaps are merged by the caller.
 */
function emailSpans(text: string): Span[] {
  const out: Span[] = []
  const re = new RegExp(EMAIL.source, EMAIL.flags)
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let start = m.index
    let end = start + m[0].length
    while (start > 0 && LOCAL_CHAR.test(text.charAt(start - 1))) start--
    while (end < text.length && DOMAIN_CHAR.test(text.charAt(end))) end++
    while (/[.-]/.test(text.charAt(end - 1))) end--
    out.push({ start, end, rule: DETERMINISTIC_LABELS.email })
    re.lastIndex = end
  }
  return out
}

/**
 * Every email, URL and handle in `text`, merged, computed ONCE per text.
 *
 * 🔴 Same text form and same character classes as the roster. These rules run
 * on the decomposed text, with letters AND accent marks in their classes, so a
 * name inside an address lies inside exactly one span. The ASCII-only versions
 * stopped at the first accent: "maría@gmail.com" became "marí" + a span, and
 * the name beside it survived (re-audit 2026-10-21).
 */
function addressSpans(text: string): Span[] {
  const rules: Array<[RegExp, string]> = [
    [URL, DETERMINISTIC_LABELS.url],
    [ARROBA, DETERMINISTIC_LABELS.arroba],
  ]
  return mergeSpans([
    ...emailSpans(text),
    ...rules.flatMap(([re, rule]) =>
      [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, rule })),
    ),
  ])
}

/**
 * The roster and the address rules, in ONE pass over the decomposed `text`.
 *
 * Each entry, longest first, claims its whole-word matches. Then:
 *
 *   · a match that IS an address (a roster entry that is an email) takes the
 *     member's label instead of `[Dato omitido]`;
 *   · 🔴 a match that only PARTLY overlaps an address joins it: the address
 *     span grows over the whole name, and the result is one `[Dato omitido]`.
 *     No placeholder is ever spliced into an address, and no letter of the name
 *     is ever left beside one;
 *   · a match inside a placeholder this pipeline emitted is skipped. 🔴 ONLY
 *     those: `[Dato omitido]` and the labels in `ownLabels`. "[Persona ANA]"
 *     typed into a document is ordinary text, and the "Ana" in it is a name
 *     (audit).
 *
 * ⚠ A match rejected for being glued restarts the search ONE character later,
 * not after the match, so a real hit overlapping it is still found.
 *
 * ⚠ LINEAR in the text and the matches. What each character belongs to lives
 * in per-character arrays, so a match costs its own length. The address list is
 * sorted once, at the end; it used to be re-merged on every partial overlap.
 */
function rosterAndAddresses(
  text: string,
  entries: readonly string[],
  labelOf: (entry: string) => string,
  ownLabels: ReadonlySet<string>,
): { text: string; spans: Span[] } {
  const addresses = addressSpans(text)
  const rules = [...new Set(addresses.map((a) => a.rule))]
  /** Index of the address each character is in, or -1. */
  const owner = new Int32Array(text.length).fill(-1)
  /** 1 + index in `rules` for every character an address covers or has grown over. */
  const ruleAt = new Uint8Array(text.length)
  addresses.forEach((a, i) => {
    owner.fill(i, a.start, a.end)
    ruleAt.fill(1 + rules.indexOf(a.rule), a.start, a.end)
  })
  const grown = new Uint8Array(addresses.length)
  const taken = new Uint8Array(addresses.length)
  const joined: Span[] = []
  /** Real placeholders and accepted names: no later match may touch them. */
  const blocked = new Uint8Array(text.length)
  for (const m of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (m[0] === OMITTED_PLACEHOLDER || ownLabels.has(m[0])) {
      blocked.fill(1, m.index, m.index + m[0].length)
    }
  }
  const people: Span[] = []

  for (const entry of entries) {
    const pattern = rosterPattern(entry.trim())
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const start = m.index
      const end = start + m[0].length
      // 🔴 Never accept an empty match: `exec` would return it again forever.
      if (end === start) {
        pattern.lastIndex = start + 1
        continue
      }
      // Where an entry has a space: whitespace always starts a break; an empty
      // gap ("MaríaLópez") must be one too.
      const gaps = (m.indices ?? []).slice(1)
      const ok =
        wholeWord(text, start, end) &&
        gaps.every((g) => g === undefined || breakAt(text, g[0])) &&
        !blocked.subarray(start, end).includes(1)
      if (!ok) {
        pattern.lastIndex = start + 1
        continue
      }
      const exact = owner[start] ?? -1
      const isAddress =
        exact >= 0 &&
        addresses[exact]?.start === start &&
        addresses[exact]?.end === end &&
        grown[exact] === 0
      if (isAddress) {
        taken[exact] = 1
      } else {
        let code = 0
        for (let i = start; i < end && code === 0; i++) code = ruleAt[i] ?? 0
        if (code > 0) {
          for (let i = start; i < end; i++) {
            const a = owner[i] ?? -1
            if (a >= 0) grown[a] = 1
            if (ruleAt[i] === 0) ruleAt[i] = code
          }
          joined.push({ start, end, rule: rules[code - 1] ?? DETERMINISTIC_LABELS.email })
          continue
        }
      }
      people.push({ start, end, rule: labelOf(entry), person: true })
      blocked.fill(1, start, end)
    }
  }

  const merged = mergeSpans([...addresses.filter((_, i) => taken[i] === 0), ...joined])
  const spans = [...people, ...merged].sort((x, y) => x.start - y.start)
  let out = ''
  let copied = 0
  for (const s of spans) {
    out += text.slice(copied, s.start) + (s.person ? s.rule : OMITTED_PLACEHOLDER)
    copied = s.end
  }
  return { text: out + text.slice(copied), spans }
}

/**
 * `ana.lopez+notas@correo.gob.mx`. Deliberately permissive on the local part —
 * a missed address is a leak, an over-matched one is a slightly uglier sentence.
 *
 * Letters and accent marks of any script: it runs on decomposed text (see
 * {@link addressSpans}). ⚠ The parts are BOUNDED (64 / 255, the mail limits):
 * unbounded, a long run with no `@` cost quadratic time. A longer part is
 * still caught: the second branch takes a domain past 255 characters, and
 * {@link emailSpans} grows every match over the rest of its address.
 */
const EMAIL =
  /[\p{L}\p{M}\p{N}._%+-]{1,64}@(?:[\p{L}\p{M}\p{N}.-]{1,255}\.[\p{L}\p{M}]{2,63}|[\p{L}\p{M}\p{N}.-]{256})/gu

/** 18-char CURP. Runs BEFORE the RFC rule, whose shape is its first 13 chars. */
const CURP = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi

/** RFC, both persona física (4 letters) and moral (3). */
const RFC = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/gi

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi

/**
 * Mexican phone numbers: `+52 55 1234 5678`, `(55) 1234-5678`, `5512345678`,
 * `55.1234.5678`. Minimum nine digits, so it cannot claim a year or a short id.
 *
 * ⚠ Runs before `numero-largo` so a spaced-out number is redacted as a PHONE.
 * Otherwise a 10-digit run scores as `numero-largo` and the same number written
 * with separators escapes entirely — inconsistency in the report AND a leak.
 */
const TELEFONO =
  /(?<!\d)(?:\+?52[\s.-]?)?(?:1[\s.-]?)?(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/g

/**
 * `@anitalopez`. Its lookbehind refuses an `@` with a letter before it, so it
 * never starts inside an email; overlaps are merged anyway ({@link addressSpans}).
 *
 * ⚠ The handle may not END on a dot. `[A-Za-z0-9._]{2,30}` is greedy, so on
 * "escríbele a @anita." it swallowed the full stop and the sentence came back
 * without its punctuation — cosmetic here, but the same greed on "@anita.mx" is
 * the difference between a handle and a domain.
 */
const ARROBA =
  /(?<![\p{L}\p{M}\p{N}_.@])@[\p{L}\p{N}_]\p{M}*(?:[\p{L}\p{N}._]\p{M}*){0,28}[\p{L}\p{N}_]\p{M}*(?![\p{L}\p{M}\p{N}_])/gu

/**
 * The catch-all: any run of 8+ digits nothing more specific claimed. Employee
 * numbers, expedientes, account numbers, an INE folio.
 *
 * 🔴 LAST, ALWAYS. See the header — it is the rule that eats the others' matches
 * if it is allowed to run first.
 */
const NUMERO_LARGO = /\d{8,}/g

// ---------------------------------------------------------------------------
// DOMICILIOS — the postal code, and nothing else
// ---------------------------------------------------------------------------
//
// 🔴 OWNER'S RULING, 2026-10-21 (Q3, "A: fixed shapes only"). This stage keeps
// identifiers whose shape never varies. Of an address, that is the postal code:
// a marker and five digits. Street lines (`Calle Morelos No. 45`), settlements
// (`Col. Portales`) and blocks (`Mz. 4 Lt. 12`) are free-form and belong to the
// model, whose prompt lists them (`detector.ts`, "Domicilios").
//
// ⚠ The marker is required. A bare five-digit number is a price, a folio or a
// year range; `C.P.` is the anchor prose does not produce.

/**
 * `calle` → `[Cc][Aa][Ll][Ll][Ee]`. Regex metacharacters are escaped.
 *
 * Case-insensitivity spelled into the keyword, so the pattern carries no `i`
 * flag. Both cases, not just Title Case: a transcriber's caps lock writes `CP`.
 */
function anyCase(literal: string): string {
  return [...literal]
    .map((ch) => {
      const upper = ch.toUpperCase()
      const lower = ch.toLowerCase()
      if (upper === lower) return escapeRegExp(ch)
      // ⚠ `toUpperCase` CAN RETURN MORE THAN ONE CHARACTER (`ß` → `SS`), and
      // `[SSß]` would match a bare `S`.
      if (upper.length !== 1 || lower.length !== 1) return `[${escapeRegExp(ch)}]`
      return `[${upper}${lower}]`
    })
    .join('')
}

/** Longest first, so `c. p.` is offered before `cp`. */
function anyCaseAlternation(literals: readonly string[]): string {
  return [...literals]
    .sort((a, b) => b.length - a.length)
    .map(anyCase)
    .join('|')
}

/**
 * `C.P.` / `CP` / `Código Postal`, then exactly five digits.
 *
 * 🔴 `\s*(?::\s*)?`, NOT `\s*:?\s*`. Two `\s*` either side of an optional token
 * split a run of n spaces n ways, and the engine tries every split when the
 * digits fail: quadratic. Measured 2026-10-21, this pattern alone on
 * `'C.P.' + 100k spaces + 'x'`, host `torre`, Node 26, load 12.6: old spelling
 * 10.4 s, this one under 1 ms. PDF extraction makes such runs by accident.
 */
const CP_TOKEN = String.raw`(?:${anyCaseAlternation([
  'c.p.',
  'c. p.',
  'cp',
  'código postal',
  'codigo postal',
])})\s*(?::\s*)?\d{5}(?!\d)`

/**
 * A postal code. Runs BEFORE `telefono` and `numero-largo`, which would
 * otherwise claim its digits and leave the `C.P.` marker beside a
 * `[Dato omitido]`.
 */
const CODIGO_POSTAL = new RegExp(String.raw`(?<![\p{L}\p{N}])${CP_TOKEN}`, 'gu')

export interface DeterministicArgs {
  text: string
  /** Members' names and emails. Empty is correct for a testimony — see header. */
  roster?: readonly string[]
  /** The document's allocator `labelFor`. Threaded in so stage 3 reuses the labels. */
  allocate: (name: string) => string
  /**
   * The document's allocator `addressLabelFor`.
   *
   * 🔴 THREADED IN FOR THE SAME REASON AS `allocate`, and it is not optional in
   * spirit even though the signature tolerates its absence for the standalone
   * helper below. An address the regexes catch in paragraph one and the model
   * catches in paragraph three must come out as the SAME `[Domicilio A]`. Two
   * allocators would restart at `A` and turn one house into two.
   */
  allocateAddress?: (address: string) => string
}

function pushCount(into: RedactionCount[], label: string, count: number): void {
  if (count > 0) into.push({ label, count })
}

/** Replace every match of `re` with `OMITTED_PLACEHOLDER`, returning the count. */
function omit(text: string, re: RegExp): { text: string; count: number } {
  let count = 0
  const out = text.replace(re, () => {
    count += 1
    return OMITTED_PLACEHOLDER
  })
  return { text: out, count }
}

/**
 * Replace every match of `re` with a LABEL allocated from the match itself.
 *
 * ⚠ Unlike {@link omit}, the replacement depends on WHAT matched, so repeats
 * share a label. That is the whole difference between `[Domicilio A]` and a
 * redaction bar — see `types.ts`.
 */
function label(
  text: string,
  re: RegExp,
  allocate: (matched: string) => string,
): { text: string; count: number } {
  let count = 0
  const out = text.replace(re, (matched) => {
    count += 1
    return allocate(matched)
  })
  return { text: out, count }
}

export function deterministicPass(args: DeterministicArgs): {
  text: string
  removed: RedactionCount[]
} {
  const removed: RedactionCount[] = []
  let out = args.text

  // ── Roster and addresses first, together. See the header: an entry that is
  // an email must become that member's `[Persona X]`, not `[Dato omitido]`.
  //
  // ⚠ Longest entry first, so "Ana López Ruiz" is not half-eaten by a separate
  // roster entry "Ana López" and left as "[Persona A] Ruiz" — a surname still in
  // the corpus, attached to a label, which is worse than either alone.
  const entries = [...(args.roster ?? [])]
    .filter((e) => e.trim().length >= 2)
    // 🔴 An entry of only accent marks has nothing to match; it looped forever.
    .filter((e) => /[\p{L}\p{N}]/u.test(e))
    .sort((a, b) => b.length - a.length)
  // Labels in roster order, before any match: the letters do not depend on
  // which entry happens to be found first.
  const labels = new Map(entries.map((e) => [e, args.allocate(e)]))

  // 🔴 THE TEXT IS DECOMPOSED FOR THIS PASS AND RECOMPOSED AFTER.
  //
  // `rosterPattern` builds `o\p{M}*` per letter, which matches a DECOMPOSED `ó`
  // (o + U+0301) and NOT the precomposed U+00F3 that almost every real document
  // actually contains. Without this round trip the roster silently matched
  // nothing on any accented name — the one input it exists for — while the
  // report said zero hits, which reads as "no members were named" rather than
  // "the matcher is broken". The address rules run on the same decomposed text,
  // so both sides agree on every offset.
  //
  // NFD→NFC is canonical-equivalence-preserving: it can change the BYTES of
  // text this stage did not redact, never the characters.
  const first = rosterAndAddresses(
    out.normalize('NFD'),
    entries,
    (e) => labels.get(e) ?? '',
    new Set(labels.values()),
  )
  out = first.text.normalize('NFC')
  const countOf = (rule: string) => first.spans.filter((s) => !s.person && s.rule === rule).length
  pushCount(removed, DETERMINISTIC_LABELS.rosterPerson, first.spans.filter((s) => s.person).length)
  pushCount(removed, DETERMINISTIC_LABELS.email, countOf(DETERMINISTIC_LABELS.email))

  // ── Then the shaped identifiers, specific → greedy. Do not reorder.
  const curp = omit(out, CURP)
  out = curp.text
  pushCount(removed, DETERMINISTIC_LABELS.curp, curp.count)

  const rfc = omit(out, RFC)
  out = rfc.text
  pushCount(removed, DETERMINISTIC_LABELS.rfc, rfc.count)

  pushCount(removed, DETERMINISTIC_LABELS.url, countOf(DETERMINISTIC_LABELS.url))
  pushCount(removed, DETERMINISTIC_LABELS.arroba, countOf(DETERMINISTIC_LABELS.arroba))

  // ── Then the postal code. BEFORE `telefono` and `numero-largo`, which would
  // otherwise claim its digits and leave `C.P.` beside a `[Dato omitido]`.
  const allocateAddress = args.allocateAddress ?? ((matched: string) => matched)
  const cp = label(out, CODIGO_POSTAL, allocateAddress)
  out = cp.text
  pushCount(removed, DETERMINISTIC_LABELS.codigoPostal, cp.count)

  const telefono = omit(out, TELEFONO)
  out = telefono.text
  pushCount(removed, DETERMINISTIC_LABELS.telefono, telefono.count)

  const numero = omit(out, NUMERO_LARGO)
  out = numero.text
  pushCount(removed, DETERMINISTIC_LABELS.numeroLargo, numero.count)

  return { text: out, removed }
}

/**
 * Convenience for callers that want stage 2 alone with a throwaway allocator.
 *
 * ⚠ NOT used by the gate — the gate threads ONE allocator through all four
 * stages so a member named in stage 2 and again in stage 3 gets the SAME label.
 * A second allocator here would restart at `[Persona A]` and quietly merge two
 * different people.
 */
export function deterministicPassStandalone(
  text: string,
  roster?: readonly string[],
): { text: string; removed: RedactionCount[] } {
  const allocator = createPseudonymAllocator()
  return deterministicPass({
    text,
    roster,
    allocate: (n) => allocator.labelFor(n),
    allocateAddress: (a) => allocator.addressLabelFor(a),
  })
}
