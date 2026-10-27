/**
 * TOLERANT READING of one extraction reply's raw `text`.
 *
 * ── 🔴 WHY THIS EXISTS (measured on dev, 2026-10-26) ───────────────────────
 *
 * ~20 % of extractions failed with "no usable `parsed` payload (schema miss…)".
 * Every one of the 8 dev rows read (`graph_error` of docs 353, 385, 391, 396,
 * 398, 400, 402, 405) said `valid JSON (schema miss)`: the model answered, in
 * JSON, and ai-service's strict Ajv gate withheld `parsed` because the JSON
 * missed the schema by a detail —
 *   · an `id` per entity (`"id": "entidad_1"`) — `additionalProperties: false`;
 *   · a top-level array, `[ {entidades, relaciones} ]` or a bare entity list;
 *   · more items than `maxItems` (author notes are relation-dense).
 * The same prompt on the same notes passed on a re-run (3 of 3), so the miss is
 * the model's variance, not the input.
 *
 * `extract.ts`'s `parseWindowResponse` already re-checks every field it keeps
 * (enum types, label shape, `fragmento` length, the person rule after it), so
 * the strict gate bought nothing the code does not enforce again. This module
 * only turns `text` into a value; the shape rules stay in `extract.ts`.
 *
 * 🔴 PRIVACY: nothing here returns or logs reply text. {@link describeReply}
 * reports length, JSON kind and KNOWN key names only.
 */

/** The schema's own vocabulary — the only key names a miss report may print. */
const KNOWN_KEYS = new Set([
  'entidades',
  'relaciones',
  'entities',
  'relations',
  'id',
  'tipo',
  'etiqueta',
  'menciones',
  'fragmento',
  'figura_publica',
  'desde',
  'hacia',
])

export type Salvaged = { value: unknown; truncated: boolean } | { error: string }

/** Strip a markdown fence if the reply has one. */
function unfence(text: string): string {
  const m = /```(?:json|JSON)?\s*\n?([\s\S]*?)(?:```|$)/.exec(text)
  return m ? m[1] : text
}

/**
 * Scan from the first `{`/`[`, string-aware. Returns the balanced value, or —
 * when the reply was cut off — the text up to the last complete nested value
 * with the still-open brackets closed.
 */
function extractValue(text: string): { json: string; truncated: boolean } | null {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const stack: string[] = []
  let inString = false
  let escaped = false
  let lastCut = -1
  let stackAtCut: string[] = []
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      stack.pop()
      if (stack.length === 0) return { json: text.slice(start, i + 1), truncated: false }
      lastCut = i + 1
      stackAtCut = [...stack]
    }
  }
  if (lastCut < 0) return { json: text.slice(start), truncated: true }
  return { json: text.slice(start, lastCut) + stackAtCut.reverse().join(''), truncated: true }
}

const withoutTrailingCommas = (json: string): string => json.replace(/,(\s*[}\]])/g, '$1')

/** Best effort: fences, surrounding prose, trailing commas, a cut-off tail. */
export function salvageJson(text: string): Salvaged {
  const found = extractValue(unfence(text))
  if (!found) return { error: 'no JSON value found' }
  for (const candidate of [found.json, withoutTrailingCommas(found.json)]) {
    try {
      return { value: JSON.parse(candidate), truncated: found.truncated }
    } catch {
      // try the next repair
    }
  }
  try {
    JSON.parse(found.json)
  } catch (err) {
    return { error: parseErrorPosition(err) }
  }
  return { error: 'parse error (position unknown)' }
}

/** Where JSON.parse stopped, without echoing the text (V8 messages can quote it). */
function parseErrorPosition(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const msg = err instanceof Error ? err.message : ''
  const pos = /position (\d+)/.exec(msg)?.[1]
  if (pos) return `parse error at position ${pos} (${name})`
  if (/end of JSON input|Unterminated/i.test(msg)) return `parse error at end of input (${name})`
  return `parse error, position unknown (${name})`
}

/**
 * Coerce the reply shapes measured on dev into `{entidades, relaciones}`.
 * Returns null when no entity list can be found at all.
 */
export function coerceReplyShape(value: unknown): { entidades: unknown[]; relaciones: unknown[] } | null {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

  if (isObj(value)) {
    const entidades = value.entidades ?? value.entities
    const relaciones = value.relaciones ?? value.relations
    if (Array.isArray(entidades)) return { entidades, relaciones: list(relaciones) }
    // `{}`: the model found nothing, and said so in JSON.
    if (Object.keys(value).length === 0) return { entidades: [], relaciones: [] }
    return null
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { entidades: [], relaciones: [] }
    // `[ {entidades, relaciones}, … ]`
    if (value.every((v) => isObj(v) && Array.isArray(v.entidades ?? v.entities))) {
      const out = { entidades: [] as unknown[], relaciones: [] as unknown[] }
      for (const v of value as Record<string, unknown>[]) {
        out.entidades.push(...list(v.entidades ?? v.entities))
        out.relaciones.push(...list(v.relaciones ?? v.relations))
      }
      return out
    }
    // A bare list: entities carry `etiqueta`, relations carry `desde`/`hacia`.
    const entidades = value.filter((v) => isObj(v) && 'etiqueta' in v)
    const relaciones = value.filter((v) => isObj(v) && 'desde' in v && 'hacia' in v)
    if (entidades.length > 0) return { entidades, relaciones }
  }
  return null
}

/**
 * 🔴 SHAPE ONLY. Length, JSON kind, known key names (the rest counted). Never
 * a value, never an unknown key — a key the model invented can be document text.
 */
export function describeReply(text: string | undefined, salvaged?: Salvaged): string {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return 'the response carried no text'
  const s = salvaged ?? salvageJson(body)
  if ('error' in s) return `response length ${body.length}, ${s.error}`
  const v = s.value
  const cut = s.truncated ? ', cut off' : ''
  if (Array.isArray(v)) return `response length ${body.length}, JSON array of ${v.length}${cut}, no entity list`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    const known = keys.filter((k) => KNOWN_KEYS.has(k)).slice(0, 5)
    const other = keys.length - known.length
    const list = [...known, ...(other ? [`+${other} other`] : [])].join(', ')
    return `response length ${body.length}, JSON object${cut}, keys [${list}], no entity list`
  }
  return `response length ${body.length}, JSON ${v === null ? 'null' : typeof v}, no entity list`
}
