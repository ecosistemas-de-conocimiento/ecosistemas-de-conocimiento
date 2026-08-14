import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { relationshipsToRefs } from '$lib/server/contextRefs';

// GET /api/sessions → list the current user's sessions, most-recent first.
// Fragile read: degrade a 403-on-empty-tenant / transient backend failure to
// an empty list (with a `degraded` flag) instead of surfacing a hard error.
//
// `depth=1` so the polymorphic `contextScope` relationship is populated; we map
// each session's `[{relationTo,value}]` back to the store's `{refs:[{kind,id,
// label}]}` shape (CANONICAL ref-field contract).
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const res = await backendFetch(
    locals.token,
    `/api/sessions?limit=200&sort=-lastUsedAt,-createdAt&depth=1`,
    { method: 'GET' },
  );
  const body = (await res.json().catch(() => ({}))) as { docs?: Record<string, unknown>[] };
  if (Array.isArray(body.docs)) {
    for (const doc of body.docs) {
      doc.contextScope = { refs: relationshipsToRefs(doc.contextScope) };
    }
  }
  const out = degradeListResponse(res, body, 'sessions');
  return json(out.body, { status: out.status });
};

/**
 * Resolve which ecosistema a new session belongs to.
 *
 * `sessions.organization` is REQUIRED on create, and a user can belong to
 * several ecosistemas — so somebody has to choose. It is resolved HERE, not
 * sent by the browser: Payload scopes `/api/organizations` to what this user
 * may read, so the list is already the user's own memberships and the client
 * never gets to name a tenant. (A client that can name an org is exactly the
 * cross-tenant hole the backend just closed on document-create.)
 *
 * ⚠ GAP: with more than one membership this silently takes the first. There is
 * no ecosistema picker in the UI yet — see the README. `limit=2` so the caller
 * can detect the ambiguity and log it.
 */
async function resolveOrganizationId(
  token: string | undefined,
): Promise<{ id: number | string | null; ambiguous: boolean }> {
  try {
    const res = await backendFetch(token, '/api/organizations?limit=2&depth=0', {
      method: 'GET',
    });
    if (!res.ok) return { id: null, ambiguous: false };
    const body = (await res.json().catch(() => ({}))) as {
      docs?: { id?: number | string }[];
    };
    const docs = body.docs ?? [];
    return { id: docs[0]?.id ?? null, ambiguous: docs.length > 1 };
  } catch {
    return { id: null, ambiguous: false };
  }
}

// POST /api/sessions → create a new session for the current user.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let incoming: { title?: string; panelState?: unknown } = {};
  try {
    incoming = (await request.json()) as typeof incoming;
  } catch {
    /* allow empty body */
  }

  const { id: organization, ambiguous } = await resolveOrganizationId(locals.token);
  if (organization == null) {
    // Better a clear refusal than a 400 from the backend's required-field
    // validator, which the UI cannot explain to anyone.
    return json({ error: 'no_ecosystem' }, { status: 409 });
  }
  if (ambiguous) {
    console.warn(
      `[sessions] user ${locals.user.id} belongs to more than one ecosistema; ` +
        `defaulting the new session to ${organization}. Needs a picker.`,
    );
  }

  const now = new Date().toISOString();
  const payload = {
    // Matches `UNTITLED_SESSION` in the store, which uses it as the sentinel
    // for auto-titling from the first message.
    title: incoming.title ?? 'Nueva conversación',
    // REQUIRED by the backend. Resolved server-side; never taken from the body.
    organization,
    panelState: incoming.panelState ?? null,
    lastUsedAt: now,
  };
  const res = await backendFetch(locals.token, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return json(body, { status: res.status });
  return json(body, { status: 201 });
};
