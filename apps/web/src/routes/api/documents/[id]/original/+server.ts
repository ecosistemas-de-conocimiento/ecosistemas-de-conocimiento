import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { downloadName } from '$lib/server/downloadName';

/**
 * GET /api/documents/[id]/original — the file as it was uploaded.
 * "Descargar original" in Mis documentos (UX demo backlog #15).
 *
 * 🔴 UPLOADER ONLY, checked here AND upstream. The backend's `Media.access.read`
 * already limits the bytes to the uploader or, for a published file, the
 * ecosistema. This route narrows it further to the uploader, because the only
 * screen that offers the button lists the caller's own documents. For a Voz
 * that matters: the original is the un-anonymised file, and nobody but the
 * person who filed it should get it through this route.
 *
 * ⚠ Both reads run under the caller's own JWT, so the backend's access rules
 * apply to each. This route adds no privilege; it only removes some.
 */

function relationId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    const id = (raw as { id?: unknown }).id;
    return id === null || id === undefined ? null : String(id);
  }
  return String(raw);
}

/** `Content-Disposition` for a filename that may hold accents or quotes. */
function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  let docRes: Response;
  try {
    docRes = await backendFetch(locals.token, `/api/documents/${encodeURIComponent(id)}?depth=1`, {
      method: 'GET',
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, { status: 502 });
  }
  // 403 and 404 both read as "not found": no hint that the id exists.
  if (!docRes.ok) return json({ error: 'not_found' }, { status: docRes.status === 401 ? 401 : 404 });

  const doc = (await docRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (relationId(doc.uploadedBy) !== String(locals.user.id)) {
    return json({ error: 'not_found' }, { status: 404 });
  }

  const media = doc.mediaFile;
  const filename =
    media && typeof media === 'object' && typeof (media as { filename?: unknown }).filename === 'string'
      ? (media as { filename: string }).filename
      : null;
  // A note written in the app has no file behind it.
  if (!filename) return json({ error: 'no_original' }, { status: 404 });

  let fileRes: Response;
  try {
    fileRes = await backendFetch(locals.token, `/api/media/file/${encodeURIComponent(filename)}`, {
      method: 'GET',
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, { status: 502 });
  }
  if (!fileRes.ok || !fileRes.body) {
    return json({ error: 'not_found' }, { status: fileRes.status === 401 ? 401 : 404 });
  }

  const headers = new Headers({
    'Content-Type': fileRes.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': attachmentHeader(downloadName(doc.name, filename)),
    'Cache-Control': 'private, no-store',
  });
  const length = fileRes.headers.get('content-length');
  if (length) headers.set('Content-Length', length);
  return new Response(fileRes.body, { status: 200, headers });
};
