/**
 * Server half of the biblioteca: read ONE ecosistema's PUBLISHED documents.
 *
 * ── 🔴 THE TWO CONSTRAINTS, AND WHY NEITHER IS DELEGATED ────────────────────
 *
 * Every read in this file carries both, in the query, always:
 *
 *   `where[organization][equals]=<the caller's current ecosistema>`
 *   `where[publicationStatus][equals]=published`
 *
 * ⚠ THE TENANT FILTER IS NOT REDUNDANT WITH ACCESS CONTROL. The backend's
 * `Documents.visibleToCaller` returns a bare `true` — no constraint at all —
 * for a platform admin. Correct for the CMS; catastrophic here. An unscoped
 * query would hand that account every tenant's documents under one ecosistema's
 * name, and the page would look completely normal doing it. Same reasoning, and
 * the same shape, as `$lib/server/admin.ts`.
 *
 * ⚠ THE PUBLICATION FILTER IS NOT REDUNDANT EITHER, for the mirror-image
 * reason. `visibleToCaller` deliberately shows the caller their OWN drafts —
 * that is what makes the documents panel work. On this page that same
 * generosity is the bug: a draft on a shared-library page reads as shared, and
 * the person who sees theirs there will assume everyone else does too. So the
 * constraint is explicit rather than inherited.
 *
 * ── 🔴 ANONYMITY IS ENFORCED HERE, NOT IN THE COMPONENT ─────────────────────
 *
 * A testimonio's contributor is dropped BEFORE the row leaves this module. Not
 * hidden in the template — dropped. The name never reaches the browser, so
 * there is nothing for a careless `{#if}` to leak later. See `isGatedContent`
 * (keyed on `contentKind`, never on the file-format `kind`).
 */

import { safeErrMessage } from '$lib/errorSummary';
import { env } from '$env/dynamic/private';
import { backendFetch } from '$lib/server/auth';
import {
  excerptFrom,
  isGatedContent,
  kindFilterWhere,
  libraryKindOf,
  isGatedDocumento,
  libraryTitleOf,
  normalizeSearch,
  parseSkipIntro,
  testimonyHeading,
  testimonyTopic,
  type KindFilter,
  type LibraryDocument,
  type LibraryItem,
} from '$lib/biblioteca';

/** Rows per page. Payload's list ceiling is 100; a page of 30 reads fine. */
export const LIBRARY_PAGE_SIZE = 30;

/**
 * The fields the LIST reads.
 *
 * ⚠ `extractedText` and `bodyMarkdown` are absent on purpose: the raw
 * original never feeds the list, and a documento's full text is never shown
 * there. The reader route fetches the text for exactly one document.
 *
 * 🔴 `redactedText` IS READ, SERVER-SIDE ONLY: the BFF cuts the testimonio's
 * excerpt from it (`toLibraryItem`) and drops it. The browser gets the excerpt
 * line, never the text. Members could already read it on the reader page; the
 * backend's access to it is unchanged. Cost: one list page carries up to 30
 * full redacted texts from backend to BFF (not measured), never to the browser.
 */
export const LIBRARY_LIST_FIELDS = [
  'name',
  'kind',
  'publicationStatus',
  'organization',
  'uploadedBy',
  'audioMeta',
  'createdAt',
  'updatedAt',
  // 🔴 A PAIR. `lenguaReadable` (backend Documents.ts) reads `contentKind` off
  // the projected row; select `lengua` without it and the field vanishes from
  // every row, with no error.
  'lengua',
  'contentKind',
  // 🔴 Read so the list can drop a gated row the gate has not cleared — see
  // `isClearedForLibrary`.
  'anonymisationStatus',
  // 🔴 For the excerpt only — see above. Dropped before the row leaves.
  'redactedText',
  // The testimonio's topic ("Testimonio · Discapacidad"); no personal content.
  'tema',
  // 🔴 The system-proposed title, from the gate's redacted output (owner ruling
  // 2026-10-24). A PAIR with `anonymisationStatus` above: the backend's read
  // rule (`mayReadTestimonioTitle`) reads the status off the projected row.
  'testimonioTitle',
  // 🔴 A documento filed for anonymisation is gated too — see `hasGatedText`.
  // (Backend `forceSelect` returns it anyway; named here so the dependency shows.)
  'anonymise',
  // 🔴 A gated documento's title is the gate's (`redactedTitle`, P-13); the
  // report is counts plus that title. Dropped before the row leaves.
  'anonymisationReport',
] as const;

/**
 * The reader adds the text itself.
 *
 * 🔴 `redactedText` IS THE TEXT OF A TESTIMONIO (already in the list fields).
 * `extractedText` and `bodyMarkdown` are the unredacted original; the backend
 * hides them from everyone but the uploader on gated rows
 * (`mayReadGatedOriginal`), and {@link documentText} never reads them for one
 * either.
 */
export const LIBRARY_DOC_FIELDS = [...LIBRARY_LIST_FIELDS, 'extractedText', 'bodyMarkdown'] as const;

function selectParams(fields: readonly string[]): Array<[string, string]> {
  return fields.map((f) => [`select[${f}]`, 'true']);
}

export interface LibraryQueryInput {
  organizationId: string;
  kind: KindFilter;
  search: string;
  /** 1-based, as Payload counts. */
  page: number;
  /**
   * The lengua filter, as the documento ids `GET /api/lenguas` named for it.
   *
   * ⚠ Ids, not `where[lengua][equals]`: the backend refuses a `where` on that
   * field for any non-override caller (see `apps/backend/src/endpoints/lenguas.ts`).
   * Absent ⇒ no lengua filter. An EMPTY list is the caller's to short-circuit;
   * it is never sent as an empty `in`.
   */
  documentIds?: readonly string[];
  /** The topic of a testimonio with no `tema` (`testimonyTopic`). */
  ecosystemName?: string | null;
}

/**
 * The list query string.
 *
 * 🔴 EVERY LIST READ GOES THROUGH HERE. Centralising it is what makes "is this
 * scoped?" a one-line check rather than an audit of every call site — and it is
 * the only reason the two constraints above are testable at all.
 *
 * ⚠ Search is on the title the card shows, and the UI says so: `name`, and a
 * testimonio's `testimonioTitle` (`resolveSearchIds`). Matching the full text would
 * mean a `like` over every transcript in the ecosistema on every keystroke; at
 * a few hundred documents that is a full scan of the largest column in the
 * table. A title search that is honest about being a title search beats a
 * full-text search that times out.
 */
/** Statuses that clear gated content: the gate's own `ready`, or a reviewer's `approved`. */
export const CLEARED_STATUSES = ['ready', 'approved'] as const;

const CLEARED_WHERE: Array<[string, string]> = [
  // A documento not filed for anonymisation (`false`, or a legacy null)…
  ['where[or][0][and][0][contentKind][equals]', 'documento'],
  ['where[or][0][and][1][anonymise][equals]', 'false'],
  ['where[or][1][and][0][contentKind][equals]', 'documento'],
  ['where[or][1][and][1][anonymise][exists]', 'false'],
  // …or any gated row (testimonio, conversación, gated documento) the gate cleared.
  ['where[or][2][and][0][anonymisationStatus][in]', CLEARED_STATUSES.join(',')],
  ['where[or][2][and][1][redactedText][exists]', 'true'],
];

/**
 * Not a `documento` whose title is gated, for the name search: `anonymise` is
 * `false`. A NULL is gated for the title (`isGatedTitle`, 2026-11-10), so it is
 * not matched by its raw name either.
 */
const NOT_GATED_DOCUMENTO_WHERE: Array<[string, string]> = [
  ['where[and][1][or][0][contentKind][not_equals]', 'documento'],
  ['where[and][1][or][1][anonymise][equals]', 'false'],
];

/**
 * 🔴 IS THIS ROW'S TEXT GATED? A testimonio or conversación (`isGatedContent`),
 * or a `documento` filed for anonymisation (`anonymise`, backend
 * `anonymiseRequested`: anything but missing/null/false). The backend hides
 * `extractedText`/`bodyMarkdown` of either from everyone but the uploader, so
 * the library shows `redactedText` or nothing. Audit 2026-10-26: a published
 * gated documento showed an empty body.
 *
 * ⚠ Text only. Its title is the gate's redacted one (2026-11-10, P-13,
 * `libraryTitleOf`), and since R4-01 (audit 2026-11-10) the backend gives a
 * colleague a gated documento's `name` as the neutral title and its
 * `uploadedBy` not at all (`mayReadGatedOriginal` scope `identity`).
 */
export function hasGatedText(row: Record<string, unknown>): boolean {
  if (isGatedContent(row.contentKind)) return true;
  return isGatedDocumento(row.anonymise);
}

/**
 * 🔴 MAY THIS ROW SHOW IN THE LIBRARY AT ALL? A plain `documento` yes. Gated
 * text (`hasGatedText`: a testimonio, a conversación, a documento filed for
 * anonymisation) only when cleared, and — when the row carries its text — only
 * with a non-empty redaction, so there is never an empty card.
 *
 * ⚠ Separate from {@link isLibraryVisible} on purpose: that one answers "is it
 * shared in this ecosistema", this one "is there something safe to show".
 */
export function isClearedForLibrary(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  if (!hasGatedText(row)) return true;
  if (!(CLEARED_STATUSES as readonly unknown[]).includes(row.anonymisationStatus)) return false;
  if ('redactedText' in row) {
    return typeof row.redactedText === 'string' && row.redactedText.trim() !== '';
  }
  return true;
}

/** The three constraints every read in this file carries. */
function scopeQuery(organizationId: string): URLSearchParams {
  const qs = new URLSearchParams();
  // 🔴 The two constraints. First, so they are the first thing anyone reads.
  qs.set('where[organization][equals]', organizationId);
  qs.set('where[publicationStatus][equals]', 'published');

  // 🔴 THE THIRD CONSTRAINT: gated content only once the gate (or a reviewer)
  // cleared it, and only with a redaction to show. Measured on dev, 2026-10-21:
  // 13 held testimonios were `published` and showed as empty "Testimonio"
  // cards. A `documento` is never gated. Mirrors `isClearedForLibrary`.
  for (const [k, v] of CLEARED_WHERE) qs.set(k, v);
  return qs;
}

export function libraryListQuery(input: LibraryQueryInput): string {
  const qs = scopeQuery(input.organizationId);

  for (const [k, v] of kindFilterWhere(input.kind)) qs.set(k, v);

  const search = normalizeSearch(input.search);
  if (search) {
    qs.set('where[and][0][name][like]', search);
    // 🔴 NOT ON A GATED DOCUMENTO'S NAME (P-13): it shows the redacted title,
    // so matching the raw filename would say who it names. Rows that are not a
    // documento keep today's search.
    for (const [k, v] of NOT_GATED_DOCUMENTO_WHERE) qs.set(k, v);
  }

  if (input.documentIds && input.documentIds.length > 0) {
    qs.set('where[id][in]', input.documentIds.join(','));
  }

  qs.set('depth', '0');
  qs.set('limit', String(LIBRARY_PAGE_SIZE));
  qs.set('page', String(Math.max(1, Math.floor(input.page) || 1)));
  // Newest first: a library is read from what just arrived, not from the
  // beginning of time.
  qs.set('sort', '-createdAt');
  for (const [k, v] of selectParams(LIBRARY_LIST_FIELDS)) qs.set(k, v);
  return qs.toString();
}

/** The single-document query. Same fields plus the text. */
export function libraryDocQuery(): string {
  const qs = new URLSearchParams({ depth: '0' });
  for (const [k, v] of selectParams(LIBRARY_DOC_FIELDS)) qs.set(k, v);
  return qs.toString();
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Most ids one search resolves to. Past it {@link resolveSearchIds} gives up and
 * the list falls back to a title-only search. 1000 ids is about 7 KB of query
 * string, under Node's 16 KB header limit (inferred: four-digit ids on dev,
 * 2026-11-10, plus an encoded comma each).
 */
export const SEARCH_ID_CEILING = 1000;

/**
 * Payload's `like`, as the BFF needs it for a title it reads itself: every
 * space-separated word, as a case-insensitive substring
 * (`@payloadcms/drizzle@3.88.0`, `queries/parseParams.js`).
 */
export function titleMatches(title: unknown, search: string): boolean {
  if (typeof title !== 'string' || !title) return false;
  const haystack = title.toLocaleLowerCase('es');
  const words = search.toLocaleLowerCase('es').split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

async function readIds(
  token: string | undefined,
  qs: URLSearchParams,
  keep: (row: Record<string, unknown>) => boolean,
): Promise<string[] | null> {
  qs.set('depth', '0');
  qs.set('limit', String(SEARCH_ID_CEILING));
  const res = await backendFetch(token, `/api/documents?${qs.toString()}`, { method: 'GET' });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { docs?: unknown; hasNextPage?: unknown };
  if (body.hasNextPage === true || !Array.isArray(body.docs)) return null;
  return (body.docs as Record<string, unknown>[])
    .filter((row) => row && row.id != null && keep(row))
    .map((row) => String(row.id));
}

/**
 * 🔴 A TESTIMONIO IS FOUND BY THE TITLE ITS CARD SHOWS. That title is
 * `testimonioTitle`; `name` is the uploader's filename, never shown. Searching
 * `name` alone missed every Voz: measured on dev 2026-11-10, 0 of 6 sampled
 * testimonios in Prevención del dengue and Discapacidad came back for a word
 * of their own title.
 *
 * ⚠ Two reads, then ids, because one query cannot say it. A member may not
 * query `testimonioTitle` (backend `testimonioTitleReadable`: 400), and any
 * `where` naming `name` is narrowed to documentos not filed for anonymisation
 * and the caller's own uploads
 * (`constrainGatedQueries`), so an `or` of the two would drop the testimonios
 * again. The titles are read only from cleared rows (`scopeQuery`), which every
 * member already sees on the cards.
 *
 * `null` ⇒ could not tell (a read failed, or past {@link SEARCH_ID_CEILING});
 * the caller falls back to the title-only search.
 */
export async function resolveSearchIds(
  token: string | undefined,
  organizationId: string,
  search: string,
): Promise<string[] | null> {
  const byName = scopeQuery(organizationId);
  byName.set('where[and][0][name][like]', search);
  // 🔴 P-13, as `libraryListQuery`: never a gated documento by its raw name.
  for (const [k, v] of NOT_GATED_DOCUMENTO_WHERE) byName.set(k, v);
  byName.set('select[contentKind]', 'true');

  const voces = scopeQuery(organizationId);
  voces.set('where[contentKind][equals]', 'testimonio');
  // 🔴 A PAIR: the backend reads `anonymisationStatus` off the projected row
  // to decide whether `testimonioTitle` is readable (`mayReadTestimonioTitle`).
  voces.set('select[testimonioTitle]', 'true');
  voces.set('select[anonymisationStatus]', 'true');

  try {
    const [names, titled] = await Promise.all([
      readIds(token, byName, () => true),
      readIds(token, voces, (row) => titleMatches(row.testimonioTitle, search)),
    ]);
    if (!names || !titled) return null;
    return [...new Set([...names, ...titled])];
  } catch (err) {
    console.warn('[biblioteca] search id read failed', safeErrMessage(err));
    return null;
  }
}

// ── Row parsing ────────────────────────────────────────────────────────────

function relationId(raw: unknown): string | null {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return null;
}

function epoch(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * 🔴 THE SERVER-SIDE RE-CHECK ON A SINGLE ROW.
 *
 * A list query can be scoped by its `where`. A read-by-id cannot: the backend
 * answers with whatever `visibleToCaller` allows, which for a platform admin is
 * everything, and for an ordinary member includes their OWN DRAFTS. So the row
 * is re-checked here against the same two constraints the list applies, and
 * anything that fails either one is treated as absent.
 *
 * ⚠ Absent, not forbidden. A 404 tells a prober nothing; a 403 confirms the id
 * exists in some other ecosistema.
 */
export function isLibraryVisible(
  row: Record<string, unknown> | null | undefined,
  organizationId: string,
): boolean {
  if (!row) return false;
  if (row.publicationStatus !== 'published') return false;
  return relationId(row.organization) === String(organizationId);
}

/**
 * Turn a backend row into a library item.
 *
 * 🔴 `contributorName` IS IGNORED FOR A TESTIMONIO. The caller passes whatever
 * it resolved; this function decides whether it is allowed to survive. Putting
 * the decision here rather than at the call site means a future second call
 * site inherits it instead of re-deciding it.
 */
export function toLibraryItem(
  row: Record<string, unknown>,
  contributorName: string | null,
  ecosystemName: string | null = null,
): LibraryItem {
  const kind = libraryKindOf(row);
  // 🔴 `contentKind`, not `kind`. See `isGatedContent`.
  const gated = isGatedContent(row.contentKind);
  const testimonio = row.contentKind === 'testimonio';
  // A testimonio: its generated title over its short day (source icon in the page),
  // or "Testimonio · <tema or ecosistema>" alone when it has none.
  const heading = testimonio
    ? testimonyHeading(row.testimonioTitle, testimonyTopic(row.tema, ecosystemName), row.createdAt)
    : null;
  return {
    id: String(row.id ?? ''),
    // 🔴 Never the uploader's filename on gated content, even when the backend
    // hands it over (it does, to the uploader and to a platform admin).
    // A gated documento: the gate's redacted title (P-13), never `name`.
    title: heading ? heading.title : libraryTitleOf(row),
    subtitle: heading ? heading.subtitle : null,
    kind,
    createdAt: epoch(row.createdAt),
    updatedAt: epoch(row.updatedAt ?? row.createdAt),
    contributor: gated ? null : (contributorName ?? null),
    // 🔴 Documento only, whatever the row says. See `$lib/lengua.ts`.
    lengua:
      row.contentKind === 'documento' && typeof row.lengua === 'string' && row.lengua.trim()
        ? row.lengua.trim()
        : null,
    // ⚠ Not on gated content: `audioMeta.language` is the same
    // re-identification key `lengua` is (backend `enforceLenguaDocumentoOnly`).
    audioMeta:
      !gated && kind === 'audio' && row.audioMeta && typeof row.audioMeta === 'object' && !Array.isArray(row.audioMeta)
        ? (row.audioMeta as Record<string, unknown>)
        : null,
    // The FILE format, so a PDF Voz is not labelled machine-transcribed.
    fromAudio: row.kind === 'audio',
    // 🔴 From `redactedText` only, and only once the gate cleared the row
    // (`isClearedForLibrary`). Never the original; no fallback to it.
    // `BIBLIOTECA_EXCERPT_SKIP_INTRO` (default off): `true` skips origin/language/age lines.
    excerpt:
      testimonio && isClearedForLibrary(row)
        ? excerptFrom(row.redactedText, {
            skipIntro: parseSkipIntro(env.BIBLIOTECA_EXCERPT_SKIP_INTRO),
            // Owner ruling 2026-10-28: no `[Persona A]` on a card, like the chat title.
            placeholderFree: true,
          })
        : null,
  };
}

/**
 * The document's text, from whichever column this kind stores it in.
 *
 * 🔴 GATED TEXT (`hasGatedText`) READS `redactedText` AND NOTHING ELSE. The original is the
 * uploader's; the library shows what the anonymisation gate released. No
 * redaction ⇒ no text, never a fallback to the original.
 */
export function documentText(row: Record<string, unknown>): string {
  if (hasGatedText(row)) {
    return typeof row.redactedText === 'string' ? row.redactedText : '';
  }
  const extracted = typeof row.extractedText === 'string' ? row.extractedText : '';
  if (extracted.trim()) return extracted;
  const body = typeof row.bodyMarkdown === 'string' ? row.bodyMarkdown : '';
  return body;
}

/**
 * The uploader ids we are ALLOWED to resolve names for.
 *
 * 🔴 A TESTIMONIO'S UPLOADER IS NEVER IN THIS SET. The investigador who filed
 * it is not the person whose voice it is, and showing "subido por X" on an
 * anonymous testimony invites exactly the wrong inference — that X is the
 * source. The id is dropped before any name lookup happens, so it is not even a
 * question the users endpoint gets asked.
 */
export function contributorIdsToResolve(rows: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (isGatedContent(row.contentKind)) continue;
    const id = relationId(row.uploadedBy);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * id → display name, for the ids we are allowed to ask about.
 *
 * ⚠ ONE batch read with `where[id][in]=…`, never a general user list: the ids
 * are ones we already hold, so this reveals nothing the caller could not
 * already infer. A failure degrades to an empty map — a card with no
 * contributor line is a smaller loss than a page that will not load.
 */
export async function resolveContributors(
  token: string | undefined,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const qs = new URLSearchParams({
      'where[id][in]': ids.join(','),
      limit: String(Math.min(ids.length, 100)),
      depth: '0',
      'select[displayName]': 'true',
      'select[email]': 'true',
    });
    const res = await backendFetch(token, `/api/users?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[biblioteca] backend answered ${res.status} resolving contributors`);
      return {};
    }
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const out: Record<string, string> = {};
    for (const raw of Array.isArray(body.docs) ? body.docs : []) {
      const row = raw as { id?: unknown; displayName?: unknown; email?: unknown };
      const id = relationId(row.id);
      if (!id) continue;
      const name =
        typeof row.displayName === 'string' && row.displayName.trim()
          ? row.displayName.trim()
          : typeof row.email === 'string'
            ? row.email
            : '';
      if (name) out[id] = name;
    }
    return out;
  } catch (err) {
    console.warn('[biblioteca] contributor read failed', safeErrMessage(err));
    return {};
  }
}

// ── The reads ──────────────────────────────────────────────────────────────

export interface LibraryPage {
  items: LibraryItem[];
  /** The backend's own count for the current filter. */
  total: number;
  page: number;
  hasNextPage: boolean;
  /**
   * `false` ⇒ the read FAILED. ⚠ Load-bearing, same as
   * `EcosystemList.ok`: an empty list because the backend blinked must never be
   * rendered as "tu ecosistema no ha publicado nada".
   */
  ok: boolean;
}

const EMPTY_PAGE: LibraryPage = { items: [], total: 0, page: 1, hasNextPage: false, ok: false };

export async function listPublished(
  token: string | undefined,
  input: LibraryQueryInput,
): Promise<LibraryPage> {
  try {
    // A search becomes ids (`resolveSearchIds`), ANDed with a lengua filter's.
    let query = input;
    const search = normalizeSearch(input.search);
    if (search) {
      const ids = await resolveSearchIds(token, input.organizationId, search);
      if (ids) {
        const scoped = input.documentIds ? ids.filter((id) => input.documentIds!.includes(id)) : ids;
        // ⚠ Never an empty `in`: nothing matched is an empty page, said so.
        if (scoped.length === 0) return { items: [], total: 0, page: input.page, hasNextPage: false, ok: true };
        query = { ...input, search: '', documentIds: scoped };
      }
    }
    const res = await backendFetch(token, `/api/documents?${libraryListQuery(query)}`, {
      method: 'GET',
    });
    if (!res.ok) {
      // A 403 from Payload is often just "empty tenant", so this is not proof
      // of an authz problem — but it is not proof of an empty library either.
      // Warn so a real regression stays visible, and report a failed read.
      console.warn(`[biblioteca] backend answered ${res.status} listing published documents`);
      return { ...EMPTY_PAGE, page: input.page };
    }
    const body = (await res.json().catch(() => ({}))) as {
      docs?: unknown;
      totalDocs?: unknown;
      hasNextPage?: unknown;
    };
    // ⚠ Belt and braces: the query already says so (`CLEARED_WHERE`).
    const rows = ((Array.isArray(body.docs) ? body.docs : []) as Record<string, unknown>[]).filter(
      isClearedForLibrary,
    );
    const names = await resolveContributors(token, contributorIdsToResolve(rows));
    const items = rows.map((row) => {
      const uploader = relationId(row.uploadedBy);
      return toLibraryItem(row, uploader ? (names[uploader] ?? null) : null, input.ecosystemName ?? null);
    });
    return {
      items,
      total: typeof body.totalDocs === 'number' ? body.totalDocs : items.length,
      page: input.page,
      hasNextPage: body.hasNextPage === true,
      ok: true,
    };
  } catch (err) {
    console.warn('[biblioteca] list read failed', safeErrMessage(err));
    return { ...EMPTY_PAGE, page: input.page };
  }
}

export type LibraryReadResult =
  | { state: 'ok'; doc: LibraryDocument }
  /** Not published, not this ecosistema, or does not exist. All the same to a reader. */
  | { state: 'not-found' }
  | { state: 'unavailable' };

export async function readPublished(
  token: string | undefined,
  organizationId: string,
  id: string,
  ecosystemName: string | null = null,
): Promise<LibraryReadResult> {
  try {
    const res = await backendFetch(
      token,
      `/api/documents/${encodeURIComponent(id)}?${libraryDocQuery()}`,
      { method: 'GET' },
    );
    if (res.status === 404 || res.status === 403) return { state: 'not-found' };
    if (!res.ok) {
      console.warn(`[biblioteca] backend answered ${res.status} reading document ${id}`);
      return { state: 'unavailable' };
    }
    const row = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // 🔴 The re-check. See `isLibraryVisible`.
    if (!isLibraryVisible(row, organizationId)) return { state: 'not-found' };
    // 🔴 And nothing uncleared or empty: a held testimonio reads as absent.
    if (!isClearedForLibrary(row)) return { state: 'not-found' };
    const doc = row as Record<string, unknown>;
    const names = await resolveContributors(token, contributorIdsToResolve([doc]));
    const uploader = relationId(doc.uploadedBy);
    return {
      state: 'ok',
      doc: {
        ...toLibraryItem(doc, uploader ? (names[uploader] ?? null) : null, ecosystemName),
        text: documentText(doc),
      },
    };
  } catch (err) {
    console.warn('[biblioteca] document read failed', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}
