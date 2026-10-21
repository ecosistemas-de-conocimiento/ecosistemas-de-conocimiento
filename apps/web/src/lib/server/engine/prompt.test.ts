import { describe, expect, it } from 'vitest';
import { CHAT_SYSTEM_PROMPT, CITE_RULE, NO_ANSWER_REPLY, PLAIN_LANGUAGE_RULE } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('carries the cite rule: only direct support, one [N] group per sentence', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(CITE_RULE);
    expect(CITE_RULE).toContain('Cita solo los pasajes que apoyan directamente una afirmación');
    expect(CITE_RULE).toContain('Regla firme: como máximo un grupo de números por frase, con uno a tres');
    expect(CITE_RULE).toContain('No cites cada frase');
    expect(CITE_RULE).toContain('ni una frase que diga que falta información');
    expect(CITE_RULE).toMatch(/\[\d+\]/);
  });

  it('🔴 no passage on the topic: the exact no-answer reply and nothing else', () => {
    expect(CITE_RULE).toContain(
      `Contesta exactamente "${NO_ANSWER_REPLY}" y nada más solo si ningún pasaje tiene relación con la pregunta`,
    );
  });

  it('🔴 partly relevant passages get an answer, not the no-answer reply (Educación, 8b525fa)', () => {
    // 8b525fa's "Si los documentos no responden la pregunta, contesta
    // exactamente …" refused 3/3 on-topic Educación questions on dev.
    expect(CITE_RULE).not.toContain('Si los documentos no responden la pregunta');
    expect(CITE_RULE).toContain('aunque solo cubran una parte de ella');
    // Round 2: a two-part topic ("discapacidad en la escuela") still refused.
    expect(CITE_RULE).toContain('el tema pero no el lugar');
    expect(CITE_RULE).not.toContain('ningún pasaje trata el tema');
    // The partial answer opens with what the passages say, so `isNoAnswer`
    // (first sentence only) never drops its sources.
    expect(CITE_RULE).toContain('empieza por lo que dicen');
  });

  it('gives the no-answer instruction once: the plain-language rule no longer carries it', () => {
    expect(PLAIN_LANGUAGE_RULE).not.toContain(NO_ANSWER_REPLY);
    expect(CHAT_SYSTEM_PROMPT.split(NO_ANSWER_REPLY)).toHaveLength(2);
  });

  it('keeps the plain-language rule, and the cite rule uses none of its banned words', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(PLAIN_LANGUAGE_RULE);
    expect(CITE_RULE).not.toMatch(/fragmento|contexto|recuperad/i);
  });
});
