import { describe, expect, it } from 'vitest';

import { holdSummary, NOT_ADDED, plainReason } from './holdSummary';

// The exact reason a row held on dev carried (2026-10-21, screenshot 80).
const OLD_VERIFY_REASON =
  'La verificación encontró 4 dato(s) personal(es) que siguen en el texto, así que no se ingirió nada. Revisa el documento original.';

describe('holdSummary — one number on the screen', () => {
  it('uses the badge count, not the number inside an old stored reason', () => {
    const s = holdSummary({ stage: 'verify', reason: OLD_VERIFY_REASON, survivorCount: 7 });
    expect(s.why).toContain('7 datos');
    expect(`${s.why} ${s.detail}`).not.toContain('4');
    expect(s.detail).toBe(NOT_ADDED);
  });

  it('agrees in number for one dato', () => {
    const s = holdSummary({ stage: 'verify', reason: null, survivorCount: 1 });
    expect(s.why).toBe(
      'La revisión automática lo detuvo: quedó 1 dato que podría identificar a alguien.',
    );
  });

  it('never shows jargon or "(s)" plurals', () => {
    for (const count of [0, 1, 7]) {
      const s = holdSummary({ stage: 'verify', reason: OLD_VERIFY_REASON, survivorCount: count });
      const shown = `${s.why} ${s.detail}`;
      expect(shown).not.toMatch(/ingiri|ingerir|\(s\)|\(es\)|documento original/);
    }
  });
});

describe('holdSummary — holds with no highlights keep the gate reason, in plain words', () => {
  it('rewrites the old content-stage reason', () => {
    const s = holdSummary({
      stage: 'content',
      reason: 'No se pudo revisar el contenido con el modelo (transporte), así que no se ingirió nada.',
      survivorCount: 0,
    });
    expect(s.why).toBe('La revisión automática lo detuvo.');
    expect(s.detail).toBe(`No se pudo revisar el contenido con el modelo (transporte). ${NOT_ADDED}`);
  });

  it('falls back to the plain sentence when there is no reason', () => {
    expect(holdSummary({ stage: null, reason: null, survivorCount: 0 }).detail).toBe(NOT_ADDED);
  });

  it('leaves a reason already in plain words alone', () => {
    const plain = `Quedaron 3 datos que podrían identificar a alguien. ${NOT_ADDED}`;
    expect(plainReason(plain)).toBe(plain);
  });

  it('rewrites the old structural reason', () => {
    expect(
      plainReason(
        'El texto quedó vacío después de la limpieza estructural, así que no hay nada que ingerir. Revisa la extracción del documento.',
      ),
    ).not.toMatch(/ingerir/);
  });

  it('writes every stage as a whole sentence', () => {
    for (const stage of ['structural', 'deterministic', 'content', 'verify', null, 'otro']) {
      const { why } = holdSummary({ stage, reason: null, survivorCount: 0 });
      expect(why).not.toMatch(/archivo lo detuvo|reglas .* lo detuvo/);
      expect(why).toMatch(/\.$/);
    }
    expect(holdSummary({ stage: 'structural', reason: null, survivorCount: 0 }).why).toBe(
      'No se pudo leer el texto del archivo.',
    );
  });
});
