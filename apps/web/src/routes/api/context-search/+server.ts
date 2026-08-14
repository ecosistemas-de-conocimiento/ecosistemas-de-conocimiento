import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeChatDomainAdapter } from '$lib/server/engine';
import { resolveEcosystem, sessionEcosystemId } from '$lib/server/ecosystem';
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
export const GET: RequestHandler = async ({ locals, url, cookies }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const q = url.searchParams.get('q') ?? '';
  const kind = url.searchParams.get('kind') ?? undefined;
  const sessionId = url.searchParams.get('sessionId') ?? '';

  // Which ecosistema to offer in the menu: the conversation's own when we can
  // read it, else the selected one. Never "the first" — someone with two
  // memberships would be offered the wrong ecosistema to `@`-mention.
  //
  // ⚠ Only resolved when the menu could actually show an ecosistema. This route
  // runs per keystroke; a document-only search must not pay for two extra
  // backend reads to answer a question it never asks.
  const organizationId =
    !kind || kind === 'org'
      ? ((await sessionEcosystemId(locals.token, sessionId)) ??
        (await resolveEcosystem(cookies, locals.token)).selected?.id ??
        null)
      : null;

  const adapter = makeChatDomainAdapter({ token: locals.token, sessionId, organizationId });
  let results: ContextSearchResult[] = [];
  try {
    results = await adapter.searchEntities(kind, q, { refs: [] });
  } catch {
    results = [];
  }
  return json({ results });
};
