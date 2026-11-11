import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { safeReason } from '$lib/errorSummary';
import { relationIds, relationSessions } from '$lib/documents';
import { ECOSYSTEM_COOKIE, resolveEcosystem } from '$lib/server/ecosystem';
import { uploadLooseDocument } from '$lib/server/uploadDocument';

/**
 * GET /api/documentos — "Mis documentos": everything the caller owns in the
 * ecosistema they are currently looking at.
 *
 * ── 🔴 WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * Drafts are scoped to the conversations they are attached to: retrieval reads
 * the ones hanging off the current conversation and no others. That is the
 * right default, and it left one hole. A document attached to NO conversation
 * is not retrievable by anything and is not listed anywhere — every other
 * document list in this app is per-conversation. It is still owned, still
 * stored, still embedded, and completely invisible.
 *
 * Nothing exotic makes that happen. Deleting a conversation, detaching the last
 * one, an e2e run tearing down its sessions — in the dev database more than
 * half the documents were already in that state. This route is the list that
 * makes them visible again. Nothing is auto-deleted; the owner decides.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * 🔴 IT ACCEPTS NO ORGANIZATION ID FROM THE CALLER. The ecosistema comes from
 * `resolveEcosystem`, which re-validates the selection cookie against the
 * caller's real memberships on every request (read that module's header). A
 * client-named tenant id here would be a way to enumerate another ecosistema's
 * document titles — the exact thing the cookie design exists to prevent.
 *
 * 🔴 IT DOES NOT RE-IMPLEMENT TENANCY. Payload's `visibleToCaller` access rule
 * is the authority and the read goes out as the caller's own JWT. The
 * `uploadedBy` filter on top of it is a PRODUCT rule — "documents I own" —
 * not a security boundary.
 *
 * ⚠ IT NEVER RETURNS `extractedText`. For an audio document that field is the
 * entire transcript, and this list can hold every recording a person ever made.
 * `slimDoc` names the fields that go out; anything else stays on the server.
 */

/** Rows per backend page. The list reads every page (C-08, audit 2026-11-10). */
const LIST_LIMIT = 500;

/**
 * ⚠ A ceiling, not a cut: past it the reply says `truncated: true` and keeps
 * the backend's real `totalDocs`. 20 pages = 10 000 documents; the largest
 * owner on dev had 727 in one ecosistema (measured 2026-11-10, admin seed
 * account, Semiosis práctica).
 */
const MAX_PAGES = 20;

/**
 * The columns `slimDoc` reads, and no others.
 *
 * ⚠ Without a `select`, `depth=1` sent every column and every populated
 * relationship, `extractedText` included, for `slimDoc` to throw away. Measured
 * 2026-11-10 against the dev backend from outside, 500 of 727 rows: 41 MB in
 * 18.6 s; with this list, 580 KB in 0.56 s. Inside dev the old read made
 * `GET /api/documentos` take 1.6–2.0 s (browser timing, 4 loads).
 *
 * 🔴 `contentKind`, `anonymise`, `uploadedBy` and `anonymisationStatus` are
 * also what the backend's field rules read off the projected row
 * (`mayReadGatedOriginal`, `mayReadTestimonioTitle`). Drop one and `name`,
 * `bodyMarkdown` or `testimonioTitle` vanish with no error.
 */
const OWNED_DOC_FIELDS = [
  'name',
  'kind',
  'contentKind',
  'anonymise',
  'testimonioTitle',
  'ingestStatus',
  'ingestError',
  'anonymisationStatus',
  'audioMeta',
  'publicationStatus',
  'publicationError',
  'graphStatus',
  'graphError',
  'uploadedBy',
  'isPinned',
  'bodyMarkdown',
  'mediaFile',
  'processedBody',
  'session',
  'createdAt',
  'updatedAt',
] as const;

/**
 * What `depth=1` populates, per related collection. Conversation titles are
 * the reason for the depth; the uploader and the file only need an id.
 */
const POPULATE: Array<[string, string]> = [
  ['populate[sessions][title]', 'true'],
  ['populate[users][displayName]', 'true'],
  ['populate[media][filename]', 'true'],
];

function ownedDocsQuery(userId: string, organizationId: string, page: number): string {
  const qs = new URLSearchParams({
    'where[uploadedBy][equals]': userId,
    'where[organization][equals]': organizationId,
    sort: '-createdAt',
    limit: String(LIST_LIMIT),
    page: String(page),
    // ⚠ `depth=1` so `session` arrives populated and we get conversation TITLES.
    depth: '1',
  });
  for (const f of OWNED_DOC_FIELDS) qs.set(`select[${f}]`, 'true');
  for (const [k, v] of POPULATE) qs.set(k, v);
  return qs.toString();
}

/**
 * `?filter=` — `all` (default) or `sueltos`.
 *
 * `sueltos` = attached to no conversation at all. It is the case people will
 * actually come looking for, so it gets a name rather than a client-side
 * checkbox: the answer has to be computed from the relationship anyway.
 */
export type DocFilter = 'all' | 'sueltos';

function parseFilter(raw: string | null): DocFilter {
  return raw === 'sueltos' ? 'sueltos' : 'all';
}

/**
 * The fields that leave this server, and nothing else.
 *
 * ⚠ An allow-list, not a delete-list. `extractedText` is the field that must
 * never appear here, and a list of what to REMOVE would silently start leaking
 * the next large field somebody adds to the collection.
 *
 * `session` is rewritten to `[{id, title}]`: the store's `docFromBackend`
 * already reads ids out of that shape, and the view needs the titles to say
 * WHICH conversations a document is being used in.
 */
function slimDoc(row: Record<string, unknown>, callerId: string): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    // A testimonio's generated title (`workingDocHeading`); the backend's read
    // rule already withholds it until the gate clears the row.
    contentKind: row.contentKind,
    testimonioTitle: row.testimonioTitle,
    ingestStatus: row.ingestStatus,
    // Rows from before 2026-11-10 may hold database text (`safeReason`).
    ingestError: safeReason(row.ingestError),
    anonymisationStatus: row.anonymisationStatus,
    audioMeta: row.audioMeta,
    publicationStatus: row.publicationStatus,
    publicationError: safeReason(row.publicationError),
    graphStatus: row.graphStatus,
    graphError: safeReason(row.graphError),
    // ⚠ A boolean, not the uploader's id: the view only needs to know whether
    // the backend's graph-retry rule ("only the uploader") lets this caller in.
    uploadedByCaller: relationIds(row.uploadedBy)[0] === callerId,
    isPinned: row.isPinned,
    bodyMarkdown: row.bodyMarkdown,
    // An uploaded `.md` is not an in-app note (`WorkingDoc.isNote`).
    hasFile: row.mediaFile != null,
    processedBody: row.processedBody,
    session: relationSessions(row.session),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const filter = parseFilter(url.searchParams.get('filter'));

  // Which ecosistema. From the validated cookie — never from `url.searchParams`.
  const { selected, ok } = await resolveEcosystem(cookies, locals.token);
  if (!ok) {
    // ⚠ "We could not find out", not "you have none". Listing nothing here
    // would tell someone their documents are gone because a backend blinked.
    console.warn('[documentos] could not resolve the ecosistema; returning an empty list');
    return json({ docs: [], totalDocs: 0, degraded: true, reason: 'unavailable' }, { status: 200 });
  }
  if (!selected) {
    // Genuinely no membership. There is no ecosistema to hold documents, so an
    // empty list is the true answer — the view's own empty state explains it.
    return json({ docs: [], totalDocs: 0 }, { status: 200 });
  }

  // ⚠ EVERY PAGE, not the first 500 (C-08): a single read cut the list at 500
  // and reported `totalDocs: 500`, so the oldest documents could not be opened,
  // deleted or published from here. Measured on dev 2026-11-10: 727 owned.
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const res = await backendFetch(
      locals.token,
      `/api/documents?${ownedDocsQuery(String(locals.user.id), selected.id, page)}`,
      { method: 'GET' },
    );
    const body = await res.json().catch(() => ({}));
    const out = degradeListResponse(res, body, 'documentos');
    // 401 passes through as a real 401 so the browser's session layer can act on
    // it; everything else is already the degraded empty list. ⚠ A later page
    // failing degrades the whole list too: half a list with no flag reads as
    // "the rest are gone".
    if (out.kind !== 'ok') return json(out.body, { status: out.status });
    const docs = (out.body as { docs?: unknown }).docs;
    if (Array.isArray(docs)) rows.push(...(docs as Record<string, unknown>[]));
    if ((out.body as { hasNextPage?: unknown }).hasNextPage !== true) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      console.warn(`[documentos] stopped after ${MAX_PAGES} pages of ${LIST_LIMIT}`);
      break;
    }
  }

  // ⚠ The `sueltos` filter is applied HERE, not pushed into the Payload query.
  // "Attached to nothing" on a hasMany relationship has no `where` spelling we
  // trust across adapters, and getting it subtly wrong would hide exactly the
  // documents this screen exists to surface. One array scan is cheap.
  const docs = rows
    .filter((row) => row && row.id != null)
    .filter((row) => (filter === 'sueltos' ? relationIds(row.session).length === 0 : true))
    .map((row) => slimDoc(row, String(locals.user!.id)));

  return json(
    { docs, totalDocs: docs.length, filter, ...(truncated ? { truncated: true } : {}) },
    { status: 200 },
  );
};

/**
 * POST /api/documentos — upload a file into the ecosistema with no
 * conversation ("Subir documento" in Mis documentos, UX demo backlog #15).
 *
 * 🔴 IT GOES TO THE SELECTED ECOSISTEMA — the switcher cookie, validated by
 * `resolveEcosystem` against the caller's memberships. The backend checks the
 * membership again (`Documents.ts`), so neither layer trusts the other.
 *
 * 🔴 A COOKIE NAMING A NON-MEMBER ECOSISTEMA IS REFUSED (403), not quietly
 * replaced by the fallback: the person would be looking at one ecosistema and
 * filing into another. The list read already rewrote the cookie, so the next
 * page load shows the ecosistema they really are in.
 */
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return json({ error: 'multipart_missing_file' }, { status: 400 });
  }

  const requested = cookies.get(ECOSYSTEM_COOKIE);
  const { selected, ok } = await resolveEcosystem(cookies, locals.token);
  if (!ok) return json({ error: 'upstream_unavailable' }, { status: 503 });
  if (!selected) return json({ error: 'no_ecosystem' }, { status: 403 });
  if (requested && requested !== selected.id) {
    return json({ error: 'ecosystem_forbidden' }, { status: 403 });
  }

  const { status, body } = await uploadLooseDocument(
    locals.token,
    await request.formData(),
    selected.id,
  );
  return json(body, { status });
};
