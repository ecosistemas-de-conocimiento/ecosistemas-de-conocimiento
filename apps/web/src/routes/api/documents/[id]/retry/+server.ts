import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { backendJson } from '$lib/server/backendResponse';

/**
 * BFF proxy for re-running a FAILED ingest / transcription.
 *
 * ⚠ THIS IS WHY `failed` IS ALLOWED TO BE A VISIBLE STATE. Without a way out,
 * the only honest options would be to hide the failure or to revert the row to
 * "queued" and let the user wonder why nothing ever happens. The document keeps
 * its reason (`ingestError`), shows it, and this is the button.
 *
 * ⚠ The browser sends NO body — the document id in the URL is the whole
 * request. Whether there is anything to retry, and whether retrying means
 * "re-embed the text we already have" or "transcribe the recording again", is
 * decided entirely on the backend (`planIngestRetry`). A client that could
 * choose would be a client that could burn CPU-hours by asking twice.
 */
const UPSTREAM_RETRY_PATH = (id: string) =>
  `/api/documents/${encodeURIComponent(id)}/retry`;

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  let res: Response;
  try {
    res = await backendFetch(locals.token, UPSTREAM_RETRY_PATH(id), { method: 'POST' });
  } catch (err) {
    // DNS / connect / TLS failure. Nothing changed upstream, so the caller
    // should keep rendering the document exactly as it was.
    return json(
      {
        error: 'upstream_unreachable',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
      { status: 502 },
    );
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Pass the status through: 403 "not yours", 409 "nothing to retry" and a
    // 5xx are three different things the caller should not have to guess at.
    return backendJson(body, res);
  }

  // The backend accepted the re-run; the row is back at `pending` and the
  // afterChange hook has it. We report only that — never a completed state.
  return backendJson({ ok: true, ingestStatus: 'pending' }, res);
};
