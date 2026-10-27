import { describe, expect, it } from 'vitest';

import {
  SESSION_KINDS,
  SESSION_KIND_LABELS,
  SESSION_KIND_TAB_KEY,
  parseSessionKind,
  readSessionKindTab,
  sessionsOfKind,
  writeSessionKindTab,
} from './sessionKind';

describe('parseSessionKind', () => {
  it('resonancias is resonancias; anything else is generales', () => {
    expect(parseSessionKind('resonancias')).toBe('resonancias');
    for (const raw of ['generales', undefined, null, '', 'Resonancias', 'otra', 3]) {
      expect(parseSessionKind(raw)).toBe('generales');
    }
  });
});

describe('the tabs', () => {
  it('Generales first, then Resonancias, labels only', () => {
    expect(SESSION_KINDS).toEqual(['generales', 'resonancias']);
    expect(SESSION_KINDS.map((k) => SESSION_KIND_LABELS[k])).toEqual(['Generales', 'Resonancias']);
  });
});

describe('sessionsOfKind', () => {
  const list = [
    { id: 'a', kind: 'resonancias' as const },
    { id: 'b' },
    { id: 'c', kind: 'generales' as const },
    { id: 'd', kind: 'resonancias' as const },
  ];

  it('splits the list, keeping order; a row with no kind is Generales', () => {
    expect(sessionsOfKind(list, 'generales').map((s) => s.id)).toEqual(['b', 'c']);
    expect(sessionsOfKind(list, 'resonancias').map((s) => s.id)).toEqual(['a', 'd']);
  });
});

describe('the remembered tab', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('round-trips through storage', () => {
    const s = memory();
    writeSessionKindTab(() => s, 'resonancias');
    expect(s.getItem(SESSION_KIND_TAB_KEY)).toBe('resonancias');
    expect(readSessionKindTab(() => s)).toBe('resonancias');
  });

  it('no storage, a throwing one, or junk all read as Generales', () => {
    expect(readSessionKindTab(() => null)).toBe('generales');
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSessionKindTab(() => throwing)).toBe('generales');
    expect(() => writeSessionKindTab(() => throwing, 'resonancias')).not.toThrow();
    const s = memory();
    s.setItem(SESSION_KIND_TAB_KEY, 'x');
    expect(readSessionKindTab(() => s)).toBe('generales');
  });
});
