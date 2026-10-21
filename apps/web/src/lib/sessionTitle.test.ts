import { describe, expect, it } from 'vitest';
import { AUTO_TITLE_MAX, autoTitle, cleanTitle } from './sessionTitle';

describe('autoTitle', () => {
  it('keeps a short message as it is', () => {
    expect(autoTitle('  ¿Qué es la partería?  ')).toBe('¿Qué es la partería?');
  });

  it('cuts a long message at a word boundary and adds "…"', () => {
    const t = autoTitle('¿Qué barreras enfrentan las personas con discapacidad en los hospitales?');
    expect(t).toBe('¿Qué barreras enfrentan las personas con…');
    expect(t.length).toBeLessThanOrEqual(AUTO_TITLE_MAX);
  });

  it('cuts one very long word anyway, still within the limit', () => {
    const t = autoTitle('a'.repeat(100));
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBe(AUTO_TITLE_MAX);
  });
});

describe('cleanTitle', () => {
  it('trims and collapses spaces; empty means keep the old title', () => {
    expect(cleanTitle('  Mi   tema ')).toBe('Mi tema');
    expect(cleanTitle('   ')).toBeNull();
  });
});
