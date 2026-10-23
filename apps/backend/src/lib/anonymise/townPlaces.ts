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
 * So the rule is repeated in code, in TWO places of `gate.ts`: stage 3 does not
 * redact a town, and verify does not hold on one. (Until 2026-10-23 it ran on
 * verify only, and stage 3 turned "vivo en Xochitepec" into "vivo en
 * [Domicilio A]" on dev.) 🔴 A finding this file ignores SHIPS IN CLEAR, so
 * every doubt goes to "redact" / "hold": a town redacted or held by mistake
 * costs a reviewer one click; a person or a home let through costs the person.
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
 *      "me quedé en"), so "pienso en Soledad" holds. Work is not residence:
 *      "trabajo en Coppel" names an employer.
 *   6. NOTHING STREET-LIKE AFTER, in the next five words: no digit, "#",
 *      "s/n", street word ("casi esquina con", "a dos cuadras", "dpto 4"),
 *      spelled-out number ("cuarenta y cinco") or "N° 45". ⚠ A year counts
 *      too: "vivo en Xochitepec desde 2010" redacts the town (fail-closed).
 *   7. ONE PIECE, ONE PROPER WORD, unless a town word comes before it or
 *      starts it ("el municipio de Gómez Farías", "Ciudad Juárez"). 🔴 A state
 *      after it is NOT an anchor (re-audit 2026-10-23): "Insurgentes Sur,
 *      CDMX", "Santa Úrsula, CDMX" are redacted, and so are real towns such
 *      as "Gómez Farías, Jalisco" (fail-closed; a reviewer approves). A state
 *      paired with a state ("Hidalgo, Morelos") is a street.
 *   ·  A finding the model typed `domicilio` is never a town (`typedAddress`).
 *   ·  Every set lookup is case- and accent-folded ("Callejon" = "callejón").
 *
 * ⚠ THE TWO RESIDUAL RISKS, STATED. There is no gazetteer and no census here,
 * so both directions of "looks like a town" can still be wrong:
 *
 *   1. A COLONIA, STREET (or paraje, or named building) written as ONE bare,
 *      capitalised word after a place verb and "en", with nothing street-like
 *      after it — "vivo en Portales", "vivo en Insurgentes", "vivo en Tepito"
 *      — that the model typed `lugar` passes as a town and ships in clear.
 *   2. A PERSON the detector typed `lugar` whose name is not on the compact
 *      lists — an uncommon given name or a surname not ending in "-ez",
 *      after "vivo en" / "soy de" — passes as a town and ships in clear.
 *      ("Vivo en Xiadani" passes.) Common names and every "-ez" surname hold.
 *
 * 🔴 ONE MODEL ANSWER IS ENOUGH for either. Since 2026-10-23 stage 3 applies
 * this exemption too, so a single `lugar` answer shows the name; nothing later
 * redacts it (verify ignores it by the same rule). The opposite error — a real
 * town redacted or held — costs a reviewer one click and is the direction
 * every rule above leans. (Rule for one bare word: owner's decision pending.)
 *
 * ⚠ A `persona`, `contacto`, `identificador` or `otro` finding is never ignored.
 */

import { foldedMatches } from './detector'
import type { DetectorFinding } from './types'

/**
 * 🔴 FOLDED: lower case AND accents dropped, on both sides of every set lookup
 * (audit 2026-10-23: "Callejon", "Prolongacion", "Seccion" missed their
 * accented head nouns). Folding only ever makes a lookup match more.
 */
const lower = (word: string) =>
  word.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es')

function foldedSet(words: readonly string[]): Set<string> {
  return new Set(words.map(lower))
}

/**
 * Street, settlement and building words, abbreviations included. Matched
 * case- and accent-folded, with or without a dot ("Priv.", "Cda", "Calz").
 * These also count in the few words AFTER a place (rule 6).
 * ⚠ Not "ejido": the owner ruled ejidos are shown (`TOWN_WORDS`).
 */
const STREET_WORDS: readonly string[] = [
  // calles
  'calle', 'avenida', 'av', 'avda', 'andador', 'cerrada', 'cda', 'privada', 'priv',
  'callejón', 'cjon', 'calzada', 'calz', 'boulevard', 'bulevar', 'blvd',
  'prolongación', 'prol', 'carretera', 'carr', 'camino', 'brecha', 'vereda',
  'kilómetro', 'km', 'esquina', 'entre', 'número', 'núm', 'num', 'nro', 'retorno',
  'circuito', 'cto', 'pasaje', 'cuadra', 'cuadras', 'frente', 'enfrente',
  // dentro de una localidad
  'colonia', 'col', 'barrio', 'fraccionamiento', 'fracc', 'frac', 'unidad', 'habitacional',
  'manzana', 'mz', 'supermanzana', 'smz', 'lote', 'lt', 'sector', 'sección', 'secc',
  'ampliación', 'ampl', 'residencial', 'condominio', 'conjunto', 'infonavit',
  'fovissste', 'privadas', 'villas',
  // el edificio
  'edificio', 'edif', 'torre', 'departamento', 'depto', 'dpto', 'interior', 'int', 'piso',
]

/** Words that make a finding an address, a home, or an institution. Lower case, accents kept. */
export const ADDRESS_WORDS: readonly string[] = [
  ...STREET_WORDS,
  'no', 'sin',
  // nombres frecuentes de colonias (auditoría de `genericPlaces.ts`, 2026-10-21)
  'barranca', 'presa', 'loma', 'lomas', 'jardín', 'jardines', 'pedregal',
  // ranchos, parajes, tierras
  'rancho', 'rcho', 'ranchito', 'ranchería', 'paraje', 'predio', 'finca', 'parcela',
  'terreno', 'huerta', 'milpa', 'potrero', 'hacienda', 'granja', 'quinta',
  // reclusión (audit 2026-10-23: "Cereso Atlacholoaya, Morelos" was shown)
  'cereso', 'cefereso', 'penal', 'reclusorio', 'penitenciaría', 'cárcel',
  // la casa y cómo llegar
  'casa', 'domicilio', 'cuarto', 'junto', 'atrás', 'detrás', 'lado', 'subiendo',
  'bajando', 'cerca', 'reja', 'puerta', 'zaguán', 'tanque',
  // código postal
  'código', 'postal', 'cp',
  // instituciones y lugares que pueden señalar a una persona
  'escuela', 'primaria', 'secundaria', 'telesecundaria', 'kínder', 'preescolar',
  'preparatoria', 'prepa', 'bachillerato', 'universidad', 'clínica', 'hospital',
  'centro', 'salud', 'consultorio', 'imss', 'issste', 'issstep', 'seguro', 'siglo',
  'xxi', 'raza', 'iglesia', 'parroquia', 'capilla', 'templo', 'mercado', 'tienda',
  'tiendita', 'plaza', 'panteón', 'cancha', 'oficina', 'empresa', 'fábrica',
  'taller', 'cooperativa', 'albergue', 'refugio', 'sanatorio', 'asilo', 'internado',
  'orfanato', 'cuartel',
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
// ⚠ NOT "trabaj": "trabajo en Coppel" names an employer (audit 2026-10-23).
const PLACE_VERB_STEMS = ['viv', 'nac', 'crec', 'lleg', 'qued', 'mud', 'resid', 'habit', 'regres']
const PLACE_VERB_FORMS = foldedSet([
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
const EZ_TOWNS = foldedSet(['jerez'])

const NAMES = foldedSet([...GIVEN_NAMES, ...SURNAMES])

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

const DIRECT_LOCATIVES = foldedSet(['en', 'desde', 'hasta', 'hacia', 'rumbo', ...TOWN_WORDS])
const ARTICLES = foldedSet(['el', 'la', 'los', 'las'])
const SAINTS = foldedSet(['san', 'santa', 'santo'])
const ADDRESS = foldedSet(ADDRESS_WORDS)
const PERSON = foldedSet(PERSON_WORDS)
const TOWN = foldedSet(TOWN_WORDS)
const ORIGIN = foldedSet(ORIGIN_WORDS)
const STATE = foldedSet(STATES)
const CONNECTOR = foldedSet(['de', 'del', 'la', 'las', 'los', 'el'])
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

/** Rule 6: a house number spelled out. Tens and hundreds anywhere near; a unit only right after. */
const NUMBER_TENS = foldedSet([
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete',
  'dieciocho', 'diecinueve', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta',
  'setenta', 'ochenta', 'noventa', 'cien', 'ciento', 'doscientos', 'trescientos',
  'cuatrocientos', 'quinientos',
])
const NUMBER_UNITS = foldedSet(['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'])
/** "n. 45", "No 45", "Nº 45", "N° 45": a marker that is a number only before one. */
const NUMBER_MARKERS = foldedSet(['n', 'no', 'nº', 'num', 'núm', 'nro', 'número'])
const STREET = foldedSet(STREET_WORDS)
/** How many words after a place rule 6 reads. */
const AFTER_WINDOW = 5

const isNumberWord = (w: string) =>
  NUMBER_TENS.has(w) || /^veinti\p{L}+$/u.test(w) || NUMBER_UNITS.has(w)

/**
 * Rule 6 — what stands AFTER (audit 2026-10-23, two passes). In the next
 * {@link AFTER_WINDOW} words: a digit, a "#", "s/n", a street word ("casi
 * esquina con", "a dos cuadras de", "dpto 4", "torre B"), a spelled-out
 * ten ("cuarenta y cinco"), or a number marker before a number ("N° 45").
 * The word right after may also be any address word or a unit ("Hidalgo
 * cinco"). The window stops at a sentence end, but the first word of the
 * next sentence still counts ("Vivo en Hidalgo. Número 45.").
 */
function streetFollows(after: string): boolean {
  const tokens = after.split(/\s+/u).filter((t) => t !== '')
  let seen = 0
  for (let i = 0; i < tokens.length && seen < AFTER_WINDOW; i += 1) {
    const t = tokens[i]!
    // "familia." ends a sentence; "n.", "int.", "edif." are abbreviations.
    const abbreviation = ADDRESS.has(bare(t)) || NUMBER_MARKERS.has(bare(t)) || bare(t).length <= 3
    const sentenceEnd = /^[.!?;:]+$/u.test(t) || /[!?;]$/u.test(t) || (/\.$/u.test(t) && !abbreviation)
    if (!/[\p{L}\p{N}#]/u.test(t)) {
      if (sentenceEnd) seen = AFTER_WINDOW - 1
      continue
    }
    seen += 1
    const w = bare(t)
    if (/[\p{N}#]/u.test(t) || /^s\/n\.?$/iu.test(t)) return true
    if (STREET.has(w) || NUMBER_TENS.has(w) || /^veinti\p{L}+$/u.test(w)) return true
    if (seen === 1 && (ADDRESS.has(w) || NUMBER_UNITS.has(w))) return true
    if (NUMBER_MARKERS.has(w)) {
      const nextT = tokens[i + 1] ?? ''
      if (/\p{N}/u.test(nextT) || isNumberWord(bare(nextT))) return true
    }
    if (sentenceEnd) seen = AFTER_WINDOW - 1
  }
  return false
}

/**
 * Rules 2–4 and 6 for one occurrence.
 *
 * @param anchorRequired rule 4 (weak name) or rule 7 (several proper words):
 *   the occurrence needs a town word before it or a state after it.
 * @param anchoredInSpan the span itself already carries that anchor (it ends
 *   in ", <state>", starts with a town word, or is a state).
 */
function placeContext(
  text: string,
  at: number,
  end: number,
  words: readonly string[],
  anchorRequired: boolean,
  anchoredInSpan: boolean,
): boolean {
  const beforeRaw = text.slice(0, at)
  const after = text.slice(end)
  const first = lower(words[0]!)
  const startsWithTownWord = TOWN.has(first)

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

  // Rule 6: nothing street-like right after.
  if (streetFollows(after)) return false

  // Rules 4 and 7: a weak or many-word name needs a town word before it. 🔴 A
  // state after it is NOT enough (re-audit 2026-10-23: "Insurgentes Sur, CDMX",
  // "Santa Úrsula, CDMX" were shown).
  if (anchorRequired && !anchoredInSpan && !townWordBefore) return false
  return true
}

/** What may stand before a town inside the finding's own span: "en Xochitepec". */
const LEAD_PREPOSITIONS = new Set(['en', 'de', 'del', 'desde', 'hasta', 'hacia'])

/**
 * The town the model's span wraps, or the span itself.
 *
 * Measured 2026-10-23 (fake-model tests, `gate.towns.test.ts`): models mark a
 * town as "Xochitepec", "en Xochitepec" or "vivo en Xochitepec". Only ONE
 * lead is cut — a locative preposition, optionally after one verb of residence
 * or origin — and the rest must then pass every rule at every occurrence in
 * the text, with the text's own words before it. "Yo vivo en …" is not cut:
 * the whole span stays a finding and is redacted.
 */
function withoutLead(needle: string): string {
  const parts = needle.split(/\s+/u)
  let cut = 0
  if (parts.length >= 2 && LEAD_PREPOSITIONS.has(bare(parts[0]!))) cut = 1
  else if (
    parts.length >= 3 &&
    (isPlaceVerb(bare(parts[0]!)) || ORIGIN.has(bare(parts[0]!))) &&
    LEAD_PREPOSITIONS.has(bare(parts[1]!))
  ) {
    cut = 2
  }
  let rest = needle
  for (let i = 0; i < cut; i += 1) rest = rest.replace(/^\S+\s+/u, '')
  return rest
}

/**
 * True when a `lugar` finding is a town-level place (shown by the owner's
 * ruling) and so must not be redacted (stage 3) nor hold the document
 * (verify). See the file header: every rule must pass at every occurrence,
 * and anything unsure is NOT a town.
 *
 * 🔴 EVERY OCCURRENCE, IN EVERY SPELLING. Stage 3 redacts case- and
 * accent-blind (`gate.ts`), so skipping a town there skips "XOCHITEPEC" too:
 * each folded occurrence, glued or not, must stand in a town context.
 *
 * @param text the text the finding was found in (stage 3's or verify's input).
 */
export function isTownLevelPlace(
  finding: Pick<DetectorFinding, 'text' | 'type' | 'typedAddress'>,
  text: string,
): boolean {
  if (finding.type !== 'lugar' || finding.typedAddress) return false
  const needle = withoutLead(finding.text.normalize('NFC').trim())
  if (needle === '' || /[\d.#°º/]/u.test(needle)) return false
  const words = needle.split(/[\s,]+/u).filter(Boolean)
  if (!hasTownShape(words)) return false
  if (namesAPerson(words)) return false

  // Rule 7 (audit 2026-10-23): ONE piece, and one proper word, unless anchored.
  // "Insurgentes, Cuernavaca", "Hidalgo, Xochitepec, Morelos": more than one
  // piece before a closing state is never a town. "Ranchito El Huizache",
  // "Hacienda San José", "Priv Hidalgo", "Jiutepec Civac": several proper words
  // need a town word before or a state after, like a weak name (rule 4). A real
  // many-word town without one is redacted: fail-closed, accepted.
  const pieces = needle.split(',').map((p) => p.trim()).filter(Boolean)
  const isState = (piece: string) => STATE.has(piece.split(/\s+/u).map(lower).join(' '))
  const endsInState = pieces.length >= 2 && isState(pieces[pieces.length - 1]!)
  const core = endsInState ? pieces.slice(0, -1) : pieces
  if (core.length > 1) return false
  // "Hidalgo, Morelos": a state paired with a state is a street, not a town.
  if (endsInState && isState(core[0]!)) return false
  const pairedWithState = !endsInState && isState(core[0]!)
  const coreWords = core[0]!.split(/\s+/u)
  const proper = coreWords.filter((w) => !CONNECTOR.has(lower(w)) && !TOWN.has(lower(w))).length
  const first = lower(coreWords[0]!)
  const weak = ARTICLES.has(first) || SAINTS.has(first)
  const anchorRequired = weak || proper > 1
  // A town word starting the span, or the span being a state, anchors it.
  const anchoredInSpan = TOWN.has(first) || isState(core[0]!)

  const haystack = text.normalize('NFC')
  const occurrences = foldedMatches(haystack, needle)
  if (occurrences.length === 0) return false
  return occurrences.every(
    ([at, end]) =>
      !(pairedWithState && stateFollows(haystack.slice(end))) &&
      placeContext(haystack, at, end, words, anchorRequired, anchoredInSpan),
  )
}
