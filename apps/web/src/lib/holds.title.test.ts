import { describe, expect, it } from 'vitest';

import { parseHeldSummary } from './holds';

describe('a held testimonio with a system-proposed title (owner ruling 2026-10-24)', () => {
  it('shows the generated title, with the neutral label kept for the secondary line', () => {
    const row = parseHeldSummary({
      id: 4,
      contentKind: 'testimonio',
      title: 'Vivir con la familia en el barrio',
      label: 'Testimonio retenido',
      generatedTitle: 'Vivir con la familia en el barrio',
      survivorCount: 1,
    });
    expect(row).toMatchObject({
      title: 'Vivir con la familia en el barrio',
      generatedTitle: 'Vivir con la familia en el barrio',
      label: 'Testimonio retenido',
    });
  });

  it('🔴 a generated title with a bracket (a placeholder) is dropped for the neutral one', () => {
    const row = parseHeldSummary({
      id: 4,
      contentKind: 'testimonio',
      title: '[Persona A] y la escuela',
      generatedTitle: '[Persona A] y la escuela',
    });
    expect(row).toMatchObject({ title: 'Testimonio retenido', generatedTitle: null, label: 'Testimonio retenido' });
  });

  it('no generated title: the title is the neutral one, unchanged', () => {
    expect(parseHeldSummary({ id: 4, contentKind: 'testimonio', title: 'Testimonio retenido' })).toMatchObject({
      title: 'Testimonio retenido',
      generatedTitle: null,
    });
  });
});
