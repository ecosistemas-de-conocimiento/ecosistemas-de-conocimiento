import { describe, expect, it } from 'vitest';

import {
  formatLibraryDate,
  isGatedContent,
  isTestimony,
  kindFilterWhere,
  libraryKindOf,
  libraryTitleFor,
  kindFilterLabel,
  kindFilterValues,
  kindLabel,
  KIND_FILTERS,
  LIBRARY_EMPTY,
  LIBRARY_KINDS,
  LIBRARY_NO_RESULTS,
  LIBRARY_SCOPE_NOTE,
  mayShowContributor,
  MAX_SEARCH_LENGTH,
  normalizeSearch,
  parseKindFilter,
  parseLibraryKind,
  resultsSummary,
  TESTIMONY_ANONYMITY_NOTE,
  textStatsCopy,
} from './biblioteca';

describe('parseLibraryKind', () => {
  it.each(LIBRARY_KINDS)('accepts the known kind %s', (kind) => {
    expect(parseLibraryKind(kind)).toBe(kind);
  });

  // ⚠ The `testimonio` model is landing separately in the backend. Before it
  // does, no row carries the value; after it does, rows must be labelled
  // correctly with no change here.
  it('accepts testimonio even though DocKind does not have it yet', () => {
    expect(parseLibraryKind('testimonio')).toBe('testimonio');
  });

  // A document missing from the library is worse than one with a dull label.
  it.each([undefined, null, '', 'video', 42, {}])('degrades %p to otro rather than dropping it', (raw) => {
    expect(parseLibraryKind(raw)).toBe('otro');
  });
});

describe('the anonymity rule', () => {
  it('only testimonio is a testimony', () => {
    for (const kind of LIBRARY_KINDS) {
      expect(isTestimony(kind)).toBe(kind === 'testimonio');
    }
  });

  // 🔴 The predicate every "who contributed this?" decision routes through.
  it('refuses a contributor for a testimonio and allows one for everything else', () => {
    expect(mayShowContributor('testimonio')).toBe(false);
    for (const kind of LIBRARY_KINDS.filter((k) => k !== 'testimonio')) {
      expect(mayShowContributor(kind)).toBe(true);
    }
  });

  it('explains the absence instead of leaving a blank', () => {
    expect(TESTIMONY_ANONYMITY_NOTE).toMatch(/anónimo/i);
    expect(TESTIMONY_ANONYMITY_NOTE).toMatch(/no guarda quién/i);
  });
});

describe('kindLabel', () => {
  it('gives every kind a label and a description', () => {
    for (const kind of LIBRARY_KINDS) {
      const label = kindLabel(kind);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.description.length).toBeGreaterThan(0);
    }
  });

  // ⚠ The visible difference between the two kinds of source. A reader must not
  // have to guess whether they are holding a person's words or a file.
  it('gives a testimonio its own tone and its own word', () => {
    const voice = kindLabel('testimonio');
    expect(voice.tone).toBe('voice');
    expect(voice.label).toBe('Voz');
    for (const kind of LIBRARY_KINDS.filter((k) => k !== 'testimonio')) {
      expect(kindLabel(kind).tone).toBe('document');
      expect(kindLabel(kind).label).not.toBe('Voz');
    }
  });

  it("says a testimonio is anonymous in its own description", () => {
    expect(kindLabel('testimonio').description).toMatch(/anónimo/i);
  });

  // The ASR mitigation, carried into the library. An audio document's text is
  // machine-written and will be quoted as fact.
  it('says an audio document was transcribed by machine', () => {
    expect(kindLabel('audio').description).toMatch(/automática|máquina/i);
  });
});

describe('the scope note', () => {
  // 🔴 The commonest misreading of a shared library is "this is everything".
  it('says out loud that drafts are not here, including the reader’s own', () => {
    expect(LIBRARY_SCOPE_NOTE).toMatch(/publicado/i);
    expect(LIBRARY_SCOPE_NOTE).toMatch(/borradores/i);
    expect(LIBRARY_SCOPE_NOTE).toMatch(/tuyos/i);
  });
});

describe('kind filters', () => {
  it.each(KIND_FILTERS)('round-trips %s', (f) => {
    expect(parseKindFilter(f)).toBe(f);
  });

  it.each([undefined, null, '', 'otro', 'DROP TABLE', 7])('falls back to todos for %p', (raw) => {
    expect(parseKindFilter(raw)).toBe('todos');
  });

  it('gives every filter a Spanish label', () => {
    for (const f of KIND_FILTERS) expect(kindFilterLabel(f).length).toBeGreaterThan(0);
  });

  // ⚠ `todos` must NOT enumerate the kinds: the day the backend adds a sixth,
  // "Todo" would silently stop showing it.
  it('does not constrain the query for todos', () => {
    expect(kindFilterValues('todos')).toBeNull();
  });

  it('selects exactly the chosen kind otherwise', () => {
    expect(kindFilterValues('testimonio')).toEqual(['testimonio']);
    expect(kindFilterValues('audio')).toEqual(['audio']);
  });
});

describe('normalizeSearch', () => {
  it('trims', () => {
    expect(normalizeSearch('  actas  ')).toBe('actas');
  });

  it.each([undefined, null, 42, {}])('reads %p as no search', (raw) => {
    expect(normalizeSearch(raw)).toBe('');
  });

  // ⚠ The term reaches a backend `like` pattern. An unbounded string from the
  // URL is an unbounded string in a database query.
  it('caps the length', () => {
    expect(normalizeSearch('a'.repeat(500))).toHaveLength(MAX_SEARCH_LENGTH);
  });
});

describe('resultsSummary', () => {
  it('says nothing is published when nothing is', () => {
    expect(resultsSummary({ total: 0, shown: 0, filtered: false })).toBe(LIBRARY_EMPTY);
  });

  // ⚠ Different sentence: an empty filter result is not an empty library, and
  // saying "no hay nada publicado" while a filter is on is simply false.
  it('says nothing matched when a filter is on', () => {
    expect(resultsSummary({ total: 0, shown: 0, filtered: true })).toBe(LIBRARY_NO_RESULTS);
  });

  it('agrees in number', () => {
    expect(resultsSummary({ total: 1, shown: 1, filtered: false })).toBe('1 publicación');
    expect(resultsSummary({ total: 4, shown: 4, filtered: false })).toBe('4 publicaciones');
  });

  it('says how many of how many when the page is a prefix', () => {
    expect(resultsSummary({ total: 90, shown: 30, filtered: false })).toBe('30 de 90 publicaciones');
  });
});

describe('textStatsCopy', () => {
  it('counts words', () => {
    expect(textStatsCopy('hola que tal')).toBe('3 palabras');
    expect(textStatsCopy(' solo ')).toBe('1 palabra');
  });

  it.each([undefined, null, '', '   '])('says nothing for %p', (raw) => {
    expect(textStatsCopy(raw)).toBeNull();
  });
});

describe('formatLibraryDate', () => {
  it('formats in Spanish', () => {
    const out = formatLibraryDate(Date.UTC(2026, 7, 15, 12));
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/agosto/i);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('says nothing for %p', (raw) => {
    expect(formatLibraryDate(raw)).toBe('');
  });
});

// 🔴 Audit 2026-10-17: the library keyed testimony on `kind` (the FILE FORMAT),
// which a Voz never carries. These pin the `contentKind` reading.
describe('contentKind, not kind', () => {
  it('a Voz is {kind: audio, contentKind: testimonio}', () => {
    expect(libraryKindOf({ kind: 'audio', contentKind: 'testimonio' })).toBe('testimonio');
    expect(libraryKindOf({ kind: 'audio', contentKind: 'documento' })).toBe('audio');
  });

  it('isGatedContent fails closed', () => {
    expect(isGatedContent('documento')).toBe(false);
    for (const k of ['testimonio', 'conversacion', 'x', undefined, null]) {
      expect(isGatedContent(k)).toBe(true);
    }
  });

  it('libraryTitleFor never shows a typed name on gated content', () => {
    expect(libraryTitleFor('testimonio', 'María.m4a')).toBe('Testimonio');
    expect(libraryTitleFor('conversacion', 'María')).toBe('Conversación');
    expect(libraryTitleFor(undefined, 'María')).toBe('Documento sin título');
    expect(libraryTitleFor('documento', '  Acta  ')).toBe('Acta');
  });

  it('kindFilterWhere puts Voces on contentKind and formats on documentos', () => {
    expect(kindFilterWhere('todos')).toEqual([]);
    expect(kindFilterWhere('testimonio')).toEqual([['where[contentKind][equals]', 'testimonio']]);
    expect(kindFilterWhere('pdf')).toEqual([
      ['where[kind][in]', 'pdf'],
      ['where[contentKind][equals]', 'documento'],
    ]);
  });
});
