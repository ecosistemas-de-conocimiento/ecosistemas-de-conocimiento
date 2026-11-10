import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { backendJson } from '$lib/server/backendResponse';

/**
 * `PATCH /api/documents/[id]/note` — the note editor's autosave: name, body, pin.
 *
 * 🔴 A narrow column write in the backend (`lib/studentNotes.ts`), never the
 * whole-row PATCH: that one wrote stale publication and pipeline columns back
 * while "Publicar" was running. It never starts processing.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_body' }, { status: 400 });
  }
  const res = await backendFetch(locals.token, `/api/documents/${encodeURIComponent(params.id)}/note`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  return backendJson(out, res);
};
