import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { errSummary } from '$lib/errorSummary';
import { backendJson } from '$lib/server/backendResponse';

/**
 * BFF proxy for rebuilding ONE document's contribution to the corpus graph
 * ("Reconstruir grafo" in Mis documentos).
 *
 * ⚠ The browser sends NO body; the id in the URL is the whole request. Who may
 * rebuild (only the uploader) and when (not during a recent in-flight run, not
 * without text) is decided by the backend's `planGraphRetry`, under the
 * caller's own JWT. This route adds no rule of its own beyond "signed in".
 */
const UPSTREAM_GRAPH_RETRY_PATH = (id: string) =>
  `/api/documents/${encodeURIComponent(id)}/graph-retry`;

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  let res: Response;
  try {
    res = await backendFetch(locals.token, UPSTREAM_GRAPH_RETRY_PATH(id), { method: 'POST' });
  } catch (err) {
    // Nothing changed upstream; the row keeps its `failed` badge and button.
    return json(
      {
        error: 'upstream_unreachable',
        detail: errSummary(err),
      },
      { status: 502 },
    );
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // 403 "not the uploader", 409 "in flight / no text", 404 "not visible":
    // passed through so the UI can say which.
    return backendJson(body, res);
  }

  // The run is armed (backend answers 202). Report only that — never `ready`.
  return backendJson({ ok: true, graphStatus: 'pending' }, res);
};
