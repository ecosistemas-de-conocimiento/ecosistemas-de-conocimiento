/**
 * The answer style of an ecosistema (owner ruling 2026-10-28): three optional
 * texts the chat appends to its system prompt, one per prompt —
 * Generales (answers), Resonancias, and the Generales interviewer. Set by a
 * platform admin only (`refuseAnswerStyleChange` in `collections/Organizations.ts`).
 *
 * Stored as three nullable `organizations` columns, NOT inside `features`:
 * that parser takes booleans only.
 *
 * 🔴 The text lands in a SYSTEM message. The web wraps it under a header that
 * says it adjusts tone and focus, never the rules (`withEcosystemStyle` in
 * `apps/web/src/lib/server/engine/prompt.ts`). This module refuses the shapes
 * that would talk to the rules directly: the `<fuente>` fence, `[N]` markers,
 * and "ignora … instrucciones". It is a guard against mistakes, not a sandbox:
 * the only writer is a platform admin.
 */

export const ANSWER_STYLE_MAX_LENGTH = 1500

/** `organizations` field per prompt. */
export const ANSWER_STYLE_FIELDS = {
  generales: 'answerStyleGenerales',
  resonancias: 'answerStyleResonancias',
  interviewer: 'answerStyleInterviewer',
} as const

export type AnswerStyleKind = keyof typeof ANSWER_STYLE_FIELDS
export type AnswerStyleField = (typeof ANSWER_STYLE_FIELDS)[AnswerStyleKind]
export type AnswerStyles = Record<AnswerStyleKind, string | null>

export const ANSWER_STYLE_KINDS = Object.keys(ANSWER_STYLE_FIELDS) as AnswerStyleKind[]
export const ANSWER_STYLE_FIELD_NAMES = Object.values(ANSWER_STYLE_FIELDS) as AnswerStyleField[]

export const ANSWER_STYLE_LOCKED_MESSAGE = 'Solo administración de la plataforma puede cambiar el estilo de respuesta.'

export type NormalizedAnswerStyle = { ok: true; value: string | null } | { ok: false; message: string }

// Every C0 control and DEL except "\n" (CR is folded into "\n" first).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/g
const FENCE = /<\s*\/?\s*fuente/i
const CITATION_MARKER = /\[\s*\d+\s*\]/
const IGNORE_INSTRUCTIONS = /\bignor\w*\b[\s\S]{0,80}?\binstrucci/i

/**
 * Pure. `null`/`undefined`/blank → `null` (no style). Otherwise the cleaned
 * text, or a Spanish refusal (the caller answers 400 with it).
 */
export function normalizeAnswerStyle(raw: unknown): NormalizedAnswerStyle {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, message: 'El estilo de respuesta debe ser texto.' }
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text === '') return { ok: true, value: null }
  if (text.length > ANSWER_STYLE_MAX_LENGTH) {
    return { ok: false, message: `El estilo de respuesta admite hasta ${ANSWER_STYLE_MAX_LENGTH} caracteres.` }
  }
  if (FENCE.test(text)) return { ok: false, message: 'El estilo de respuesta no puede incluir etiquetas <fuente>.' }
  if (CITATION_MARKER.test(text)) {
    return { ok: false, message: 'El estilo de respuesta no puede incluir números entre corchetes, como [1].' }
  }
  if (IGNORE_INSTRUCTIONS.test(text)) {
    return { ok: false, message: 'El estilo de respuesta no puede pedir que se ignoren las instrucciones.' }
  }
  return { ok: true, value: text }
}

/** Whatever a row holds, as the three styles. Junk reads as no style. */
export function answerStylesOf(row: unknown): AnswerStyles {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const out = {} as AnswerStyles
  for (const kind of ANSWER_STYLE_KINDS) {
    const v = r[ANSWER_STYLE_FIELDS[kind]]
    out[kind] = typeof v === 'string' && v.trim() !== '' ? v : null
  }
  return out
}
