import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { relationshipsToRefs } from '$lib/server/contextRefs';
import { toBackendId } from '$lib/ecosystems';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { parseSessionKind } from '$lib/sessionKind';

// GET /api/sessions → the current user's sessions IN THE SELECTED ECOSISTEMA,
// most-recent first.
//
// 🔴 THE `organization` FILTER IS NOT AN OPTIMISATION. Payload's `ownOnly`
// access rule returns every session this person owns, across every ecosistema
// they belong to — correct for access, wrong for the screen. Without this
// filter, switching ecosistema would leave the previous one's conversations in
// the sidebar, and a user cannot tell that apart from a cross-tenant leak.
// The id comes from `resolveEcosystem` (cookie → checked against memberships),
// never from the query string.
//
// Fragile read: degrade a 403-on-empty-tenant / transient backend failure to
// an empty list (with a `degraded` flag) instead of surfacing a hard error.
//
// `depth=1` so the polymorphic `contextScope` relationship is populated; we map
// each session's `[{relationTo,value}]` back to the store's `{refs:[{kind,id,
// label}]}` shape (CANONICAL ref-field contract).
//
// Each row's `kind` (`$lib/sessionKind`) is normalised: a row made before the
// Generales/Resonancias split has none and reads as `generales`. ONE read for
// both tabs; the sidebar splits the list.
export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const { selected, ok } = await resolveEcosystem(cookies, locals.token);
  if (!selected) {
    // No ecosistema (or we could not find out). Either way there is nothing
    // this user may legitimately see here, and an unfiltered read would show
    // conversations from ecosistemas the picker is not pointing at.
    return json(
      ok
        ? { docs: [], totalDocs: 0 }
        : { docs: [], totalDocs: 0, degraded: true, reason: 'unavailable' },
    );
  }

  const qs = new URLSearchParams({
    'where[organization][equals]': String(toBackendId(selected.id)),
    limit: '200',
    sort: '-lastUsedAt,-createdAt',
    depth: '1',
  });
  const res = await backendFetch(locals.token, `/api/sessions?${qs.toString()}`, {
    method: 'GET',
  });
  const body = (await res.json().catch(() => ({}))) as { docs?: Record<string, unknown>[] };
  if (Array.isArray(body.docs)) {
    for (const doc of body.docs) {
      doc.contextScope = { refs: relationshipsToRefs(doc.contextScope) };
      doc.kind = parseSessionKind(doc.kind);
    }
  }
  const out = degradeListResponse(res, body, 'sessions');
  return json(out.body, { status: out.status });
};

// POST /api/sessions → create a new session for the current user, in the
// ecosistema they have selected, of the kind the client asks for (the active
// sidebar tab). The kind is immutable after this: the PATCH route drops it.
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let incoming: { title?: string; panelState?: unknown; kind?: unknown } = {};
  try {
    incoming = (await request.json()) as typeof incoming;
  } catch {
    /* allow empty body */
  }

  // `sessions.organization` is REQUIRED on create, and a user can belong to
  // several ecosistemas — so somebody has to choose. The USER chooses, through
  // the picker; the choice reaches us as a cookie and is re-checked against
  // Payload's membership-scoped list on the way in (`resolveEcosystem`). The
  // request body is never consulted: a client that can name an org is exactly
  // the cross-tenant hole the backend closed on document-create.
  const { selected, ok } = await resolveEcosystem(cookies, locals.token);
  if (!selected) {
    // Better a clear refusal than a 400 from the backend's required-field
    // validator, which the UI cannot explain to anyone. `no_ecosystem` gets its
    // own Spanish screen; an unverifiable read is a transient failure instead.
    return json({ error: ok ? 'no_ecosystem' : 'ecosystems_unavailable' }, {
      status: ok ? 409 : 503,
    });
  }

  const now = new Date().toISOString();
  const payload = {
    // Matches `UNTITLED_SESSION` in the store, which uses it as the sentinel
    // for auto-titling from the first message.
    title: incoming.title ?? 'Nueva conversación',
    // ⚠ Sent EXPLICITLY, so the backend's `beforeValidate` compares it against
    // this caller's memberships and rejects a foreign one instead of guessing.
    // Omitting it only works for people with exactly one membership.
    organization: toBackendId(selected.id),
    panelState: incoming.panelState ?? null,
    // Anything but `resonancias` is `generales` — never a raw client string.
    kind: parseSessionKind(incoming.kind),
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
