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
 * phones, CURP, RFC, URLs, handles, long digit runs. Real, worth removing,
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
  /** A street line: a via publica, its name, and a number. */
  domicilio: 'domicilio',
  /** `C.P. 06700` on its own. */
  codigoPostal: 'codigo-postal',
  /** `Col. Portales`, `Fracc. Los Sauces`, `Mz. 4 Lt. 12`. */
  asentamiento: 'asentamiento',
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
// DOMICILIOS — the owner's decision: "addressess should be anonimized"
// ---------------------------------------------------------------------------
//
// ── 🔴 WHY THE HIGHLY-PATTERNED HALF LIVES HERE AND NOT WITH THE MODEL ───────
//
// This started as a MEASURED failure, not a hunch. On a live test testimony the
// gate HELD the document because a street address survived stage 3, and stage 4
// caught it. Holding was the right outcome; the address surviving was not.
//
// The split we chose, and why:
//
//   · `C.P. 06700`, `Calle Morelos No. 45`, `Mz. 4 Lt. 12` are POSTAL NOTATION.
//     They have a shape, the shape does not vary, and a regex that reads the
//     shape is right every time and costs nothing. Handing them to a
//     probabilistic detector means paying a model to re-derive a grammar we
//     already know — and, as measured, occasionally getting it wrong.
//   · "vivo enfrente de la tienda de doña Mari, subiendo por donde el tanque" is
//     an address with no shape at all. No regex reaches it. It stays with the
//     model, whose prompt names domicilios explicitly.
//
// ── 🔴 EVERY RULE BELOW NEEDS A STRUCTURAL ANCHOR. THAT IS THE WHOLE DESIGN ──
//
// Measured against the 250-document synthetic corpus (`corpus-generativo`),
// which contains ZERO addresses and a great many address-shaped WORDS:
//
//     `calle`     20 hits / 16 docs — every one is `[se escucha ruido de calle]`
//     `colonia`   365 hits / 159 docs — ~60% the common noun ("la colonia es
//                 nuestra", "delegada de colonia"); the rest a neighbourhood
//                 named in ordinary prose, never in address position
//     `manzana`   19 hits / 19 docs — "las visitas por manzana", a walking route
//     `camino`    39 hits / 37 docs — metaphor, every time
//     `dirección` 26 hits / 22 docs — the school PRINCIPAL'S OFFICE
//
// A bare-keyword rule would have redacted two thirds of that corpus and removed
// the thing those testimonies are ABOUT — the neighbourhood — while removing no
// address, because there are none. So every rule here demands a companion token
// prose does not produce: a house number, five postal digits, or an abbreviation
// carrying its full stop.
//
// ⚠ THAT IS WHY SPELLED-OUT `colonia X` IS DELIBERATELY NOT A RULE. `Col.` is
// postal notation; `colonia` is a word people say about where they live. The
// abbreviation is matched here, the noun is left for the model to judge in
// context. Do not "complete" this by adding the spelled-out form — it was left
// out on evidence, not by oversight.

/**
 * `calle` → `[Cc][Aa][Ll][Ll][Ee]`. Regex metacharacters are escaped.
 *
 * 🔴 THIS EXISTS SO THE ADDRESS PATTERNS CAN DROP THE `i` FLAG, and that is not
 * a style preference — it is a bug fix. Under `i`, `\p{Lu}` matches lower-case
 * letters too, so "a capitalised word" silently became "any word" and the
 * street-name run happily absorbed ordinary prose: `en la calle hay 20 casas`
 * matched as an address. Spelling the case-insensitivity into the KEYWORDS
 * instead lets `\p{Lu}` mean what it says in the NAMES.
 *
 * ⚠ Both cases, not just Title Case: a transcriber's caps lock produces
 * `CALLE MORELOS`, which `pseudonyms.ts` already warns about for names.
 */
function anyCase(literal: string): string {
  return [...literal]
    .map((ch) => {
      const upper = ch.toUpperCase()
      const lower = ch.toLowerCase()
      if (upper === lower) return escapeRegExp(ch)
      // ⚠ `toUpperCase` CAN RETURN MORE THAN ONE CHARACTER — `ß` → `SS`,
      // `ﬁ` → `FI`. Splicing that into a character class gives `[SSß]`, which
      // matches a bare `S`. No word in the lists below hits this today; the
      // guard is here so the next keyword someone adds cannot.
      if (upper.length !== 1 || lower.length !== 1) return `[${escapeRegExp(ch)}]`
      return `[${upper}${lower}]`
    })
    .join('')
}

/** Longest first, so `calles` is offered before `calle`. */
function anyCaseAlternation(literals: readonly string[]): string {
  return [...literals]
    .sort((a, b) => b.length - a.length)
    .map(anyCase)
    .join('|')
}

/**
 * The vías públicas. Plain words — `anyCase` handles the casing and
 * `escapeRegExp` handles the full stops, so there is no regex syntax to get
 * wrong in this list.
 */
const VIAS = [
  'calle', 'calles', 'avenida', 'avenidas', 'av.', 'blvd', 'blvd.', 'boulevard',
  'calz.', 'calzada', 'calzadas', 'privada', 'privadas', 'priv.', 'andador',
  'andadores', 'cerrada', 'cerradas', 'retorno', 'retornos', 'prolongación',
  'prolongacion', 'circuito', 'circuitos', 'callejón', 'callejon', 'paseo',
  'paseos', 'carretera', 'carreteras', 'eje', 'ejes',
]

/**
 * ⚠ `camino` / `caminos` ARE DELIBERATELY ABSENT, on the corpus measurement.
 * 39 occurrences across 37 documents and every single one is a metaphor — "este
 * camino lo he hecho junto a mi hermana", "que no se le caiga la mitad en el
 * camino". Keeping it matched `el camino de Dios 40 años después` and
 * `camino de regreso a la casa número 3`, which redacts the sentence and leaves
 * the reader with a testimony that no longer says anything.
 *
 * The cost is a literal `Camino Real 12`, which the model still sees and can
 * still flag as `lugar`. That is the right side of the trade: over-redaction
 * here destroys the material these testimonies are about.
 */

const TIPO_VIA = `(?:${anyCaseAlternation(VIAS)})`

/**
 * The separator between the parts of an address: optional whitespace, an
 * optional comma, optional whitespace.
 *
 * 🔴 WRITTEN UNAMBIGUOUSLY, AND THE SHAPE IS A ReDoS FIX. The obvious spelling
 * — `\s*,?\s*` — puts two `\s*` either side of an optional token, so a run of
 * *n* spaces can be split between them *n* ways. When the literal after the
 * separator then fails, the engine tries every split. That is QUADRATIC, and
 * four of these tails hang off `DOMICILIO`.
 *
 * Measured on Node 24, one pass over `'Calle Morelos No. 45' + ' '.repeat(n) + 'x'`:
 * 16k spaces → 0.7s, 32k → 2.8s, 64k → 10.8s, 100k → 26.2s. This stage runs
 * synchronously on whole transcripts and PDF/DOCX extracts, on the server
 * thread — and long whitespace runs are something PDF extraction produces BY
 * ACCIDENT, so it does not even need an attacker.
 *
 * `\s*(?:,\s*)?` has exactly one way to match any given input, so it is linear.
 * ⚠ Do not "simplify" it back.
 */
const SEP = String.raw`\s*(?:,\s*)?`

/**
 * A word inside a street name, STRICT: capitalised, numeric, or a connector.
 *
 * 🔴 THE CONNECTORS CARRY A TRAILING BOUNDARY, AND WITHOUT IT THEY SHRED WORDS.
 * `de` is an alternative in a group with nothing after it, so on
 * "Col. Portales y despues de eso" it matched the first two letters of
 * `despues` and the redaction came back as `[Domicilio A]spues de eso`. Measured,
 * not hypothetical.
 *
 * ⚠ `y` IS NOT A CONNECTOR HERE, on purpose. It is grammatically one, but in
 * practice it is the word that joins an address to the NEXT CLAUSE — "Col.
 * Portales y ahí vivía mi tía Rosa" — so accepting it made the run walk out of
 * the address and into the sentence. `Calle Ruiz y Flores` loses its second half
 * to the model; that is the cheaper mistake.
 *
 * Real street names are proper nouns — `Morelos`, `5 de Mayo`, `Emiliano
 * Zapata`. Requiring the capital is what stops the run walking into a sentence.
 */
const PALABRA_NOMBRE = String.raw`(?:\p{Lu}[\p{L}\p{N}'’-]*|\d{1,4}|(?:${anyCaseAlternation([
  'de',
  'del',
  'la',
  'las',
  'los',
  'el',
])})(?![\p{L}\p{N}]))`

/**
 * A word inside a street name, LOOSE: any word at all.
 *
 * ⚠ Only ever used on the arm that ALSO demands an explicit number marker
 * (`No. 45`, `#45`, `s/n`). "calle morelos no. 45" is how a transcript comes
 * back when nobody dictated the capitals, and the marker is what makes the
 * looseness safe. Never combine this with the bare-number anchor.
 */
const PALABRA_LIBRE = String.raw`(?:[\p{L}][\p{L}\p{N}'’-]*|\d{1,4})`

/** `45`, `45B`, `1450-B`. ⚠ The letter suffix keeps its hyphen — see below. */
const SUFIJO_NUMERO = String.raw`(?:\s*-\s*[A-Za-z0-9]{1,3}|[A-Za-z])?`

/**
 * 🔴 THE ANCHOR, MARKED FORM. `No.` keeps its full stop on purpose — `no`
 * without one is the commonest word in the language, and "Calle no me acuerdo
 * cuál" would match. `s/n` (sin número) counts because it appears nowhere but in
 * an address.
 *
 * ⚠ THE `45-B` SUFFIX MUST KEEP ITS HYPHEN, or it eats the next word. Written
 * loosely as an optional space-then-letter it matched the `y` in "Calle Morelos
 * No. 45 y volví…" and the redaction swallowed the conjunction. Measured, not
 * hypothetical: it broke two tests in this directory.
 */
const NUMERO_MARCADO =
  String.raw`(?:${SEP}(?:${anyCaseAlternation([
    'no.',
    'núm',
    'núm.',
    // ⚠ `numero` / `número` SPELLED OUT ARE NOT MARKERS. "la casa número 3",
    // "el expediente número 12" are ordinary Spanish, and with the loose arm's
    // any-word run in front of them the pair matched whole clauses. `núm` is
    // the abbreviation and only ever appears in an address.
  ])}|#)\s*\d{1,5}${SUFIJO_NUMERO}|${SEP}${anyCase('s')}\s*\/\s*${anyCase('n')})` +
  String.raw`(?![\p{L}\p{N}])`

/** The marked form, or a bare number hanging off a capitalised street name. */
const NUMERO_CUALQUIERA = String.raw`(?:${NUMERO_MARCADO}|\s+\d{1,5}${SUFIJO_NUMERO}(?![\p{L}\p{N}]))`

/** `int. 3`, `interior 3`, `ext. 12`. An optional tail on a street line. */
const NUMERO_INTERIOR = String.raw`(?:${SEP}(?:${anyCaseAlternation([
  'int',
  'int.',
  'interior',
  'ext',
  'ext.',
  'exterior',
])})\s*\d{1,4}[A-Za-z]?)?`

/** The abbreviated settlement forms. See the header: abbreviations only. */
const ASENTAMIENTO_ABREV = `(?:${anyCaseAlternation([
  'col.',
  'fracc.',
  'fraccionamiento',
  'u.h.',
  'u. h.',
  'unidad habitacional',
])})`

/** The manzana / lote words. A settlement's name run stops in front of them. */
const MARCAS_MZ_LT = anyCaseAlternation([
  'mz',
  'mz.',
  'mza',
  'mza.',
  'manz',
  'manz.',
  'manzana',
  'lt',
  'lt.',
  'lote',
])

/**
 * `Mz. 4 Lt. 12`, `manzana 4, lote 12`.
 *
 * ⚠ `Mz`/`Mza` REQUIRE a following number, because "las visitas por manzana" is
 * a real sentence in the corpus and means a city block on a walking route.
 */
const MANZANA_LOTE = String.raw`(?:${anyCaseAlternation([
  'mz',
  'mz.',
  'mza',
  'mza.',
  'manz',
  'manz.',
  'manzana',
])})\s*\d{1,3}(?:${SEP}(?:${anyCaseAlternation(['lt', 'lt.', 'lote'])})\s*\d{1,3})?`

/**
 * 🔴 NOT A MANZANA/LOTE WORD. Measured before this existed (audit, 2026-10-21):
 * `U.H. Vicente Guerrero Mz. 4 Lt. 12` came out as `[Domicilio A]. 4 Lt. 12` —
 * the capitalised `Mz` passed as one more word of the name, the run stopped at
 * its full stop, and the block and lot numbers stayed in the text.
 */
const NO_MZ_LT = String.raw`(?!(?:${MARCAS_MZ_LT})(?![\p{L}\p{N}]))`

/**
 * Words that end a lower-case settlement name: the ones that start the next
 * clause. See {@link NOMBRE_ASENTAMIENTO}.
 */
const FIN_DE_NOMBRE = String.raw`(?!(?:${anyCaseAlternation([
  'y', 'e', 'o', 'u', 'ni', 'que', 'en', 'a', 'al', 'con', 'por', 'para', 'desde',
  'hasta', 'me', 'se', 'le', 'les', 'nos', 'te', 'mi', 'mis', 'su', 'sus', 'tu',
  'donde', 'cuando', 'pero', 'porque', 'pues', 'hace', 'ya', 'no', 'es', 'era',
  'fue', 'son', 'está', 'esta', 'estaba', 'vivo', 'vive', 'vivía', 'vivimos',
  'ahí', 'allí', 'aquí', 'allá', 'acá', 'entonces', 'luego', 'después', 'despues',
  'delante', 'detrás', 'detras', 'atrás', 'atras', 'cerca', 'lejos', 'frente',
  'enfrente', 'junto', 'arriba', 'abajo', 'rumbo', 'sobre', 'entre', 'sin', 'hacia',
])})(?![\p{L}\p{N}]))`

/**
 * The NAME after `Col.` / `Fracc.` / `U.H.`, in two shapes.
 *
 *   · LOWER CASE from its first word, up to four words, ONLY when a terminator follows — a comma,
 *     full stop, semicolon, colon, closing bracket, line end, the end of the
 *     text, or `Mz.`/`Lt.`. Measured before this existed (audit, 2026-10-21):
 *     `col. santa cruz` came out as `[Domicilio A] cruz`. The terminator is the
 *     brake: without it a run of loose words walks into the sentence. A word
 *     that starts a clause (`y`, `que`, `desde`, …) ends the run too.
 *   · STRICT otherwise: one loose word, then capitalised words only. This is
 *     the shape `Col. Portales y ahí vivía mi tía Rosa` needs.
 *
 * Either shape may carry `Mz. 4 Lt. 12` after it, inside the same label.
 */
const NOMBRE_ASENTAMIENTO =
  String.raw`(?:` +
  // Lower case: the FIRST word too. A capitalised name ("Col. Portales delante
  // del pozo") always takes the strict shape below.
  String.raw`${NO_MZ_LT}\p{Ll}[\p{L}\p{N}'’-]*` +
  String.raw`(?:\s+${NO_MZ_LT}${FIN_DE_NOMBRE}${PALABRA_LIBRE}){1,3}` +
  String.raw`(?=[ \t]*(?:[,.;:)\n]|$)|\s+(?:${MARCAS_MZ_LT})(?![\p{L}\p{N}]))` +
  String.raw`|${NO_MZ_LT}${PALABRA_LIBRE}(?:\s+${NO_MZ_LT}${PALABRA_NOMBRE}){0,4}` +
  String.raw`)(?:${SEP}${MANZANA_LOTE})?`

/**
 * `, Col. Portales` hanging off a street line.
 *
 * ⚠ THE FIRST NAME WORD IS LOOSE, THE REST ARE STRICT, and the split is doing
 * real work at both ends.
 *
 * Loose first: requiring a capital there meant
 * `calle morelos no. 45, col. portales, c.p. 03300` — one address, dictated by a
 * transcriber who used no capitals — came out as THREE labels instead of one.
 * The `Col.` / `Fracc.` marker is an anchor prose does not produce, so one loose
 * word behind it is safe.
 *
 * 🔴 STRICT AFTER THAT, because a greedy run of FIVE loose words has no
 * terminator and walks straight into the sentence. Measured:
 * `"Calle Morelos No. 45, Col. Portales y ahí vivía mi tía Rosa"` matched
 * through `…y ahí vivía mi`, leaving `[Domicilio A] tía Rosa`. Worse than the
 * lost words: the match differs per occurrence, so the same colonia collects
 * `[Domicilio A]`, `[Domicilio B]`, … — which defeats the entire reason these
 * are labels and not redaction bars.
 */
const COLA_ASENTAMIENTO = String.raw`(?:${SEP}${ASENTAMIENTO_ABREV}\s*${NOMBRE_ASENTAMIENTO})?`

/** `C.P.` / `CP` / `Código Postal`, always followed by exactly five digits. */
const CP_TOKEN = String.raw`(?:${anyCaseAlternation([
  'c.p.',
  'c. p.',
  'cp',
  'código postal',
  'codigo postal',
])})\s*:?\s*\d{5}(?!\d)`

/** `, C.P. 06700` hanging off a street line. */
const COLA_CP = String.raw`(?:${SEP}${CP_TOKEN})?`

/**
 * A whole street line, swallowed as ONE match.
 *
 * ⚠ TWO ARMS, AND THE PAIRING IS THE SAFETY PROPERTY:
 *
 *   · capitalised name + ANY number  — `Av. Emiliano Zapata 128`
 *   · any words + MARKED number      — `calle morelos no. 45`
 *
 * Loose words with a bare number is the combination that matches
 * "en la calle hay 20 casas", so it is the one combination not offered.
 *
 * ⚠ THE OPTIONAL TAILS ARE NOT COSMETIC. Without them
 * `Calle Morelos No. 45, Col. Portales, C.P. 06700` matches three rules and
 * comes out as `[Domicilio A], [Domicilio B], [Domicilio C]` — three places
 * where the person named one. Greedy-but-anchored gives one label, which is what
 * keeps the redacted sentence true to what was said.
 */
const DOMICILIO = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${TIPO_VIA}(?:` +
    String.raw`(?:\s+${PALABRA_NOMBRE}){1,6}${NUMERO_CUALQUIERA}` +
    String.raw`|(?:\s+${PALABRA_LIBRE}){1,6}${NUMERO_MARCADO}` +
    String.raw`)${NUMERO_INTERIOR}${COLA_ASENTAMIENTO}${COLA_CP}`,
  'gu',
)

/**
 * A postal code standing alone.
 *
 * ⚠ Runs AFTER {@link DOMICILIO}, which has already eaten the ones attached to a
 * street line — the same specific-before-greedy discipline as `email` before
 * `numero-largo`.
 */
const CODIGO_POSTAL = new RegExp(String.raw`(?<![\p{L}\p{N}])${CP_TOKEN}`, 'gu')

/**
 * A settlement standing alone: `Col. Portales`, `Fracc. Los Sauces`, `Mz. 4 Lt. 12`.
 *
 * 🔴 `Alcaldía` / `Delegación` ARE NOT HERE ANY MORE (owner's ruling,
 * 2026-10-21, backlog #12: town and municipality names are shown). A CDMX
 * alcaldía is a municipality of hundreds of thousands of people; it locates no
 * home. The colonia, street and C.P. beside it are still caught.
 *
 * ⚠ `Mz`/`Mza` REQUIRE a following number — see {@link MANZANA_LOTE}.
 */
const ASENTAMIENTO = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:` +
    // The dotted markers are postal notation, so the NAME after one may be
    // lower-cased — see `COLA_ASENTAMIENTO`.
    String.raw`${ASENTAMIENTO_ABREV}\s*${NOMBRE_ASENTAMIENTO}` +
    String.raw`|${MANZANA_LOTE}` +
    String.raw`)`,
  'gu',
)

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

  // ── Then the address rules. BEFORE `telefono` and `numero-largo`, which would
  // otherwise claim the digits out of `C.P. 06700` and `Calle Morelos No. 45`
  // and leave the street name standing next to a `[Dato omitido]` — the exact
  // half-eaten failure the header warns about, one family down.
  //
  // ⚠ `DOMICILIO` runs FIRST of the three so a full street line is swallowed as
  // ONE match with one label. `CODIGO_POSTAL` and `ASENTAMIENTO` then only see
  // the fragments that stood alone.
  const allocateAddress = args.allocateAddress ?? ((matched: string) => matched)
  const domicilio = label(out, DOMICILIO, allocateAddress)
  out = domicilio.text
  pushCount(removed, DETERMINISTIC_LABELS.domicilio, domicilio.count)

  const cp = label(out, CODIGO_POSTAL, allocateAddress)
  out = cp.text
  pushCount(removed, DETERMINISTIC_LABELS.codigoPostal, cp.count)

  const asentamiento = label(out, ASENTAMIENTO, allocateAddress)
  out = asentamiento.text
  pushCount(removed, DETERMINISTIC_LABELS.asentamiento, asentamiento.count)

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
