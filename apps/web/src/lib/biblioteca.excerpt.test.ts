/**
 * Testimonio label and excerpt (owner ruling 2026-10-23): "Testimonio · <tema
 * or ecosistema>" plus a short line from the REDACTED text.
 */
import { describe, expect, it } from 'vitest';

import {
  chatSourceTitle,
  excerptFrom,
  EXCERPT_MAX,
  isIntroLine,
  libraryTitleFor,
  parseSkipIntro,
  testimonyLabel,
  testimonyTopic,
} from './biblioteca';

describe('testimonyTopic / testimonyLabel', () => {
  it('prefers tema, mapped to its plain name', () => {
    expect(testimonyTopic('dengue', 'Discapacidad')).toBe('Prevención del dengue');
    expect(testimonyTopic('escuela', null)).toBe('Acompañamiento escolar');
  });
  it('shows an unknown tema as stored', () => {
    expect(testimonyTopic('agua', 'Eco')).toBe('agua');
  });
  it('falls back to the ecosistema name, then to nothing', () => {
    expect(testimonyTopic(null, ' Discapacidad ')).toBe('Discapacidad');
    expect(testimonyTopic('  ', '')).toBeNull();
  });
  it('labels "Testimonio · topic", or plain "Testimonio"', () => {
    expect(testimonyLabel('Discapacidad')).toBe('Testimonio · Discapacidad');
    expect(testimonyLabel(null)).toBe('Testimonio');
  });
  it('libraryTitleFor uses the topic on a testimonio only', () => {
    expect(libraryTitleFor('testimonio', 'Voz de Juana.m4a', 'Discapacidad')).toBe('Testimonio · Discapacidad');
    expect(libraryTitleFor('testimonio', 'Voz de Juana.m4a')).toBe('Testimonio');
    expect(libraryTitleFor('documento', 'Acta.pdf', 'Discapacidad')).toBe('Acta.pdf');
  });
});

describe('excerptFrom', () => {
  it('returns null for empty or non-string text', () => {
    expect(excerptFrom('')).toBeNull();
    expect(excerptFrom('   \n  ')).toBeNull();
    expect(excerptFrom(null)).toBeNull();
  });

  it('keeps a short first line whole, placeholders as they are', () => {
    const line = 'Me llamo [Persona A] y vivo en Cuautla desde hace mucho tiempo.';
    expect(excerptFrom(line)).toBe(line);
  });

  it(`cuts at a word boundary within ${EXCERPT_MAX} chars and ends with "…"`, () => {
    const long = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ');
    const out = excerptFrom(long)!;
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out.endsWith('…')).toBe(true);
    const body = out.slice(0, -1);
    expect(long.startsWith(body)).toBe(true);
    expect(long[body.length]).toBe(' ');
  });

  it('does not cut a line of exactly the limit', () => {
    const exact = `${'palabra '.repeat(14)}fin.`.padEnd(EXCERPT_MAX, 'x');
    expect(exact.length).toBe(EXCERPT_MAX);
    expect(excerptFrom(exact)).toBe(exact);
    expect(excerptFrom(`${exact} más`)!.endsWith('…')).toBe(true);
  });

  it('drops trailing punctuation before the "…"', () => {
    const text = `${'uno dos, '.repeat(20)}`;
    expect(excerptFrom(text)).toMatch(/[^,\s]…$/);
  });

  it('never leaves a placeholder half open at the cut', () => {
    // The last space before the limit is the one inside "[Persona A]".
    const text = `${'a'.repeat(102)} x [Persona A],palabra larga`;
    expect(excerptFrom(text)).toBe(`${'a'.repeat(102)} x…`);
  });

  it('hard-cuts one giant word', () => {
    const out = excerptFrom('x'.repeat(300))!;
    expect(out.length).toBe(EXCERPT_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('skips a capitals heading and a metadata line (seeded testimonio shape)', () => {
    const text = [
      'TESTIMONIO — [Persona A]',
      'Trabajadora social, 32 años · Villa de Ayala, Morelos · 21 de febrero de 2026',
      '',
      'Nací hace 32 años en Huautla de Jiménez, Oaxaca. Mi madre me enseñó el mazateco.',
    ].join('\n');
    expect(excerptFrom(text, { skipIntro: false })).toBe('Nací hace 32 años en Huautla de Jiménez, Oaxaca. Mi madre me enseñó el mazateco.');
  });

  it('skips the header block above a rule line, the interviewer question and the speaker label', () => {
    const text = [
      'TRANSCRIPCIÓN DE ENTREVISTA — BIOGRAFÍA DE VIDA',
      'Persona entrevistada: [Persona A] (39 años, acompañante de trámites)',
      'Nota: transcripción de audio; se conservan muletillas y marcas de oralidad.',
      '------------------------------------------------------------',
      '',
      'E: Le agradezco su tiempo. Cuénteme, ¿cómo llegó usted a este trabajo?',
      '',
      'P: Este..., nací hace 39 años en San Juan Atzingo, Estado de México.',
    ].join('\n');
    expect(excerptFrom(text, { skipIntro: false })).toBe('Este..., nací hace 39 años en San Juan Atzingo, Estado de México.');
  });

  it('skips a date line and a salutation (carta shape)', () => {
    const text =
      'Jiutepec, a 26 de marzo de 2026.\n\nA quien corresponda:\n\nMi nombre es [Persona A]. Me dirijo a usted con el propósito de compartir.';
    expect(excerptFrom(text)).toBe('Mi nombre es [Persona A]. Me dirijo a usted con el propósito de compartir.');
  });

  it('skips the field lines of a ficha and reaches the prose', () => {
    const text = [
      'FICHA DE PARTICIPANTE — ECOSISTEMAS DE CONOCIMIENTO',
      'Proyecto: IH-2025-I-445 · Fecha de registro: 14 de enero de 2026',
      '------------------------------------------------------------',
      'Nombre: [Persona A]',
      'Edad: 19 años',
      'Espacio principal de actividad: el Centro de Salud de [Lugar B]',
      '------------------------------------------------------------',
      'SEMBLANZA (en palabras de la persona participante):',
      'Empecé a acompañar a la gente casi sin darme cuenta, una vecina tras otra.',
    ].join('\n');
    expect(excerptFrom(text)).toBe('Empecé a acompañar a la gente casi sin darme cuenta, una vecina tras otra.');
  });

  it('strips markdown heading, quote, list and bold markers', () => {
    expect(
      excerptFrom('# Título\n\n> **Vecina:** lo que pasó en la colonia [Lugar B] fue que nadie llegó a tiempo'),
    ).toBe('lo que pasó en la colonia [Lugar B] fue que nadie llegó a tiempo');
    expect(excerptFrom('- uno dos tres cuatro cinco seis siete ocho')).toBe('uno dos tres cuatro cinco seis siete ocho');
  });

  it('falls back to the first non-empty line when nothing reads as prose', () => {
    expect(excerptFrom('---\n\nHola.\nAdiós.')).toBe('Hola.');
  });

  it('does not treat a placeholder as a speaker label', () => {
    const line = '[Persona A]: yo siempre fui al centro de salud con mi hija los martes';
    expect(excerptFrom(line)).toBe(line);
  });
});

describe('chatSourceTitle', () => {
  it('a testimonio reads "Testimonio · <ecosistema> — «excerpt»"', () => {
    expect(chatSourceTitle('Testimonio', { kind: 'testimonio', excerpt: 'nací en Cuautla…' }, 'Discapacidad')).toBe(
      'Testimonio · Discapacidad — «nací en Cuautla…»',
    );
  });
  it('without excerpt or ecosistema it degrades to the label', () => {
    expect(chatSourceTitle('Testimonio', { kind: 'testimonio' }, 'Discapacidad')).toBe('Testimonio · Discapacidad');
    expect(chatSourceTitle('Testimonio', { kind: 'testimonio' }, null)).toBe('Testimonio');
  });
  it('a documento keeps its title, excerpt or not', () => {
    expect(chatSourceTitle('Acta.pdf', { excerpt: 'x' }, 'Eco')).toBe('Acta.pdf');
    expect(chatSourceTitle(null, null, 'Eco')).toBeNull();
  });
  it('🔴 a documento TITLED "Testimonio" is not labelled as one', () => {
    expect(chatSourceTitle('Testimonio', { kind: 'documento', excerpt: 'x' }, 'Eco')).toBe('Testimonio');
    expect(chatSourceTitle('Testimonio', { excerpt: 'x' }, 'Eco')).toBe('Testimonio');
  });
});

describe('excerptFrom — skipIntro (BIBLIOTECA_EXCERPT_SKIP_INTRO)', () => {
  const intro = [
    'Soy de Chenalhó, Chiapas. Crecí hablando tsotsil; el español lo aprendí después.',
    'Nací hace 79 años en San Juan Mixtepec, Oaxaca, en una familia de campesinos.',
    'Mi pueblo es Hueyapan, Morelos. Ahí aprendí de mis abuelos el náhuatl y a escuchar.',
    'Hace 16 años que hago traducción en los servicios de salud de la región.',
    'Empecé a acompañar a la gente casi sin darme cuenta, una vecina tras otra.',
  ].join('\n\n');

  it('🔴 is off by default (owner ruling 2026-10-23, option A): the first prose line shows', () => {
    expect(excerptFrom(intro)).toMatch(/^Soy de Chenalhó/);
  });

  it('on: skips origin, language and age lines', () => {
    expect(excerptFrom(intro, { skipIntro: true })).toBe(
      'Empecé a acompañar a la gente casi sin darme cuenta, una vecina tras otra.',
    );
  });

  it('on, only headings and intro lines left: no excerpt', () => {
    expect(excerptFrom('Soy de Xoxocotla, Morelos.\nCrecí hablando náhuatl.', { skipIntro: true })).toBeNull();
    expect(
      excerptFrom('SEMBLANZA (en palabras de la persona):\n\nNací hace 25 años en Potoichán.', { skipIntro: true }),
    ).toBeNull();
  });

  it.each([
    ['Mi abuela hablaba mixe en la casa y en la milpa.', true],
    ['El otomí se hablaba en la plaza.', true],
    ['Me enseñó a curar con hierbas del monte, una por una.', false],
    ['Los mixes no vinieron.', false],
  ])('isIntroLine(%j) = %s', (line, expected) => {
    expect(isIntroLine(line)).toBe(expected);
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['no', false],
    ['true', true],
    ['1', true],
    [' ON ', true],
    ['yes', true],
  ])('parseSkipIntro(%j) = %s', (raw, expected) => {
    expect(parseSkipIntro(raw)).toBe(expected);
  });
});
