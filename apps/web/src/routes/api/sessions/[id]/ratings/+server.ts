import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { idOf, isValidStars } from '$lib/ratings';
import { backendJson } from '$lib/server/backendResponse';

/**
 * BFF proxy for the backend `ratings` collection — the 1–5 star rating a user
 * gives an assistant answer.
 *
 * Same shape as the sibling `messages` / `documents` routes: the browser never
 * talks to the backend, `locals.token` (the httpOnly session JWT) is attached
 * server-side by `backendFetch`, and an unauthenticated call is a 401 here
 * rather than a redirect.
 *
 * The backend fills `user` and `organization` from the authenticated request.
 * We deliberately do NOT send them: the browser has no trustworthy org id, and
 * accepting one from the client would let a user write a rating into another
 * tenant.
 */

/**
 * Payload's relationship column is `bigint` on the default Postgres adapter, so
 * a numeric id must go on the wire as a number. Non-numeric ids (a future uuid
 * mode) pass through untouched. Same coercion as the `messages` route.
 */
function coerceId(raw: string): number | string {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * GET /api/sessions/[id]/ratings → this user's ratings for this session.
 *
 * Fragile read: a 403 (Payload answers 403 rather than an empty list for an
 * empty tenant) or a transient backend failure degrades to an empty list, so a
 * chat still renders — just without its stars filled in.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const qs = new URLSearchParams({
    'where[and][0][session][equals]': String(params.id),
    'where[and][1][user][equals]': String(locals.user.id),
    limit: '1000',
    depth: '0',
  });
  const res = await backendFetch(locals.token, `/api/ratings?${qs.toString()}`, {
    method: 'GET',
  });
  const body = await res.json().catch(() => ({}));
  const out = degradeListResponse(res, body, 'ratings');
  return json(out.body, { status: out.status });
};

/**
 * POST /api/sessions/[id]/ratings → rate one assistant message.
 *
 * Body: `{ messageId: string, stars: 1..5, comment?: string }`.
 *
 * Upsert, not append: one rating per (message, user). The backend exposes
 * `POST /api/ratings/upsert` for exactly this — re-rating-updates-the-row is
 * not expressible on Payload's plain create path. One call, race-free.
 *
 * We still verify that the message belongs to the session in the URL, because
 * that URL is what gets written into the row and the client chose it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  let incoming: {
    messageId?: unknown;
    stars?: unknown;
    reason?: unknown;
    comment?: unknown;
  } = {};
  try {
    incoming = (await request.json()) as typeof incoming;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }

  const messageId = typeof incoming.messageId === 'string' ? incoming.messageId.trim() : '';
  if (!messageId) return json({ error: 'message_required' }, { status: 400 });

  const stars = incoming.stars;
  if (!isValidStars(stars)) return json({ error: 'invalid_stars' }, { status: 400 });

  const comment = typeof incoming.comment === 'string' ? incoming.comment.trim() : '';
  const reason = typeof incoming.reason === 'string' ? incoming.reason.trim() : '';

  // The session in the URL is written into the row, and the client chose it —
  // so prove the message actually belongs to it. Without this a client could
  // POST a message from thread A to /api/sessions/B/ratings and store a row
  // whose session and message disagree, poisoning every per-session read.
  // Payload's access control gates the message read, so a message this caller
  // cannot see 404s here. (Same posture as the backend's document-create fix.)
  const messageRes = await backendFetch(
    locals.token,
    `/api/messages/${encodeURIComponent(messageId)}?depth=0`,
    { method: 'GET' },
  );
  if (!messageRes.ok) return json({ error: 'message_not_found' }, { status: 404 });
  const messageDoc = (await messageRes.json().catch(() => ({}))) as { session?: unknown };
  if (idOf(messageDoc.session) !== String(params.id)) {
    return json({ error: 'message_session_mismatch' }, { status: 400 });
  }

  // Single upsert. `user` and `organization` are NOT sent: the backend derives
  // both from the session, and a client that can name them can write into
  // another ecosistema.
  const res = await backendFetch(locals.token, '/api/ratings/upsert', {
    method: 'POST',
    body: JSON.stringify({
      message: coerceId(messageId),
      session: coerceId(String(params.id)),
      stars,
      // Both always sent, so changing a rating actually CLEARS the old
      // feedback. An absent key would leave "se lo inventó" attached to a
      // score the person just moved to 5 stars.
      // ⚠ The backend rejects the pair if the reason does not belong to this
      // score, or if there is free text without `other`. We forward and let it
      // answer — duplicating that rule here is how the two drift apart.
      reason: reason || null,
      comment: comment || null,
    }),
  });

  const out = (await res.json().catch(() => ({}))) as { doc?: unknown };
  // 🔴 At Payload's default depth the reply POPULATES `doc.message`, raw
  // provenance included: chunk `sessionId`, `authoredBy` and another
  // conversation's `msg-…` id (Fable audit #8). Collapse the relations to ids.
  // The store never reads this body, so nothing is lost.
  if (out.doc && typeof out.doc === 'object') {
    const doc = out.doc as Record<string, unknown>;
    for (const rel of ['message', 'session'] as const) {
      if (doc[rel] && typeof doc[rel] === 'object') doc[rel] = idOf(doc[rel]);
    }
  }
  return backendJson(out, res);
};

/**
 * Remove your rating entirely.
 *
 * ⚠ NOT the same as rating 1 star. "This answer was bad" and "I take back what
 * I said" are different facts, and a 1-star row left behind by someone who
 * meant to withdraw drags every average down for a judgement they no longer
 * hold.
 *
 * Deletes only YOUR row: the backend's delete rule is scoped to
 * `user.equals(me)`, so this cannot remove a colleague's rating even with a
 * guessed id. We still look the row up by message first, so the client never
 * names a rating id at all.
 */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  let incoming: { messageId?: unknown } = {};
  try {
    incoming = (await request.json()) as typeof incoming;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }
  const messageId = typeof incoming.messageId === 'string' ? incoming.messageId.trim() : '';
  if (!messageId) return json({ error: 'message_required' }, { status: 400 });

  // Find MY rating for this message. Payload scopes the read to the caller, so
  // this cannot return anyone else's row.
  const qs = new URLSearchParams({
    'where[message][equals]': messageId,
    limit: '1',
    depth: '0',
  });
  const findRes = await backendFetch(locals.token, `/api/ratings?${qs.toString()}`, {
    method: 'GET',
  });
  if (!findRes.ok) return json({ error: 'upstream_failed' }, { status: 502 });

  const body = (await findRes.json().catch(() => ({}))) as { docs?: Array<{ id?: unknown }> };
  const existingId = body.docs?.[0]?.id;
  // ⚠ Already absent is SUCCESS, not 404. Two fast clicks on "quitar" should
  // both leave the person with no rating, which is what they asked for.
  if (existingId === undefined || existingId === null) {
    return json({ ok: true, removed: false });
  }

  const res = await backendFetch(
    locals.token,
    `/api/ratings/${encodeURIComponent(String(existingId))}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return backendJson({ error: 'delete_failed', detail: detail.slice(0, 300) }, res);
  }
  return json({ ok: true, removed: true });
};
