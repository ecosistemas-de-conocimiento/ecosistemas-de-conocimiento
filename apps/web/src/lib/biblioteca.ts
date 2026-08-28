/**
 * La biblioteca del ecosistema — the taxonomy, the copy, and the pure rules.
 *
 * Sibling of `$lib/publication.ts` and `$lib/ingest.ts`, same shape and same
 * reason: this repo has no DOM test environment, so anything that lives inside
 * a `.svelte` file cannot be covered by a unit test. The rules that matter here
 * — which kinds exist, which one is a testimonio, and what a card is allowed to
 * say about who contributed it — are exactly the ones a refactor would quietly
 * get wrong, so they live in a plain module that vitest can assert.
 *
 * ## 🔴 WHAT THIS SURFACE IS
 *
 * Everything the ecosistema has PUBLISHED, browsable by any member. It is not
 * "my documents" and it is not `/admin`:
 *
 *   · `/` (DocsPanel)  — one conversation's documents, drafts included, yours.
 *   · `/admin`         — every tenant's METADATA, for platform admins.
 *   · `/biblioteca`    — one ecosistema's PUBLISHED content, readable by its
 *                        members. This file.
 *
 * ## 🔴 DRAFTS ARE NOT LISTED HERE. NOT EVEN THE READER'S OWN.
 *
 * The filter is `publicationStatus = published`, applied in the backend query
 * (`$lib/server/biblioteca.ts`), never in the component. Two reasons, and the
 * second is the one that is easy to miss:
 *
 *  1. A list that mixes two privacy states teaches people to read it as one.
 *     Someone who finds their own draft on a page titled "lo que ha reunido tu
 *     ecosistema" will reasonably conclude that everyone else sees it too — and
 *     the drafts they never publish are the ones they most wanted private.
 *  2. `Documents.visibleToCaller` in the backend returns bare `true` for a
 *     platform admin. Leaning on access control to do the filtering would make
 *     this page show an admin every tenant's documents under one ecosistema's
 *     name, and it would look perfectly normal doing it.
 */

/**
 * The kinds a library row can have.
 *
 * ⚠ `testimonio` IS NOT IN `DocKind` (`$lib/types.ts`) YET. The backend model
 * for Voces is being added separately, and this page must not break in either
 * direction: before it lands, no row carries the value and the taxonomy is
 * simply unused; after it lands, rows carry it and are labelled correctly with
 * no change here. A kind we do not recognise degrades to `otro` rather than
 * being hidden — a document missing from the library is worse than one with a
 * dull label.
 */
export const LIBRARY_KINDS = [
  'testimonio',
  'audio',
  'pdf',
  'docx',
  'markdown',
  'otro',
] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function parseLibraryKind(raw: unknown): LibraryKind {
  return typeof raw === 'string' && (LIBRARY_KINDS as readonly string[]).includes(raw)
    ? (raw as LibraryKind)
    : 'otro';
}

/**
 * 🔴 THE ONE PREDICATE THE ANONYMITY RULE HANGS OFF.
 *
 * A testimonio is a voice recorded ON BEHALF OF someone by an investigador, and
 * the system deliberately does not store who spoke. Every "who contributed
 * this?" decision in this file and in `$lib/server/biblioteca.ts` routes
 * through here, so the rule is one line to check rather than an audit.
 */
export function isTestimony(kind: LibraryKind): boolean {
  return kind === 'testimonio';
}

/**
 * 🔴 WHETHER A CONTRIBUTOR NAME MAY EXIST FOR THIS ROW AT ALL.
 *
 * Not "should the UI hide it" — whether the field is allowed to be populated.
 * The server drops `uploadedBy` before the row leaves the BFF (see
 * `$lib/server/biblioteca.ts`), so for a testimonio there is no name in the
 * response, nothing in the browser's memory, and no slot in the card. A UI that
 * merely declines to render a value it holds is one careless `{#if}` away from
 * publishing it.
 */
export function mayShowContributor(kind: LibraryKind): boolean {
  return !isTestimony(kind);
}

// ── Copy ───────────────────────────────────────────────────────────────────

export interface KindLabel {
  /** The chip on the card. Short, because it repeats on every row. */
  label: string;
  /** What this kind IS, in one sentence. `title=` and the reader header. */
  description: string;
  /** Drives the chip's colour class. Testimonies get their own tone. */
  tone: 'voice' | 'document';
}

/**
 * ⚠ A TESTIMONIO AND A DOCUMENTO MUST NOT LOOK THE SAME. They are different
 * kinds of source: one is a person's words, gathered and anonymised; the other
 * is a file somebody wrote. A reader deciding how much weight to give a passage
 * needs to know which they are looking at without guessing, so the difference
 * is a labelled chip with its own colour, not a subtle icon.
 */
export function kindLabel(kind: LibraryKind): KindLabel {
  switch (kind) {
    case 'testimonio':
      return {
        label: 'Voz',
        description:
          'Testimonio recogido de viva voz. Es anónimo: no se guarda quién lo contó.',
        tone: 'voice',
      };
    case 'audio':
      return {
        label: 'Audio',
        description:
          'Grabación con transcripción automática. El texto lo escribió una máquina y puede contener errores.',
        tone: 'document',
      };
    case 'pdf':
      return { label: 'PDF', description: 'Documento en PDF.', tone: 'document' };
    case 'docx':
      return { label: 'DOCX', description: 'Documento de Word.', tone: 'document' };
    case 'markdown':
      return {
        label: 'Nota',
        description: 'Nota escrita dentro de la aplicación.',
        tone: 'document',
      };
    case 'otro':
      return { label: 'Documento', description: 'Documento del ecosistema.', tone: 'document' };
  }
}

/**
 * ⚠ NOT OPTIONAL on a testimonio. The absence of a name is a DECISION, and an
 * absence that is not explained reads as an omission — a reader who sees no
 * author on one card and a name on the next assumes the data is incomplete and
 * goes looking. This says the quiet part: nobody knows, on purpose.
 */
export const TESTIMONY_ANONYMITY_NOTE =
  'Testimonio anónimo: el sistema no guarda quién lo contó.';

/** The machine-transcription warning, reused verbatim from `$lib/ingest.ts`. */
export const LIBRARY_TRANSCRIPT_NOTE =
  'Este texto se generó automáticamente a partir de un audio y puede contener errores.';

/**
 * ⚠ Said on the page, not only in a tooltip. The single most common misreading
 * of a shared library is "this is everything there is". It is not: it is
 * everything that has been PUBLISHED, and the drafts people are still working
 * on are deliberately not here.
 */
export const LIBRARY_SCOPE_NOTE =
  'Aquí solo aparece lo publicado: lo que alguien de tu ecosistema decidió compartir. Los borradores, incluidos los tuyos, no se ven en esta página.';

export const LIBRARY_EMPTY = 'Todavía no hay nada publicado en tu ecosistema.';
export const LIBRARY_EMPTY_HINT =
  'Cuando alguien publique un documento o una voz, aparecerá aquí para todas las personas del ecosistema.';

export const LIBRARY_NO_RESULTS = 'Ningún documento coincide con lo que buscas.';

export const LIBRARY_UNAVAILABLE =
  'No pudimos leer la biblioteca en este momento. Vuelve a intentarlo en un rato.';

// ── Filters ────────────────────────────────────────────────────────────────

/**
 * The kind filter, as it travels in the URL and on the wire.
 *
 * `todos` is a real value rather than "the parameter is absent", so the state
 * is always nameable and a bad value has somewhere safe to land.
 */
export const KIND_FILTERS = [
  'todos',
  'testimonio',
  'audio',
  'pdf',
  'docx',
  'markdown',
] as const;

export type KindFilter = (typeof KIND_FILTERS)[number];

export function parseKindFilter(raw: unknown): KindFilter {
  return typeof raw === 'string' && (KIND_FILTERS as readonly string[]).includes(raw)
    ? (raw as KindFilter)
    : 'todos';
}

export function kindFilterLabel(filter: KindFilter): string {
  switch (filter) {
    case 'todos':
      return 'Todo';
    case 'testimonio':
      return 'Voces';
    case 'audio':
      return 'Audios';
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'Word';
    case 'markdown':
      return 'Notas';
  }
}

/**
 * The backend `kind` values a filter selects, or `null` for "do not constrain".
 *
 * ⚠ `todos` returns null instead of listing every kind. A list would have to be
 * kept in step with a `kind` enum this app does not own — and the day the
 * backend adds a sixth kind, "Todo" would silently stop showing it.
 */
export function kindFilterValues(filter: KindFilter): string[] | null {
  return filter === 'todos' ? null : [filter];
}

/**
 * Trim and cap a search term.
 *
 * ⚠ The cap is not cosmetic: the term is interpolated into a backend `like`
 * query, and an unbounded string from the URL is an unbounded string in a
 * database pattern match.
 */
export const MAX_SEARCH_LENGTH = 120;

export function normalizeSearch(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_SEARCH_LENGTH) : '';
}

// ── Reading a row ──────────────────────────────────────────────────────────

/** One row of the library, as the BFF hands it to the browser. */
export interface LibraryItem {
  id: string;
  title: string;
  kind: LibraryKind;
  /** Epoch ms. When it was published is not stored, so this is when it landed. */
  createdAt: number;
  updatedAt: number;
  /**
   * Who contributed it.
   *
   * 🔴 ALWAYS `null` FOR A TESTIMONIO, and null because the server never put a
   * value here — not because the card declines to render one. See
   * `mayShowContributor`.
   */
  contributor: string | null;
  /** Duration / language chips, for `audio`. Absent otherwise. */
  audioMeta?: Record<string, unknown> | null;
}

/** A full document, as the reader page gets it. */
export interface LibraryDocument extends LibraryItem {
  /** The document's text: the transcript for audio, the extraction otherwise. */
  text: string;
}

/**
 * Human summary of what the list is currently showing.
 *
 * Lives here rather than in the component because "27 documentos" vs "1
 * documento" vs "ninguno" is the kind of thing that reads fine until the day it
 * says "1 documentos".
 */
export function resultsSummary(input: {
  total: number;
  shown: number;
  filtered: boolean;
}): string {
  if (input.total === 0) return input.filtered ? LIBRARY_NO_RESULTS : LIBRARY_EMPTY;
  const noun = input.total === 1 ? 'publicación' : 'publicaciones';
  const total = input.total.toLocaleString('es-MX');
  if (input.shown >= input.total) return `${total} ${noun}`;
  return `${input.shown.toLocaleString('es-MX')} de ${total} ${noun}`;
}

/** `'hola que tal'` → `3 palabras`. Null for empty text. Mirrors ingest.ts. */
export function textStatsCopy(text: string | null | undefined): string | null {
  const words = typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  if (words === 0) return null;
  return words === 1 ? '1 palabra' : `${words.toLocaleString('es-MX')} palabras`;
}

/** `2026-08-15T…` → `15 de agosto de 2026`. Empty string when unparseable. */
export function formatLibraryDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(epochMs));
  } catch {
    return '';
  }
}
