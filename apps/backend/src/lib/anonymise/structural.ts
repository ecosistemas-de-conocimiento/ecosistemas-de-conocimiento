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

import { NOT_A_PART } from './nameParts'
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

/** The rule name for an author named in a byline ("Autor: …"). */
export const LABEL_AUTOR = 'persona-autor'

/** `autor` → `[aA][uU][tT][oO][rR]`: case-insensitive WITHOUT the `i` flag (see {@link NAME_WORD}). */
function anyCase(word: string): string {
  return word.replace(/\p{L}/gu, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
}

/**
 * Nothing word-like right before a key. 🔴 NOT `\b`: `\b` holds after a hyphen,
 * so "función-autor: cuando" lost its "autor" (measured 2026-10-28).
 */
const KEY_START = String.raw`(?<![\p{L}\p{M}\p{N}_\-])`

/**
 * Nothing word-like right after a value. 🔴 NOT `\b`: `\b` is ASCII-only, so it
 * holds between "Jos" and "é", and "usuario: José" came out "[Dato omitido]é"
 * (measured 2026-10-28).
 */
const VALUE_END = String.raw`(?![\p{L}\p{M}\p{N}_])`

/**
 * WHERE A HEADER FIELD STARTS: a line start, or after `|`, `;` or a tab, then
 * any markdown bullet, quote or bold (`- **Autor:** …`). A key here is a label,
 * not a word in a sentence, and its value runs to the end of the field.
 */
const FIELD_START = String.raw`(?<=(?:^|[|;\t])[ \t>*_#\-]*)`

/**
 * Titles whose abbreviation dot does NOT end a byline: "Autor: Dr. Juan Pérez".
 * "Ma." is María ("Ma. Elena Ruiz"); "Pbro." is presbítero.
 */
const TITLE_WORDS = ['dr', 'dra', 'sr', 'sra', 'srta', 'lic', 'ing', 'mtro', 'mtra', 'prof', 'profa', 'arq', 'mr', 'mrs', 'ms', 'jr', 'ma', 'pbro']
const TITLE_ABBREVIATIONS = TITLE_WORDS.map(anyCase).join('|')

/**
 * A field's value: up to the next newline, `|`, `;` or tab, or a SENTENCE END
 * (". " — "Autora: Ximena Arriaga. Ximena coordinó." keeps its second
 * sentence), minus trailing space and a final dot.
 *
 * ⚠ A dot after an initial ("J. Pérez") or a title ("Dr. Juan Pérez") is NOT a
 * sentence end: stopping there would leave the rest of the name in the text.
 */
const FIELD_VALUE =
  String.raw`(?:[^\n\r|;\t.]|\.(?!\s)|(?<=(?<![\p{L}\p{M}])(?:\p{L}|${TITLE_ABBREVIATIONS}))\.)*` +
  String.raw`[^\s|;.]`

/**
 * One capitalised name word, or an initial ("J."). 🔴 The regexes that use it
 * carry no `i` flag: under `iu`, `\p{Lu}` also matches lower case, and "el
 * autor: según" would lose "según".
 */
const NAME_WORD = String.raw`(?:(?=\p{Lu})(?:${TITLE_ABBREVIATIONS})\.|\p{Lu}\.|\p{Lu}[\p{L}\p{M}'’\-]*)`

/** The small words inside a Spanish name, or between two names. */
const NAME_JOINER = '(?:de|del|la|las|los|y|e|van|von|da|di|do|dos)'

/**
 * Capitalised name words, joined by spaces and particles: "Juan Pérez de la
 * Cruz", "Ana Ruiz y Luis Gómez". Stops at the first lower-case word that is
 * not a particle, so "Juan Pérez subió" keeps "subió".
 */
const NAME_RUN = String.raw`${NAME_WORD}(?:[ \t]+(?:${NAME_JOINER}[ \t]+)*${NAME_WORD})*${VALUE_END}`

/** The keys an export or a debug dump uses when it writes an author ID into text. */
const AUTHOR_KEY = ['user', 'usuario', 'usuario_id', 'userId', 'uploadedBy', 'uploaded_by', 'authorId', 'author_id']
  .map(anyCase)
  .join('|')

/**
 * Author-id markers left in the BODY: `user:42`, `usuario 8f1c`,
 * `uploadedBy=17`, `authorId: abc123`.
 *
 * ⚠ The KEY IS CONSUMED WITH THE VALUE. Leaving `usuario [Dato omitido]` behind
 * would still tell a reader "this passage was written by one identified
 * account", which is the fact being removed.
 *
 * 🔴 THE WHOLE VALUE, NOT ITS FIRST WORD. The value used to be one token, so
 * "usuario: Juan Pérez" came out "[Dato omitido] Pérez" — a surname left in
 * the corpus beside a redaction that makes it look safe. Now:
 *
 *   · at a FIELD START ({@link ID_FIELD}) a value that starts with a letter
 *     runs to the end of the field, whatever its case;
 *   · anywhere else ({@link ID_INLINE}) a capitalised {@link NAME_RUN} wins
 *     over a single token.
 *
 * ⚠ THE SEPARATOR-LESS FORM IS NARROW ON PURPOSE. With an explicit `:`/`=` the
 * following token is an id by construction. WITHOUT one, `usuario` is just a
 * Spanish noun, and a rule that swallowed the next word would turn "el usuario
 * dijo que…" into "el [Dato omitido] que…" — a redaction that silently
 * corrupts ordinary prose while removing nothing identifying. So the
 * separator-less form additionally requires the token to CONTAIN A DIGIT,
 * which is what an id has and a word does not.
 */
const ID_FIELD = new RegExp(
  String.raw`${FIELD_START}${KEY_START}(?:${AUTHOR_KEY})[ \t]*[:=][ \t]*\p{L}${FIELD_VALUE}`,
  'gmu',
)
const ID_INLINE = new RegExp(
  String.raw`${KEY_START}(?:${AUTHOR_KEY})(?:\s*[:=]\s*(?:${NAME_RUN}|[A-Za-z0-9_\-]{1,64}${VALUE_END})` +
    String.raw`|\s+[A-Za-z0-9_\-]*\d[A-Za-z0-9_\-]*${VALUE_END})`,
  'gmu',
)

/**
 * A BYLINE KEY: "Autor", "Autora", "Autores", "Autoras", "Author(s)". Its value
 * is a PERSON, not an account id, which is why it is not in {@link AUTHOR_KEY}.
 * It used to be, with a one-token value: "Autor: Juan Pérez" came out
 * "[Dato omitido] Pérez", and "Autora: …" did not match at all (measured
 * 2026-10-28).
 *
 * ⚠ THE KEY STAYS, THE NAME GOES. "Autor: [Persona A]" says only that the text
 * has an author, which every text has. The name becomes the SAME `[Persona X]`
 * the rest of the gate gives that person (`person` in {@link structuralPass}),
 * or `[Dato omitido]` when stage 1 runs alone.
 */
const BYLINE_KEY = ['autor', 'autora', 'autores', 'autoras', 'author', 'authors'].map(anyCase).join('|')

/** `[*_]*` takes markdown bold around the key or the colon: `**Autor:**`. */
const BYLINE_SEP = String.raw`[*_]*[ \t]*[:=][ \t]*[*_]*[ \t]*`

/**
 * A byline at a field start: the whole field is the value, whatever its case.
 *
 * 🔴 A `;` or `|` does NOT end a byline unless what follows is another field
 * ("| Lugar: el salón"). "Autores: Ana Ruiz; Luis Gómez" kept "Luis Gómez"
 * (audit 2026-10-28): the second author read as a new, key-less field.
 */
const BYLINE_FIELD = new RegExp(
  String.raw`${FIELD_START}${KEY_START}((?:${BYLINE_KEY})${BYLINE_SEP})` +
    String.raw`(${FIELD_VALUE}(?:[ \t]*[;|][ \t]*(?![^\n\r|;]*[:=])${FIELD_VALUE})*)`,
  'gmu',
)

/**
 * A byline mid-line ("Notas de clase. Autor: Juan Pérez, 2026."): only
 * CAPITALISED name runs, so "el autor: según él" — a sentence — is left alone.
 *
 * 🔴 A LIST OF RUNS, NOT ONE (audit 2026-10-28): "Autores: Ana Ruiz, Luis Gómez
 * y Eva Paz" kept everyone after the first comma. Each further run still has to
 * start with a capital, so ", 2026" and ", en Puebla" stay; and the list only
 * ever starts after a byline key, so plain prose with commas is never touched.
 */
const BYLINE_INLINE = new RegExp(
  String.raw`${KEY_START}((?:${BYLINE_KEY})${BYLINE_SEP})(${NAME_RUN}(?:[ \t]*[,;|/&][ \t]*${NAME_RUN})*)`,
  'gmu',
)

/**
 * Where one author ends and the next begins, in two tiers: hard separators
 * (`,` `;` `|` `/` `&`), then " y " / " e " / " and " inside each hard piece.
 * The value is split into authors FIRST, and only then is each one classified.
 *
 * 🔴 SPLIT FIRST (byline audit 2, 2026-10-28). The institution check used to
 * run before the " y " split, so "Ana Ruiz García y Luis Gómez Paz" — six
 * capitalised words — read as one institution and neither surname spread.
 *
 * ⚠ A comma inside a person ("Ruiz, Ana") is re-joined after the split by
 * {@link pairsAsSurnameGiven}, so it does not hand out two labels.
 */
const HARD_SPLIT = /(\s*[,;|/&]\s*)/u
const SOFT_SPLIT = /(\s+(?:y|e|and)\s+)/u

/**
 * 🔴 AN INSTITUTION IS NOT A PERSON (audit 2026-10-28). Every word handed to
 * `person` is spread by the gate as a name part, so "Autor: Universidad
 * Nacional Autónoma de México" turned every later "México" into "[Persona A]".
 * An institution is still redacted in the byline but never reaches `person`.
 *
 * ⚠ FAIL-CLOSED: WHEN IN DOUBT, A PERSON. A person read as an institution
 * leaks every surname into the body; an institution read as a person only
 * over-redacts. So ONE author segment — already split — skips `person` only
 * when it is an institution BY ITSELF, by any one of:
 *   · its first capitalised word, after a leading article ("El Colegio de
 *     México"), is an organisation head ({@link ORG_HEADS});
 *   · it is a single acronym ("CIDE", "UNAM");
 *   · its name run has more than four NAME words — "María Fernanda López
 *     García" has four. A title or an initial is not a name word: "Dr. Juan
 *     Carlos López García" has four, and leaked "López" when it counted five.
 * And a "Surname, Given" pair is never an institution
 * ({@link pairsAsSurnameGiven}).
 *
 * ⚠ "Ciudad" and "Estado" are here because a byline often ends in a place
 * ("Autor: Juan Pérez, Ciudad de México"), not because they are institutions.
 */
const ORG_HEADS: ReadonlySet<string> = new Set([
  'universidad', 'instituto', 'centro', 'secretaria', 'comite', 'colectivo', 'asociacion',
  'fundacion', 'consejo', 'comision', 'coordinacion', 'direccion', 'departamento', 'facultad',
  'escuela', 'colegio', 'red', 'grupo', 'equipo', 'organizacion', 'sindicato', 'cooperativa',
  'gobierno', 'ayuntamiento', 'municipio', 'ministerio', 'programa', 'proyecto', 'observatorio',
  'laboratorio', 'ciudad', 'estado',
])

/** "El Colegio de México": the head word is the one after the article. */
const LEADING_ARTICLES: ReadonlySet<string> = new Set(['el', 'la', 'los', 'las'])

const TITLES: ReadonlySet<string> = new Set(TITLE_WORDS)

const fold = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The part of a byline piece handed to `person`: its first name run, plus a
 * second one after a comma for a surname-first piece ("Ruiz, Ana"). "Juan
 * Pérez coordinador del Proyecto Agua" hands over "Juan Pérez" — the label
 * still covers the whole piece, but "Proyecto" and "Agua" are not spread.
 */
const PERSON_CORE = new RegExp(String.raw`${NAME_RUN}(?:[ \t]*,[ \t]*${NAME_RUN})?`, 'u')

/** The capitalised words that can be a name part: no title, initial or particle. */
function nameWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[\p{L}\p{M}'’\-]+/gu)) {
    const w = m[0]
    if (!/^\p{Lu}/u.test(w) || w.length < 2) continue
    if (text[m.index + w.length] === '.') continue // "Dr.", "Ma.", "J."
    if (TITLES.has(fold(w)) || NOT_A_PART.has(fold(w))) continue
    out.push(w)
  }
  return out
}

/** ONE author segment, already split from the list, that is an institution by itself. */
export function isInstitution(segment: string): boolean {
  const words = segment.match(/[\p{L}\p{M}]+/gu) ?? []
  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w) && w.length >= 2)
  if (capitalised.length === 0) return false
  if (words.length === 1 && /^\p{Lu}{2,}$/u.test(words[0] as string)) return true
  const head = LEADING_ARTICLES.has(fold(capitalised[0] as string)) ? capitalised[1] : capitalised[0]
  if (head !== undefined && ORG_HEADS.has(fold(head))) return true
  const core = PERSON_CORE.exec(segment)
  return core !== null && nameWords(core[0]).length > 4
}

/**
 * True when `given`, after a comma, completes `surname` as "Surname, Given".
 *
 * 🔴 SUCH A PAIR IS ALWAYS A PERSON (byline audit 2): "Ciudad Ruiz, Ana" split
 * at the comma, "Ciudad Ruiz" read as an institution, and "Ruiz" stayed in the
 * body. The pair is joined BEFORE any head-word check.
 *
 * With `;` or `|` in the value the list is surname-first, so up to two given
 * names pair ("Ruiz, Ana María"). With commas only, "Ana Ruiz, Luis Gómez" is
 * two people, so only one given name or initials pair ("Ruiz, Ana", "Ruiz,
 * A."). A wrong pair merges two people under one label; every word of both is
 * still registered, so it never leaks.
 *
 * ⚠ A head word followed by "de"/"del" is an institution's name, not a
 * surname: "Centro de Estudios Rurales, Puebla" is an institution and a
 * place, and pairing it would spread "Puebla" and "Estudios" as name parts.
 */
const HEAD_THEN_DE = new RegExp(String.raw`^\s*(?:(?:el|la|los|las)\s+)?(\p{L}+)\s+del?\s`, 'iu')
function pairsAsSurnameGiven(surname: string, given: string, surnameFirstList: boolean): boolean {
  if (nameWords(surname).length === 0 || !/^\p{Lu}/u.test(given)) return false
  const head = HEAD_THEN_DE.exec(surname)?.[1]
  if (head !== undefined && ORG_HEADS.has(fold(head))) return false
  if (isInstitution(given)) return false
  return nameWords(given).length <= (surnameFirstList ? 2 : 1)
}

/** A lower-case segment that opens with one of these is a sentence, not a name. */
const PROSE_OPENERS: ReadonlySet<string> = new Set([
  'que', 'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'de', 'del', 'en', 'y', 'e', 'o', 'u', 'a',
  'por', 'para', 'con', 'sin', 'segun', 'sobre', 'entre', 'hasta', 'desde', 'como', 'cuando',
  'donde', 'pero', 'si', 'se', 'su', 'sus', 'este', 'esta', 'ese', 'esa', 'al', 'no', 'ya',
])

/**
 * Words a name never holds, anywhere in the segment: verbs and function words
 * that are not name particles ("de", "la", "y" are, as in "de la cruz").
 * ⚠ A LIST, NOT A SUFFIX RULE: "-ar"/"-ado" would catch Aguilar and Delgado.
 */
const PROSE_WORDS: ReadonlySet<string> = new Set([
  ...PROSE_OPENERS,
  'ver', 'vease', 'vea', 'consultar', 'consulte', 'es', 'son', 'fue', 'fueron', 'era', 'esta',
  'estan', 'ha', 'han', 'hay', 'sera', 'revisado', 'revisada', 'publicado', 'publicada', 'anexo',
].filter((w) => !['de', 'la', 'las', 'los', 'y', 'e'].includes(w)))

/**
 * 🔴 FAIL-CLOSED (byline audit 2): a lower-case segment after ";" or "|" is a
 * NAME — redacted, though never handed to `person`, since a lower-case word
 * cannot spread safely — unless it is plainly prose: five words or more, a
 * digit, a function-word opener, or a verb or function word inside.
 * "luis gómez" is a name; "ver anexo 3" and "según la convocatoria de este
 * año" are prose.
 */
function isProse(segment: string): boolean {
  if (/\p{Lu}/u.test(segment)) return false
  if (/\d/u.test(segment)) return true
  const words = (segment.match(/[\p{L}\p{M}]+/gu) ?? []).map(fold)
  if (words.length === 0) return false
  if (words.length >= 5 || PROSE_OPENERS.has(words[0] as string)) return true
  return words.some((w) => PROSE_WORDS.has(w))
}

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
export interface StructuralOptions {
  /**
   * The `[Persona X]` for a name found in a byline. The gate passes its ONE
   * per-document allocator here, so the author in a byline and the same person
   * in the body share a label. Absent → `[Dato omitido]`.
   */
  person?: (name: string) => string
}

export function structuralPass(
  text: string,
  options: StructuralOptions = {},
): { text: string; removed: RedactionCount[] } {
  const removed: RedactionCount[] = []
  let dates = 0
  let ids = 0
  let authors = 0

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

  // Each author on its own: "Ana Ruiz y Luis Gómez" is two people, two labels.
  // A piece with no name run ("anónimo") or an institution gets no person label.
  const author = (piece: string, pair: boolean): string => {
    authors += 1
    if (!options.person || (!pair && isInstitution(piece))) return OMITTED_PLACEHOLDER
    const core = PERSON_CORE.exec(piece)
    return core ? options.person(core[0]) : OMITTED_PLACEHOLDER
  }
  /** Split on `split`, keeping each separator in front of the piece it precedes. */
  const segmentsOf = (value: string, split: RegExp) => {
    const parts = value.split(split)
    return parts.flatMap((text, i) => (i % 2 === 1 ? [] : [{ sep: parts[i - 1] ?? '', text }]))
  }
  const byline = (_m: string, key: string, value: string) => {
    const surnameFirst = /[;|]/.test(value)
    let out = key
    let prose = false
    const hard: Array<{ sep: string; text: string; pair?: true }> = []
    for (const s of segmentsOf(value, HARD_SPLIT)) {
      const prev = hard.at(-1)
      if (prev && !prev.pair && s.sep.trim() === ',' && pairsAsSurnameGiven(prev.text, s.text, surnameFirst)) {
        prev.text += s.sep + s.text
        prev.pair = true
      } else hard.push(s)
    }
    for (const h of hard) {
      // Lower-case PROSE after ";" or "|" is not an author, nor anything after
      // it: "Autor: Ana Ruiz; el texto fue revisado". A short lower-case
      // segment is still a name ("Ana Ruiz; luis gómez"), see {@link isProse}.
      if (prose || (/[;|]/.test(h.sep) && isProse(h.text))) {
        prose = true
        out += h.sep + h.text
        continue
      }
      out += h.sep
      if (h.text.trim() === '') out += h.text
      else if (h.pair) out += author(h.text, true)
      else {
        // "Secretaría de Educación y Cultura" is ONE institution: a one-word
        // tail after " y " joins the institution before it. A longer tail is
        // its own author ("Colectivo Tierra Viva y Ana Ruiz").
        const soft: Array<{ sep: string; text: string }> = []
        for (const s of segmentsOf(h.text, SOFT_SPLIT)) {
          const prev = soft.at(-1)
          if (prev && isInstitution(prev.text) && nameWords(s.text).length <= 1) prev.text += s.sep + s.text
          else soft.push(s)
        }
        for (const s of soft) out += s.sep + (s.text.trim() === '' ? s.text : author(s.text, false))
      }
    }
    return out
  }
  // Field form first. What it leaves starts with "[", not a capital, so the
  // inline form cannot take the same byline twice.
  out = out.replace(BYLINE_FIELD, byline)
  out = out.replace(BYLINE_INLINE, byline)

  for (const re of [ID_FIELD, ID_INLINE]) {
    out = out.replace(re, () => {
      ids += 1
      return OMITTED_PLACEHOLDER
    })
  }

  pushCount(removed, LABEL_FECHA, dates)
  pushCount(removed, LABEL_ID, ids)
  pushCount(removed, LABEL_AUTOR, authors)

  return { text: out, removed }
}
