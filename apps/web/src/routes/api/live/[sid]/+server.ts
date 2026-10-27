import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { ECOSYSTEM_COOKIE } from '$lib/server/ecosystem';

/**
 * POST   /api/live/:sid?offset=N — one recorder slice → live partial text.
 * DELETE /api/live/:sid          — recording stopped.
 *
 * Same-origin pass-through to the backend's `/api/live/:sid`, which binds the
 * session to the caller and forwards to audio-service.
 *
 * 🔴 The partial text is raw, pre-gate testimony. It goes back in this response
 * only: nothing is stored, logged or cached here.
 */

const NO_STORE = { 'cache-control': 'no-store' };

export const POST: RequestHandler = async ({ locals, params, url, request, cookies }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const offset = url.searchParams.get('offset') ?? '0';
  // The selected ecosistema, as a hint: the backend checks membership and the
  // `liveMic` switch (`lib/features.ts`) and 403s otherwise.
  const organization = cookies.get(ECOSYSTEM_COOKIE) ?? '';
  // 🔴 The conversation the recording uploads into: when named, the backend
  // checks ITS ecosistema and ignores the cookie's (they can differ).
  const conversation = url.searchParams.get('conversation');
  let res: Response;
  try {
    res = await backendFetch(
      locals.token,
      `/api/live/${encodeURIComponent(params.sid)}?organization=${encodeURIComponent(organization)}` +
        (conversation ? `&conversation=${encodeURIComponent(conversation)}` : '') +
        `&offset=${encodeURIComponent(offset)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await request.arrayBuffer(),
      },
    );
  } catch {
    return json({ error: 'live_unreachable' }, { status: 502, headers: NO_STORE });
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json', ...NO_STORE },
  });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  try {
    await backendFetch(locals.token, `/api/live/${encodeURIComponent(params.sid)}`, {
      method: 'DELETE',
    });
  } catch {
    // The session expires on its own.
  }
  return new Response(null, { status: 204, headers: NO_STORE });
};
