import { afterEach, describe, expect, it, vi } from 'vitest';

// `./config` reads `$env/dynamic/private`; backing it with the live
// `process.env` lets a test change CHAT_CITE_VARIANT between two reads.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
  CHAT_SYSTEM_PROMPT,
  CHUNK_DATA_RULE,
  ORIENTATION_RULE,
  CITE_RULE,
  CITE_RULE_VARIANTS,
  CITE_VARIANTS,
  GENERAL_KNOWLEDGE_LEAD,
  NO_ANSWER_REPLY,
  PLAIN_LANGUAGE_RULE,
  answersFromGeneralKnowledge,
  chatSystemPrompt,
  parseCiteVariant,
  DEFAULT_CITE_VARIANT,
} from './prompt';
// Static, not `await import` inside a test: loading `./config` pulls the engine
// and timed out under full-suite load (5 s default); here it loads once at
// collection, outside any test's timeout.
import { CHAT_ENGINE_CONFIG, chatCiteVariant } from './config';

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
  });

  it('the default is E; CHAT_SYSTEM_PROMPT stays A for the eval harness', () => {
    expect(DEFAULT_CITE_VARIANT).toBe('E');
    expect(chatSystemPrompt()).toBe(chatSystemPrompt('E'));
    expect(chatSystemPrompt()).not.toBe(CHAT_SYSTEM_PROMPT);
  });

  it.each(CITE_VARIANTS)('variant %s builds a full prompt with its own rule', (v) => {
    const p = chatSystemPrompt(v);
    expect(p).toContain(CITE_RULE_VARIANTS[v]);
    expect(p).toContain(PLAIN_LANGUAGE_RULE);
    expect(p).toContain(CHUNK_DATA_RULE);
    // 🔴 Earlier conversations are background, never cited (ruling 2026-10-21, #4 A).
    expect(p).toContain(ORIENTATION_RULE);
    expect(CITE_RULE_VARIANTS[v]).not.toMatch(/fragmento|contexto|recuperad/i);
  });

  it('the orientation rule names the block, forbids citing it, and uses no banned word', () => {
    expect(ORIENTATION_RULE).toContain('Conversaciones anteriores');
    expect(ORIENTATION_RULE).toContain('nunca lo cites con [N]');
    expect(ORIENTATION_RULE).toContain('No repitas ni cites lo que preguntaron o dijeron otras personas');
    expect(ORIENTATION_RULE).not.toMatch(/fragmento|contexto|recuperad/i);
  });

  it('the five variants differ from one another', () => {
    expect(new Set(CITE_VARIANTS.map((v) => chatSystemPrompt(v))).size).toBe(5);
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

  it('unset or blank means E, silently; case and spaces are ignored; A–D stay selectable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseCiteVariant(undefined)).toBe('E');
    expect(parseCiteVariant('')).toBe('E');
    expect(parseCiteVariant('  ')).toBe('E');
    expect(parseCiteVariant('a')).toBe('A');
    expect(parseCiteVariant('B\n')).toBe('B');
    expect(parseCiteVariant(' c ')).toBe('C');
    expect(parseCiteVariant('d')).toBe('D');
    expect(parseCiteVariant(' e')).toBe('E');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('🔴 an unknown value falls back to E and warns once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseCiteVariant('Z')).toBe('E');
    expect(parseCiteVariant('z')).toBe('E');
    expect(parseCiteVariant('"E"')).toBe('E');
    expect(parseCiteVariant('BB')).toBe('E');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[prompt\] unknown CHAT_CITE_VARIANT "Z"; using E/);
    warn.mockRestore();
  });
});

// Owner ruling 2026-10-21: "we can still have answers, either from the docs,
// the corpus, or the training weights".
describe('variant E — documents first, then general knowledge, marked', () => {
  const E = CITE_RULE_VARIANTS.E;
  const ALL_SENTENCE = 'Si el contexto no alcanza para responder algo, dilo explícitamente.';

  it('keeps A\'s over-citation guard word for word', () => {
    expect(E.startsWith(CITE_RULE.slice(0, CITE_RULE.indexOf(' Responde con lo que dicen')))).toBe(true);
    expect(E).toContain('Regla firme: como máximo un grupo de números por frase');
  });

  it('answers from the passages first and never opens with what is missing', () => {
    expect(E).toContain('Responde primero con lo que dicen los pasajes');
    expect(E).toContain('nunca abras diciendo lo que falta');
  });

  it('completes from general knowledge in a part that starts with the lead and has no [N]', () => {
    expect(GENERAL_KNOWLEDGE_LEAD).toBe('Fuera de los documentos:');
    expect(E).toContain(`que empiece exactamente con "${GENERAL_KNOWLEDGE_LEAD}"`);
    expect(E).toContain('Ese párrafo no lleva números entre corchetes');
    expect(E).toContain('Si ningún pasaje tiene relación con la pregunta, responde solo con ese párrafo');
  });

  it('🔴 has no no-answer reply: an off-topic question gets an answer', () => {
    expect(chatSystemPrompt('E')).not.toContain(NO_ANSWER_REPLY);
    expect(E).not.toMatch(/contesta exactamente/i);
  });

  it('swaps the "dilo explícitamente" instruction only under E; A–D keep it', () => {
    expect(chatSystemPrompt('E')).not.toContain(ALL_SENTENCE);
    expect(chatSystemPrompt('E')).toContain('complétalo con tu conocimiento general');
    for (const v of ['A', 'B', 'C', 'D'] as const) expect(chatSystemPrompt(v)).toContain(ALL_SENTENCE);
  });

  it('keeps the orientation block uncited', () => {
    expect(chatSystemPrompt('E')).toContain(ORIENTATION_RULE);
  });

  it('only E answers from general knowledge', () => {
    expect(CITE_VARIANTS.filter(answersFromGeneralKnowledge)).toEqual(['E']);
  });
});

describe('CHAT_ENGINE_CONFIG.systemPrompt reads CHAT_CITE_VARIANT per request', () => {
  const saved = process.env.CHAT_CITE_VARIANT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_CITE_VARIANT;
    else process.env.CHAT_CITE_VARIANT = saved;
    vi.restoreAllMocks();
  });

  it('unset is E', () => {
    delete process.env.CHAT_CITE_VARIANT;
    expect(CHAT_ENGINE_CONFIG.systemPrompt).toBe(chatSystemPrompt('E'));
  });

  it('an unknown value is E, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CHAT_CITE_VARIANT = 'nope';
    expect(CHAT_ENGINE_CONFIG.systemPrompt).toBe(chatSystemPrompt('E'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown CHAT_CITE_VARIANT "nope"'));
  });

  it('changing the env between two reads changes the prompt, and logs each variant', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    process.env.CHAT_CITE_VARIANT = 'B';
    const first = CHAT_ENGINE_CONFIG.systemPrompt;
    process.env.CHAT_CITE_VARIANT = 'C';
    const second = CHAT_ENGINE_CONFIG.systemPrompt;
    expect(first).toBe(chatSystemPrompt('B'));
    expect(second).toBe(chatSystemPrompt('C'));
    expect(debug).toHaveBeenNthCalledWith(1, '[prompt] cite variant B');
    expect(debug).toHaveBeenNthCalledWith(2, '[prompt] cite variant C');
  });

  it('🔴 logs the active variant at info level on first use and on each change, not every turn', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.env.CHAT_CITE_VARIANT = 'D';
    chatCiteVariant();
    chatCiteVariant();
    process.env.CHAT_CITE_VARIANT = 'a';
    chatCiteVariant();
    chatCiteVariant();
    expect(info.mock.calls).toEqual([['[prompt] cite variant D'], ['[prompt] cite variant A']]);
  });
});
