/**
 * The answer style of an ecosistema — mirror of the backend's
 * `lib/answerStyle.ts`, which owns it (owner ruling 2026-10-28). Three
 * optional texts, one per prompt; a platform admin sets them in `/ajustes`.
 */

export const ANSWER_STYLE_KINDS = ['generales', 'resonancias', 'interviewer'] as const;
export type AnswerStyleKind = (typeof ANSWER_STYLE_KINDS)[number];
export type AnswerStyles = Record<AnswerStyleKind, string | null>;

export const ANSWER_STYLE_MAX_LENGTH = 1500;

export const NO_ANSWER_STYLES: AnswerStyles = Object.freeze({ generales: null, resonancias: null, interviewer: null });

/** `/ajustes` labels. */
export const ANSWER_STYLE_LABELS: Record<AnswerStyleKind, string> = {
  generales: 'Generales',
  resonancias: 'Resonancias',
  interviewer: 'Entrevista',
};

/** Whatever came over the wire. Junk or blank reads as no style. */
export function resolveAnswerStyles(raw: unknown): AnswerStyles {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out = { ...NO_ANSWER_STYLES };
  for (const k of ANSWER_STYLE_KINDS) {
    const v = r[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return out;
}
