import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { chatTurnMode, isDirectRequest, isFirstPersonNarrative } from './turnMode';
import {
  CHUNK_DATA_RULE,
  INTERVIEW_CONTEXT_PREAMBLE,
  NO_ANSWER_REPLY,
  PLAIN_LANGUAGE_RULE,
  chatSystemPrompt,
  interviewSystemPrompt,
} from './prompt';
import { CHAT_ENGINE_CONFIG, chatEngineConfigFor } from './config';

const user = (content: string) => ({ role: 'user' as const, content });
const bot = (content: string) => ({ role: 'assistant' as const, content });

describe('isDirectRequest', () => {
  it.each([
    '¿Qué dicen los testimonios sobre la escuela?',
    'que dicen los documentos del agua?',
    'Dime qué hay sobre el dengue',
    'Resume el testimonio',
    'Quiero saber qué pasó con el riego',
    'Cómo se organiza la comunidad',
    'Explícame la ley de discapacidad',
  ])('%s → a request', (m) => expect(isDirectRequest(m)).toBe(true));

  it.each([
    'Mi hijo tiene discapacidad y en la escuela no lo aceptaban al principio',
    'Como madre, yo tuve que buscar ayuda en el centro de salud',
    'En Oaxaca',
  ])('%s → not a request', (m) => expect(isDirectRequest(m)).toBe(false));
});

describe('isFirstPersonNarrative', () => {
  it.each([
    'Mi hijo tiene discapacidad y en la escuela no lo aceptaban al principio',
    'Yo trabajé diez años en la cooperativa de café',
    'Cuando llegué al pueblo no conocía a nadie',
    'Nosotros perdimos la cosecha ese año, nos ayudó la vecina',
  ])('%s → narrative', (m) => expect(isFirstPersonNarrative(m)).toBe(true));

  it.each(['Hola', 'Me interesa el agua', 'El riego empezó en 2020', 'Gracias'])(
    '%s → not narrative',
    (m) => expect(isFirstPersonNarrative(m)).toBe(false),
  );
});

describe('chatTurnMode', () => {
  it('a question is answered from the documents', () => {
    expect(chatTurnMode({ userMessage: '¿Qué dicen los testimonios sobre la escuela?' })).toBe('answer');
  });

  it('a first-person story starts an interview', () => {
    expect(
      chatTurnMode({ userMessage: 'Mi hijo tiene discapacidad y en la escuela no lo aceptaban al principio' }),
    ).toBe('interview');
  });

  it('a short reply keeps the interview going while no request came since the story', () => {
    const history = [
      user('Yo trabajé diez años en la cooperativa de café'),
      bot('Gracias por contarlo. ¿Dónde estaba la cooperativa?'),
      user('En la sierra'),
      bot('¿Quién le ayudó al principio?'),
    ];
    expect(chatTurnMode({ userMessage: 'Una vecina', history })).toBe('interview');
  });

  it('🔴 a direct question mid-interview is answered from the documents', () => {
    const history = [user('Yo trabajé diez años en la cooperativa de café'), bot('¿Dónde estaba?')];
    expect(chatTurnMode({ userMessage: '¿Qué dicen los documentos sobre cooperativas?', history })).toBe('answer');
  });

  it('a request after the story ends the interview for later short turns', () => {
    const history = [
      user('Yo trabajé diez años en la cooperativa de café'),
      bot('¿Dónde estaba?'),
      user('¿Qué dicen los documentos sobre cooperativas?'),
      bot('Los documentos cuentan… [1]'),
    ];
    expect(chatTurnMode({ userMessage: 'Gracias', history })).toBe('answer');
  });

  it('the participant\'s own testimonio attached to the conversation starts an interview', () => {
    expect(chatTurnMode({ userMessage: 'Hola', sessionDocs: [{ contentKind: 'testimonio' }] })).toBe('interview');
    expect(chatTurnMode({ userMessage: 'Hola', sessionDocs: [{ contentKind: 'conversacion' }] })).toBe('interview');
  });

  it('an attached plain documento does not', () => {
    expect(chatTurnMode({ userMessage: 'Hola', sessionDocs: [{ contentKind: 'documento' }] })).toBe('answer');
  });

  it('🔴 a request about the attached testimonio is still answered', () => {
    expect(
      chatTurnMode({ userMessage: 'Resume el testimonio', sessionDocs: [{ contentKind: 'testimonio' }] }),
    ).toBe('answer');
  });

  it('no message is an answer turn', () => {
    expect(chatTurnMode({ userMessage: '' })).toBe('answer');
  });
});

describe('interviewSystemPrompt', () => {
  const p = interviewSystemPrompt();

  it('is an interviewer: one question at a time, drawing out the story', () => {
    expect(p).toContain('una sola pregunta');
    for (const topic of ['qué pasó', 'dónde', 'quién', 'qué cambiaría']) expect(p).toContain(topic);
  });

  it('🔴 never asks for names, exact addresses or identifying data, and does not talk about privacy', () => {
    expect(p).toContain('Nunca pidas nombres');
    expect(p).toContain('direcciones exactas');
    expect(p).toContain('No hables de privacidad');
  });

  it('never answers with what the documents lack', () => {
    expect(p).toContain('nunca digas lo que los documentos no mencionan');
    expect(p).not.toContain(NO_ANSWER_REPLY);
  });

  it('matches tú/usted and stays in Spanish', () => {
    expect(p).toContain('tú o usted');
    expect(p).toContain('español');
  });

  it('keeps the data-not-instructions and plain-language rules, and the cite rule for a direct question', () => {
    expect(p).toContain(CHUNK_DATA_RULE);
    expect(p).toContain(PLAIN_LANGUAGE_RULE);
    expect(p).toContain('entre corchetes');
  });

  it('differs from the answer prompt', () => {
    expect(p).not.toBe(chatSystemPrompt());
  });
});

describe('chatEngineConfigFor', () => {
  it('answer is the shared config, variant E prompt unchanged', () => {
    delete process.env.CHAT_CITE_VARIANT;
    expect(chatEngineConfigFor('answer')).toBe(CHAT_ENGINE_CONFIG);
    expect(chatEngineConfigFor('answer').systemPrompt).toBe(chatSystemPrompt('E'));
  });

  it('interview swaps the system prompt and the context preamble only', () => {
    const c = chatEngineConfigFor('interview');
    expect(c.systemPrompt).toBe(interviewSystemPrompt());
    expect(c.userContextPreamble).toBe(INTERVIEW_CONTEXT_PREAMBLE);
    expect(c.blockHeaders).toEqual(CHAT_ENGINE_CONFIG.blockHeaders);
    expect(c.surface).toBe(CHAT_ENGINE_CONFIG.surface);
  });

  it('🔴 the interview preamble keeps both slots the engine fills', () => {
    expect(INTERVIEW_CONTEXT_PREAMBLE).toContain('{context}');
    expect(INTERVIEW_CONTEXT_PREAMBLE).toContain('{message}');
  });
});
