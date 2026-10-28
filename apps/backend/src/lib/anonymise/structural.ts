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

/** Titles whose abbreviation dot does NOT end a byline: "Autor: Dr. Juan Pérez". */
const TITLE_ABBREVIATIONS = ['dr', 'dra', 'sr', 'sra', 'srta', 'lic', 'ing', 'mtro', 'mtra', 'prof', 'profa', 'arq', 'mr', 'mrs', 'ms', 'jr']
  .map(anyCase)
  .join('|')

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
const NAME_WORD = String.raw`(?:\p{Lu}\.|\p{Lu}[\p{L}\p{M}'’\-]*)`

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

/**
 * `[*_]*` takes markdown bold around the key or the colon: `**Autor:**`.
 * 🔴 `(?:[*_]+[ \t]*)?`, NOT `[*_]*[ \t]*` after the colon's spaces: two
 * `[ \t]*` around an empty `[*_]*` split a run of N spaces N ways, and
 * "Autor:" + 20k spaces + "x" took 0.5 s, 4x per 2x (measured 2026-10-28,
 * local tsx). Same strings matched.
 */
const BYLINE_SEP = String.raw`[*_]*[ \t]*[:=][ \t]*(?:[*_]+[ \t]*)?`

/** A byline at a field start: the whole field is the value, whatever its case. */
const BYLINE_FIELD = new RegExp(
  String.raw`${FIELD_START}${KEY_START}((?:${BYLINE_KEY})${BYLINE_SEP})(${FIELD_VALUE})`,
  'gmu',
)

/**
 * A byline mid-line ("Notas de clase. Autor: Juan Pérez, 2026."): only a
 * CAPITALISED name run, so "el autor: según él" — a sentence — is left alone.
 */
const BYLINE_INLINE = new RegExp(String.raw`${KEY_START}((?:${BYLINE_KEY})${BYLINE_SEP})(${NAME_RUN})`, 'gmu')

/**
 * Where one author ends and the next begins: `,` `;` `/` `&`, or " y " / " e "
 * / " and ". The pattern is `/(\s*[,;/&]\s*|\s+(?:y|e|and)\s+)/u`; see
 * {@link splitAuthors} for why it is not used with `String.split`.
 */
const AUTHOR_SEPARATOR_CHARS = ',;/&'
const AUTHOR_WORDS = ['y', 'e', 'and']
const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c)

/**
 * `value.split(/(\s*[,;/&]\s*|\s+(?:y|e|and)\s+)/u)`, EXACTLY (a test checks
 * it on 20,000 random strings), in linear time. Taken from the byline-parsing
 * lane (worktree-agent-a5e482ec8faa9397f, 9c92994).
 *
 * 🔴 WHY NOT `split` (audit 5, 2026-10-28): the regex is tried at every
 * position, and inside a run of N spaces each try reads to the end of the run
 * before failing: N² ("Autor: Ana Ruiz | Lugar" + 60k spaces took 11.4 s,
 * measured by that lane). A try inside a whitespace run succeeds or fails
 * exactly as a try at the run's start does, so after a failed try the scan
 * skips the run.
 */
export function splitAuthors(value: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < value.length) {
    let b = i
    while (isSpace(value[b])) b++
    let end = -1
    if (b < value.length && AUTHOR_SEPARATOR_CHARS.includes(value[b] as string)) end = b + 1
    else if (b > i) {
      const word = AUTHOR_WORDS.find((w) => value.startsWith(w, b) && isSpace(value[b + w.length]))
      if (word !== undefined) end = b + word.length
    }
    if (end < 0) {
      i = b + 1 // no separator starts anywhere in this run, nor at the character after it
      continue
    }
    while (isSpace(value[end])) end++
    out.push(value.slice(start, i), value.slice(i, end))
    start = i = end
  }
  out.push(value.slice(start))
  return out
}

/*
 * ── 🔴 KEEPING A DOCUMENT'S OWN AUTHORS (owner ruling R60, 2026-10-28) ──────
 *
 * "Don't redact authors." The people a `documento` names in its own byline
 * stay visible, in the byline and everywhere else in that document, even
 * when they are on the roster. Everyone else stays redacted.
 *
 * This stage does NOT decide what is shown. It only (a) leaves a CLEAN byline
 * for stages 2–4 to redact like any other name, and (b) reports its authors.
 * The gate then restores those authors' placeholders after verify, from the
 * source text (`authorRestore.ts`), the same "redact all, then restore" shape
 * as public figures.
 *
 * 🔴 FAIL CLOSED: a byline is CLEAN only when every piece of it parses as a
 * person's name (see {@link parseByline}). Anything else — prose, an
 * institution, a digit, a parenthesis, a value over {@link BYLINE_KEEP_MAX}
 * characters, a key in the middle of a sentence — goes through the rules
 * below exactly as before R60, and its authors stay redacted.
 */

/** The byline keys R60 keeps: "Autor:", "Autora:", "Autores:", "Por:" (and English). */
const KEEP_KEY_WORDS = ['autor', 'autora', 'autores', 'autoras', 'author', 'authors', 'por']
const KEEP_BYLINE_KEY = new RegExp(
  String.raw`${KEY_START}(?:${KEEP_KEY_WORDS.map(anyCase).join('|')})[*_]*[ \t]*:[ \t]*(?:[*_]+[ \t]*)?`,
  'gu',
)

/** Longest byline value that may be kept. Longer → fail closed (and linear: a value is read at most this far). */
export const BYLINE_KEEP_MAX = 300

/** Byline keys, folded: a detector span "Autora: Ana Ruiz" is still the author. */
export const BYLINE_KEY_WORDS: ReadonlySet<string> = new Set(KEEP_KEY_WORDS)

/**
 * A key at `k` starts a field: line start, or `|` `;` tab, then markdown
 * only. Reads backwards over the markdown alone, so the whole pass stays
 * linear. (From the byline-parsing lane.)
 */
function fieldStartsAt(text: string, k: number): boolean {
  for (let i = k - 1; i >= 0; i--) {
    const c = text[i] as string
    if (c === '\n' || c === '\r' || c === '|' || c === ';' || c === '\t') return true
    if (!' >*_#-'.includes(c)) return false
  }
  return true
}

/**
 * The end of a byline value starting at `from`: a line end, `|`, a tab, or a
 * sentence end (". " not after an initial or a title). -1 when none comes
 * within {@link BYLINE_KEEP_MAX} characters and the text goes on.
 */
function bylineValueEnd(text: string, from: number): number {
  const limit = Math.min(text.length, from + BYLINE_KEEP_MAX + 1)
  for (let i = from; i < limit; i++) {
    const c = text[i] as string
    if (c === '\n' || c === '\r' || c === '|' || c === '\t') return i
    if (c === '.' && (i + 1 === text.length || /\s/u.test(text[i + 1] as string))) {
      const before = /(?:^|[^\p{L}\p{M}])([\p{L}\p{M}]+)$/u.exec(text.slice(Math.max(from, i - 8), i))?.[1] ?? ''
      if (before.length === 1 || TITLE_WORDS.has(before.toLowerCase())) continue
      return i
    }
  }
  return limit === text.length ? limit : -1
}

/** Titles whose dot is not a sentence end, and that may lead a kept name. */
const TITLE_WORDS: ReadonlySet<string> = new Set([
  'dr', 'dra', 'sr', 'sra', 'srta', 'lic', 'ing', 'mtro', 'mtra', 'prof', 'profa', 'arq', 'mr', 'mrs', 'ms',
  'ma', 'pbro', 'presb', 'mons', 'fr', 'hno', 'hna', 'jr',
])
const TITLE_X = [...TITLE_WORDS].map(anyCase).join('|')

/** A capitalised name word: "Ruiz", "O'Brien", "McAllen", "Ruiz-Pérez", "d'Ávila". Never ALL CAPS. */
const KEEP_WORD = String.raw`(?:\p{Lu}(?:['’]\p{Lu})?[\p{Ll}\p{M}]+(?:\p{Lu}[\p{Ll}\p{M}]+|-\p{Lu}?[\p{Ll}\p{M}]+)*|[dDlL]['’]\p{Lu}[\p{Ll}\p{M}]+|\p{Lu}\.)`
/** Particles inside or at the start of a name: "de la Cruz", "van der Berg". */
const KEEP_PARTICLE = '(?:de|del|la|las|los|van|von|der|den|da|di|do|dos|du)'
/** One person's name, whole: optional titles, particles, two to six name words at most. */
const KEEP_NAME = new RegExp(
  String.raw`^(?:(?:${TITLE_X})\.?[ \t]+)*(?:${KEEP_PARTICLE}[ \t]+)*${KEEP_WORD}(?:[ \t]+(?:${KEEP_PARTICLE}[ \t]+)*${KEEP_WORD}){0,5}$`,
  'u',
)
/** Only initials: "A.", "A. M.", "J.-P.". */
const INITIALS_ONLY = /^(?:\p{Lu}\.[ \t]*-?[ \t]*)+$/u

/** A word that makes a byline piece an institution, not a person. Folded. */
const INSTITUTION_WORDS: ReadonlySet<string> = new Set([
  'universidad', 'instituto', 'centro', 'colectivo', 'red', 'comite', 'secretaria', 'gobierno',
  'asociacion', 'fundacion', 'equipo', 'grupo', 'coordinacion', 'departamento', 'facultad', 'escuela',
  'consejo', 'comision', 'programa', 'proyecto', 'laboratorio', 'observatorio', 'cooperativa',
  'organizacion', 'sociedad', 'unidad', 'direccion', 'area', 'comunidad', 'taller', 'seminario',
  'editorial', 'revista', 'anonimo', 'anonima', 'varios', 'varias', 'redaccion', 'staff', 'ejido',
  'municipio', 'ayuntamiento', 'colegio', 'museo', 'biblioteca', 'archivo', 'oficina', 'agencia',
])

const foldWord = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const wordCount = (s: string) => (s.match(/[\p{L}\p{M}]+/gu) ?? []).length

/** One piece is one person's name, and not an institution. */
function personName(piece: string): boolean {
  if (!KEEP_NAME.test(piece)) return false
  return (piece.match(/[\p{L}\p{M}]+/gu) ?? []).every((w) => !INSTITUTION_WORDS.has(foldWord(w)))
}

/**
 * The authors a byline VALUE names, in natural order ("Ruiz, Ana" → "Ana
 * Ruiz"), or NULL when any piece of it is not plainly a person's name.
 *
 *   · `;` separates authors; inside one, `Surname, Given` is surname-first.
 *   · Without `;`: `,` `y` `e` `&` `/` separate authors, except a lone
 *     "Ruiz, Ana" / "Ruiz, A." (surname-first) and an APA list of
 *     "Surname, I." pairs.
 *   · A final ", 2021" or "(2021)" is dropped; any other digit, a
 *     parenthesis, a colon, an ALL-CAPS word, a lower-case word that is not
 *     a particle, or an institution word ("Universidad", "Colectivo") → NULL.
 */
export function parseByline(raw: string): string[] | null {
  if (raw.length > BYLINE_KEEP_MAX) return null
  let v = raw.replace(/[*_]+$/u, '').trim()
  v = v.replace(/(?<=[\p{Ll}\p{M}\d)])\.$/u, '')
  v = v.replace(/[ \t]*(?:,[ \t]*\(?|\()[ \t]*\d{4}[ \t]*\)?$/u, '').trim()
  v = v.replace(/(?<=[\p{Ll}\p{M}])\.$/u, '')
  if (v === '' || /[^\p{L}\p{M} \t.,;/&'’-]/u.test(v)) return null
  const semicolons = v.includes(';')
  const authors: string[] = []
  for (const segment of semicolons ? v.split(';') : [v]) {
    const split = splitAuthors(segment.trim())
    const names = split.filter((_, i) => i % 2 === 0).map((p) => p.trim())
    const seps = split.filter((_, i) => i % 2 === 1).map((p) => p.trim())
    if (names.some((n) => n === '')) return null
    const surnameFirst =
      names.length === 2 &&
      seps[0] === ',' &&
      (semicolons || INITIALS_ONLY.test(names[1] as string) || (wordCount(names[0] as string) === 1 && wordCount(names[1] as string) <= 2))
    const apaPairs =
      !surnameFirst &&
      names.length >= 4 &&
      names.length % 2 === 0 &&
      names.every((n, i) => (i % 2 === 1 ? INITIALS_ONLY.test(n) : !INITIALS_ONLY.test(n))) &&
      seps.every((s, i) => i % 2 === 1 || s === ',')
    if (surnameFirst || apaPairs) {
      for (let i = 0; i < names.length; i += 2) {
        const [surname, given] = [names[i] as string, names[i + 1] as string]
        if (!personName(surname) || !personName(given)) return null
        authors.push(`${given} ${surname}`)
      }
    } else {
      for (const n of names) {
        if (!personName(n)) return null
        authors.push(n)
      }
    }
  }
  return authors.length > 0 ? authors : null
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
  /**
   * R60: called once per author of each CLEAN byline at a field start (see
   * {@link parseByline}). With it, such a byline is LEFT IN THE TEXT for
   * stages 2–4 and the gate restores its authors afterwards. Without it (or
   * for a byline that does not parse), the byline is redacted as before.
   */
  keepAuthor?: (name: string) => void
}

/** A clean byline held out of the redaction rules below. A noncharacter: the input's own are replaced first. */
const KEPT = String.fromCharCode(0xfdd0)
const NONCHARACTER = new RegExp(KEPT, 'gu')

export function structuralPass(
  text: string,
  options: StructuralOptions = {},
): {
  text: string
  removed: RedactionCount[]
  /** R60: `[start, end)` of each kept byline (key and value) in `text`. */
  bylines: Array<[number, number]>
} {
  const removed: RedactionCount[] = []
  let dates = 0
  let ids = 0
  let authors = 0

  // 🔴 The input's own U+FDD0 out first: the held-byline sentinel must be the only one.
  let out = options.keepAuthor ? text.replace(NONCHARACTER, String.fromCharCode(0xfffd)) : text

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
  // A piece with no capital letter ("anónimo") gets no person label.
  const byline = (_m: string, key: string, value: string) =>
    key +
    splitAuthors(value)
      .map((piece, i) => {
        if (i % 2 === 1 || piece.trim() === '') return piece
        authors += 1
        return options.person && /\p{Lu}/u.test(piece) ? options.person(piece) : OMITTED_PLACEHOLDER
      })
      .join('')
  // R60: a CLEAN byline at a field start is held out of every rule below, and
  // its authors reported. Linear: each key is read once, its value at most
  // BYLINE_KEEP_MAX characters far.
  const kept: string[] = []
  if (options.keepAuthor) {
    const keepAuthor = options.keepAuthor
    const pieces: string[] = []
    let copied = 0
    for (const m of out.matchAll(KEEP_BYLINE_KEY)) {
      if (m.index < copied || !fieldStartsAt(out, m.index)) continue
      const from = m.index + m[0].length
      const end = bylineValueEnd(out, from)
      const authors = end < 0 ? null : parseByline(out.slice(from, end))
      if (authors === null) continue
      for (const a of authors) keepAuthor(a)
      pieces.push(out.slice(copied, m.index), KEPT)
      kept.push(out.slice(m.index, end))
      copied = end
    }
    if (kept.length > 0) out = pieces.join('') + out.slice(copied)
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

  const bylines: Array<[number, number]> = []
  if (kept.length > 0) {
    let k = 0
    let delta = 0
    out = out.replace(NONCHARACTER, (_m: string, offset: number) => {
      const t = kept[k++] as string
      bylines.push([offset + delta, offset + delta + t.length])
      delta += t.length - 1
      return t
    })
  }

  pushCount(removed, LABEL_FECHA, dates)
  pushCount(removed, LABEL_ID, ids)
  pushCount(removed, LABEL_AUTOR, authors)

  return { text: out, removed, bylines }
}
