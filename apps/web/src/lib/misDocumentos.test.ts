import { describe, expect, it } from 'vitest';
import { fileTile, isInFlight, kindTile, publishLabel, statusPills, uploadFormats, uploadSteps } from './misDocumentos';

const base = {
  id: '7',
  kind: 'pdf' as const,
  isNote: false,
  ingestStatus: 'ready' as const,
  ingestError: null,
  anonymisationStatus: 'n/a' as const,
  audioMeta: null,
  publicationStatus: 'draft' as const,
  graphStatus: 'ready' as const,
  subtitle: null,
};

describe('kindTile', () => {
  it('names a note, an audio, a Voz and a file by its kind', () => {
    expect(kindTile({ ...base, isNote: true, kind: 'markdown' }).label).toBe('Nota');
    expect(kindTile({ ...base, kind: 'audio' }).label).toBe('Audio');
    expect(kindTile({ ...base, subtitle: '12 oct' }).label).toBe('Voz');
    expect(kindTile({ ...base, kind: 'xlsx' }).label).toBe('XLSX');
    expect(kindTile({ ...base, kind: 'markdown' }).label).toBe('MD');
  });
});

describe('statusPills', () => {
  const labels = (d: Parameters<typeof statusPills>[0]) => statusPills(d).map((p) => p.label);

  it('a finished draft shows only who can see it', () => {
    expect(labels(base)).toEqual(['Borrador · solo tú']);
  });

  it('a running pipeline shows first, capitalised', () => {
    expect(labels({ ...base, ingestStatus: 'pending' })).toEqual(['En cola', 'Borrador · solo tú']);
    expect(statusPills({ ...base, ingestStatus: 'embedding' })[0]).toMatchObject({ tone: 'progress', busy: true });
  });

  it('a held document says En revisión', () => {
    expect(statusPills({ ...base, anonymisationStatus: 'held', ingestStatus: 'failed' })[0]).toMatchObject({
      label: 'En revisión',
      tone: 'held',
    });
  });

  it('a failed run names the failure, not the raw code', () => {
    const [first] = statusPills({ ...base, ingestStatus: 'failed', ingestError: 'empty_file: nothing' });
    expect(first?.tone).toBe('error');
    expect(first?.label).not.toContain('empty_file');
  });

  it('published and failed publication have their tones', () => {
    expect(statusPills({ ...base, publicationStatus: 'published' })[0]).toMatchObject({ label: 'Publicado', tone: 'shared' });
    expect(statusPills({ ...base, publicationStatus: 'failed' })[0]?.tone).toBe('error');
    expect(statusPills({ ...base, publicationStatus: 'publishing' })[0]?.busy).toBe(true);
    expect(statusPills({ ...base, publicationStatus: 'published', changesPending: true })[0]).toMatchObject({ label: 'Publicado', busy: true });
  });

  it('Conexiones shows only while preparing or unfinished, with its e2e testid', () => {
    expect(labels({ ...base, graphStatus: 'skipped' })).toHaveLength(1);
    const graph = statusPills({ ...base, graphStatus: 'failed' })[1];
    expect(graph?.testid).toBe('graph-status-7');
  });
});

describe('publishLabel', () => {
  it('words the three states', () => {
    expect(publishLabel('draft')).toBe('Publicar');
    expect(publishLabel('failed')).toBe('Reintentar publicación');
    expect(publishLabel('published')).toBe('Publicar cambios');
  });
});

describe('isInFlight', () => {
  it('is true while anything runs, false when everything settled', () => {
    expect(isInFlight(base)).toBe(false);
    expect(isInFlight({ ...base, ingestStatus: 'transcribing' })).toBe(true);
    expect(isInFlight({ ...base, publicationStatus: 'publishing' })).toBe(true);
    expect(isInFlight({ ...base, graphStatus: 'pending' })).toBe(true);
  });
});

describe('upload flow', () => {
  it('the options step exists only for someone with a choice', () => {
    expect(uploadSteps(true)).toEqual(['archivo', 'opciones', 'listo']);
    expect(uploadSteps(false)).toEqual(['archivo', 'listo']);
  });
  it('offers audio only when it is switched on', () => {
    expect(uploadFormats(false)).not.toContain('Audio');
    expect(uploadFormats(true)).toContain('Audio');
  });
  it('tiles a chosen file by its extension', () => {
    expect(fileTile('informe.docx', false)).toBe('DOCX');
    expect(fileTile('pagina.htm', false)).toBe('HTML');
    expect(fileTile('junta.m4a', true)).toBe('Audio');
    expect(fileTile('sin-extension', false)).toBe('Archivo');
  });
});
