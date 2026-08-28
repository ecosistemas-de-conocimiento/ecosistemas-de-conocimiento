/**
 * STAGE 1 — THE STRUCTURAL PASS. What identifies a person WITHOUT naming them.
 *
 * ── ⚠ THE HALF OF THIS STAGE THAT IS A NEGATIVE, NOT CODE ───────────────────
 *
 * The first thing the structural stage does is nothing, and that is deliberate.
 * Author ids are NEVER PUT INTO CHUNK METADATA IN THE FIRST PLACE:
 * `lib/contentKind.ts` → `chunkMetadata()` is the single builder every ingest
 * path uses, and it emits `docId`, `organizationId`, `kind`, `format`,
 * `publication`, `title` and — for a `conversacion` only — `authoredBy` /
 * `sessionId`. No `uploadedBy`, no user id, no speaker; `organizationId` is a
 * TENANT id, not a person.
 *
 * So there is no author id in metadata to strip HERE, and the way to keep it
 * that way is to keep every ingest going through that one function rather than
 * to add a scrubber that pretends to catch it. A scrubber would also be a lie:
 * it would run on the chunk text, and metadata never passes through this file.
 *
 * What DOES reach this file is the document BODY, which is where the leftovers
 * live: a transcription header someone pasted in, an export that wrote
 * `uploadedBy=8f1c…` into the text, a UUID in a filename echoed into the first
 * line. Those are what the patterns below are for.
 *
 * ── ⚠ COARSENING DATES IS NOT COSMETIC ──────────────────────────────────────
 *
 * "el ingeniero que renunció el 3 de marzo" names a person. Not by name — by
 * INTERSECTION. In an ecosistema of forty people there is exactly one person who
 * resigned that day, and anyone inside the organisation knows who. No name
 * scrubber touches that sentence; the model in stage 3 will often miss it too,
 * because there is no name in it to find. Dropping the date to `marzo` removes
 * the join key while leaving the sentence readable.
 *
 * Timestamps are the same failure with a machine on the other end: an ISO
 * timestamp to the second lines a testimony up against an access log, a calendar
 * or a shift roster. Month granularity is the coarsest thing that still keeps a
 * testimony narratively coherent ("that spring, after the layoffs").
 *
 * ⚠ AND, STATED HONESTLY: COARSENING DOES NOT SOLVE RE-IDENTIFICATION BY
 * CONTEXT. NOTHING DOES. "the only nurse in the clinic" survives every pass in
 * this directory and always will. What this stage removes is the CHEAPEST
 * handle — the one that needs no local knowledge, that a script can join on, and
 * that would otherwise be sitting in the text for free. Treat it as raising the
 * cost of re-identification, never as making it impossible.
 */

import type { RedactionCount } from './types'
import { OMITTED_PLACEHOLDER } from './types'

/** The rule name that appears in the report for a coarsened date. */
export const LABEL_FECHA = 'fecha'

/** The rule name for a stripped uuid / author marker. */
export const LABEL_ID = 'identificador-interno'

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const

/**
 * `2026-08-15T10:23:45Z`, `2026-08-15 10:23`, `2026-08-15` → `2026-08`.
 *
 * ⚠ Runs FIRST of the date rules. A `dd/mm/yyyy` rule cannot match an ISO date,
 * but the generic long-digit-run rule in `deterministic.ts` absolutely can eat
 * `20260815`, which is why the whole date family is handled in this stage, ahead
 * of stage 2, rather than sharing a pass with it.
 */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g

/** `15/08/2026`, `15-08-2026`, `3/3/26` → `08/2026`. Day-first: this is es-MX. */
const SLASH_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g

/** `15 de agosto de 2026` → `agosto de 2026`. Also `15 de agosto del 2026`. */
const LONG_DATE = new RegExp(
  String.raw`\b\d{1,2}\s+de\s+(${MONTHS.join('|')})\s+de[l]?\s+(\d{4})\b`,
  'gi',
)

/**
 * A UUID in any casing, with or without dashes in the canonical positions.
 *
 * ⚠ Matched before the author markers below so `uploadedBy=<uuid>` loses the
 * whole assignment rather than leaving a dangling `uploadedBy=[Dato omitido]`
 * that still says a specific person uploaded this.
 */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** The keys an export or a debug dump uses when it writes an author into text. */
const AUTHOR_KEY = 'user|usuario|usuario_id|userId|uploadedBy|uploaded_by|authorId|author_id|autor'

/**
 * Author markers left in the BODY: `user:42`, `usuario 8f1c`, `uploadedBy=17`,
 * `authorId: abc123`.
 *
 * ⚠ The KEY IS CONSUMED WITH THE VALUE. Leaving `usuario [Dato omitido]` behind
 * would still tell a reader "this passage was written by one identified
 * account", which is the fact being removed.
 *
 * ⚠ TWO ALTERNATIVES, AND THE SECOND ONE IS NARROW ON PURPOSE. With an explicit
 * `:`/`=` the following token is an id by construction. WITHOUT one, `usuario`
 * is just a Spanish noun, and a rule that swallowed the next word would turn
 * "el usuario dijo que…" into "el [Dato omitido] que…" — a redaction that
 * silently corrupts ordinary prose while removing nothing identifying. So the
 * separator-less form additionally requires the token to CONTAIN A DIGIT, which
 * is what an id has and a word does not.
 */
const AUTHOR_MARKER = new RegExp(
  String.raw`\b(?:${AUTHOR_KEY})(?:\s*[:=]\s*[A-Za-z0-9_-]{1,64}` +
    String.raw`|\s+[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\b`,
  'gi',
)

/** Count a rule only when it actually fired — a zero row is noise in the report. */
function pushCount(into: RedactionCount[], label: string, count: number): void {
  if (count === 0) return
  const existing = into.find((r) => r.label === label)
  if (existing) existing.count += count
  else into.push({ label, count })
}

/**
 * Coarsen dates and strip internal identifiers.
 *
 * Pure and synchronous: nothing here talks to a model, so this stage cannot
 * fail, cannot be slow, and — unlike stages 3 and 4 — never sends the text
 * anywhere. It runs first for exactly that reason.
 */
export function structuralPass(text: string): { text: string; removed: RedactionCount[] } {
  const removed: RedactionCount[] = []
  let dates = 0
  let ids = 0

  let out = text

  out = out.replace(ISO_DATE, (_m, year: string, month: string) => {
    dates += 1
    return `${year}-${month}`
  })

  out = out.replace(SLASH_DATE, (_m, _day: string, month: string, year: string) => {
    dates += 1
    // Two-digit years are read as 20xx. A testimony about 1998 written `3/3/98`
    // would come out `03/2098`, which is wrong but NOT a leak — and inventing a
    // century cutoff here would be a guess dressed as precision.
    const yyyy = year.length === 4 ? year : `20${year.padStart(2, '0')}`
    return `${month.padStart(2, '0')}/${yyyy}`
  })

  out = out.replace(LONG_DATE, (_m, month: string, year: string) => {
    dates += 1
    return `${month} de ${year}`
  })

  out = out.replace(UUID, () => {
    ids += 1
    return OMITTED_PLACEHOLDER
  })

  out = out.replace(AUTHOR_MARKER, () => {
    ids += 1
    return OMITTED_PLACEHOLDER
  })

  pushCount(removed, LABEL_FECHA, dates)
  pushCount(removed, LABEL_ID, ids)

  return { text: out, removed }
}
