import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
  CHUNK_DATA_RULE,
  NO_ANSWER_REPLY,
  ORIENTATION_RULE,
  PLAIN_LANGUAGE_RULE,
  RESONANCIAS_CONTEXT_PREAMBLE,
  chatSystemPrompt,
  resonanciasSystemPrompt,
} from './prompt';
import { CHAT_ENGINE_CONFIG, chatEngineConfigFor } from './config';

describe('resonanciasSystemPrompt', () => {
  const p = resonanciasSystemPrompt();

  it('is an interviewer: acknowledge in their words, then one open question', () => {
    expect(p).toContain('con sus propias palabras');
    expect(p).toContain('una sola pregunta abierta');
    expect(p).toContain('Nunca hagas dos preguntas a la vez');
  });

  it('anchors the question in one corpus concept, named and cited, or asks plainly', () => {
    expect(p).toContain('concepto, una práctica o una metodología');
    expect(p).toContain('pregunta cómo se relaciona con su experiencia');
    expect(p).toContain('trabajo colectivo [2]');
    expect(p).toContain('Usa un solo concepto por respuesta');
    expect(p).toContain('sin citar');
  });

  it('🔴 never asks for names, exact addresses or identifying data, and does not talk about privacy', () => {
    expect(p).toContain('Nunca pidas nombres');
    expect(p).toContain('direcciones exactas');
    expect(p).toContain('teléfonos');
    expect(p).toContain('No hables de privacidad');
  });

  it('🔴 never attributes corpus content to the person, and invents nothing', () => {
    expect(p).toContain('nunca le atribuyas a esta persona algo que no dijo ella');
    expect(p).toContain('No inventes detalles');
  });

  it('never answers with what the documents lack', () => {
    expect(p).toContain('nunca digas lo que los documentos no mencionan');
    expect(p).not.toContain(NO_ANSWER_REPLY);
  });

  it('answers a direct question briefly, cited, then back to the story', () => {
    expect(p).toContain('Si la persona pregunta algo directamente');
    expect(p).toContain('entre corchetes al final de la frase');
    expect(p).toContain('Después vuelve a su historia con una pregunta');
  });

  it('keeps the data, orientation and plain-language rules', () => {
    expect(p).toContain(CHUNK_DATA_RULE);
    expect(p).toContain(ORIENTATION_RULE);
    expect(p).toContain(PLAIN_LANGUAGE_RULE);
  });

  // 🔴 Audit 2026-10-26: ORIENTATION_RULE says "no cites lo que dijeron otras
  // personas", and the anchor sentence is "Otras personas hablan de … [N]".
  it('🔴 squares the orientation rule with the cited concept: documents yes, earlier conversations never', () => {
    const at = p.indexOf(ORIENTATION_RULE);
    const exception = p.slice(at + ORIENTATION_RULE.length);
    expect(exception).toMatch(/^ La única excepción: puedes nombrar un concepto.*de los documentos con su número \[N\]/);
    expect(exception).toContain('"Conversaciones anteriores" nunca se nombra ni se cita');
  });

  it('the Generales prompt does not carry the Resonancias exception', () => {
    expect(chatSystemPrompt('E')).not.toContain('La única excepción');
    expect(chatSystemPrompt('A')).not.toContain('La única excepción');
  });

  it('short, no headers or lists, tú/usted mirrored, Spanish', () => {
    expect(p).toContain('sin encabezados ni listas');
    expect(p).toContain('tú o usted');
    expect(p).toContain('español');
  });

  it('differs from the answer prompt', () => {
    expect(p).not.toBe(chatSystemPrompt());
  });
});

describe('chatEngineConfigFor', () => {
  it('generales is the shared config, variant E prompt unchanged', () => {
    delete process.env.CHAT_CITE_VARIANT;
    expect(chatEngineConfigFor('generales')).toBe(CHAT_ENGINE_CONFIG);
    expect(chatEngineConfigFor('generales').systemPrompt).toBe(chatSystemPrompt('E'));
  });

  it('resonancias swaps the system prompt and the context preamble only', () => {
    const c = chatEngineConfigFor('resonancias');
    expect(c.systemPrompt).toBe(resonanciasSystemPrompt());
    expect(c.userContextPreamble).toBe(RESONANCIAS_CONTEXT_PREAMBLE);
    expect(c.blockHeaders).toEqual(CHAT_ENGINE_CONFIG.blockHeaders);
    expect(c.surface).toBe(CHAT_ENGINE_CONFIG.surface);
  });

  // 🔴 Audit 2026-10-26: the interview preamble dropped the engine's no-invention rules.
  it('🔴 the Resonancias preamble keeps the no-invented-facts rules', () => {
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain('Never invent, assume, estimate or extrapolate');
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain('Give a number only if that number is written below');
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain('Never attribute');
  });

  it('the Resonancias preamble answers a direct question briefly with [N], then back to the story', () => {
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain(
      'If the person asks a direct question, answer it briefly from the context with [N], then return to their story with one question.',
    );
  });

  it('🔴 the Resonancias preamble keeps both slots the engine fills', () => {
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain('{context}');
    expect(RESONANCIAS_CONTEXT_PREAMBLE).toContain('{message}');
  });
});
