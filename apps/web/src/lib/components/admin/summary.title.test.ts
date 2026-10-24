import { describe, expect, it } from 'vitest';

import { DOC_FIELDS } from '$lib/server/admin';
import { parseDocRow } from './summary';

describe('admin DocumentsTable: testimonio titles (owner ruling 2026-10-24)', () => {
  it('reads contentKind, tema and testimonioTitle', () => {
    expect(DOC_FIELDS).toEqual(expect.arrayContaining(['contentKind', 'tema', 'testimonioTitle']));
  });

  it('a testimonio shows its generated title over "Testimonio · <tema>", not the filename', () => {
    const row = parseDocRow({
      id: 3,
      name: 'grabacion-0012.webm',
      contentKind: 'testimonio',
      tema: 'dengue',
      testimonioTitle: 'Limpiar los patios antes de la lluvia',
    });
    expect(row).toMatchObject({ title: 'Limpiar los patios antes de la lluvia', subtitle: 'Testimonio · Prevención del dengue' });
  });

  it('without a generated title: the label, no subtitle', () => {
    expect(parseDocRow({ id: 3, name: 'x.webm', contentKind: 'testimonio', tema: 'dengue' })).toMatchObject({
      title: 'Testimonio · Prevención del dengue',
      subtitle: null,
    });
  });

  it('a documento keeps its name', () => {
    expect(parseDocRow({ id: 4, name: 'Acta.pdf', contentKind: 'documento', testimonioTitle: 'x y z' })).toMatchObject({
      title: 'Acta.pdf',
      subtitle: null,
    });
  });
});
