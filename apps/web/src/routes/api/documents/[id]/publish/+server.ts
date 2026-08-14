import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { parsePublicationStatus } from '$lib/publication';

/**
 * BFF proxy for publishing a document into the ecosistema's shared corpus.
 *
 * Same pattern as the sibling document + rating routes: the browser never
 * reaches the backend, `locals.token` is attached server-side by
 * `backendFetch`, and an unauthenticated call is a 401 here.
 *
 * ⚠ The browser sends NO body at all — not the org, not the user, not the
 * target visibility. The document id in the URL is the entire request, and the
 * backend derives owner and ecosistema from the session. A client that could
 * name an ecosistema could publish into someone else's.
 *
 * ⚠ ASSUMED BACKEND SHAPE (not settled when this was written):
 *   - the upstream route is `POST /api/documents/:id/publish`;
 *   - retrying a `failed` publish is the same call (idempotent per document),
 *     not a separate verb.
 * Both assumptions are confined to the single `backendFetch` line below — if
 * the backend agent lands a different path or verb, this is the only edit.
 */
const UPSTREAM_PUBLISH_PATH = (id: string) =>
  `/api/documents/${encodeURIComponent(id)}/publish`;

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  let res: Response;
  try {
    res = await backendFetch(locals.token, UPSTREAM_PUBLISH_PATH(id), { method: 'POST' });
  } catch (err) {
    // DNS / connect / TLS failure — the backend is not reachable at all. The
    // document stays exactly as it was, which is what the caller will render.
    return json(
      {
        error: 'upstream_unreachable',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
      { status: 502 },
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    doc?: Record<string, unknown>;
    publicationStatus?: unknown;
  };

  if (!res.ok) {
    // Pass the status through so the caller can tell "not yours" (403) from
    // "backend is down" (5xx). No status change is implied either way.
    return json(body, { status: res.status });
  }

  /**
   * Normalise the answer to `{ publicationStatus, publicationError }`.
   *
   * We report the status the BACKEND returned, never an assumed `publishing`.
   * The caller repaints from this, and painting a state the server did not
   * confirm is exactly the lie this feature must not tell. If the response is
   * unreadable, `parsePublicationStatus` yields `draft` — the private reading.
   */
  // Payload wraps a mutation result in `{ doc }`, but a custom endpoint may
  // return the document flat. Accept either rather than depending on which.
  const doc = (body.doc ?? body) as Record<string, unknown>;
  return json(
    {
      publicationStatus: parsePublicationStatus(doc.publicationStatus),
      publicationError:
        typeof doc.publicationError === 'string' ? doc.publicationError : null,
    },
    { status: res.status },
  );
};
