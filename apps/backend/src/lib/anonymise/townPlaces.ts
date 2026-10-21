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
 *   5. NOT A PERSON: no word of the finding is a common given name, diminutive
 *      or surname, and a one-word finding does not end in "-ez" ("Martínez").
 *      Words after a saint ("San Juan Chamula") and state names are exempt.
 *      And "en" counts only after a verb of residence or movement ("vivo en",
 *      "me quedé en"), so "pienso en Soledad" holds.
 *
 * ⚠ THE TWO RESIDUAL RISKS, STATED. There is no gazetteer and no census here,
 * so both directions of "looks like a town" can still be wrong:
 *
 *   1. A COLONIA (or paraje, or named building) written by a bare, town-shaped
 *      name after a place verb and "en" — "vivo en Portales" — that stage 3
 *      also missed passes as a town and ships in clear.
 *   2. A PERSON the detector typed `lugar` whose name is not on the compact
 *      lists — an uncommon given name or a surname not ending in "-ez",
 *      after "vivo en" / "soy de" — passes as a town and ships in clear.
 *      ("Vivo en Xiadani" passes.) Common names and every "-ez" surname hold.
 *
 * Both need the detector to have mistyped AND stage 3 to have missed it. The
 * opposite error — a real town held — costs a reviewer one click and is the
 * direction every rule above leans.
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
/**
 * Words after which "de" introduces where someone is from.
 *
 * ⚠ NOT es/era/son: "eso es de Soledad", "es de Ramírez" name an owner or a
 * family as often as a place (re-audit, 2026-10-21).
 */
const ORIGIN_WORDS = [
  'soy', 'eres', 'somos', 'vengo', 'venimos', 'viene', 'vienen',
  'originario', 'originaria', 'originarios', 'originarias', 'oriundo', 'oriunda',
  'nativo', 'nativa', 'salí', 'salimos', 'llegamos', 'llegué',
]

/**
 * 🔴 "en" counts only after a verb of residence or movement: "vivo en",
 * "nací en", "me quedé en". "Pienso en Soledad", "confío en Pedro" hold.
 * Stems for regular forms; exact forms where a stem would catch other words.
 */
const PLACE_VERB_STEMS = ['viv', 'nac', 'crec', 'lleg', 'trabaj', 'qued', 'mud', 'resid', 'habit', 'regres']
const PLACE_VERB_FORMS = new Set([
  // estar
  'estar', 'estoy', 'está', 'estás', 'estamos', 'están', 'estaba', 'estábamos', 'estaban',
  'estuve', 'estuvo', 'estuvimos', 'estuvieron', 'estado', 'estuvimos',
  // ir
  'ir', 'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'íbamos', 'iban', 'fui', 'fue', 'fuimos',
  'fueron', 'ido',
  // venir
  'venir', 'vengo', 'viene', 'venimos', 'vienen', 'venía', 'veníamos', 'vine', 'vino',
  'vinimos', 'vinieron', 'venido',
  // volver
  'volver', 'vuelvo', 'vuelve', 'volvemos', 'volví', 'volvió', 'volvimos', 'volvieron',
])

function isPlaceVerb(word: string): boolean {
  return PLACE_VERB_FORMS.has(word) || PLACE_VERB_STEMS.some((stem) => word.startsWith(stem))
}

/**
 * 🔴 PEOPLE'S NAMES. A one-word finding that is a common given name, a
 * diminutive or a surname is a PERSON the detector mistyped, whatever the
 * sentence around it. Compact on purpose — a seatbelt, not a census — and the
 * direction of every doubt is "hold".
 *
 * ⚠ Towns that share a name (Dolores, Soledad, Guadalupe, Zapata, Juárez) are
 * deliberately NOT exempted: a reviewer releases a town in one click; a name
 * shown in clear cannot be taken back. State names pass (`STATES`).
 */
const GIVEN_NAMES = [
  // mujeres
  'maría', 'guadalupe', 'lupe', 'lupita', 'juana', 'rosa', 'rosario', 'chayo', 'josefina',
  'josefa', 'chepa', 'pepa', 'ana', 'margarita', 'mago', 'verónica', 'vero', 'leticia', 'lety',
  'elena', 'teresa', 'tere', 'patricia', 'paty', 'paola', 'alejandra', 'ale', 'gabriela', 'gaby',
  'martha', 'marta', 'carmen', 'mari', 'lucía', 'luz', 'isabel', 'chabela', 'chela', 'graciela',
  'silvia', 'laura', 'adriana', 'claudia', 'mónica', 'norma', 'irma', 'alicia', 'beatriz', 'bety',
  'gloria', 'esperanza', 'dolores', 'lola', 'soledad', 'concepción', 'concha', 'conchita',
  'socorro', 'refugio', 'cuca', 'antonia', 'francisca', 'pancha', 'paquita', 'catalina', 'cata',
  'julia', 'sofía', 'fernanda', 'daniela', 'valeria', 'andrea', 'karla', 'diana', 'sandra',
  'yolanda', 'yola', 'angélica', 'araceli', 'blanca', 'cecilia', 'cristina', 'elvira', 'eva',
  'imelda', 'inés', 'irene', 'jazmín', 'lourdes', 'lulú', 'marisol', 'mercedes', 'micaela',
  'natalia', 'olga', 'pilar', 'raquel', 'reyna', 'rocío', 'ruth', 'sara', 'susana', 'victoria',
  'virginia', 'ximena', 'yesenia', 'úrsula',
  // hombres
  'josé', 'pepe', 'juan', 'juanito', 'pedro', 'luis', 'carlos', 'jorge', 'miguel', 'jesús',
  'chucho', 'chuy', 'antonio', 'toño', 'francisco', 'paco', 'pancho', 'manuel', 'manolo',
  'alejandro', 'roberto', 'beto', 'ricardo', 'fernando', 'javier', 'raúl', 'rafael', 'rafa',
  'sergio', 'arturo', 'eduardo', 'lalo', 'enrique', 'kike', 'mario', 'martín', 'daniel',
  'david', 'alberto', 'ramón', 'rubén', 'salvador', 'chava', 'gerardo', 'guillermo', 'memo',
  'héctor', 'hugo', 'ignacio', 'nacho', 'jaime', 'joaquín', 'julio', 'leonardo', 'lorenzo',
  'marco', 'mauricio', 'nicolás', 'óscar', 'pablo', 'rodrigo', 'samuel', 'santos', 'tomás',
  'víctor', 'agustín', 'andrés', 'ángel', 'benito', 'cristian', 'diego', 'emiliano', 'ernesto',
  'esteban', 'felipe', 'gabriel', 'gilberto', 'gustavo', 'isidro', 'jacinto', 'leonel',
  'lucio', 'marcos', 'mateo', 'moisés', 'omar', 'porfirio', 'reynaldo', 'rogelio', 'saúl',
  'simón', 'timoteo', 'ulises', 'vicente', 'germán', 'abel', 'adrián', 'aurelio', 'baltazar',
  'camilo', 'cirilo', 'efraín', 'eusebio', 'fidel', 'gonzalo', 'heriberto', 'israel',
]

/** Common surnames that do not end in "-ez" (those are caught by {@link EZ_SURNAME}). */
const SURNAMES = [
  'garcía', 'flores', 'torres', 'rivera', 'morales', 'ortiz', 'cruz', 'reyes', 'ramos', 'romero',
  'mendoza', 'castillo', 'vargas', 'guzmán', 'herrera', 'medina', 'aguilar', 'moreno', 'ruiz',
  'díaz', 'silva', 'rojas', 'castro', 'ortega', 'delgado', 'vega', 'luna', 'ríos', 'campos',
  'navarro', 'salazar', 'cortés', 'mejía', 'bravo', 'cervantes', 'escobar', 'estrada', 'fuentes',
  'ibarra', 'lara', 'lozano', 'maldonado', 'mora', 'montes', 'muñoz', 'orozco', 'pacheco', 'peña',
  'rangel', 'robles', 'rosales', 'salas', 'sandoval', 'serrano', 'solís', 'soto', 'velasco',
  'zapata', 'acosta', 'ávila', 'barrera', 'bautista', 'cabrera', 'calderón', 'camacho', 'cano',
  'carrillo', 'contreras', 'espinoza', 'espinosa', 'figueroa', 'gallegos', 'garza', 'gil',
  'marín', 'miranda', 'molina', 'montoya', 'ochoa', 'olvera', 'padilla', 'ponce', 'quintero',
  'rosas', 'trejo', 'valencia', 'zúñiga', 'santiago', 'león', 'zamora', 'mendez', 'vázquez',
  'velázquez', 'domínguez',
]

/** "Martínez", "Gutiérrez", "Hernández", "Pérez": the patronymic ending. */
const EZ_SURNAME = /^\p{Lu}\p{Ll}*[eé]z$/u

/**
 * Real towns that the "-ez" rule would hold, released by name. ⚠ EMPTY of
 * anything that is also a common surname: "Juárez" alone holds (it is a
 * surname first); "Ciudad Juárez" passes because "Ciudad" starts it, and
 * "Gómez Farías" passes because the "-ez" rule reads one-word findings only.
 */
const EZ_TOWNS = new Set(['jerez'])

const NAMES = new Set([...GIVEN_NAMES, ...SURNAMES])

/** True when any word of the finding is a person's name (words after a saint are exempt). */
function namesAPerson(words: readonly string[]): boolean {
  if (words.length === 1) {
    const only = lower(words[0]!)
    if (STATE.has(only)) return false
    if (EZ_SURNAME.test(words[0]!) && !EZ_TOWNS.has(only)) return true
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = lower(words[i]!)
    // "San Juan Chamula", "Santa María Tonantzintla": the saint names the town.
    if (SAINTS.has(w)) return false
    if (NAMES.has(w) && !STATE.has(w)) return true
  }
  return false
}

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
    if (prev === 'en') {
      // 🔴 Only after a verb of residence or movement (`PLACE_VERB_*`).
      ok = isPlaceVerb(bare(tokens[i - 1] ?? ''))
    } else if (DIRECT_LOCATIVES.has(prev)) ok = true
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
  if (namesAPerson(words)) return false

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
