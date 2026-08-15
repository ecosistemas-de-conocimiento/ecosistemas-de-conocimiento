/**
 * Server half of the ecosistema picker: read the caller's memberships, and
 * remember which one they chose.
 *
 * 🔴 THE CHOICE IS STORED IN AN httpOnly COOKIE, NOT IN localStorage, AND NOT ON
 * THE USER RECORD.
 *
 *  · Not `localStorage`, because the selection is an INPUT TO A SERVER
 *    DECISION — it picks the `organization` stamped on every new session, and
 *    therefore the corpora that session searches. A value the browser owns and
 *    the server merely believes is the wrong shape for that. In the cookie it
 *    arrives on the request that uses it, and the BFF re-validates it against
 *    Payload's membership-scoped list every single time.
 *  · `httpOnly`, because no client code needs to read it: the browser learns the
 *    selection from `GET /api/ecosistemas`, which returns the RESOLVED one.
 *    Nothing is lost by making it unreadable, and script-borne tampering goes
 *    with it.
 *  · Not a field on `users`, because that would be a backend schema change
 *    (a migration, an access rule, a write path) for a per-device UI preference.
 *    "Which ecosistema is this browser looking at" is genuinely per-device:
 *    someone with two ecosistemas open in two windows is a normal thing to want,
 *    and a user field would fight it. Real portability across devices belongs on
 *    the user record; this is not that.
 *
 * ⚠ THE COOKIE IS A HINT, NEVER AN AUTHORITY. Every read runs it through
 * `resolveEcosystemSelection` against the list Payload just returned for this
 * JWT. A forged or stale cookie can therefore only select an ecosistema the
 * caller already belongs to — worst case it is ignored and rewritten.
 */

import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

import {
  normalizeEcosystems,
  resolveEcosystemSelection,
  type Ecosystem,
  type EcosystemSelection,
} from '$lib/ecosystems';
import { backendFetch } from '$lib/server/auth';

/** Name of the selection cookie. Distinct from `chat_auth`; carries no authority. */
export const ECOSYSTEM_COOKIE = 'eco_selected';

/** A year. The choice is a preference — there is nothing to expire it for. */
export const ECOSYSTEM_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !dev,
    maxAge: ECOSYSTEM_COOKIE_MAX_AGE,
  };
}

/** Persist the chosen ecosistema for this browser. */
export function setEcosystemCookie(cookies: Cookies, id: string): void {
  cookies.set(ECOSYSTEM_COOKIE, id, cookieOptions());
}

/** Drop the stored choice (no memberships left to point at). */
export function clearEcosystemCookie(cookies: Cookies): void {
  cookies.delete(ECOSYSTEM_COOKIE, { path: '/' });
}

export interface EcosystemList {
  list: Ecosystem[];
  /**
   * `false` when the backend read itself failed. ⚠ Load-bearing: an empty list
   * because the backend is down must NOT be shown as "no perteneces a ningún
   * ecosistema". That screen tells someone to go ask an administrator for
   * access they already have.
   */
  ok: boolean;
}

/**
 * The caller's ecosistemas — the ones they are a MEMBER of.
 *
 * 🔴 THIS ASKS ABOUT MEMBERSHIP, NOT ABOUT READ ACCESS, and the difference is
 * the whole reason this function is shaped the way it is.
 *
 * It used to list `/api/organizations` and rely on Payload's
 * `withinMyOrganizations` access rule to scope the answer. That reasoning holds
 * for every ordinary user — and breaks completely for a PLATFORM ADMIN, whose
 * access rule short-circuits to "everything". On a system with 90 tenants the
 * admin's picker was handed all 90, took the first, and every
 * `POST /api/sessions` came back 400 `You do not belong to that ecosistema.`
 * The product was unusable for exactly the account most likely to be demoing
 * it, and perfectly fine for everyone else — so it survived every earlier test.
 *
 * "Which tenants may I read?" and "which tenants am I in?" are different
 * questions that happen to have the same answer for most people. Ask the one we
 * actually mean: filter memberships by the caller's own id rather than leaning
 * on an access rule to do it implicitly.
 *
 * Costs one extra round trip to resolve who the caller is. Worth it — the
 * alternative is decoding the JWT here, which puts a second, silently-diverging
 * notion of identity in the frontend.
 *
 * Sorted by name so the list, and therefore the fallback "first" membership, is
 * stable between requests.
 */
export async function listEcosystems(token: string | undefined): Promise<EcosystemList> {
  try {
    const meRes = await backendFetch(token, '/api/users/me?depth=0', { method: 'GET' });
    if (!meRes.ok) {
      console.warn(`[ecosistemas] backend answered ${meRes.status} identifying the caller`);
      return { list: [], ok: false };
    }
    const me = (await meRes.json().catch(() => ({}))) as { user?: { id?: unknown } | null };
    const userId = me.user?.id;
    if (userId == null || userId === '') {
      // Authenticated but unidentifiable. Not the same as "no memberships" —
      // stay quiet rather than telling someone they belong to nothing.
      console.warn('[ecosistemas] /api/users/me returned no user id');
      return { list: [], ok: false };
    }

    // ⚠ `depth=1` so each membership carries its organization row; the picker
    // needs the name, not just the id.
    const qs = new URLSearchParams({
      'where[user][equals]': String(userId),
      limit: '100',
      depth: '1',
    });
    const res = await backendFetch(token, `/api/memberships?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      // A 403 here is Payload's "empty tenant" answer in some shapes, so it is
      // not proof of a real authz problem — but it is also not proof of zero
      // memberships. Report it as a failed read and let the caller stay quiet.
      console.warn(`[ecosistemas] backend answered ${res.status} listing memberships`);
      return { list: [], ok: false };
    }
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const orgs = Array.isArray(body.docs)
      ? body.docs
          .map((m) => (m as { organization?: unknown } | null)?.organization)
          .filter((o) => o != null)
      : [];
    const list = normalizeEcosystems(orgs);
    list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return { list, ok: true };
  } catch (err) {
    console.warn('[ecosistemas] membership read failed', err);
    return { list: [], ok: false };
  }
}

export interface ResolvedEcosystem extends EcosystemSelection {
  list: Ecosystem[];
  /** See `EcosystemList.ok` — false means "we do not know", not "none". */
  ok: boolean;
}

/**
 * Which ecosistema is this request working in?
 *
 * Reads the cookie, checks it against the caller's real memberships, and
 * REWRITES the cookie whenever the answer differs — so a stale id (left the
 * ecosistema, tenant deleted, hand-edited value) self-heals on the next request
 * instead of being re-validated forever.
 */
export async function resolveEcosystem(
  cookies: Cookies,
  token: string | undefined,
): Promise<ResolvedEcosystem> {
  const { list, ok } = await listEcosystems(token);
  const requested = cookies.get(ECOSYSTEM_COOKIE);
  // ⚠ On a failed read do NOT fall back and do NOT touch the cookie: we cannot
  // tell a foreign id from an unverifiable one, and clobbering the user's real
  // choice because the backend blinked would silently move them.
  if (!ok) return { list, ok, selected: null, source: 'none' };

  const resolution = resolveEcosystemSelection(list, requested);
  if (resolution.source === 'fallback') {
    if (requested) {
      console.warn(
        `[ecosistemas] stored selection ${requested} is not a membership; ` +
          `falling back to ${resolution.selected?.id}`,
      );
    }
    if (resolution.selected) setEcosystemCookie(cookies, resolution.selected.id);
  } else if (resolution.source === 'none' && requested) {
    clearEcosystemCookie(cookies);
  }
  return { ...resolution, list, ok };
}

/**
 * The ecosistema a given conversation belongs to.
 *
 * ⚠ Read off the SESSION, not the cookie. `sessions.organization` is immutable
 * and was validated against memberships when the row was created, so it is the
 * truth about which ecosistema this conversation searches — the selection
 * cookie is only about which one the user is looking at right now. A chat turn
 * must describe the conversation's ecosistema, never the currently-selected one.
 *
 * Payload's `ownOnly` access rule means a session belonging to someone else
 * simply is not found, so this cannot be used to look up a stranger's tenant.
 * Null on any failure — the caller degrades to its old behaviour.
 */
export async function sessionEcosystemId(
  token: string | undefined,
  sessionId: string,
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const res = await backendFetch(
      token,
      `/api/sessions/${encodeURIComponent(sessionId)}?depth=0`,
      { method: 'GET' },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { organization?: unknown };
    const org = body.organization;
    if (typeof org === 'string' || typeof org === 'number') return String(org);
    // depth>0 (or a config change) would populate it as an object.
    if (org && typeof org === 'object' && 'id' in org) {
      const id = (org as { id?: unknown }).id;
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
    return null;
  } catch {
    return null;
  }
}
