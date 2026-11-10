/**
 * Server half of the held-document review: who may review, and the three calls.
 *
 * ── 🔴 ASK THE BACKEND WHAT THE PERSON MAY DO. DO NOT WORK IT OUT. ──────────
 *
 * `holds:review` belongs to the `investigador` role and up, per ecosistema. The
 * tempting shortcut is to read the caller's memberships — `$lib/server/
 * ecosystem.ts` already fetches them, and the `role` field is right there — and
 * decide here that "investigador or above ⇒ may review".
 *
 * That is exactly what `apps/backend/src/lib/permissions.ts` tells consumers not
 * to do: *"Consumers receive a FLAT permission list and check membership in it.
 * They never expand a role themselves."* A frontend that expands roles bakes
 * today's rank order into a second place, and the day a role gains or loses the
 * capability the menu and the API disagree. It also silently misses PLATFORM
 * ADMINS, who have the capability everywhere and no membership rows at all.
 *
 * So this file asks `GET /api/v1/identity/me`, which is the one endpoint that
 * hands a caller their own flat permission list per ecosistema, and checks for
 * the string.
 *
 * ── ⚠ AND IT IS STILL NOT THE CONTROL ───────────────────────────────────────
 *
 * The real control is in the backend: `/api/holds*` answers 404 — never 403 —
 * to a caller without the capability, to an ecosistema that is not theirs, and
 * to an id that does not exist, all indistinguishably. Everything in this file
 * is there so a person is refused BEFORE they see a broken screen, and so the
 * menu does not advertise a section they cannot open. If this file were deleted
 * the data would still be safe; the experience would just be worse.
 */

import { safeErrMessage } from '$lib/errorSummary';
import { backendFetch } from '$lib/server/auth';
import {
  parseHeldDetail,
  parseHeldList,
  type DecisionBody,
  type HeldDetail,
  type HeldSummary,
} from '$lib/holds';

/** The exact permission string. Mirrors `PERMISSIONS.holdsReview` in the backend. */
export const HOLDS_REVIEW = 'holds:review';

/**
 * What `GET /api/v1/identity/me` says about the caller, reduced to what this
 * feature needs.
 *
 * ⚠ `slugs`, not ids. The identity endpoint keys its permission map by
 * organization SLUG (the field is called `projects` on the wire for
 * compatibility with `@edc/identity-client`). Everything else in this app
 * addresses an ecosistema by id, so the two have to be joined somewhere — see
 * {@link mayReviewSlug}.
 */
export interface ReviewCapability {
  /** `true` ⇒ may review in every active ecosistema, with no membership row. */
  isPlatformAdmin: boolean;
  /** Slugs of the ecosistemas where the caller holds `holds:review`. */
  slugs: string[];
  /**
   * `false` when the identity read itself failed.
   *
   * 🔴 LOAD-BEARING, AND IT FAILS CLOSED. An unreachable identity endpoint is
   * not "this person may review nothing" — but on this screen the two have to
   * be treated the same, because the alternative is showing an oversight
   * surface to whoever happens to be signed in when the backend hiccups. What
   * the flag buys is the WORDING: "no pudimos comprobar" rather than "no
   * tienes permiso", so nobody goes asking an administrator for access they
   * already have.
   */
  ok: boolean;
}

const NONE: ReviewCapability = { isPlatformAdmin: false, slugs: [], ok: false };

/**
 * Pull the ecosistemas where a permission is held out of an identity payload.
 *
 * Pure, so the parsing can be asserted without a backend. Tolerant of a garbled
 * body in one direction only: anything it cannot understand becomes "no
 * capability", never "capability everywhere".
 */
export function reviewCapabilityFrom(body: unknown, permission = HOLDS_REVIEW): ReviewCapability {
  if (!body || typeof body !== 'object') return NONE;
  const principal = (body as { principal?: unknown }).principal;
  if (!principal || typeof principal !== 'object') return NONE;

  const p = principal as { isPlatformAdmin?: unknown; projects?: unknown };
  // 🔴 Literally `true`, nothing else. A truthy string must not open this.
  const isPlatformAdmin = p.isPlatformAdmin === true;

  const slugs: string[] = [];
  if (p.projects && typeof p.projects === 'object') {
    for (const [slug, grant] of Object.entries(p.projects as Record<string, unknown>)) {
      if (!grant || typeof grant !== 'object') continue;
      const permissions = (grant as { permissions?: unknown }).permissions;
      if (!Array.isArray(permissions)) continue;
      if (permissions.includes(permission)) slugs.push(slug);
    }
  }

  return { isPlatformAdmin, slugs: slugs.sort(), ok: true };
}

/** Does this capability cover the ecosistema with this slug? */
export function mayReviewSlug(cap: ReviewCapability, slug: string | null | undefined): boolean {
  if (!cap.ok) return false;
  if (cap.isPlatformAdmin) return true;
  if (!slug) return false;
  return cap.slugs.includes(slug);
}

/** May this person review holds ANYWHERE? The question the menu asks. */
export function mayReviewAnywhere(cap: ReviewCapability): boolean {
  return cap.ok && (cap.isPlatformAdmin || cap.slugs.length > 0);
}

/**
 * Read the caller's own identity payload, or null when the read failed.
 *
 * ⚠ Forwards the user's JWT, like every other call in this app. The endpoint
 * answers about whoever the token names — there is no id parameter to get wrong
 * and no way to ask about somebody else.
 */
export async function readIdentity(token: string | undefined): Promise<unknown | null> {
  if (!token) return null;
  try {
    const res = await backendFetch(token, '/api/v1/identity/me', { method: 'GET' });
    if (!res.ok) {
      console.warn(`[holds] identity answered ${res.status} reading the caller's permissions`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (err) {
    console.warn('[holds] could not read the caller permissions', safeErrMessage(err));
    return null;
  }
}

/** Read the caller's own permissions, for one permission string. */
export async function readReviewCapability(
  token: string | undefined,
  permission = HOLDS_REVIEW,
): Promise<ReviewCapability> {
  const body = await readIdentity(token);
  return body === null ? NONE : reviewCapabilityFrom(body, permission);
}

// ---------------------------------------------------------------------------
// The three calls
// ---------------------------------------------------------------------------

export type HoldsResult<T> =
  | { state: 'ready'; value: T }
  /** ⚠ The backend's ONE refusal. Never told apart into "missing" and "not yours". */
  | { state: 'not-found' }
  | { state: 'unavailable' };

/**
 * The queue for one ecosistema.
 *
 * 🔴 THE ECOSISTEMA IS NAMED BY THE SERVER, NOT BY THE BROWSER. The id comes
 * from `+page.server.ts`, which resolved it from `?eco=` through
 * `readEcosystem` — a read with the caller's own token, so an id they cannot
 * see comes back null. The browser never gets to put an arbitrary id on this
 * wire. Same shape as `/admin`, which has the same oversight problem.
 *
 * ⚠ The response carries NO TEXT, by the API's design. Do not add a field here
 * that would make it: a list of every held transcript in one response is the
 * thing `GET /api/holds` exists to avoid.
 */
export async function listHolds(
  token: string | undefined,
  organizationId: string,
  limit = 50,
): Promise<HoldsResult<HeldSummary[]>> {
  const qs = new URLSearchParams({ organization: organizationId, limit: String(limit) });
  try {
    const res = await backendFetch(token, `/api/holds?${qs.toString()}`, { method: 'GET' });
    if (res.status === 404 || res.status === 401) return { state: 'not-found' };
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json().catch(() => null)) as { holds?: unknown } | null;
    return { state: 'ready', value: parseHeldList(body?.holds) };
  } catch (err) {
    console.warn('[holds] could not list the held documents', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}

/** One held document, with its text and the offsets of what survived. */
export async function readHold(
  token: string | undefined,
  id: string,
): Promise<HoldsResult<HeldDetail>> {
  try {
    const res = await backendFetch(token, `/api/holds/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
    if (res.status === 404 || res.status === 401) return { state: 'not-found' };
    if (!res.ok) return { state: 'unavailable' };
    const detail = parseHeldDetail(await res.json().catch(() => null));
    if (!detail) return { state: 'unavailable' };
    return { state: 'ready', value: detail };
  } catch (err) {
    console.warn('[holds] could not read the held document', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}

export interface DecisionOutcome {
  id: string;
  decision: 'approved' | 'rejected';
  reviewId: string;
  anonymisationStatus: string;
}

export type DecisionResult =
  | { state: 'ready'; value: DecisionOutcome }
  | { state: 'not-found' }
  /** A 400: the request itself was wrong. The backend's message is safe to show. */
  | { state: 'rejected-input'; message: string }
  | { state: 'unavailable' };

/**
 * Record the decision.
 *
 * 🔴 THE BODY IS PASSED THROUGH UNTOUCHED. In particular this function never
 * supplies a `text` the caller omitted. An absent `text` means "release the
 * gate's own refused output", which the server already holds — and the only
 * other string within reach on the server side is the raw original, which must
 * never be sent anywhere. See `decisionBody` in `$lib/holds.ts`.
 */
export async function decideHold(
  token: string | undefined,
  id: string,
  body: DecisionBody,
): Promise<DecisionResult> {
  try {
    const res = await backendFetch(token, `/api/holds/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 401) return { state: 'not-found' };
    if (res.status === 400) {
      const detail = (await res.json().catch(() => null)) as
        | { errors?: Array<{ message?: unknown }> }
        | null;
      const message = detail?.errors?.[0]?.message;
      return {
        state: 'rejected-input',
        message: typeof message === 'string' && message ? message : 'La decisión no se pudo enviar.',
      };
    }
    if (!res.ok) return { state: 'unavailable' };
    const outcome = (await res.json().catch(() => null)) as DecisionOutcome | null;
    if (!outcome || typeof outcome.id !== 'string') return { state: 'unavailable' };
    return { state: 'ready', value: outcome };
  } catch (err) {
    console.warn('[holds] could not record the decision', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}
