import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { idOf, isValidStars } from '$lib/ratings';

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

  let incoming: { messageId?: unknown; stars?: unknown; comment?: unknown } = {};
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
      // Always sent, so clearing a comment actually clears it. An absent key
      // would leave a stale comment attached to a changed rating.
      comment: comment || null,
    }),
  });

  const out = await res.json().catch(() => ({}));
  return json(out, { status: res.status });
};
