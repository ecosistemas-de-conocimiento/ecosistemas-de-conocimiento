import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { allowQuestions, generateQuestions, parseQuestions, questionsUserPrompt } from './preguntas';
import type { StudentOverview } from './estudiante';

const overview: StudentOverview = {
  perfil: { shareWithPeers: false, shareActivity: false },
  temas: [
    { id: 1, label: 'semiosis' },
    { id: 2, label: 'signo' },
  ],
  documentos: [{ id: 1, name: 'Mi ensayo', status: 'draft', kind: 'documento' }],
  companeros: [{ id: 'slug', name: 'Beto', topics: [{ id: 1, label: 'semiosis' }] }],
  autores: [{ name: 'Peirce', docs: 2, page: null }],
  autoresParaLeer: [{ name: 'Umberto Eco', docs: 1, page: null }],
  temasDelEcosistema: ['abducción'],
};

describe('parseQuestions', () => {
  it('strips numbering, keeps 3–5 questions', () => {
    const text = '1. ¿Cómo se relaciona el signo con la abducción?\n- ¿Qué cambia en la semiosis si…?\n• ¿Por qué Eco lee a Peirce así?\nNota final\n¿Qué?';
    expect(parseQuestions(text)).toEqual([
      '¿Cómo se relaciona el signo con la abducción?',
      '¿Qué cambia en la semiosis si…?',
      '¿Por qué Eco lee a Peirce así?',
    ]);
  });
  it('fewer than 3 → none', () => {
    expect(parseQuestions('¿Una sola pregunta larga aquí?')).toEqual([]);
  });
});

describe('generateQuestions', () => {
  it('one call, labels and titles only — never peers', async () => {
    const generateSync = vi.fn().mockResolvedValue({
      text: '¿Pregunta número uno aquí?\n¿Pregunta número dos aquí?\n¿Pregunta número tres aquí?',
    });
    const out = await generateQuestions('8', '1', overview, { generateSync } as never);
    expect(out).toHaveLength(3);
    expect(generateSync).toHaveBeenCalledTimes(1);
    const body = generateSync.mock.calls[0]![0] as { unit: { input: { userPrompt: string }; systemPrompt: string } };
    expect(body.unit.input.userPrompt).toBe(questionsUserPrompt(overview));
    expect(body.unit.input.userPrompt).not.toContain('Beto');
    expect(body.unit.systemPrompt).toContain('preguntas abiertas');
  });
});

describe('🔴 questionsUserPrompt sends documentos only (audit 2026-10-28 item 9)', () => {
  const withTestimonios: StudentOverview = {
    ...overview,
    documentos: [
      { id: 1, name: 'Mi ensayo', status: 'draft', kind: 'documento' },
      // A testimonio's file name often carries the speaker's name.
      { id: 2, name: 'Entrevista Juana Pérez.m4a', status: 'draft', kind: 'testimonio' },
      // No kind (an older backend): fail closed, never sent.
      { id: 3, name: 'Grabación Doña Rosa', status: 'draft' },
    ],
  };

  it('a testimonio name never reaches the hosted model', () => {
    const prompt = questionsUserPrompt(withTestimonios);
    expect(prompt).toContain('Mis trabajos: Mi ensayo');
    expect(prompt).not.toContain('Juana');
    expect(prompt).not.toContain('Rosa');
  });

  it('only testimonios: the line says there are none', () => {
    const prompt = questionsUserPrompt({ ...withTestimonios, documentos: withTestimonios.documentos.slice(1) });
    expect(prompt).toContain('Mis trabajos: —');
  });
});

describe('allowQuestions', () => {
  it('10 per hour per user', () => {
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) expect(allowQuestions('u', t + i)).toBe(true);
    expect(allowQuestions('u', t + 11)).toBe(false);
    expect(allowQuestions('other', t)).toBe(true);
    expect(allowQuestions('u', t + 60 * 60 * 1000 + 20)).toBe(true);
  });
});
