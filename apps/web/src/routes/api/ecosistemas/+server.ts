import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { belongsTo, findEcosystem } from '$lib/ecosystems';
import { listEcosystems, resolveEcosystem, setEcosystemCookie } from '$lib/server/ecosystem';

/**
 * The ecosistema picker's BFF.
 *
 *   GET  /api/ecosistemas   → the caller's ecosistemas + the resolved selection
 *   POST /api/ecosistemas   → choose one (validated, then remembered in a cookie)
 *
 * ⚠ The browser never sends an ecosistema id anywhere ELSE. It picks one here,
 * once; every other route resolves the selection server-side from the cookie.
 * That is what keeps "the client cannot name a tenant" true of the whole app
 * rather than of one endpoint.
 */

// GET → what the picker renders, and which one is current.
export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const { list, selected, ok } = await resolveEcosystem(cookies, locals.token);

  // ⚠ `degraded` is not cosmetic here. Zero ecosistemas has a dedicated screen
  // ("pide que te agreguen a uno"), and showing it because the backend is down
  // would tell someone with perfectly good access to go ask for access. The
  // client shows the unavailable banner on this flag instead.
  return json({
    ecosistemas: list,
    selectedId: selected?.id ?? null,
    ...(ok ? {} : { degraded: true, reason: 'unavailable' }),
  });
};

interface SelectBody {
  id?: unknown;
}

// POST → switch. The id is CHECKED against this user's memberships before the
// cookie is written; the backend checks it again on the next session create.
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  let body: SelectBody;
  try {
    body = (await request.json()) as SelectBody;
  } catch {
    return json({ error: 'invalid_body' }, { status: 400 });
  }
  const wanted = body.id;
  if (typeof wanted !== 'string' && typeof wanted !== 'number') {
    return json({ error: 'invalid_body' }, { status: 400 });
  }

  const { list, ok } = await listEcosystems(locals.token);
  if (!ok) {
    // We could not verify membership. Refusing is the only safe answer — the
    // alternative is writing an unverified tenant id into a cookie that every
    // later request treats as a hint.
    return json({ error: 'ecosystems_unavailable' }, { status: 503 });
  }
  if (list.length === 0) {
    return json({ error: 'no_ecosystem' }, { status: 409 });
  }

  // 🔴 The refusal branch. A deliberate switch to an ecosistema the caller does
  // not belong to is an error, NOT something to quietly resolve to a different
  // one: silently answering with somebody else's ecosistema selected is how a
  // user ends up publishing into a tenant they never chose.
  if (!belongsTo(list, wanted)) {
    console.warn(
      `[ecosistemas] user ${locals.user.id} tried to select ${String(wanted)}, ` +
        'which is not one of their memberships',
    );
    return json({ error: 'not_a_member' }, { status: 403 });
  }

  const selected = findEcosystem(list, wanted)!;
  setEcosystemCookie(cookies, selected.id);
  return json({ selected, ecosistemas: list });
};
