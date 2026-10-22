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
 * And the roster runs FIRST of all, ahead of `email`, on purpose: a roster entry
 * that happens to be an email address must become that member's `[Persona X]`
 * label — which keeps the sentence readable — rather than an anonymous
 * `[Dato omitido]` that loses the fact that the same person appears twice.
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
import { OMITTED_PLACEHOLDER } from './types'

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

const COMBINING = '\\u0300-\\u036f'

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
 * `i` + U+0301, so every letter can carry `[\\u0300-\\u036f]*` and the accents
 * become optional without a hand-written variant table that always misses `ñ`.
 *
 * ⚠ `\b` IS NOT USED. In decomposed text `\b` fires between a letter and its own
 * combining accent, so `\bLopez\b` would match inside `Lópezcorp`. Unicode
 * property lookarounds are the version that actually holds.
 */
function rosterPattern(entry: string): RegExp {
  const base = entry.normalize('NFD').replace(new RegExp(`[${COMBINING}]`, 'gu'), '')
  const body = [...base]
    .map((ch) => (/\s/.test(ch) ? '\\s+' : `${escapeRegExp(ch)}[${COMBINING}]*`))
    .join('')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu')
}

/**
 * `ana.lopez+notas@correo.gob.mx`. Deliberately permissive on the local part —
 * a missed address is a leak, an over-matched one is a slightly uglier sentence.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

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
 * `@anitalopez`. Runs after `email`, which has already consumed every real `@`.
 *
 * ⚠ The handle may not END on a dot. `[A-Za-z0-9._]{2,30}` is greedy, so on
 * "escríbele a @anita." it swallowed the full stop and the sentence came back
 * without its punctuation — cosmetic here, but the same greed on "@anita.mx" is
 * the difference between a handle and a domain.
 */
const ARROBA = /(?<![\w.@])@[A-Za-z0-9_][A-Za-z0-9._]{0,28}[A-Za-z0-9_](?!\w)/g

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

  // ── Roster first. See the header: an entry that is an email must become that
  // member's `[Persona X]`, not an anonymous `[Dato omitido]`.
  //
  // ⚠ Longest entry first, so "Ana López Ruiz" is not half-eaten by a separate
  // roster entry "Ana López" and left as "[Persona A] Ruiz" — a surname still in
  // the corpus, attached to a label, which is worse than either alone.
  let rosterHits = 0
  const entries = [...(args.roster ?? [])]
    .filter((e) => e.trim().length >= 2)
    .sort((a, b) => b.length - a.length)

  if (entries.length > 0) {
    // 🔴 THE TEXT IS DECOMPOSED FOR THE ROSTER PASS AND RECOMPOSED AFTER.
    //
    // `rosterPattern` builds `o[\u0300-\u036f]*` per letter, which matches a
    // DECOMPOSED `ó` (o + U+0301) and NOT the precomposed U+00F3 that almost
    // every real document actually contains. Without this round trip the roster
    // silently matched nothing on any accented name — the one input it exists
    // for — while the report said zero hits, which reads as "no members were
    // named" rather than "the matcher is broken".
    //
    // NFD→NFC is canonical-equivalence-preserving: it can change the BYTES of
    // text this stage did not redact, never the characters.
    out = out.normalize('NFD')
    for (const entry of entries) {
      const label = args.allocate(entry)
      out = out.replace(rosterPattern(entry.trim()), () => {
        rosterHits += 1
        return label
      })
    }
    out = out.normalize('NFC')
  }
  pushCount(removed, DETERMINISTIC_LABELS.rosterPerson, rosterHits)

  // ── Then the shaped identifiers, specific → greedy. Do not reorder.
  const email = omit(out, EMAIL)
  out = email.text
  pushCount(removed, DETERMINISTIC_LABELS.email, email.count)

  const curp = omit(out, CURP)
  out = curp.text
  pushCount(removed, DETERMINISTIC_LABELS.curp, curp.count)

  const rfc = omit(out, RFC)
  out = rfc.text
  pushCount(removed, DETERMINISTIC_LABELS.rfc, rfc.count)

  const url = omit(out, URL)
  out = url.text
  pushCount(removed, DETERMINISTIC_LABELS.url, url.count)

  const arroba = omit(out, ARROBA)
  out = arroba.text
  pushCount(removed, DETERMINISTIC_LABELS.arroba, arroba.count)

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
