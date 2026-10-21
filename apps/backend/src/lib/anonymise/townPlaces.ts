/**
 * 🔴 A TOWN IS SHOWN, SO A TOWN NEVER HOLDS A DOCUMENT — BUT ONLY A TOWN.
 *
 * The owner's ruling (2026-10-21, backlog #12, commits 891afdd and 7c7ff83):
 * estados, municipios, alcaldías, ciudades, pueblos, comunidades, localidades,
 * ejidos and congregaciones are SHOWN. The detector prompt says so
 * (`DETECT_SYSTEM_PROMPT`, "NUNCA marques estados, municipios…"), and stage 4
 * (verify) runs that same prompt. The model still marks towns there: measured
 * on dev the same day (runbook `infra/fleet/edc-1.md` §4p), 31 of the 38
 * verify holds had place findings only.
 *
 * So the rule is repeated in code, on the HOLD DECISION only. 🔴 A finding this
 * file ignores SHIPS IN CLEAR (`gate.ts`), so every doubt goes to "hold": a
 * town held by mistake costs a reviewer one click; a person or a home let
 * through costs the person.
 *
 * ── THE RULES (all must pass, for EVERY occurrence) ──────────────────────────
 *
 *   1. SHAPE of the finding: proper-noun words, connectors (de, del, la, las,
 *      los, el) and town words (municipio, ciudad, pueblo…), spaces and commas.
 *      No digit, no period, and none of {@link ADDRESS_WORDS} (streets,
 *      colonias, ranchos, homes, institutions: calle, colonia, rancho, casa,
 *      hospital, IMSS, Siglo XXI, La Raza…) or {@link PERSON_WORDS} (don, doña,
 *      tía, compadre, maestra…).
 *   2. NOTHING NEAR IT says address or person: no address word or person word in
 *      the 3 tokens before ("la casa está por Los Encinos", "la hija de Soledad").
 *   3. WHAT STANDS RIGHT BEFORE IT (auditor's rule, 2026-10-21):
 *        · en, desde, hasta, hacia, rumbo, or a town word — "vivo en Xoxocotla";
 *        · de/del only after an ORIGIN word or a town word — "soy de Cuautla",
 *          "el municipio de Ayala". Not "la hija de Soledad";
 *        · a comma only when the finding is a STATE — "Xoxocotla, Morelos";
 *        · ⚠ NOT a, al, y, para, por: "le dije a Soledad", "Juan y Soledad".
 *      An article between ("en la Ciudad de México") is skipped only when the
 *      finding starts with a town word; otherwise an article before it means a
 *      named building or colonia ("en la Benito Juárez", "en el Siglo XXI",
 *      "en el Pedregal de Santo Domingo") and it holds.
 *   4. WEAK NAMES need a state after them or a town word before them. A finding
 *      that STARTS with an article or a saint (La Raza, Los Pinos, Santa Úrsula)
 *      is as often a colonia, a hospital or a ranch as a town. "Vivo en San Juan
 *      Chamula, Chiapas" passes; "vivo en Santa Úrsula" holds.
 *
 * ⚠ THE RESIDUAL RISK, STATED: a colonia written by a bare, town-shaped name
 * with "en" before it ("vivo en Portales") that stage 3 also missed passes as a
 * town. There is no gazetteer here; the detector cannot tell them apart either.
 *
 * ⚠ A `persona`, `contacto`, `identificador` or `otro` finding is never ignored.
 */

import type { DetectorFinding } from './types'

/** Words that make a finding an address, a home, or an institution. Lower case, accents kept. */
export const ADDRESS_WORDS: readonly string[] = [
  // calles
  'calle', 'avenida', 'av', 'andador', 'cerrada', 'privada', 'callejón', 'calzada',
  'boulevard', 'bulevar', 'blvd', 'prolongación', 'carretera', 'camino', 'brecha',
  'vereda', 'kilómetro', 'km', 'esquina', 'entre', 'número', 'núm', 'no', 'sin',
  // dentro de una localidad
  'colonia', 'col', 'barrio', 'fraccionamiento', 'fracc', 'unidad', 'habitacional',
  'manzana', 'mz', 'lote', 'lt', 'sector', 'sección', 'ampliación', 'residencial',
  'condominio', 'conjunto', 'infonavit', 'fovissste', 'privadas', 'villas',
  // nombres frecuentes de colonias (auditoría de `genericPlaces.ts`, 2026-10-21)
  'barranca', 'presa', 'loma', 'lomas', 'jardín', 'jardines', 'pedregal',
  // ranchos, parajes, tierras
  'rancho', 'ranchería', 'paraje', 'predio', 'finca', 'parcela', 'terreno', 'huerta',
  'milpa', 'potrero',
  // la casa y cómo llegar
  'casa', 'domicilio', 'edificio', 'departamento', 'depto', 'interior', 'piso',
  'cuarto', 'enfrente', 'frente', 'junto', 'atrás', 'detrás', 'lado', 'subiendo',
  'bajando', 'cerca', 'reja', 'puerta', 'zaguán', 'tanque',
  // código postal
  'código', 'postal', 'cp',
  // instituciones y lugares que pueden señalar a una persona
  'escuela', 'primaria', 'secundaria', 'telesecundaria', 'kínder', 'preescolar',
  'preparatoria', 'prepa', 'bachillerato', 'universidad', 'clínica', 'hospital',
  'centro', 'salud', 'consultorio', 'imss', 'issste', 'issstep', 'seguro', 'siglo',
  'xxi', 'raza', 'iglesia', 'parroquia', 'capilla', 'templo', 'mercado', 'tienda',
  'tiendita', 'plaza', 'panteón', 'cancha', 'oficina', 'empresa', 'fábrica',
  'taller', 'cooperativa', 'albergue', 'refugio',
]

/** Honorifics and kin words: a finding with one of these, or right after one, is a person. */
export const PERSON_WORDS: readonly string[] = [
  'don', 'doña', 'señor', 'señora', 'sr', 'sra', 'srta', 'tío', 'tía', 'tíos', 'tías',
  'compadre', 'comadre', 'maestro', 'maestra', 'profe', 'doctor', 'doctora', 'dr', 'dra',
  'licenciado', 'licenciada', 'lic', 'ingeniero', 'ingeniera', 'padre', 'madre', 'hijo',
  'hija', 'hermano', 'hermana', 'abuelo', 'abuela', 'primo', 'prima', 'sobrino',
  'sobrina', 'esposo', 'esposa', 'mamá', 'papá', 'suegro', 'suegra', 'cuñado', 'cuñada',
  'nieto', 'nieta', 'vecino', 'vecina', 'amigo', 'amiga',
]

/** Town-level words: the unit the owner ruled is shown. */
const TOWN_WORDS = [
  'estado', 'municipio', 'alcaldía', 'delegación', 'ciudad', 'pueblo', 'comunidad',
  'localidad', 'ejido', 'congregación', 'villa', 'región',
]

/** Words after which "de" introduces where someone is from. */
const ORIGIN_WORDS = [
  'soy', 'es', 'era', 'eres', 'somos', 'son', 'vengo', 'venimos', 'viene', 'vienen',
  'originario', 'originaria', 'originarios', 'originarias', 'oriundo', 'oriunda',
  'nativo', 'nativa', 'salí', 'salimos', 'llegamos', 'llegué',
]

/** The 32 Mexican states (and the capital), lower case: what a comma may introduce. */
const STATES = [
  'aguascalientes', 'baja california', 'baja california sur', 'campeche', 'chiapas',
  'chihuahua', 'coahuila', 'colima', 'durango', 'guanajuato', 'guerrero', 'hidalgo',
  'jalisco', 'méxico', 'estado de méxico', 'michoacán', 'morelos', 'nayarit',
  'nuevo león', 'oaxaca', 'puebla', 'querétaro', 'quintana roo', 'san luis potosí',
  'sinaloa', 'sonora', 'tabasco', 'tamaulipas', 'tlaxcala', 'veracruz', 'yucatán',
  'zacatecas', 'ciudad de méxico', 'cdmx',
]

const DIRECT_LOCATIVES = new Set(['en', 'desde', 'hasta', 'hacia', 'rumbo', ...TOWN_WORDS])
const ARTICLES = new Set(['el', 'la', 'los', 'las'])
const SAINTS = new Set(['san', 'santa', 'santo'])
const ADDRESS = new Set(ADDRESS_WORDS)
const PERSON = new Set(PERSON_WORDS)
const TOWN = new Set(TOWN_WORDS)
const ORIGIN = new Set(ORIGIN_WORDS)
const STATE = new Set(STATES)
const CONNECTOR = new Set(['de', 'del', 'la', 'las', 'los', 'el'])

const lower = (word: string) => word.normalize('NFC').toLocaleLowerCase('es')
const bare = (token: string) => lower(token).replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
const isCapitalised = (word: string) => /^\p{Lu}/u.test(word)

/** Rule 1. */
function hasTownShape(words: readonly string[]): boolean {
  if (words.length === 0 || words.length > 8) return false
  let proper = 0
  for (const word of words) {
    if (!/^[\p{L}'-]+$/u.test(word)) return false
    const w = lower(word)
    if (ADDRESS.has(w) || PERSON.has(w)) return false
    if (CONNECTOR.has(w) || TOWN.has(w)) continue
    if (!isCapitalised(word)) return false
    proper += 1
  }
  return proper > 0
}

/** "Xoxocotla, Morelos." → true after "Xoxocotla". */
function stateFollows(after: string): boolean {
  const m = /^\s*,\s*([\p{L} ]+)/u.exec(after)
  if (!m) return false
  const words = m[1]!.trim().split(/\s+/u).map(lower)
  // Longest match first: "baja california sur" before "baja california".
  for (let n = Math.min(4, words.length); n >= 1; n -= 1) {
    if (STATE.has(words.slice(0, n).join(' '))) return true
  }
  return false
}

/** Rules 2–4 for one occurrence. */
function placeContext(text: string, at: number, needle: string, words: readonly string[]): boolean {
  const beforeRaw = text.slice(0, at)
  const after = text.slice(at + needle.length)
  const first = lower(words[0]!)
  const startsWithTownWord = TOWN.has(first)
  const weak = ARTICLES.has(first) || SAINTS.has(first)

  // Rule 2: no address or person word in the 3 tokens before.
  const tokens = beforeRaw.trimEnd().split(/\s+/u).filter(Boolean)
  for (const t of tokens.slice(-3)) {
    const w = bare(t)
    if (ADDRESS.has(w) || PERSON.has(w)) return false
  }

  // Rule 3: what stands right before.
  const trimmed = beforeRaw.trimEnd()
  let ok = false
  let townWordBefore = false
  if (trimmed.endsWith(',')) {
    ok = STATE.has(words.map(lower).join(' '))
  } else {
    let i = tokens.length - 1
    let prev = bare(tokens[i] ?? '')
    if (ARTICLES.has(prev)) {
      // Only "en la Ciudad de México"; "en la Benito Juárez" is a building.
      if (!startsWithTownWord) return false
      i -= 1
      prev = bare(tokens[i] ?? '')
    }
    if (TOWN.has(prev)) townWordBefore = true
    if (DIRECT_LOCATIVES.has(prev)) ok = true
    else if (prev === 'de' || prev === 'del') {
      const before = bare(tokens[i - 1] ?? '')
      if (ORIGIN.has(before)) ok = true
      if (TOWN.has(before)) {
        ok = true
        townWordBefore = true
      }
    }
  }
  if (!ok) return false

  // Rule 4: a weak name needs a state after it or a town word before it.
  if (weak && !townWordBefore && !stateFollows(after)) return false
  return true
}

/**
 * True when a `lugar` finding is a town-level place (shown by the owner's
 * ruling) and so must not hold the document. See the file header: every rule
 * must pass at every occurrence, and anything unsure is NOT a town.
 *
 * @param text the text the finding was found in (verify's input).
 */
export function isTownLevelPlace(
  finding: Pick<DetectorFinding, 'text' | 'type'>,
  text: string,
): boolean {
  if (finding.type !== 'lugar') return false
  const needle = finding.text.normalize('NFC').trim()
  if (needle === '' || /[\d.#°º/]/u.test(needle)) return false
  const words = needle.split(/[\s,]+/u).filter(Boolean)
  if (!hasTownShape(words)) return false

  const haystack = text.normalize('NFC')
  let from = 0
  let seen = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return seen > 0
    seen += 1
    from = at + 1
    if (!placeContext(haystack, at, needle, words)) return false
  }
}
