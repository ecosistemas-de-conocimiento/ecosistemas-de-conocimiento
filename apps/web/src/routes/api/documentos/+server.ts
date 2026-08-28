import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { relationIds, relationSessions } from '$lib/documents';
import { resolveEcosystem } from '$lib/server/ecosystem';

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

/** Payload list reads are capped; the same ceiling the sibling document lists use. */
const LIST_LIMIT = '500';

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
function slimDoc(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ingestStatus: row.ingestStatus,
    ingestError: row.ingestError,
    audioMeta: row.audioMeta,
    publicationStatus: row.publicationStatus,
    publicationError: row.publicationError,
    isPinned: row.isPinned,
    bodyMarkdown: row.bodyMarkdown,
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

  // ⚠ `depth=1` so `session` arrives populated and we get conversation TITLES.
  // It also populates the rest of the relationships; `slimDoc` drops them.
  const qs = new URLSearchParams({
    'where[uploadedBy][equals]': String(locals.user.id),
    'where[organization][equals]': selected.id,
    sort: '-createdAt',
    limit: LIST_LIMIT,
    depth: '1',
  });
  const res = await backendFetch(locals.token, `/api/documents?${qs.toString()}`, {
    method: 'GET',
  });
  const body = await res.json().catch(() => ({}));
  const out = degradeListResponse(res, body, 'documentos');
  // 401 passes through as a real 401 so the browser's session layer can act on
  // it; everything else is already the degraded empty list.
  if (out.kind !== 'ok') return json(out.body, { status: out.status });

  const rows = Array.isArray((out.body as { docs?: unknown }).docs)
    ? ((out.body as { docs: unknown[] }).docs as Record<string, unknown>[])
    : [];

  // ⚠ The `sueltos` filter is applied HERE, not pushed into the Payload query.
  // "Attached to nothing" on a hasMany relationship has no `where` spelling we
  // trust across adapters, and getting it subtly wrong would hide exactly the
  // documents this screen exists to surface. One array scan is cheap.
  const docs = rows
    .filter((row) => row && row.id != null)
    .filter((row) => (filter === 'sueltos' ? relationIds(row.session).length === 0 : true))
    .map(slimDoc);

  return json({ docs, totalDocs: docs.length, filter }, { status: 200 });
};
