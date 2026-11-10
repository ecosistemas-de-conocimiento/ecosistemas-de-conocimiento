import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { backendJson } from '$lib/server/backendResponse';

// GET /api/documents/[id] → status / metadata for one document.
// Used by apps/web to poll ingest status for PDF/DOCX uploads (M6).
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const res = await backendFetch(locals.token, `/api/documents/${params.id}?depth=0`, {
    method: 'GET',
  });
  const out = await res.json().catch(() => ({}));
  return backendJson(out, res);
};

// PATCH /api/documents/[id] → update name / bodyMarkdown / isPinned.
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* allow empty */
  }
  const res = await backendFetch(locals.token, `/api/documents/${params.id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  return backendJson(out, res);
};

// DELETE /api/documents/[id]
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const res = await backendFetch(locals.token, `/api/documents/${params.id}`, {
    method: 'DELETE',
  });
  const out = await res.json().catch(() => ({}));
  return backendJson(out, res);
};
