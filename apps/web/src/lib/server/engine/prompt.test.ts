import { afterEach, describe, expect, it, vi } from 'vitest';

// `./config` reads `$env/dynamic/private`; backing it with the live
// `process.env` lets a test change CHAT_CITE_VARIANT between two reads.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
  CHAT_SYSTEM_PROMPT,
  CHUNK_DATA_RULE,
  CITE_RULE,
  CITE_RULE_VARIANTS,
  CITE_VARIANTS,
  NO_ANSWER_REPLY,
  PLAIN_LANGUAGE_RULE,
  chatSystemPrompt,
  parseCiteVariant,
} from './prompt';

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

describe('CHAT_CITE_VARIANT — the dev prompt A/B', () => {
  it('A is the 8a1df66 rule and prompt, unchanged', () => {
    expect(CITE_RULE_VARIANTS.A).toBe(CITE_RULE);
    expect(chatSystemPrompt('A')).toBe(CHAT_SYSTEM_PROMPT);
    expect(chatSystemPrompt()).toBe(CHAT_SYSTEM_PROMPT);
  });

  it.each(CITE_VARIANTS)('variant %s builds a full prompt with its own rule', (v) => {
    const p = chatSystemPrompt(v);
    expect(p).toContain(CITE_RULE_VARIANTS[v]);
    expect(p).toContain(PLAIN_LANGUAGE_RULE);
    expect(p).toContain(CHUNK_DATA_RULE);
    expect(CITE_RULE_VARIANTS[v]).not.toMatch(/fragmento|contexto|recuperad/i);
  });

  it('the four variants differ from one another', () => {
    expect(new Set(CITE_VARIANTS.map((v) => chatSystemPrompt(v))).size).toBe(4);
  });

  it('B and D cap citations and keep the no-answer reply for unrelated passages only', () => {
    for (const v of ['B', 'D'] as const) {
      expect(CITE_RULE_VARIANTS[v]).toContain('como máximo cinco grupos de números');
      expect(CITE_RULE_VARIANTS[v]).toContain('como máximo un grupo por párrafo');
      expect(CITE_RULE_VARIANTS[v]).toContain('empieza por lo que dicen');
      expect(CITE_RULE_VARIANTS[v]).toContain(
        `Contesta exactamente "${NO_ANSWER_REPLY}" y nada más solo si ningún pasaje tiene relación con la pregunta`,
      );
    }
  });

  it('C carries the same citation limit and no no-answer instruction', () => {
    expect(CITE_RULE_VARIANTS.B.startsWith(CITE_RULE_VARIANTS.C)).toBe(true);
    expect(CITE_RULE_VARIANTS.C).not.toContain(NO_ANSWER_REPLY);
    expect(CITE_RULE_VARIANTS.C).not.toMatch(/contesta exactamente/i);
  });

  it('D is B plus the partial-answer example', () => {
    expect(CITE_RULE_VARIANTS.D).toContain('"Los testimonios cuentan X [1]; no mencionan Y."');
    expect(CITE_RULE_VARIANTS.B).not.toContain('Los testimonios cuentan');
  });

  it('unset, blank or unknown means A; case and spaces are ignored', () => {
    expect(parseCiteVariant(undefined)).toBe('A');
    expect(parseCiteVariant('')).toBe('A');
    expect(parseCiteVariant('Z')).toBe('A');
    expect(parseCiteVariant('BB')).toBe('A');
    expect(parseCiteVariant(' c ')).toBe('C');
    expect(parseCiteVariant('d')).toBe('D');
  });
});

describe('CHAT_ENGINE_CONFIG.systemPrompt reads CHAT_CITE_VARIANT per request', () => {
  const saved = process.env.CHAT_CITE_VARIANT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_CITE_VARIANT;
    else process.env.CHAT_CITE_VARIANT = saved;
    vi.restoreAllMocks();
  });

  it('unset is A', async () => {
    delete process.env.CHAT_CITE_VARIANT;
    const { CHAT_ENGINE_CONFIG } = await import('./config');
    expect(CHAT_ENGINE_CONFIG.systemPrompt).toBe(CHAT_SYSTEM_PROMPT);
  });

  it('an unknown value is A', async () => {
    process.env.CHAT_CITE_VARIANT = 'nope';
    const { CHAT_ENGINE_CONFIG } = await import('./config');
    expect(CHAT_ENGINE_CONFIG.systemPrompt).toBe(CHAT_SYSTEM_PROMPT);
  });

  it('changing the env between two reads changes the prompt, and logs each variant', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { CHAT_ENGINE_CONFIG } = await import('./config');
    process.env.CHAT_CITE_VARIANT = 'B';
    const first = CHAT_ENGINE_CONFIG.systemPrompt;
    process.env.CHAT_CITE_VARIANT = 'C';
    const second = CHAT_ENGINE_CONFIG.systemPrompt;
    expect(first).toBe(chatSystemPrompt('B'));
    expect(second).toBe(chatSystemPrompt('C'));
    expect(debug).toHaveBeenNthCalledWith(1, '[prompt] cite variant B');
    expect(debug).toHaveBeenNthCalledWith(2, '[prompt] cite variant C');
  });
});
