/**
 * COMMON NOUNS FOR PLACES ARE NOT ADDRESSES.
 *
 * Seen on dev (2026-10-21, `/revision`, UX walkthrough screenshots 80/81): the
 * model flagged "la escuela", "la colonia" and "la barranca" as `lugar` in the
 * verify stage, and the testimony was held with 7 highlights, none of which
 * named anything. "Llegué a la colonia" says where the speaker went in the same
 * way "llegué a casa" does: it locates nobody.
 *
 * 🔴 THIS IS A PRIVACY GATE, SO THE RULE IS AS NARROW AS IT CAN BE. A finding is
 * dropped ONLY when its whole text is
 *
 *     [one determiner] + ONE noun from {@link GENERIC_PLACE_NOUNS}
 *
 * and the noun is written in lower case. Everything else still counts:
 *
 *   · "la colonia Portales", "la escuela Benito Juárez" — a name follows.
 *   · "vivo en La Barranca" — the capital makes it a proper name (a town can be
 *     called that), so the finding stays.
 *   · "la casa de la reja verde", "enfrente de la tienda de doña Mari" — the
 *     free-form references the detector prompt asks for are longer than one
 *     noun, so they never match.
 *   · "Calle Morelos 45", "C.P. 06700" — digits and names; never match.
 *
 * ⚠ The check is on the FINDING's own text, case-sensitively, because the gate
 * replaces findings as literal, case-sensitive strings. Dropping "la barranca"
 * leaves a separate "La Barranca" finding untouched.
 *
 * ⚠ It applies to every finding type, not only `lugar`. A bare "la escuela"
 * identifies nobody whatever label the model gave it.
 */

/** Words that may stand before the noun. Lower case; the first letter may be capitalised in the text. */
const DETERMINERS = [
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus',
  'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'aquel', 'aquella', 'aquellos', 'aquellas', 'del', 'al',
]

/**
 * Common nouns for places, singular and plural. Mexican-Spanish, the kind a
 * testimony uses for the places of everyday life. Multi-word entries are fixed
 * phrases ("centro de salud"), still with no name in them.
 *
 * ⚠ Add to this list only words that are never, on their own, a name.
 */
export const GENERIC_PLACE_NOUNS: readonly string[] = [
  // escuelas
  'escuela', 'escuelas', 'escuelita', 'primaria', 'secundaria', 'telesecundaria',
  'prepa', 'preparatoria', 'universidad', 'kínder', 'kinder', 'guardería',
  // dónde vive la gente, dicho en general
  'colonia', 'colonias', 'barrio', 'barrios', 'pueblo', 'pueblos', 'comunidad',
  'comunidades', 'ranchería', 'rancho', 'ejido', 'localidad', 'ciudad', 'municipio',
  'cabecera', 'cabecera municipal', 'casa', 'casas', 'vecindad', 'unidad',
  // paisaje
  'barranca', 'barrancas', 'cerro', 'cerros', 'río', 'arroyo', 'monte', 'campo',
  'milpa', 'milpas', 'parcela', 'presa', 'laguna', 'sierra', 'loma',
  // calles, dichas sin nombre
  'calle', 'calles', 'avenida', 'carretera', 'camino', 'brecha', 'esquina',
  // servicios y lugares públicos
  'plaza', 'mercado', 'tianguis', 'tienda', 'tiendita', 'iglesia', 'parroquia',
  'capilla', 'panteón', 'cementerio', 'clínica', 'hospital', 'centro de salud',
  'casa de salud', 'dispensario', 'cancha', 'kiosco', 'biblioteca', 'auditorio',
  'presidencia', 'presidencia municipal', 'comisaría', 'oficina', 'fábrica', 'obra',
]

const NOUNS = new Set(GENERIC_PLACE_NOUNS)
const DETS = new Set(DETERMINERS)

/**
 * True when `finding` is a determiner plus one common place noun, written in
 * lower case — "la escuela", "La colonia" at the start of a sentence — and so
 * names no place. See the file header for what it deliberately does NOT drop.
 */
export function isGenericPlace(finding: string): boolean {
  const words = finding.normalize('NFC').trim().split(/\s+/)
  if (words[0] === '') return false

  let nounWords = words
  const first = words[0]!
  if (DETS.has(first.toLowerCase())) {
    // A capital is allowed only at the start of the determiner.
    if (first.slice(1) !== first.slice(1).toLowerCase()) return false
    nounWords = words.slice(1)
  }
  if (nounWords.length === 0) return false

  // 🔴 Lower case only, determiner or not: "La Barranca" and a bare
  // "Barranca" may both be a town's name.
  return NOUNS.has(nounWords.join(' '))
}
