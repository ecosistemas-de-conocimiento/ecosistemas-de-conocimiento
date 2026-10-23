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

import { env } from '$env/dynamic/private';
import { backendFetch } from '$lib/server/auth';
import {
  excerptFrom,
  isGatedContent,
  kindFilterWhere,
  libraryKindOf,
  libraryTitleFor,
  normalizeSearch,
  parseSkipIntro,
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
 * ⚠ Search is on `name` only, and the UI says so. Matching the full text would
 * mean a `like` over every transcript in the ecosistema on every keystroke; at
 * a few hundred documents that is a full scan of the largest column in the
 * table. A title search that is honest about being a title search beats a
 * full-text search that times out.
 */
/** Statuses that clear gated content: the gate's own `ready`, or a reviewer's `approved`. */
export const CLEARED_STATUSES = ['ready', 'approved'] as const;

const CLEARED_WHERE: Array<[string, string]> = [
  ['where[or][0][contentKind][equals]', 'documento'],
  ['where[or][1][and][0][anonymisationStatus][in]', CLEARED_STATUSES.join(',')],
  ['where[or][1][and][1][redactedText][exists]', 'true'],
];

/**
 * 🔴 MAY THIS ROW SHOW IN THE LIBRARY AT ALL? A `documento` yes. Gated content
 * (a testimonio, a conversación) only when cleared, and — when the row carries
 * its text — only with a non-empty redaction, so there is never an empty card.
 *
 * ⚠ Separate from {@link isLibraryVisible} on purpose: that one answers "is it
 * shared in this ecosistema", this one "is there something safe to show".
 */
export function isClearedForLibrary(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  if (!isGatedContent(row.contentKind)) return true;
  if (!(CLEARED_STATUSES as readonly unknown[]).includes(row.anonymisationStatus)) return false;
  if ('redactedText' in row) {
    return typeof row.redactedText === 'string' && row.redactedText.trim() !== '';
  }
  return true;
}

export function libraryListQuery(input: LibraryQueryInput): string {
  const qs = new URLSearchParams();
  // 🔴 The two constraints. First, so they are the first thing anyone reads.
  qs.set('where[organization][equals]', input.organizationId);
  qs.set('where[publicationStatus][equals]', 'published');

  // 🔴 THE THIRD CONSTRAINT: gated content only once the gate (or a reviewer)
  // cleared it, and only with a redaction to show. Measured on dev, 2026-10-21:
  // 13 held testimonios were `published` and showed as empty "Testimonio"
  // cards. A `documento` is never gated. Mirrors `isClearedForLibrary`.
  for (const [k, v] of CLEARED_WHERE) qs.set(k, v);

  for (const [k, v] of kindFilterWhere(input.kind)) qs.set(k, v);

  const search = normalizeSearch(input.search);
  if (search) qs.set('where[name][like]', search);

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
  return {
    id: String(row.id ?? ''),
    // 🔴 Never the uploader's filename on gated content, even when the backend
    // hands it over (it does, to the uploader and to a platform admin).
    // A testimonio reads "Testimonio · <tema or ecosistema>".
    title: libraryTitleFor(
      row.contentKind,
      row.name,
      testimonio ? testimonyTopic(row.tema, ecosystemName) : null,
    ),
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
    // `BIBLIOTECA_EXCERPT_SKIP_INTRO` (default on): skip origin/language/age lines.
    excerpt:
      testimonio && isClearedForLibrary(row)
        ? excerptFrom(row.redactedText, { skipIntro: parseSkipIntro(env.BIBLIOTECA_EXCERPT_SKIP_INTRO) })
        : null,
  };
}

/**
 * The document's text, from whichever column this kind stores it in.
 *
 * 🔴 GATED CONTENT READS `redactedText` AND NOTHING ELSE. The original is the
 * uploader's; the library shows what the anonymisation gate released. No
 * redaction ⇒ no text, never a fallback to the original.
 */
export function documentText(row: Record<string, unknown>): string {
  if (isGatedContent(row.contentKind)) {
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
    console.warn('[biblioteca] contributor read failed', err);
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
    const res = await backendFetch(token, `/api/documents?${libraryListQuery(input)}`, {
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
    console.warn('[biblioteca] list read failed', err);
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
    console.warn('[biblioteca] document read failed', err);
    return { state: 'unavailable' };
  }
}
