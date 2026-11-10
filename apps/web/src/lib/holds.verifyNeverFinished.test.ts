import { describe, expect, it } from 'vitest';
import { mustEditToApprove, substantivelyEdited } from './holds';

/** Ola 4, carril F: mirrors `apps/backend/src/lib/holdReview.verifyNeverFinished.test.ts`. */
describe('a verify hold whose verification never finished', () => {
  const NEVER = 'La segunda revisión automática no pudo terminar (json-invalido). Todavía no se agregó a la búsqueda.';

  it('must be edited to be approved; other verify holds need not', () => {
    expect(mustEditToApprove('verify', NEVER)).toBe(true);
    expect(mustEditToApprove('verify', 'La verificación encontró 1 dato(s) personal(es).')).toBe(false);
    expect(mustEditToApprove('verify', null)).toBe(false);
    expect(mustEditToApprove('content', null)).toBe(true);
  });

  it('🔴 spacing, punctuation, case and invisible characters are not an edit', () => {
    const t = 'Vivo con Ana Ruiz.\nNos vimos.';
    expect(substantivelyEdited(`${t} `, t)).toBe(false);
    expect(substantivelyEdited(t.replace('\n', '\r\n  '), t)).toBe(false);
    expect(substantivelyEdited(t.replace('con', 'c​on'), t)).toBe(false);
    expect(substantivelyEdited(t.replace('Ruiz.', 'Ruiz!'), t)).toBe(false);
    expect(substantivelyEdited(t.toLowerCase(), t)).toBe(false);
    expect(substantivelyEdited(t.replace('Ana Ruiz', '[Persona A]'), t)).toBe(true);
  });
});
