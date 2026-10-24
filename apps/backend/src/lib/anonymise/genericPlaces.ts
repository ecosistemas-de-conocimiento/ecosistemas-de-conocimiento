/**
 * COMMON NOUNS FOR PLACES ARE NOT ADDRESSES.
 *
 * Seen on dev (2026-10-21, `/revision`, UX walkthrough screenshots 80/81): the
 * model flagged "la escuela", "la colonia" and "la barranca" as `lugar` in the
 * verify stage, and the testimony was held with 7 highlights. "Llegué a la colonia" says where the speaker went in the same
 * way "llegué a casa" does: it locates nobody.
 *
 * 🔴 THIS IS A PRIVACY GATE, SO THE RULE IS AS NARROW AS IT CAN BE. A finding is
 * dropped ONLY when its whole text is
 *
 *     [one determiner] + ONE noun from {@link GENERIC_PLACE_NOUNS}
 *
 * the noun is written in lower case, AND the model labelled it `lugar`.
 * Everything else still counts:
 *
 *   · "la colonia Portales", "la escuela Benito Juárez" — a name follows.
 *   · "vivo en La Barranca" — the capital makes it a proper name (a town can be
 *     called that), so the finding stays.
 *   · "vivo en la presa", "los barrios" — words that are ALSO common names of
 *     colonias, localities or surnames are not on the list at all (audit,
 *     2026-10-21). "la barranca" from the dev screenshot is one of them, so it
 *     still holds; a reviewer approves it in one click.
 *   · A `persona` (or any non-`lugar`) finding is never dropped: "los barrios"
 *     as a surname must still be redacted.
 *   · "la casa de la reja verde", "enfrente de la tienda de doña Mari" — the
 *     free-form references the detector prompt asks for are longer than one
 *     noun, so they never match.
 *   · "Calle Morelos 45", "C.P. 06700" — digits and names; never match.
 *
 * ⚠ The check is on the FINDING's own text, case-sensitively, because the gate
 * replaces findings as literal, case-sensitive strings. Dropping "la barranca"
 * leaves a separate "La Barranca" finding untouched.
 *
 */

import type { DetectorFinding } from './types'

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
 * ⚠ Add to this list only words that are never, on their own, a name — not of a
 * person, not of a colonia, not of a locality. When in doubt, leave it out.
 * School words that can single out one building in a village (telesecundaria,
 * prepa, kínder…) are left out on purpose.
 */
export const GENERIC_PLACE_NOUNS: readonly string[] = [
  // escuelas, dicho en general
  'escuela', 'escuelas',
  // dónde vive la gente, dicho en general
  'colonia', 'colonias', 'barrio', 'pueblo', 'pueblos', 'comunidad', 'comunidades',
  'localidad', 'ciudad', 'municipio', 'casa',
  // paisaje y campo
  'milpa', 'milpas', 'parcela', 'río',
  // calles, dichas sin nombre
  'calle', 'calles', 'carretera', 'camino', 'esquina',
  // servicios y lugares públicos
  'plaza', 'mercado', 'tianguis', 'tienda', 'iglesia', 'clínica', 'hospital',
  'centro de salud', 'cancha', 'oficina',
]

const NOUNS = new Set(GENERIC_PLACE_NOUNS)
const DETS = new Set(DETERMINERS)

/**
 * True when `finding` is a `lugar` made of a determiner plus one common place noun, written in
 * lower case — "la escuela", "La colonia" at the start of a sentence — and so
 * names no place. See the file header for what it deliberately does NOT drop.
 */
export function isGenericPlace(finding: Pick<DetectorFinding, 'text' | 'type' | 'typedAddress'>): boolean {
  // 🔴 Places only. A person's name can be spelled like a place noun.
  if (finding.type !== 'lugar') return false
  // 🔴 Never one the model typed `domicilio` (audit 2026-10-23): it called it
  // a home, and before `domicilio` became `lugar` these were `[Dato omitido]`.
  if (finding.typedAddress) return false
  const words = finding.text.normalize('NFC').trim().split(/\s+/)
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
