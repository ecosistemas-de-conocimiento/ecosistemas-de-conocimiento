/**
 * HONORIFICS AND ROLE TITLES ARE PART OF THE NAME THEY PRECEDE.
 *
 * Rodrigo's rule (2026-10-17): "Don Fernando Vázquez" becomes `[Persona F]`,
 * never `Don [Persona F]`. Two reasons:
 *
 *   · A title narrows who someone is. "la maestra [Persona J]" in a testimony
 *     from one village is close to a name.
 *   · Verify flagged it. Measured 2026-10-17 on the local stack, 1,191 words:
 *     stage 3 redacted the names and left "Don" and "La maestra", stage 4
 *     reported "Don [Persona F]" and "La maestra [Persona J]" as leftovers, and
 *     the document was held although every name was gone.
 *
 * So once a person is a placeholder, {@link absorbTitles} removes any listed
 * title standing DIRECTLY before it (whitespace only between them). The span
 * grows leftward; it never grows rightward, so `[Persona A] López` keeps its
 * surname in view and verify still holds on it.
 *
 * ⚠ KINSHIP IS NOT A TITLE. "mi hermana Lucía" stays "mi hermana [Persona A]"
 * (see the detector prompt): the relationship is the testimony's content.
 * `padre` is a priest only when no possessive precedes it — "mi padre" is a
 * father. `madre` is left out entirely: "la madre [X]" is far likelier a mother
 * than a nun in this corpus.
 *
 * The list is Mexican-Spanish usage. Seen in the synthetic corpus
 * (corpus-generativo, measured 2026-10-17, 200 files): "con doña Eulalia" 11×,
 * "la maestra Imelda" 6×, "el delegado Reynaldo Ocampo" 14×. The rest is the
 * owner's list plus their common abbreviations.
 */

const MARKS = '[\\u0300-\\u036f]*'

/** Letters that may carry an accent (or a tilde) in speech-to-text output. */
const ACCENTABLE: Record<string, string> = {
  a: '[aá]',
  e: '[eé]',
  i: '[ií]',
  o: '[oó]',
  u: '[uúü]',
  n: '[nñ]',
}

/** Build an accent-tolerant, NFD-tolerant pattern for one title, written unaccented. */
function tolerant(title: string): string {
  return [...title]
    .map((ch) => {
      if (ch === '.') return '\\.?'
      if (ch === ' ') return '\\s+'
      return `${ACCENTABLE[ch] ?? ch}${MARKS}`
    })
    .join('')
}

/**
 * Titles, unaccented, lower-case. A trailing `.` means "abbreviation, period
 * optional". Longest-first is not needed: each alternative must end at a
 * whitespace run, so a shorter one cannot steal a longer one's match.
 */
const TITLES = [
  'don',
  'dona',
  'senor',
  'senora',
  'senorita',
  'seno',
  'sr.',
  'sra.',
  'srta.',
  'maestro',
  'maestra',
  'mtro.',
  'mtra.',
  'profe',
  'profesor',
  'profesora',
  'profr.',
  'profra.',
  'doctor',
  'doctora',
  'dr.',
  'dra.',
  'licenciado',
  'licenciada',
  'lic.',
  'ingeniero',
  'ingeniera',
  'ing.',
  'arquitecto',
  'arquitecta',
  'arq.',
  'delegado',
  'delegada',
  'comisario',
  'comisaria',
  'fray',
  'sor',
]

/** Possessives that turn `padre` back into a father. */
const POSSESSIVE = `(?:mi|tu|su|nuestro|vuestro)${MARKS}`

const NOT_IN_WORD = '(?<![\\p{L}\\p{N}\\p{M}])'

const ONE_TITLE = `(?:${TITLES.map(tolerant).join('|')}|(?<!${NOT_IN_WORD}${POSSESSIVE}\\s+)padre)`

/**
 * `el`/`la` and any titles after it, or one or more titles; each followed by
 * whitespace.
 *
 * ⚠ A BARE ARTICLE COUNTS. Measured 2026-10-17: the model returned "delegado
 * Abundio Cázares" out of "El delegado Abundio Cázares", and "Chacho Melgarejo"
 * out of the nickname "el Chacho Melgarejo"; verify then held on
 * "El [Persona E]" and "el [Persona L]". Dropping an article loses no name.
 */
const TITLE_RUN = `${NOT_IN_WORD}(?:(?:el|la)\\s+(?:${ONE_TITLE}\\s+)*|(?:${ONE_TITLE}\\s+)+)`

const BEFORE_PERSON = new RegExp(`${TITLE_RUN}(?=\\[Persona [A-Z]+\\])`, 'giu')

const LEADING = new RegExp(`^\\s*${TITLE_RUN}`, 'iu')

/**
 * Remove every listed title that stands directly before a `[Persona X]`.
 *
 * ⚠ Only person placeholders. `[Domicilio A]` keeps its words: "la tortillería
 * de doña [Domicilio A]" is the model's choice of span, not a name.
 */
export function absorbTitles(text: string): string {
  return text.replace(BEFORE_PERSON, '')
}

/**
 * The name inside a titled span, for bucketing: "Don Fernando Vázquez" and
 * "Fernando Vázquez" are one person and must get one label.
 *
 * A span that is ONLY a title comes back unchanged, so it still has a key.
 */
export function stripLeadingTitles(name: string): string {
  const stripped = name.replace(LEADING, '')
  return stripped.trim().length > 0 ? stripped : name
}

const ANY_PLACEHOLDER = /\[Dato omitido\]|\[Persona [A-Z]+\]|\[Domicilio [A-Z]+\]/g

/**
 * True when `finding` holds at least one of our placeholders and, once those
 * and any title before a person placeholder are gone, no letter or digit is
 * left: "[Domicilio AP], [Domicilio AQ]", "Don [Persona F]".
 *
 * 🔴 AT LEAST ONE PLACEHOLDER IS REQUIRED. A bare "Don" with nothing after it
 * still counts as a leftover, so a model that flags only the title of a name
 * it missed still holds the document.
 */
export function onlyPlaceholders(finding: string): boolean {
  if (!finding.match(ANY_PLACEHOLDER)) return false
  return !/[\p{L}\p{N}]/u.test(absorbTitles(finding).replace(ANY_PLACEHOLDER, ''))
}
