/**
 * 🔴 A TOWN IS SHOWN, SO A TOWN NEVER HOLDS A DOCUMENT.
 *
 * The owner's ruling (2026-10-21, backlog #12, commits 891afdd and 7c7ff83):
 * estados, municipios, alcaldías, ciudades, pueblos, comunidades, localidades,
 * ejidos and congregaciones are SHOWN. The detector prompt says so
 * (`DETECT_SYSTEM_PROMPT`, "NUNCA marques estados, municipios…"), and stage 4
 * (verify) runs that same prompt. The model still marks towns there: measured
 * on dev the same day (runbook `infra/fleet/edc-1.md` §4p), 31 of the 38
 * verify holds had place findings only.
 *
 * A prompt cannot make a model obey, so the rule is repeated in code, on the
 * HOLD DECISION only. Stage 3 still redacts whatever the model marks: a town
 * redacted by mistake costs readability, never privacy.
 *
 * ── WHY AN ALLOW-LIST OF SHAPES, NOT A LIST OF TOWNS ─────────────────────────
 *
 * There is no gazetteer here, and a town list would never be complete. So a
 * `lugar` finding is ignored ONLY when it LOOKS like a bare town name in a
 * sentence that USES it as a place, and every doubt goes to "hold":
 *
 *   1. SHAPE. Proper-noun words ("Xoxocotla", "San Juan Chamula"), connectors
 *      (de, del, la, las, los, el, y) and town-level words (municipio, pueblo,
 *      ciudad, estado…), joined by spaces or commas. No digit, no period, no
 *      address word ({@link ADDRESS_WORDS}: calle, colonia, barrio, rancho,
 *      paraje, C.P., casa, escuela, clínica…). "colonia Portales", "calle
 *      Morelos 45", "rancho Los Pinos", "la casa de la reja verde" all fail it.
 *   2. CONTEXT. EVERY occurrence in the text follows a locative word ("en",
 *      "de", "desde", "hacia"…), a town-level word, a comma or "y" — skipping
 *      one article. "Vivo en Xoxocotla, Morelos" passes. "Portales" after
 *      "colonia", "Morelos" after "calle", and "Soledad" after "mi tía" or at
 *      the start of "Soledad me dijo" all fail it, so a person's name the model
 *      mislabelled `lugar` still holds in most sentences.
 *
 * ⚠ THE RESIDUAL RISK, STATED: a colonia or paraje written by its bare name
 * with no address word ("vivo en Lomas Verdes") that stage 3 also missed is
 * treated as a town. The detector cannot tell those apart either. Common
 * colonia-name words are on {@link ADDRESS_WORDS} to narrow it.
 *
 * ⚠ A `persona`, `contacto`, `identificador` or `otro` finding is never ignored.
 */

import type { DetectorFinding } from './types'

/** Words that make a finding an address, a building or a home. Lower case, accents kept. */
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
  'barranca', 'presa', 'loma', 'lomas', 'jardín', 'jardines',
  // ranchos, parajes, tierras
  'rancho', 'ranchería', 'paraje', 'predio', 'finca', 'parcela', 'terreno', 'huerta',
  'milpa', 'potrero',
  // la casa y cómo llegar
  'casa', 'domicilio', 'edificio', 'departamento', 'depto', 'interior', 'piso',
  'cuarto', 'enfrente', 'frente', 'junto', 'atrás', 'detrás', 'lado', 'subiendo',
  'bajando', 'cerca', 'reja', 'puerta', 'zaguán', 'tanque',
  // código postal
  'código', 'postal', 'cp',
  // lugares que pueden señalar a una persona
  'escuela', 'primaria', 'secundaria', 'telesecundaria', 'kínder', 'preescolar',
  'preparatoria', 'prepa', 'bachillerato', 'universidad', 'clínica', 'hospital',
  'centro', 'consultorio', 'iglesia', 'parroquia', 'capilla', 'templo', 'mercado',
  'tienda', 'tiendita', 'plaza', 'panteón', 'cancha', 'oficina', 'empresa',
  'fábrica', 'taller', 'cooperativa', 'albergue', 'refugio',
]

/** Town-level words: the unit the owner ruled is shown. */
const TOWN_WORDS = [
  'estado', 'municipio', 'alcaldía', 'delegación', 'ciudad', 'pueblo', 'comunidad',
  'localidad', 'ejido', 'congregación', 'villa', 'región',
]

const CONNECTORS = ['de', 'del', 'la', 'las', 'los', 'el', 'y']

/** What may stand right before a town used as a place. */
const LOCATIVES = [
  'en', 'de', 'del', 'a', 'al', 'desde', 'hasta', 'hacia', 'para', 'por', 'rumbo', 'y',
  ...TOWN_WORDS,
]

const ARTICLES = new Set(['el', 'la', 'los', 'las'])
const ADDRESS = new Set(ADDRESS_WORDS)
const TOWN = new Set(TOWN_WORDS)
const CONNECTOR = new Set(CONNECTORS)
const LOCATIVE = new Set(LOCATIVES)

const lower = (word: string) => word.normalize('NFC').toLocaleLowerCase('es')
const isCapitalised = (word: string) => /^\p{Lu}/u.test(word)

/** Rule 1: the finding's own text reads as a bare town name. */
function hasTownShape(text: string): boolean {
  const value = text.normalize('NFC').trim()
  if (value === '' || /[\d.#°º/]/u.test(value)) return false
  const words = value.split(/[\s,]+/u).filter(Boolean)
  if (words.length === 0 || words.length > 8) return false
  let proper = 0
  for (const word of words) {
    if (!/^[\p{L}'-]+$/u.test(word)) return false
    const w = lower(word)
    if (ADDRESS.has(w)) return false
    if (CONNECTOR.has(w) || TOWN.has(w)) continue
    if (!isCapitalised(word)) return false
    proper += 1
  }
  return proper > 0
}

/** Rule 2: every occurrence follows a locative word, a town word, a comma or "y". */
function usedAsPlaceEverywhere(text: string, needle: string): boolean {
  let from = 0
  let seen = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return seen > 0
    seen += 1
    from = at + 1

    const before = text.slice(0, at).trimEnd()
    if (before.endsWith(',')) continue
    const tokens = before.split(/\s+/u)
    let previous = lower(tokens.pop() ?? '')
    // Skip one article: "en la Ciudad de México", "en el municipio de Ayala".
    if (ARTICLES.has(previous)) previous = lower(tokens.pop() ?? '')
    if (previous.endsWith(',')) continue
    if (!LOCATIVE.has(previous)) return false
  }
}

/**
 * True when a `lugar` finding is a town-level place (shown by the owner's
 * ruling) and so must not hold the document. See the file header for both
 * rules and the risk they leave.
 *
 * @param text the text the finding was found in (verify's input).
 */
export function isTownLevelPlace(
  finding: Pick<DetectorFinding, 'text' | 'type'>,
  text: string,
): boolean {
  if (finding.type !== 'lugar') return false
  const needle = finding.text.normalize('NFC').trim()
  if (!hasTownShape(needle)) return false
  return usedAsPlaceEverywhere(text.normalize('NFC'), needle)
}
