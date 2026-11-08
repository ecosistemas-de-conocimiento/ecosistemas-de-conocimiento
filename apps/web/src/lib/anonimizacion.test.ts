import { describe, expect, it } from 'vitest';

import * as copy from './anonimizacion';
import {
  backHref,
  keptLists,
  mayOpenAnonimizacion,
  ORIGIN_LABELS,
  parseView,
  patchFromForm,
  saveErrorMessage,
  savedMessage,
  showTestimonyWarning,
  stageCountLabel,
  STATUS_LABELS,
  SWITCH_LABELS,
} from './anonimizacion';

const wire = {
  id: 7,
  name: 'Informe',
  contentKind: 'documento',
  gated: true,
  publicationStatus: 'published',
  status: 'ready',
  kept: { authors: ['Ana Pérez'], publicFigures: [], citedAuthors: ['Freire'] },
  counts: { stages: [{ stage: 'deterministic', removed: 3 }, { stage: 'content', removed: 2 }], pseudonyms: 4, addresses: null },
  switches: {
    keepDocumentAuthor: { value: true, origin: 'documento' },
    keepCitedAuthors: { value: false, origin: 'ecosistema' },
  },
};

const formOf = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('anonimización copy', () => {
  it('names every status in plain Spanish', () => {
    expect(STATUS_LABELS).toEqual({
      'n/a': 'No aplica',
      pending: 'Pendiente',
      held: 'Retenido',
      ready: 'Listo',
      approved: 'Aprobado',
      rejected: 'Rechazado',
    });
  });

  it('names the gate stages plainly; an unknown stage never prints the machine word', () => {
    expect(['structural', 'deterministic', 'content', 'verify'].map(stageCountLabel)).toEqual([
      'Estructura',
      'Reglas',
      'Modelo',
      'Verificación',
    ]);
    expect(stageCountLabel('una-etapa-nueva')).toBe('Otros');
  });

  it('labels the switches and their origin as the owner ruled', () => {
    expect(SWITCH_LABELS).toEqual({
      keepDocumentAuthor: 'Conservar al autor del documento',
      keepCitedAuthors: 'Conservar autores citados',
    });
    expect(ORIGIN_LABELS).toEqual({ ecosistema: 'Del ecosistema', documento: 'De este documento' });
  });

  it('plain language (ADR-0018): no machine words, no jargon, no explainer paragraphs', () => {
    const strings = Object.values(copy)
      .flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v) : []))
      .filter((v): v is string => typeof v === 'string');
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      expect(s).not.toMatch(/regate|gate|stage|pseud|seud|corpus|ingir|ingest|pipeline|structural|deterministic|n\/a/i);
      expect(s.length).toBeLessThanOrEqual(80); // one short line, never a paragraph
    }
  });

  it('says what a save did', () => {
    expect(savedMessage('started')).toMatch(/revisando de nuevo/);
    expect(savedMessage('not-needed')).toBe('Guardado.');
    expect(savedMessage('saved-only')).toBe('Guardado.');
    expect(saveErrorMessage(409)).toMatch(/procesando/);
    expect(saveErrorMessage(403)).toBe('No puedes cambiar esto.');
    expect(saveErrorMessage(500)).toBe('No se pudo guardar.');
  });
});

describe('parseView', () => {
  it('reads the contract', () => {
    const v = parseView(wire)!;
    expect(v.id).toBe('7');
    expect(v.status).toBe('ready');
    expect(v.switches.keepDocumentAuthor).toEqual({ value: true, origin: 'documento' });
    expect(v.counts).toEqual({ stages: wire.counts.stages, pseudonyms: 4, addresses: null });
  });

  it('🔴 drops any field it does not know — a removed-name list or a mapping never reaches the page', () => {
    const v = parseView({
      ...wire,
      removed: ['Juan López'],
      mapping: { 'Juan López': 'Persona 1' },
      counts: { ...wire.counts, names: ['Juan López'] },
      kept: { ...wire.kept, detected: ['Juan López'] },
    });
    expect(JSON.stringify(v)).not.toContain('Juan López');
  });

  it('pendingRegate: literally true only; missing or junk is false', () => {
    expect(parseView({ ...wire, pendingRegate: true })!.pendingRegate).toBe(true);
    expect(parseView({ ...wire, pendingRegate: false })!.pendingRegate).toBe(false);
    expect(parseView(wire)!.pendingRegate).toBe(false);
    expect(parseView({ ...wire, pendingRegate: 'true' })!.pendingRegate).toBe(false);
  });

  it('the pending line never says the names were removed', () => {
    expect(copy.PENDING_REGATE).toMatch(/siguen visibles/);
    expect(copy.PENDING_REGATE).not.toMatch(/quitad|borrad|eliminad|anonimizad/i);
  });

  it('junk reads safely: unknown status is "n/a", missing switches are the ecosistema\'s off', () => {
    expect(parseView(null)).toBeNull();
    expect(parseView([])).toBeNull();
    const v = parseView({ id: 1, status: 'weird', kept: null, counts: null, switches: null })!;
    expect(v.status).toBe('n/a');
    expect(v.counts).toBeNull();
    expect(v.switches.keepCitedAuthors).toEqual({ value: false, origin: 'ecosistema' });
  });

  it('shows only the non-empty kept lists, in a fixed order', () => {
    expect(keptLists(parseView(wire)!).map((l) => [l.label, l.names])).toEqual([
      ['Autor del documento', ['Ana Pérez']],
      ['Autores citados', ['Freire']],
    ]);
  });
});

describe('patchFromForm', () => {
  it('sends only the switch that moved, so the other is not pinned to the document', () => {
    expect(patchFromForm(formOf({ 'was-keepDocumentAuthor': 'off', keepDocumentAuthor: 'on', 'was-keepCitedAuthors': 'off' }))).toEqual({
      keepDocumentAuthor: true,
    });
    expect(patchFromForm(formOf({ 'was-keepDocumentAuthor': 'on', 'was-keepCitedAuthors': 'on', keepCitedAuthors: 'on' }))).toEqual({
      keepDocumentAuthor: false,
    });
    expect(patchFromForm(formOf({ 'was-keepDocumentAuthor': 'off', 'was-keepCitedAuthors': 'off' }))).toEqual({});
  });

  it('"Usar el del ecosistema" sends null for that one switch only', () => {
    expect(
      patchFromForm(formOf({ reset: 'keepCitedAuthors', keepDocumentAuthor: 'on', 'was-keepDocumentAuthor': 'off' })),
    ).toEqual({ keepCitedAuthors: null });
    expect(patchFromForm(formOf({ reset: 'keepPublicFigures', 'was-keepCitedAuthors': 'off' }))).toEqual({});
  });
});

describe('links', () => {
  it('goes back only to a page that links here', () => {
    expect(backHref('/revision')).toBe('/revision');
    expect(backHref('/revision/12')).toBe('/revision/12');
    expect(backHref('/biblioteca/12')).toBe('/biblioteca/12');
    expect(backHref('/documentos')).toBe('/documentos');
    for (const bad of [null, '', 'https://evil.test', '//evil.test', '/admin', '/revisionx', '/biblioteca', '/\\evil']) {
      expect(backHref(bad)).toBe('/documentos');
    }
  });

  it('shows the card link to the uploader, a platform admin, or a reviewer in that ecosistema only', () => {
    const none = { isPlatformAdmin: false, slugs: [], ok: true };
    expect(mayOpenAnonimizacion({ uploadedByCaller: true, holdsReview: null, slug: null })).toBe(true);
    expect(mayOpenAnonimizacion({ holdsReview: { ...none, isPlatformAdmin: true }, slug: null })).toBe(true);
    expect(mayOpenAnonimizacion({ holdsReview: { ...none, slugs: ['a'] }, slug: 'a' })).toBe(true);
    expect(mayOpenAnonimizacion({ holdsReview: { ...none, slugs: ['a'] }, slug: 'b' })).toBe(false);
    expect(mayOpenAnonimizacion({ holdsReview: none, slug: 'a' })).toBe(false);
    expect(mayOpenAnonimizacion({ holdsReview: { isPlatformAdmin: true, slugs: [], ok: false }, slug: 'a' })).toBe(false);
    expect(mayOpenAnonimizacion({ holdsReview: undefined, slug: 'a' })).toBe(false);
  });
});

describe('showTestimonyWarning', () => {
  it('only a testimonio with an effective "on" switch', () => {
    const base = parseView(wire)!;
    const sw = (a: boolean, c: boolean) => ({
      keepDocumentAuthor: { value: a, origin: 'ecosistema' as const },
      keepCitedAuthors: { value: c, origin: 'documento' as const },
    });
    expect(showTestimonyWarning({ ...base, contentKind: 'testimonio', switches: sw(true, false) })).toBe(true);
    expect(showTestimonyWarning({ ...base, contentKind: 'testimonio', switches: sw(false, true) })).toBe(true);
    expect(showTestimonyWarning({ ...base, contentKind: 'testimonio', switches: sw(false, false) })).toBe(false);
    expect(showTestimonyWarning({ ...base, contentKind: 'documento', switches: sw(true, true) })).toBe(false);
  });
});
