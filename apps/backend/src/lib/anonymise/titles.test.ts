/**
 * Honorifics and role titles belong to the name they precede. Rodrigo's rule:
 * "Don Fernando Vázquez" becomes "[Persona F]", never "Don [Persona F]".
 */

import { describe, expect, it } from 'vitest'

import { DETECT_SYSTEM_PROMPT, parseFindings } from './detector'
import { absorbTitles, stripLeadingTitles } from './titles'

describe('absorbTitles — a title directly before a person placeholder joins it', () => {
  it.each([
    // start of text / sentence
    ['Don [Persona F] nos prestaba su camioneta.', '[Persona F] nos prestaba su camioneta.'],
    ['La maestra [Persona J] nos daba clases.', '[Persona J] nos daba clases.'],
    // after punctuation
    ['Llegó tarde. Doña [Persona B] ya estaba.', 'Llegó tarde. [Persona B] ya estaba.'],
    ['Pues, don [Persona A], ya ni modo.', 'Pues, [Persona A], ya ni modo.'],
    ['Dijo: «el profe [Persona C] no vino».', 'Dijo: «[Persona C] no vino».'],
    ['ENTREVISTADA: La maestra [Persona J] nos daba', 'ENTREVISTADA: [Persona J] nos daba'],
    // mid-sentence
    ['fuimos con la maestra [Persona C] a la junta', 'fuimos con [Persona C] a la junta'],
    ['nos atendió el doctor [Persona D] en la clínica', 'nos atendió [Persona D] en la clínica'],
    ['le pregunté al delegado [Persona E] por el permiso', 'le pregunté al [Persona E] por el permiso'],
    // case- and accent-tolerant, abbreviations, chained titles
    ['DOÑA [Persona A]', '[Persona A]'],
    ['dona [Persona A]', '[Persona A]'],
    ['la Senora [Persona A]', '[Persona A]'],
    ['la Sra. [Persona A]', '[Persona A]'],
    ['el Dr. [Persona A]', '[Persona A]'],
    ['la Lic. [Persona A]', '[Persona A]'],
    ['el ingeniero [Persona A]', '[Persona A]'],
    ['el señor licenciado [Persona A]', '[Persona A]'],
    ['el padre [Persona A] dio la misa', '[Persona A] dio la misa'],
    // a bare article left by a model span that took the title but not "El"
    // (measured 2026-10-17: "El [Persona E]" and "el [Persona L]" held verify)
    ['El [Persona E] nunca firmó', '[Persona E] nunca firmó'],
    ['Le decíamos el [Persona L] porque', 'Le decíamos [Persona L] porque'],
    // decomposed accents (NFD) as the roster pass leaves them
    ['Doña [Persona A]'.normalize('NFD'), '[Persona A]'],
  ])('%s', (input, expected) => {
    expect(absorbTitles(input)).toBe(expected)
  })

  it.each([
    // a title with no name after it is just a word
    'Llegó la maestra y nos dio clase.',
    'la maestra de la escuela nunca nos hizo caso',
    'Don ya no vino a la junta.',
    // "la maestra de Juana" is Juana's teacher, not Juana
    'la maestra de [Persona A] nos regañó',
    // inside another word
    'le pidió perdón [Persona A]',
    // kinship is content, not part of the name (see the detector prompt)
    'mi padre [Persona A] trabajaba en el campo',
    'mi hermana [Persona A] me acompañó',
    // only people: places keep their own wording
    'la tortillería de doña [Domicilio A]',
  ])('leaves alone: %s', (input) => {
    expect(absorbTitles(input)).toBe(input)
  })

  it('🔴 does not swallow a surname after the placeholder', () => {
    expect(absorbTitles('Don [Persona A] López llegó')).toBe('[Persona A] López llegó')
  })
})

describe('stripLeadingTitles — the name inside a titled span', () => {
  it.each([
    ['Don Fernando Vázquez', 'Fernando Vázquez'],
    ['la maestra Imelda', 'Imelda'],
    ['El doctor Pánfilo Esquivel', 'Pánfilo Esquivel'],
    ['Sra. López', 'López'],
    ['Fernando Vázquez', 'Fernando Vázquez'],
    // nothing but a title: keep it, so it still buckets as something
    ['Don', 'Don'],
  ])('%s → %s', (input, expected) => {
    expect(stripLeadingTitles(input)).toBe(expected)
  })
})

describe('the detector prompt', () => {
  it('asks for the title inside the person span', () => {
    expect(DETECT_SYSTEM_PROMPT).toContain('el hallazgo\n  es "Don Fernando Vázquez"')
    expect(DETECT_SYSTEM_PROMPT).toContain('"la maestra Imelda"')
  })
})

describe('parseFindings — a titled span in the wrong case', () => {
  // Measured 2026-10-17, 9,454 words: the model returned "la maestra Nicasia
  // Olvera" for "La maestra Nicasia Olvera". The exact-substring filter dropped
  // it and the name went through to verify. The bare name IS in the text.
  it("keeps the name when only the title's case differs", () => {
    const source = 'ENTREVISTADA: La maestra Nicasia Olvera nos daba clases.'
    const raw = '{"hallazgos":[{"texto":"la maestra Nicasia Olvera","tipo":"persona"}]}'
    expect(parseFindings(raw, source)).toEqual([{ text: 'Nicasia Olvera', type: 'persona' }])
  })

  it('still drops a finding whose name is not in the text', () => {
    const raw = '{"hallazgos":[{"texto":"la maestra Rosa","tipo":"persona"}]}'
    expect(parseFindings(raw, 'La maestra Nicasia llegó.')).toEqual([])
  })
})
