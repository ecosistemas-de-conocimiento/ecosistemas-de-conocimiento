import { describe, expect, it } from 'vitest';
import { CHAT_SYSTEM_PROMPT, CITE_RULE, NO_ANSWER_REPLY, PLAIN_LANGUAGE_RULE } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('carries the cite rule: only direct support, one [N] group per sentence', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(CITE_RULE);
    expect(CITE_RULE).toContain('Cita solo los pasajes que apoyan directamente una afirmación');
    expect(CITE_RULE).toContain('como máximo un grupo de números por frase, de uno a tres');
    expect(CITE_RULE).toContain('ni una frase que diga que falta información');
    expect(CITE_RULE).toMatch(/\[\d+\]/);
  });

  it('🔴 no documents for the question: the exact no-answer reply and nothing else', () => {
    expect(CITE_RULE).toContain(`contesta exactamente "${NO_ANSWER_REPLY}" y nada más`);
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
