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

  const mine = (contentKind: string) => ({ contentKind, uploadedBy: '7' });

  it('the participant\'s own testimonio attached to the conversation starts an interview', () => {
    expect(chatTurnMode({ userMessage: 'Hola', callerId: '7', sessionDocs: [mine('testimonio')] })).toBe('interview');
    expect(chatTurnMode({ userMessage: 'Hola', callerId: '7', sessionDocs: [mine('conversacion')] })).toBe('interview');
  });

  // 🔴 Audit 2026-10-26: staff attaching someone else's testimonio met the interviewer.
  it('🔴 someone else\'s testimonio attached does not', () => {
    const theirs = { contentKind: 'testimonio', uploadedBy: '9' };
    expect(chatTurnMode({ userMessage: 'Hola', callerId: '7', sessionDocs: [theirs] })).toBe('answer');
  });

  it('🔴 a testimonio whose uploader is hidden (a colleague\'s) or an unknown caller does not', () => {
    expect(chatTurnMode({ userMessage: 'Hola', callerId: '7', sessionDocs: [{ contentKind: 'testimonio' }] })).toBe('answer');
    expect(chatTurnMode({ userMessage: 'Hola', sessionDocs: [mine('testimonio')] })).toBe('answer');
  });

  it('an attached plain documento does not', () => {
    expect(chatTurnMode({ userMessage: 'Hola', callerId: '7', sessionDocs: [mine('documento')] })).toBe('answer');
  });

  it('🔴 a request about the attached testimonio is still answered', () => {
    expect(
      chatTurnMode({ userMessage: 'Resume el testimonio', callerId: '7', sessionDocs: [mine('testimonio')] }),
    ).toBe('answer');
  });

  // 🔴 Audit 2026-10-26: analysis asks were read as stories.
  it.each([
    'Analiza los testimonios sobre la escuela',
    'Identifica los temas principales',
    'Genera una tabla con los hallazgos',
    'Necesito un resumen de los documentos',
    'Me puedes decir los temas del testimonio',
    'Compara las dos entrevistas',
    'Resume lo que contamos en el taller',
    'Explica nuestras conclusiones',
    'Enumera los problemas que tenemos en la comunidad',
    'Por favor, analiza lo que dije en mi testimonio',
    'Del testimonio, identifica lo que me contaron',
    'Podrías revisar mis notas de campo',
  ])('🔴 %s → answer, even with my testimonio attached and a story before', (m) => {
    const history = [user('Yo trabajé diez años en la cooperativa de café'), bot('¿Dónde estaba?')];
    expect(chatTurnMode({ userMessage: m, history, callerId: '7', sessionDocs: [mine('testimonio')] })).toBe('answer');
  });

  it('🔴 the interview does not stick once the assistant answered instead of asking', () => {
    const history = [
      user('Yo soy investigadora del CIDE y trabajo con cooperativas'),
      bot('Los documentos describen tres cooperativas [1].'),
    ];
    expect(chatTurnMode({ userMessage: 'Ok, gracias', history })).toBe('answer');
  });

  it('🔴 an analysis request breaks the chain for later short turns', () => {
    const history = [
      user('Yo trabajé diez años en la cooperativa de café'),
      bot('¿Dónde estaba?'),
      user('Analiza los testimonios de la sierra'),
      bot('Los testimonios cuentan… [1]. ¿Quieres más detalle?'),
    ];
    expect(chatTurnMode({ userMessage: 'Sí', history })).toBe('answer');
  });

  it('a first-person story is an interview even without an attachment', () => {
    expect(chatTurnMode({ userMessage: 'Yo crecí en la sierra y mi familia vivía del café', callerId: '7' })).toBe('interview');
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
    expect(chatEngineConfigFor('generales', 'answer')).toBe(CHAT_ENGINE_CONFIG);
    expect(chatEngineConfigFor('generales', 'answer').systemPrompt).toBe(chatSystemPrompt('E'));
  });

  it('interview swaps the system prompt and the context preamble only', () => {
    const c = chatEngineConfigFor('generales', 'interview');
    expect(c.systemPrompt).toBe(interviewSystemPrompt());
    expect(c.userContextPreamble).toBe(INTERVIEW_CONTEXT_PREAMBLE);
    expect(c.blockHeaders).toEqual(CHAT_ENGINE_CONFIG.blockHeaders);
    expect(c.surface).toBe(CHAT_ENGINE_CONFIG.surface);
  });

  // 🔴 Audit 2026-10-26: the interview preamble dropped the engine's no-invention rules.
  it('🔴 interview mode keeps the no-invented-facts rules', () => {
    for (const text of [INTERVIEW_CONTEXT_PREAMBLE]) {
      expect(text).toContain('Never invent, assume, estimate or extrapolate');
      expect(text).toContain('Give a number only if that number is written below');
    }
    expect(interviewSystemPrompt()).toContain('no inventes');
  });

  it('🔴 the interview preamble keeps both slots the engine fills', () => {
    expect(INTERVIEW_CONTEXT_PREAMBLE).toContain('{context}');
    expect(INTERVIEW_CONTEXT_PREAMBLE).toContain('{message}');
  });
});
