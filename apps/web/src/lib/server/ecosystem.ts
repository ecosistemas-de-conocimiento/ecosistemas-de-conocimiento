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

import { safeErrMessage } from '$lib/errorSummary';
import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

import {
  normalizeEcosystems,
  resolveEcosystemSelection,
  type Ecosystem,
  type EcosystemSelection,
} from '$lib/ecosystems';
import { backendFetch } from '$lib/server/auth';
import { parseSessionKind, type SessionKind } from '$lib/sessionKind';

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
    if (res.status === 403) {
      // 🔴 A 403 HERE MEANS "NO MEMBERSHIPS", NOT AN OUTAGE. The backend's
      // `memberships.read` is `withinMyOrganizations()`, which returns `false`
      // (→ 403 on a list) for an identified, non-admin caller who belongs to
      // no organization — it refuses rather than build an empty `in: []`
      // constraint. `/api/users/me` already answered above, so the backend is
      // up and knows who this is. Reading this as a failed read showed a brand
      // new account "problemas para llegar al servidor" and "No disponible"
      // instead of the "pide que te agreguen" screen (UX backlog #6).
      // (A deactivated account lands here too; "ask an administrator" is the
      // right advice for it as well.)
      console.warn('[ecosistemas] backend answered 403 listing memberships; treating as none');
      return { list: [], ok: true };
    }
    if (!res.ok) {
      console.warn(`[ecosistemas] backend answered ${res.status} listing memberships`);
      return { list: [], ok: false };
    }
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const orgs = Array.isArray(body.docs)
      ? body.docs
          // ⚠ Mirror the backend's `membershipsForUser`: it ignores inactive
          // memberships and switched-off organizations, so `POST /api/sessions`
          // answers 400 for them. Offering one here is offering a dead end.
          // 🔴 `=== true`, NOT `!== false`: the backend asks for `isActive =
          // true` on both rows (`lib/permissions.ts`), so a NULL or missing
          // flag is INACTIVE there and must be inactive here. Fail closed.
          .filter((m) => (m as { isActive?: unknown } | null)?.isActive === true)
          .map((m) => (m as { organization?: unknown } | null)?.organization)
          .filter((o) => o != null && (o as { isActive?: unknown }).isActive === true)
      : [];
    const list = normalizeEcosystems(orgs);
    list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return { list, ok: true };
  } catch (err) {
    console.warn('[ecosistemas] membership read failed', safeErrMessage(err));
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
  const meta = await sessionMeta(token, sessionId);
  return meta.ok ? meta.organizationId : null;
}

/**
 * What one read of the session row tells a chat turn, or `ok: false` when the
 * row could not be read (non-2xx, a throw, an unreadable body).
 *
 * 🔴 A failed read carries NO kind. The kind picks the engine config, and a
 * guess would run a Resonancias conversation as Generales (or the reverse)
 * without anyone noticing; `/api/generate` refuses the turn instead.
 */
export type SessionMeta =
  | {
      ok: true;
      /** {@link sessionEcosystemId}'s answer. */
      organizationId: string | null;
      /**
       * `sessions.kind` (`$lib/sessionKind`): which engine config the turn
       * runs. Immutable after create. A row with no kind (made before the
       * split) is `generales`.
       */
      kind: SessionKind;
      /**
       * 🔴 R77: `sessions.evalRun` — set only on a conversation an eval run
       * opened (`/api/evals/session`); `/api/generate` then refuses any turn
       * not driven by the runner.
       */
      evalRun: string | null;
    }
  | { ok: false };

/**
 * The session row read once for a chat turn: its ecosistema (same rules as
 * {@link sessionEcosystemId}) and its kind. One round trip, so `/api/generate`
 * did not grow a second read for the kind.
 */
export async function sessionMeta(token: string | undefined, sessionId: string): Promise<SessionMeta> {
  if (!sessionId) return { ok: false };
  try {
    const res = await backendFetch(
      token,
      `/api/sessions/${encodeURIComponent(sessionId)}?depth=0`,
      { method: 'GET' },
    );
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { organization?: unknown; kind?: unknown; evalRun?: unknown } | null;
    if (!body || typeof body !== 'object') return { ok: false };
    const evalRun = typeof body.evalRun === 'number' || (typeof body.evalRun === 'string' && body.evalRun !== '') ? String(body.evalRun) : null;
    return { ok: true, organizationId: organizationIdOf(body.organization), kind: parseSessionKind(body.kind), evalRun };
  } catch {
    return { ok: false };
  }
}

function organizationIdOf(org: unknown): string | null {
  if (typeof org === 'string' || typeof org === 'number') return String(org);
  // depth>0 (or a config change) would populate it as an object.
  if (org && typeof org === 'object' && 'id' in org) {
    const id = (org as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return null;
}

/**
 * An ecosistema's name, read with the caller's token, or `null` on any
 * failure. For a testimonio's neutral source title (`$lib/server/engine/sources`).
 */
export async function ecosystemName(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<string | null> {
  if (organizationId == null || organizationId === '') return null;
  try {
    const res = await backendFetch(
      token,
      `/api/organizations/${encodeURIComponent(String(organizationId))}?depth=0&select[name]=true`,
      { method: 'GET' },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    return typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null;
  } catch {
    return null;
  }
}
