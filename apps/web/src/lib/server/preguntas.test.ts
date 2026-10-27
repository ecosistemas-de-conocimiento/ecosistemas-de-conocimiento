import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { allowQuestions, generateQuestions, parseQuestions, questionsUserPrompt } from './preguntas';
import type { StudentOverview } from './estudiante';

const overview: StudentOverview = {
  perfil: { shareWithPeers: false, shareActivity: false },
  temas: ['semiosis', 'signo'],
  documentos: [{ id: 1, name: 'Mi ensayo', status: 'draft' }],
  companeros: [{ name: 'Beto', topics: ['semiosis'] }],
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

describe('allowQuestions', () => {
  it('10 per hour per user', () => {
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) expect(allowQuestions('u', t + i)).toBe(true);
    expect(allowQuestions('u', t + 11)).toBe(false);
    expect(allowQuestions('other', t)).toBe(true);
    expect(allowQuestions('u', t + 60 * 60 * 1000 + 20)).toBe(true);
  });
});
