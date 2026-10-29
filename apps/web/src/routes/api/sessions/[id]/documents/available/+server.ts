import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { relationIds } from '$lib/documents';
import { sessionEcosystemId } from '$lib/server/ecosystem';

/**
 * GET /api/sessions/[id]/documents/available
 *
 * The documents this caller could ATTACH to this conversation: their own
 * documents in this conversation's ecosistema that are not already attached
 * to it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A published document is part of the ecosistema's shared brain and is reached
 * by retrieval from anywhere. A DRAFT is not: it belongs to the conversation it
 * was uploaded into. That is the right default — a draft uploaded while asking
 * about one thing should not quietly answer questions about another — but it
 * leaves one real need uncovered: "I already uploaded that file last week, and
 * I want to use it here too."
 *
 * This route feeds that picker. Attaching APPENDS this conversation to the
 * document's `session` list; the row is never copied and never moved.
 *
 * ── WHAT THIS ROUTE DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * 🔴 It does not re-implement tenancy. Payload's `visibleToCaller` access rule
 * already scopes `/api/documents` to "mine, plus published ones in my
 * ecosistemas", and that rule is the authority. A second, hand-written copy of
 * it here would be a second place to get it wrong.
 *
 * 🔴 It accepts NO organization id from the caller. The ecosistema is read off
 * the SESSION (`sessionEcosystemId`), which Payload only hands over for a
 * conversation the caller owns. A client-named org id here would be a way to
 * enumerate another tenant's document titles.
 *
 * The `uploadedBy` filter is a product rule, not a security one: a draft is
 * private to its uploader, so somebody else's draft is not attachable, and a
 * published document is already reachable by retrieval without being attached
 * to anything. Offering only your own documents keeps the list to what
 * attaching would actually change.
 */

/** Payload list reads are capped; 500 is the same ceiling the sibling docs list uses. */
const LIST_LIMIT = '500';

/** The empty answer, in the shape `degradeListResponse` produces. */
function emptyList(reason: 'forbidden' | 'unavailable') {
  return { docs: [], totalDocs: 0, degraded: true, reason };
}

/**
 * The fields `docFromBackend` (the store's mapper) actually reads, and nothing
 * else.
 *
 * ⚠ `extractedText` is left out ON PURPOSE. For an audio document it holds the
 * whole transcript, and this list can hold every recording a person ever
 * uploaded — a picker that shows a name and a badge has no business shipping
 * hours of text to the browser to render two lines. The attached list
 * (`GET …/documents`) still carries it, so a document loses nothing by being
 * attached through here.
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
    // Every row here is the caller's (`where[uploadedBy]` below). An uploaded
    // `.md` is not an in-app note (`WorkingDoc.isNote`).
    uploadedByCaller: true,
    hasFile: row.mediaFile != null,
    processedBody: row.processedBody,
    session: row.session,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionId = String(params.id);

  // 1. What is ALREADY here. Read this first: if we cannot tell what is
  //    attached, we must not offer a list at all — a picker that re-offers a
  //    document already in the panel reads as broken, and the attach it
  //    triggers is a no-op the user cannot explain.
  const attachedQs = new URLSearchParams({
    'where[session][equals]': sessionId,
    limit: LIST_LIMIT,
    depth: '0',
  });
  const attachedRes = await backendFetch(
    locals.token,
    `/api/documents?${attachedQs.toString()}`,
    { method: 'GET' },
  );
  const attachedBody = await attachedRes.json().catch(() => ({}));
  const attached = degradeListResponse(attachedRes, attachedBody, 'documents:attached');
  if (attached.kind !== 'ok') {
    // 401 passes through as a real 401; anything else is already the empty
    // degraded list.
    return json(attached.body, { status: attached.status });
  }
  const attachedIds = new Set(
    (Array.isArray((attached.body as { docs?: unknown }).docs)
      ? ((attached.body as { docs: unknown[] }).docs as Record<string, unknown>[])
      : []
    ).map((row) => String(row?.id ?? '')),
  );

  // 2. Which ecosistema this conversation searches. Off the session, never off
  //    the selection cookie and never off the query string — a conversation's
  //    ecosistema is immutable and is the only correct answer here.
  //
  // ⚠ Null means "we could not find out", not "none". Offering documents we
  // cannot place would list rows the backend's `bindDocumentToEcosystem` hook
  // will refuse to attach ("one document, one ecosistema"), so degrade to an
  // empty list instead of showing a menu of failures.
  const organizationId = await sessionEcosystemId(locals.token, sessionId);
  if (!organizationId) {
    console.warn(
      `[available] could not resolve the ecosistema of session ${sessionId}; ` +
        'returning an empty attachable list',
    );
    return json(emptyList('unavailable'), { status: 200 });
  }

  // 3. The caller's own documents in that ecosistema.
  const qs = new URLSearchParams({
    'where[uploadedBy][equals]': String(locals.user.id),
    'where[organization][equals]': organizationId,
    sort: '-createdAt',
    limit: LIST_LIMIT,
    depth: '0',
  });
  const res = await backendFetch(locals.token, `/api/documents?${qs.toString()}`, {
    method: 'GET',
  });
  const body = await res.json().catch(() => ({}));
  const out = degradeListResponse(res, body, 'documents:available');
  if (out.kind !== 'ok') return json(out.body, { status: out.status });

  const rows = Array.isArray((out.body as { docs?: unknown }).docs)
    ? ((out.body as { docs: unknown[] }).docs as Record<string, unknown>[])
    : [];
  const docs = rows
    .filter((row) => {
      const id = String(row?.id ?? '');
      if (!id) return false;
      if (attachedIds.has(id)) return false;
      // Belt and braces: the row's own `session` list is the authority on
      // where it is attached, and it costs one array scan to not depend on
      // the first read having been complete.
      return !relationIds(row.session).includes(sessionId);
    })
    .map(slimDoc);

  return json({ docs, totalDocs: docs.length }, { status: 200 });
};
