import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { coerceRelationId, relationIds } from '$lib/documents';

/**
 * Attach / detach ONE existing document to / from ONE conversation.
 *
 * ── THE MODEL ──────────────────────────────────────────────────────────────
 *
 * `documents.session` is a `hasMany` relationship. A document hangs off every
 * conversation it has been added to. Attaching APPENDS this conversation to
 * that list; detaching REMOVES it. The document row itself is never copied,
 * never moved, and — from this file — never deleted.
 *
 * That is the whole point. A published document is part of the ecosistema's
 * shared brain and is reachable from anywhere. A draft belongs to the
 * conversations it was put in, so "I want to use last week's file here too"
 * has to be a real, explicit act rather than a side effect of having uploaded
 * it once.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 🔴 POST ATTACHES. DELETE DETACHES. DELETE DOES **NOT** DELETE.           │
 * │                                                                          │
 * │ `DELETE` here removes THIS conversation from the document's list and     │
 * │ nothing else. The document survives, keeps its text, its embeddings and  │
 * │ its publication state, and stays attached to every OTHER conversation it │
 * │ was in. The verb that destroys a document is `DELETE /api/documents/:id` │
 * │ — a different route, in a different folder.                              │
 * │                                                                          │
 * │ The two live one keystroke apart. Confusing them destroys somebody's     │
 * │ work, silently, in every conversation at once. If you are editing the    │
 * │ handler below and you are about to call `/api/documents/${docId}` with   │
 * │ method DELETE: stop, you are in the wrong file.                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHO IS ALLOWED ─────────────────────────────────────────────────────────
 *
 * 🔴 THE BACKEND DECIDES, not this route, and no elevated credential is used
 * anywhere here. Every call goes out as the caller's own JWT.
 *
 * Payload's `bindDocumentToEcosystem` hook already checks EVERY session id in
 * the list on every write: a conversation the caller does not own is refused,
 * and mixing two ecosistemas onto one document is refused. Re-checking here
 * would create a second, silently-diverging copy of that rule — so the backend's
 * error is passed through verbatim (status and body) instead.
 *
 * The read of the document is subject to the same access rule, so a document
 * the caller may not see simply 404s rather than telling them it exists.
 */

/**
 * ⚠ `relationIds` and `coerceRelationId` live in `$lib/server/documents` —
 * ONE reading of the `session` relationship, shared with the picker
 * (`…/documents/available`) and with "Mis documentos" (`/api/documentos`).
 * They used to be copied into each route, which is a silent way to lose every
 * OTHER conversation a document is in.
 */

interface DocRead {
  ok: boolean;
  /** Upstream status + body, for the failure pass-through. */
  status: number;
  body: Record<string, unknown>;
  /** The conversations this document is currently attached to. */
  sessionIds: string[];
}

/** Read the document as the caller, so the backend's access rule applies. */
async function readDoc(token: string | undefined, docId: string): Promise<DocRead> {
  const res = await backendFetch(
    token,
    `/api/documents/${encodeURIComponent(docId)}?depth=0`,
    { method: 'GET' },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: res.ok,
    status: res.status,
    body,
    sessionIds: relationIds(body?.session),
  };
}

/** Write the new attachment list. The hook re-validates every id in it. */
async function writeSessions(
  token: string | undefined,
  docId: string,
  sessionIds: string[],
): Promise<Response> {
  return backendFetch(token, `/api/documents/${encodeURIComponent(docId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ session: sessionIds.map(coerceRelationId) }),
  });
}

/**
 * POST /api/sessions/[id]/documents/[docId] → ATTACH.
 *
 * Idempotent: attaching a document that is already attached is a success that
 * writes nothing. A double click, a retried request and a stale picker all
 * mean the same thing to the user — "I want this here" — and it already is.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionId = String(params.id);
  const docId = String(params.docId);

  const doc = await readDoc(locals.token, docId);
  if (!doc.ok) return json(doc.body, { status: doc.status });

  if (doc.sessionIds.includes(sessionId)) {
    return json({ doc: doc.body, attached: true, changed: false }, { status: 200 });
  }

  // Append. The existing ids are kept exactly as they were — this is the one
  // place where dropping them would silently detach the document from every
  // other conversation it lives in.
  const res = await writeSessions(locals.token, docId, [...doc.sessionIds, sessionId]);
  const body = await res.json().catch(() => ({}));
  return json(body, { status: res.status });
};

/**
 * DELETE /api/sessions/[id]/documents/[docId] → DETACH.
 *
 * 🔴 THIS DOES NOT DELETE THE DOCUMENT. It removes ONE conversation from the
 * document's list. The row, its text, its embeddings and its publication state
 * are untouched, and it stays attached to every other conversation it was in.
 * See the box at the top of this file.
 *
 * Idempotent in the same way as POST: detaching something that is not attached
 * is a success that writes nothing.
 *
 * ⚠ Detaching the LAST conversation is allowed and leaves a document with no
 * conversation at all — still owned, still in its ecosistema, and retrievable
 * by nothing. That used to be a state the UI refused to create: the detach
 * action only appeared on a document that was in two or more conversations.
 *
 * It now appears on EVERY attached document, because there is finally somewhere
 * for the document to land: `/documentos` ("Mis documentos") lists everything
 * the caller owns, orphans first. The old gate did not prevent orphans — the
 * backend, the e2e suite and a deleted conversation all make them — it only
 * prevented anyone from SEEING them. The route was right to stay permissive.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionId = String(params.id);
  const docId = String(params.docId);

  const doc = await readDoc(locals.token, docId);
  if (!doc.ok) return json(doc.body, { status: doc.status });

  if (!doc.sessionIds.includes(sessionId)) {
    return json({ doc: doc.body, attached: false, changed: false }, { status: 200 });
  }

  const remaining = doc.sessionIds.filter((id) => id !== sessionId);
  const res = await writeSessions(locals.token, docId, remaining);
  const body = await res.json().catch(() => ({}));
  return json(body, { status: res.status });
};
