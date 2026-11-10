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

import { namePartsOf } from './nameParts'
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
// ⚠ `[A-Za-z0-9]` edges: `\b` exactly, except that `_` is NOT a letter. With `\b`
// the date in `entrevista_2026-03-03.m4a` was never seen (navegador 2026-11-10,
// D2). ASCII on purpose: a date glued to a decomposed "é" must still match.
const ISO_DATE =
  /(?<![A-Za-z0-9])(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![A-Za-z0-9])/g

/** `15/08/2026`, `15-08-2026`, `3/3/26` → `08/2026`. Day-first: this is es-MX. */
const SLASH_DATE = /(?<![A-Za-z0-9])(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?![A-Za-z0-9])/g

/**
 * True when the date at `[at, end)` is glued into an identifier by `-` or `_`:
 * `nav-2026-11-10-7`, `entrevista_2026-03-03.m4a`, `2026-03-03_notas`.
 *
 * 🔴 IT IS STILL A DATE, so it is still removed: WHOLE, as `[Dato omitido]`
 * (navegador 2026-11-10, D2). Coarsened in place, `nav-2026-11-10-7` became
 * `nav-2026-11-7`: a different identifier, with nothing marking the cut.
 */
function gluedIntoIdentifier(text: string, at: number, end: number): boolean {
  const alnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)
  const joiner = (c: string | undefined) => c === '-' || c === '_'
  return (joiner(text[at - 1]) && alnum(text[at - 2])) || (joiner(text[end]) && alnum(text[end + 1]))
}

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
 * it on 20,000 random strings), in linear time.
 *
 * 🔴 WHY NOT `split` (audit 5, 2026-10-28): the regex is tried at every
 * position, and inside a run of N spaces each try reads to the end of the run
 * before failing: N² ("Autor: Ana Ruiz | Lugar" + 60k spaces took 11.4 s, 23.9 s
 * with the additive passes). A try inside a whitespace run
 * succeeds or fails exactly as a try at the run's start does (both depend only
 * on what follows the run), so after a failed try the scan skips the run.
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
 * ── 🔴 THE ADDITIVE BYLINE PASSES (byline audits 1–3, 2026-10-28) ───────────
 *
 * The byline rules above are kept EXACTLY as they were. Two attempts to
 * replace them with an "is this author an institution?" classifier were
 * blocked: every version stopped registering names the rules above redacted
 * (five-word people, "d'Ávila", "Juan Pérez (Lucho) Gómez", "de la Vega",
 * "Red Gómez"). So what follows only ADDS: it starts where a byline the rules
 * above took ENDS, and redacts and registers what those rules left behind.
 * It never undoes a redaction or skips a registration.
 *
 * What it adds:
 *   · the authors after ";" and "|" ("Autores: Ana Ruiz; Luis Gómez"), unless
 *     the next segment is another field ("| Lugar: …") or plain prose;
 *   · the authors after a comma, "y", "e", "&" or "/" in a mid-line byline
 *     ("Notas. Autores: Ana Ruiz, Luis Gómez y Eva Paz.");
 *   · the name after a title the rules above stop at ("Ma.", "Pbro.", "vda."),
 *     in a byline or after an id key ("usuario: Ma. Elena Ruiz");
 *   · the words glued to a mid-line name ("d'Ávila", "van der Berg",
 *     "(Lucho) Gómez");
 *   · bylines under a key the rules above never read: "Autor(es):",
 *     "Autor/a:", "Autora/Autores:".
 *
 * ⚠ KNOWN OVER-REDACTION, ACCEPTED (owner, 2026-10-28): an institution in a
 * byline is registered like a person, so "Autor: Universidad Nacional Autónoma
 * de México" turns a later "México" into a `[Persona X]`. The same holds for a
 * place after the author ("Autor: Juan Pérez, Oaxaca"). A leak is worse.
 */

/**
 * A stage-1 replacement not yet resolved. U+FDD0/U+FDD1 are Unicode
 * noncharacters; any in the input are replaced with U+FFFD first, so the
 * sentinels below are the only ones in the text.
 */
const HOLD_OPEN = String.fromCharCode(0xfdd0)
const HOLD_CLOSE = String.fromCharCode(0xfdd1)
const HELD = new RegExp(String.raw`${HOLD_OPEN}(\d+)${HOLD_CLOSE}`, 'gu')
/** One sentinel at one position. Sticky. */
const HELD_Y = new RegExp(String.raw`${HOLD_OPEN}(\d+)${HOLD_CLOSE}`, 'uy')
const NONCHARACTERS = new RegExp(`[${HOLD_OPEN}${HOLD_CLOSE}]`, 'gu')
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd)

/** Titles whose dot does not end a name, for the additive passes: the list above plus these. */
const TITLE_WORDS_EXTRA = ['ma', 'pbro', 'presb', 'vda', 'fr', 'hno', 'hna', 'mons', 'gral', 'sto', 'sta', 'cap', 'tte', 'cnel']
const TITLE_X = [TITLE_ABBREVIATIONS, ...TITLE_WORDS_EXTRA.map(anyCase)].join('|')

/** A word ending in a title: the dot after it does not end the name. */
const ENDS_IN_TITLE = new RegExp(String.raw`(?:^|[^\p{L}\p{M}])(?:${TITLE_X})$`, 'u')

/** {@link FIELD_VALUE}, with the longer title list. Sticky: read at one position. */
const FIELD_VALUE_X = new RegExp(
  // ⚠ Never runs into a sentinel: a value ends where another redaction starts.
  String.raw`(?:[^\n\r|;\t.${HOLD_OPEN}${HOLD_CLOSE}]|\.(?!\s)|(?<=(?<![\p{L}\p{M}])(?:\p{L}|${TITLE_X}))\.)*` +
    String.raw`[^\s|;.${HOLD_OPEN}${HOLD_CLOSE}]`,
  'uy',
)

/** {@link NAME_WORD}, plus a title with its dot and an elided particle ("d'Ávila"). */
const NAME_WORD_X = String.raw`(?:(?=\p{Lu})(?:${TITLE_X})\.|\p{Lu}\.|\p{Lu}[\p{L}\p{M}'’\-]*|[dDlL]['’]\p{Lu}[\p{L}\p{M}'’\-]*)`

/** Inside a name, after its first word: also "(Lucho)" and "[entrevistador]". */
const NAME_PART_X = String.raw`(?:${NAME_WORD_X}|\([^()\n\r${HOLD_OPEN}]{1,40}\)|\[[^[\]\n\r${HOLD_OPEN}]{1,40}\])`

/** The small words inside a name, for the additive passes. */
const JOINER_X = String.raw`(?:de|del|la|las|los|y|e|van|von|der|den|ten|ter|da|di|do|dos|du|le|alias|viuda|vda\.)`

/** Lower-case words a name may START with: "de la Vega", "van der Berg". */
const LEADER_X = String.raw`(?:de|del|la|las|los|van|von|der|den|da|di|do|dos|du|alias)`

/** A capitalised name run, particles, parentheses and all. Sticky. */
const RUN_X = new RegExp(
  String.raw`(?:${LEADER_X}[ \t]+)*${NAME_WORD_X}(?:[ \t]+(?:${JOINER_X}[ \t]+)*${NAME_PART_X})*${VALUE_END}`,
  'uy',
)

/**
 * A name written in lower case: up to four words after an optional title
 * ("lic. sofía rojas", "juan de berg"). Never " y " / " e ", which split
 * authors. Taken only when it is not prose ({@link isProse}). Sticky.
 */
const LOWER_WORD = String.raw`\p{Ll}[\p{L}\p{M}'’\-]*`
const LOWER_RUN_X = new RegExp(
  String.raw`(?:(?:${TITLE_X})\.[ \t]+)?${LOWER_WORD}(?:[ \t]+(?!(?:y|e|and)[ \t])${LOWER_WORD}){0,3}${VALUE_END}`,
  'uy',
)

/** Words glued after a mid-line name the rules above stopped short of. Sticky. */
const GLUE_X = new RegExp(String.raw`(?: +(?:${JOINER_X} +)*${NAME_PART_X})+${VALUE_END}`, 'uy')

/** A separator between two authors. Sticky. */
const SEP_X = /(?:[ \t]*[,;|/&][ \t]*|[ \t]+(?:y|e|and)[ \t]+)/uy

/** A title's dot before the rest of the name. Sticky. */
const TITLE_DOT = /\.[ \t]+/uy

/**
 * Any byline key, including the forms the rules above never read: "Autor(es)",
 * "Autor/a", "Autora/Autores". A plain key counts too: its value may be one the
 * rules above did not take ("Notas. Autor: del Lara, Lía").
 */
const KEY_SUFFIX = [...['a', 'as', 'es', 's', 'o', 'os'].map(anyCase), BYLINE_KEY].join('|')
const BYLINE_X = new RegExp(
  String.raw`${KEY_START}(?:${BYLINE_KEY})(?:[ \t]*(?:\([ \t]*(?:${KEY_SUFFIX})[ \t]*\)|/[ \t]*(?:${KEY_SUFFIX})))*${BYLINE_SEP}`,
  'gmu',
)

/**
 * A field starts at `k`: line start or `|` `;` tab, then markdown only. Reads
 * backwards over the markdown alone, so it costs nothing on a long line.
 */
function fieldStartsAt(line: string, k: number): boolean {
  for (let i = k - 1; i >= 0; i--) {
    const c = line[i] as string
    if (c === '|' || c === ';' || c === '\t') return true
    if (!' >*_#-'.includes(c)) return false
  }
  return true
}


/** A line that may hold a byline key at all: the key-reading passes skip the rest. */
const BYLINE_HINT = /aut(?:or|hor)/iu

/** Accent- and case-blind. */
const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const PROSE_OPENERS: ReadonlySet<string> = new Set([
  'que', 'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'de', 'del', 'en', 'y', 'e', 'o', 'u', 'a',
  'por', 'para', 'con', 'sin', 'segun', 'sobre', 'entre', 'hasta', 'desde', 'como', 'cuando',
  'donde', 'pero', 'si', 'se', 'su', 'sus', 'este', 'esta', 'ese', 'esa', 'al', 'no', 'ya',
])

/** Words a name never holds. ⚠ A LIST, NOT A SUFFIX RULE: "-ar" would catch Aguilar. */
const PROSE_WORDS: ReadonlySet<string> = new Set(
  [
    ...PROSE_OPENERS,
    'ver', 'vease', 'vea', 'consultar', 'consulte', 'es', 'son', 'fue', 'fueron', 'era', 'esta',
    'estan', 'ha', 'han', 'hay', 'sera', 'revisado', 'revisada', 'publicado', 'publicada', 'anexo',
  ].filter((w) => !['de', 'la', 'las', 'los', 'y', 'e'].includes(w)),
)

/**
 * A lower-case segment that is plainly prose, not a name written in lower
 * case: five words or more, a function-word opener, or a verb or function
 * word inside. "luis gómez" is a name; "el texto fue revisado" is prose.
 */
function isProse(segment: string): boolean {
  const words = (segment.match(/[\p{L}\p{M}]+/gu) ?? []).map(fold)
  if (words.length === 0) return true
  if (words.length >= 5 || PROSE_OPENERS.has(words[0] as string)) return true
  return words.some((w) => PROSE_WORDS.has(w))
}

/*
 * ── 🔴 KEEPING A DOCUMENT'S ACTUAL AUTHORS (owner ruling R60, 2026-10-28) ───
 *
 * "Don't redact authors", clarified by the owner the same day: ONLY the
 * document's actual author — its uploader, by their membership's `personName`.
 * A byline that names anyone else is redacted wherever it sits, so a
 * forged "Autora: …" line (a quote, a list item, a heading, a reference, an
 * interview's "Por:") cannot unhide anybody: the names come from the
 * membership, never from the text.
 *
 * 🔴 NEVER `users.displayName`: every account edits its own, so an account
 * named "Carla Méndez" could publish "Autora: Carla Méndez". `personName` only
 * changes through whoever manages members (`Memberships.ts`, `manageAccess`).
 *
 * Stage 1 itself still redacts every byline. The gate runs it a SECOND time
 * with `keepAuthors` to get the text it restores from (`authorRestore.ts`):
 * identical, except that a byline piece naming a trusted author is left as
 * written.
 */

/**
 * Field labels the additive passes must not take for an author: "Autor: Ana
 * Ruiz | Lugar y fecha" used to come out "[Persona B] y [Dato omitido]", and
 * the one-word owner then redacted every later "Lugar". A CLOSED LIST on
 * purpose: a piece with any other word ("Lugar Oaxaca", "Lugar de Ana Ruiz")
 * or anything but letters, marks, spaces and basic punctuation is still
 * redacted: a number of any kind ("Fecha ٥٥١٢٣٤٥٦٧٨", "Fecha ①②③", "Fecha 🔟"),
 * a symbol, a format character.
 * 🔴 "Estado" is not on it: it is a surname here (`Autores: Luis Gómez; Estado`),
 * and a label left in the text would show it.
 */
const FIELD_LABELS: ReadonlySet<string> = new Set([
  'lugar', 'fecha', 'hora', 'sede', 'ciudad', 'municipio', 'pais', 'region', 'comunidad',
  'localidad', 'entrevista', 'tema', 'titulo', 'proyecto', 'sesion', 'duracion',
])
const LABEL_JOINERS: ReadonlySet<string> = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en'])
/** What a field label may hold besides its words. */
const NOT_LABEL_TEXT = /[^\p{L}\p{M}\s.,;:'’-]/u

export function isFieldLabel(piece: string): boolean {
  const words = (piece.match(/[\p{L}\p{M}]+/gu) ?? []).map(fold)
  if (NOT_LABEL_TEXT.test(piece) || !words.some((w) => FIELD_LABELS.has(w))) return false
  return words.every((w) => FIELD_LABELS.has(w) || LABEL_JOINERS.has(w))
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
   * R60: the document's TRUSTED authors (from its uploader's account, never
   * from the text), each with at least two name parts. A byline piece that IS
   * one of them, exactly as written there, is LEFT AS WRITTEN and its range
   * returned in `bylines`. Every other piece ("Dra. Ana Ruiz", the pair "Ruiz,
   * Ana", "ANA RUIZ", "Ana") is redacted as without it.
   */
  keepAuthors?: readonly string[]
}

/**
 * A byline piece holding what stage 2 cannot read, so nothing later would catch
 * a phone in it: a number that is not ASCII ("٥٥٥", "①②③"), a symbol ("🔟") or
 * a keycap ("5️⃣", an ASCII digit and an enclosing mark).
 */
const UNREADABLE_PIECE = /[^\p{L}\p{M}\s\p{P}0-9]|\p{Me}/u

/** R60: what a kept byline piece may hold. Anything else (a phone, an address) stays redacted. */
const KEEPABLE_PIECE = /^[\p{L}\p{M}\s.'’-]+$/u

export function structuralPass(
  text: string,
  options: StructuralOptions = {},
): {
  text: string
  removed: RedactionCount[]
  /** R60: `[start, end)` of each kept byline piece in `text` (only with `keepAuthors`). */
  bylines: Array<[number, number]>
} {
  const removed: RedactionCount[] = []
  let dates = 0
  let ids = 0
  let authors = 0

  // 🔴 Noncharacters out first: the sentinels below must be the only ones (audit 4).
  const trusted = new Set((options.keepAuthors ?? []).filter((name) => namePartsOf(name).length >= 2))
  let out = text.replace(NONCHARACTERS, REPLACEMENT_CHARACTER)

  out = out.replace(ISO_DATE, (m: string, year: string, month: string, _day: string, at: number, whole: string) => {
    dates += 1
    if (gluedIntoIdentifier(whole, at, at + m.length)) return OMITTED_PLACEHOLDER
    return `${year}-${month}`
  })

  out = out.replace(SLASH_DATE, (m: string, _day: string, month: string, year: string, at: number, whole: string) => {
    dates += 1
    if (gluedIntoIdentifier(whole, at, at + m.length)) return OMITTED_PLACEHOLDER
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

  // Every replacement from here on is HELD as a noncharacter sentinel and
  // resolved at the end, so the additive passes know where each byline ended
  // and what it ended on. Same replacements, same `person` calls, same order.
  const held: string[] = []
  const hold = (replacement: string): string => {
    held.push(replacement)
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`
  }
  /**
   * Where each byline or id value ended: its last sentinel (`id`), its first
   * (`first`), and the text its last piece replaced (`source`).
   */
  interface End {
    mode: 'field' | 'inline' | 'id'
    id: number
    first: number
    source: string
  }
  const ends: End[] = []

  // Each author on its own: "Ana Ruiz y Luis Gómez" is two people, two labels.
  // A piece with no capital letter ("anónimo") gets no person label.
  // R60: a piece that is a trusted author's whole name is held as written instead.
  const keptIds = new Set<number>()
  const holdKept = (piece: string): string => {
    const r = hold(piece)
    keptIds.add(held.length - 1)
    return r
  }
  /** A kept piece the additive passes found glued to more name is not the author: redact it. */
  const unkeep = (id: number, source: string): void => {
    if (!keptIds.delete(id)) return
    authors += 1
    held[id] = options.person && /\p{Lu}/u.test(source) ? options.person(source) : OMITTED_PLACEHOLDER
  }
  /**
   * One capitalised word across a comma may be the rest of the name
   * ("Autores: Hernández, María Guadalupe"): not the author as written. A
   * co-author of two words or a field label beside it does not count.
   */
  const loneWordBeside = (split: string[], i: number): boolean => {
    const lone = (separator: string | undefined, piece: string | undefined) =>
      separator?.includes(',') === true && piece !== undefined && /^\p{Lu}[\p{L}\p{M}'’-]*$/u.test(piece.trim()) && !isFieldLabel(piece)
    return lone(split[i - 1], split[i - 2]) || lone(split[i + 1], split[i + 2])
  }
  /** The indexes of `splitAuthors` output that name a trusted author. Letters only: a phone in the piece keeps nothing. */
  const keptPieces = (split: string[]): Set<number> => {
    const keep = new Set<number>()
    if (trusted.size === 0) return keep
    for (let i = 0; i < split.length; i += 2) {
      const piece = split[i] as string
      if (KEEPABLE_PIECE.test(piece) && trusted.has(piece.trim()) && !loneWordBeside(split, i)) keep.add(i)
    }
    return keep
  }

  const byline = (mode: 'field' | 'inline') => (_m: string, key: string, value: string) => {
    const first = held.length
    let source: string | null = null
    const split = splitAuthors(value)
    const keep = keptPieces(split)
    const replaced =
      key +
      split
        .map((piece, i) => {
          if (i % 2 === 1 || piece.trim() === '') return piece
          source = piece
          if (keep.has(i)) return holdKept(piece)
          authors += 1
          return hold(options.person && /\p{Lu}/u.test(piece) ? options.person(piece) : OMITTED_PLACEHOLDER)
        })
        .join('')
    if (source !== null) ends.push({ mode, id: held.length - 1, first, source })
    return replaced
  }
  // Field form first. What it leaves starts with a sentinel, not a capital, so
  // the inline form cannot take the same byline twice.
  out = out.replace(BYLINE_FIELD, byline('field'))
  out = out.replace(BYLINE_INLINE, byline('inline'))

  for (const re of [ID_FIELD, ID_INLINE]) {
    out = out.replace(re, (m: string) => {
      ids += 1
      const r = hold(OMITTED_PLACEHOLDER)
      ends.push({ mode: 'id', id: held.length - 1, first: held.length - 1, source: m })
      return r
    })
  }

  // ── The additive passes (see the header above TITLE_WORDS_EXTRA) ────────
  /** One author, redacted and registered. `prefix`: the words the rules above already took. */
  const take = (piece: string, prefix = ''): string => {
    authors += 1
    const name = prefix + piece
    return hold(options.person && /\p{Lu}/u.test(name) ? options.person(name) : OMITTED_PLACEHOLDER)
  }
  /**
   * Each author in `segment`, split like the rules above split a value.
   * `failClosed` (a field nobody read before) takes every piece, as the rules
   * above do; otherwise lower-case prose stays, and so does a label with a
   * number ("Entrevista 3", "Fecha 2026").
   * 🔴 A NUMBER BESIDE A NAME DOES NOT SAVE IT (audit 4): a digit keeps a piece
   * only when the piece has fewer than two capitalised words. "Luis Gómez
   * (2021)" and "Luis Gómez 2" are authors. ASCII digits only on purpose: stage
   * 2 reads those, so a phone there is still caught. 🔴 A piece stage 2 cannot
   * read ({@link UNREADABLE_PIECE}) is taken whatever else it looks like.
   */
  const takeAll = (segment: string, failClosed: boolean, prefix = ''): string => {
    const split = splitAuthors(segment)
    // A prefix means the rules above took part of this name: never a kept piece.
    const keep = prefix === '' ? keptPieces(split) : new Set<number>()
    return split
      .map((piece, i) => {
        if (i % 2 === 1 || piece.trim() === '') return piece
        if (keep.has(i)) return holdKept(piece)
        const bare = piece.replace(/\([^()]*\)/gu, '') // "(2021)", "(Lupita)": never a label's number
        const label = /\d/u.test(bare) && (bare.match(/\p{Lu}[\p{L}\p{M}]/gu) ?? []).length < 2
        if (!failClosed && !UNREADABLE_PIECE.test(piece) && (label || isFieldLabel(piece) || (!/\p{Lu}/u.test(piece) && isProse(piece)))) return piece
        return take(piece, i === 0 ? prefix : '')
      })
      .join('')
  }
  /** The match of sticky `re` at `i` in `s`, or null when empty. */
  const at = (re: RegExp, s: string, i: number): string | null => {
    re.lastIndex = i
    const m = re.exec(s)
    return m && m[0] !== '' ? m[0] : null
  }
  /** A name at `i` mid-line: capitalised, or lower case and not prose. */
  const nameAt = (s: string, i: number): string | null => {
    const run = at(RUN_X, s, i)
    if (run) return run
    const lower = at(LOWER_RUN_X, s, i)
    return lower && !isProse(lower) ? lower : null
  }

  /**
   * Extend the byline whose value ended at `start` of `line` (`source`: the
   * last piece it took). Pushes the text from `start` on into `parts`, with
   * what it redacts replaced, and returns where it stopped.
   */
  const extend = (line: string, start: number, mode: End['mode'], source: string, lastId: number, parts: string[]): number => {
    let i = start

    // 1. A title's dot ended the value: "Ma. Elena Ruiz", "Ana Ruiz vda. de Gómez".
    const dot = ENDS_IN_TITLE.test(source.trimEnd()) ? at(TITLE_DOT, line, i) : null
    if (dot) {
      const s = i + dot.length
      const v = at(mode === 'field' ? FIELD_VALUE_X : RUN_X, line, s)
      if (v && !/[:=]/u.test(v)) {
        parts.push(dot)
        if (mode === 'id') {
          ids += 1
          parts.push(hold(OMITTED_PLACEHOLDER))
        } else {
          unkeep(lastId, source)
          parts.push(takeAll(v, true, `${source.trim()}. `))
        }
        i = s + v.length
      }
    }
    if (mode === 'id') return i

    // 2. Words glued to a mid-line name: "Ana d'Ávila", "Juan Pérez (Lucho) Gómez".
    if (mode === 'inline' && i === start) {
      const g = at(GLUE_X, line, i)
      if (g && !/[:=]/u.test(g)) {
        const lead = /^ +/u.exec(g)?.[0] ?? ''
        unkeep(lastId, source)
        parts.push(lead, take(g.slice(lead.length), `${source.trim()} `))
        i += g.length
      }
    }

    // 2b. A field the rules above read through an inner key stops at "(" or a
    // digit ("Autora/Autores: Ana (Lupita) Ruiz", "Equipo 3"): the rest of the
    // field is the same author. A field the rules above took whole ends at a
    // separator, where this reads nothing.
    if (mode === 'field' && i === start && /^[ \t]/u.test(line.slice(i, i + 1))) {
      const v = at(FIELD_VALUE_X, line, i)
      if (v && !/[:=]/u.test(v) && v.trim() !== '') {
        const lead = /^[ \t]+/u.exec(v)?.[0] ?? ''
        unkeep(lastId, source)
        parts.push(lead, takeAll(v.slice(lead.length), true, `${source.trim()} `))
        i += v.length
      }
    }

    // 3. The authors after it, separator by separator.
    for (;;) {
      const sep = at(SEP_X, line, i)
      if (!sep) break
      const s = i + sep.length
      const hard = /[;|]/u.test(sep)
      // A field value never runs into a sentinel (FIELD_VALUE_X); a run cannot hold one.
      const v = mode === 'field' || hard ? at(FIELD_VALUE_X, line, s) : nameAt(line, s)
      // Another field ("| Lugar: …") ends the byline.
      if (!v || ((mode === 'field' || hard) && /[:=]/u.test(v))) break
      parts.push(sep, takeAll(v, false))
      i = s + v.length
    }
    return i
  }

  // 🔴 ONE LEFT-TO-RIGHT PASS PER LINE (audit 4: rescanning and re-slicing
  // took 4.3 s on a 2 MB one-line document, against 24 ms before). Every
  // byline is one line; each sentinel and key is read once, in order, and
  // the line is rebuilt from pieces.
  const endAt = new Map(ends.map((e) => [e.id, e]))
  const groupAt = new Map(ends.map((e) => [e.first, e]))
  const EVENT = new RegExp(`${HELD.source}|(${BYLINE_X.source})`, 'gmu')
  const extendLine = (line: string): string => {
    if (!line.includes(HOLD_OPEN) && !BYLINE_HINT.test(line)) return line
    const parts: string[] = []
    let c = 0 // the input is copied up to here
    for (const m of line.matchAll(EVENT)) {
      if (m.index < c) continue // already inside a byline the passes took
      const after = m.index + m[0].length
      if (m[2] === undefined) {
        // A sentinel: extend the byline whose LAST piece it is.
        const e = endAt.get(Number(m[1]))
        if (!e) continue
        parts.push(line.slice(c, after))
        c = extend(line, after, e.mode, e.source, e.id, parts)
        continue
      }
      const field = fieldStartsAt(line, m.index)
      if (line[after] === HOLD_OPEN) {
        // A key the rules above never read, at a field start, whose value they
        // took through an inner key ("Autora/Autores: …"): read it as a field.
        const g = groupAt.get(Number(at(HELD_Y, line, after)?.slice(1, -1)))
        if (field && g?.mode === 'inline') g.mode = 'field'
        continue
      }
      // A key whose value nothing above took: "Autor(es): Juan Pérez", or a
      // mid-line name that starts with a particle ("Notas. Autor: de la Vega").
      const value = field ? at(FIELD_VALUE_X, line, after) : nameAt(line, after)
      if (!value) continue
      parts.push(line.slice(c, after), takeAll(value, field))
      const last = splitAuthors(value).at(-1) ?? ''
      c = extend(line, after + value.length, field ? 'field' : 'inline', last, held.length - 1, parts)
    }
    parts.push(line.slice(c))
    return parts.join('')
  }
  out = out
    .split(/(\r\n|\n|\r)/u)
    .map((part, i) => (i % 2 === 1 ? part : extendLine(part)))
    .join('')

  const bylines: Array<[number, number]> = []
  let delta = 0
  out = out.replace(HELD, (m: string, i: string, offset: number) => {
    const r = held[Number(i)] as string
    if (keptIds.has(Number(i))) bylines.push([offset + delta, offset + delta + r.length])
    delta += r.length - m.length
    return r
  })

  pushCount(removed, LABEL_FECHA, dates)
  pushCount(removed, LABEL_ID, ids)
  pushCount(removed, LABEL_AUTOR, authors)

  return { text: out, removed, bylines }
}
