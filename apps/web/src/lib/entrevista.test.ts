import { describe, expect, it } from 'vitest';
import { entrevistaKey, readEntrevista, showsEntrevista, writeEntrevista } from './entrevista';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    s: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

describe('Hazme preguntas — per-conversation memory', () => {
  it('is off by default', () => {
    const { s } = memory();
    expect(readEntrevista(() => s, '7')).toBe(false);
    expect(readEntrevista(() => s, null)).toBe(false);
  });

  it('remembers on per conversation, and off removes the key', () => {
    const { s, m } = memory();
    writeEntrevista(() => s, '7', true);
    expect(readEntrevista(() => s, '7')).toBe(true);
    expect(readEntrevista(() => s, '8')).toBe(false);
    writeEntrevista(() => s, '7', false);
    expect(m.has(entrevistaKey('7'))).toBe(false);
  });

  it('a throwing or missing storage reads as off and never throws', () => {
    const boom = () => {
      throw new Error('denied');
    };
    const bad = { getItem: boom, setItem: boom, removeItem: boom };
    expect(readEntrevista(() => bad, '7')).toBe(false);
    expect(() => writeEntrevista(() => bad, '7', true)).not.toThrow();
    expect(readEntrevista(() => null, '7')).toBe(false);
    expect(() => writeEntrevista(boom, '7', true)).not.toThrow();
  });

  it('shows only on Generales with the ecosistema switch on', () => {
    expect(showsEntrevista('generales', true)).toBe(true);
    expect(showsEntrevista('generales', false)).toBe(false);
    expect(showsEntrevista('resonancias', true)).toBe(false);
  });
});
