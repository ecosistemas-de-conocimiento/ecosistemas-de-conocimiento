/**
 * Ask the backend which corpora a session may retrieve from, and as of when.
 *
 * Kept apart from `./retrieval.ts` so that module stays free of `$env` and can
 * be unit-tested as pure logic. This file is the I/O half.
 *
 * 🔴 The backend is the SOLE derivation point for corpus names — there is
 * deliberately no `eco-${orgId}` template in this app. A client that can
 * compose a corpus name can address another ecosistema's corpus.
 */

import { backendFetch } from '$lib/server/auth';
import { parseCorporaResponse, type SessionCorpora } from './retrieval';

const EMPTY: SessionCorpora = {
  corpora: [],
  asOf: null,
  draftCorpus: null,
  publishedCorpus: null,
};

/**
 * `GET /api/sessions/:id/corpora` → the caller's corpora + the `asOf` clock.
 *
 * Best-effort by shape, but NOT permissive by consequence: a failure yields
 * `asOf: null`, and `buildRetrieveBody` then refuses to issue any retrieve at
 * all. Losing retrieval on a bad read is the safe direction; retrieving
 * unscoped would surface unpublished documents.
 */
export async function fetchSessionCorpora(
  token: string | undefined,
  sessionId: string,
): Promise<SessionCorpora> {
  if (!sessionId) return EMPTY;
  try {
    const res = await backendFetch(
      token,
      `/api/sessions/${encodeURIComponent(sessionId)}/corpora`,
      { method: 'GET' },
    );
    if (!res.ok) {
      console.error(
        `[corpora] backend answered ${res.status} for session ${sessionId}; ` +
          'retrieval will be skipped this turn rather than run unscoped.',
      );
      return EMPTY;
    }
    return parseCorporaResponse(await res.json());
  } catch (err) {
    console.error('[corpora] read failed; skipping retrieval this turn:', err);
    return EMPTY;
  }
}
