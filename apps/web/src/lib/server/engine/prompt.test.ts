import { describe, expect, it } from 'vitest';
import { CHAT_SYSTEM_PROMPT, CITE_RULE, PLAIN_LANGUAGE_RULE } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('carries the cite rule: [N] right after the claim', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(CITE_RULE);
    expect(CITE_RULE).toContain('justo después de la frase');
    expect(CITE_RULE).toMatch(/\[\d+\]/);
  });

  it('keeps the plain-language rule, and the cite rule uses none of its banned words', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(PLAIN_LANGUAGE_RULE);
    expect(CITE_RULE).not.toMatch(/fragmento|contexto|recuperad/i);
  });
});
