import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeChatDomainAdapter } from '$lib/server/engine';
import type { ContextSearchResult } from '@edc/chat-engine/core';

/**
 * Context-search BFF — powers the `@`-mention typeahead in the composer.
 * Delegates to the Domain Adapter (`searchEntities`), which reads the
 * organization + the session's documents over Payload REST with the user's JWT
 * (so access control is enforced upstream).
 *
 * GET /api/context-search?q=&kind=&sessionId=
 *   q         — free-text term (optional)
 *   kind      — narrow to one kind (org|document) (optional)
 *   sessionId — the active session (needed to scope `document` results)
 *
 * Best-effort: a backend hiccup degrades to an empty result set rather than a
 * 500, so the composer stays usable.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const q = url.searchParams.get('q') ?? '';
  const kind = url.searchParams.get('kind') ?? undefined;
  const sessionId = url.searchParams.get('sessionId') ?? '';

  const adapter = makeChatDomainAdapter({ token: locals.token, sessionId });
  let results: ContextSearchResult[] = [];
  try {
    results = await adapter.searchEntities(kind, q, { refs: [] });
  } catch {
    results = [];
  }
  return json({ results });
};
