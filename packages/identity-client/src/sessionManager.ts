// STATEFUL session lifecycle for @edc/identity-client.
//
// `session.ts` is three stateless calls that map 1:1 onto three IdP endpoints.
// This file is the layer a BFF needs on top of them. Product content (cookie
// names, a role mapper, a permission slug) stays out; this is the machinery.
//
// ── What it adds over the raw calls ─────────────────────────────────────────
//
//   1. ROTATE → PERSIST, in that order, on EVERY 200. The presented ticket is
//      dead the instant `/refresh` returns; the successor is written through
//      the injected store BEFORE this module hands the outcome back, so no
//      caller can forget, early-return past it, or reorder it.
//   2. A THREE-WAY VERDICT — `dead` / `survived` / `unavailable` — over the
//      IdP's status codes. 401 ends the session; 403 does NOT. Getting that
//      backwards signs a person out of every product in the fleet because one
//      project assignment was missing.
//   3. SINGLE-FLIGHT PER TICKET, plus a spent-ticket memo. The IdP treats two
//      concurrent rotations of one ticket as theft and revokes the whole chain
//      (`identity/src/lib/refreshTokens.ts` `RefreshRotationRaceLost` →
//      `src/endpoints/refresh.ts` `revokeTicketChain`). Serializing is the
//      CONSUMER's job: the IdP cannot tell a double-firing browser from a
//      thief, so it assumes the worst, correctly.
//
// ── The state is module-level, and that is deliberate ───────────────────────
//
// The store is per REQUEST (a cookie jar), so a BFF creates one manager per
// request. The single-flight map must be per PROCESS or it protects nothing.
// So the maps live here, keyed by `baseUrl` + PROJECT + ticket, and every
// manager built against that same pair shares them.
// `resetIdentitySessionState()` is the test seam.
//
// ⚠ `project` IS PART OF THE KEY, and leaving it out is a real bug rather than
// a tidiness point. One refresh ticket is fleet-wide; the `audience` on the
// /refresh call is not. Two managers on one IdP with different projects would
// otherwise share a flight, and the memo would hand a `chat`-scoped access
// token to the manager whose store writes another product's cookies.
//
// ⚠ ONE PROCESS ONLY. `adapter-node` runs a single process, which is what makes
// a plain Map sufficient. A multi-replica BFF would need shared state and that
// has to be DESIGNED (a shared lock, or sticky routing by session), not bolted
// on — two replicas rotating one ticket is exactly the theft signal above.

import {
  IdentitySessionError,
  IdentityConfigError,
} from './errors.js';
import { loginWithPassword, refreshSession, revokeSession } from './session.js';
import { MAX_TOKEN_LIFETIME_SEC } from './types.js';

// ── Store ───────────────────────────────────────────────────────────────────

/** The rotated refresh ticket, ready to write to a cookie. */
export interface StoredTicket {
  /** ⚠ THE NEW CREDENTIAL. The one that produced it is already dead. */
  refreshToken: string;
  /** ISO-8601 expiry of the TICKET (~14 days) — never of the access token. */
  expiresAt: string;
  /**
   * Cookie `maxAge` in seconds, already clamped to
   * `[ticketMinMaxAgeSeconds, ticketTtlSeconds]`.
   *
   * ⚠ The clamp is not cosmetic. A ticket the IdP reports as already expired
   * (clock skew in a container) would otherwise be written with `maxAge <= 0`,
   * which DELETES the cookie and throws away the only copy of a ticket that is
   * probably fine.
   */
  maxAge: number;
}

/** The minted project access token, ready to write to a cookie. */
export interface StoredToken {
  /** EdDSA-signed, scoped to `project` alone. */
  token: string;
  /** Lifetime in seconds as reported by the IdP. */
  expiresIn: number;
  /** Cookie `maxAge` in seconds, capped at `MAX_TOKEN_LIFETIME_SEC` (900). */
  maxAge: number;
}

/**
 * Where a consumer keeps the session. In a BFF this wraps the request's cookie
 * jar; in a test it wraps a `Map`.
 *
 * ⚠ CREATE ONE PER REQUEST. The manager is cheap; the process-wide rotation
 * state lives outside it.
 *
 * Every method may be async and every one is awaited, so a store backed by
 * Redis or a database session table works unchanged.
 */
export interface IdentitySessionStore {
  /**
   * Persist the rotated ticket.
   *
   * 🔴 THE ONE THING A CONSUMER CAN GET WRONG SILENTLY. It is called on every
   * successful rotation, INCLUDING the 200-with-no-access-token case that this
   * module still reports as a failure. Whatever you do here must not throw
   * conditionally — a store that drops this write leaves a dead ticket in the
   * browser, and the next request trips reuse detection, which revokes the
   * entire chain across every product.
   */
  saveTicket(ticket: StoredTicket): void | Promise<void>;

  /**
   * Persist the access token. Optional: a consumer that forwards the token
   * straight to its backend and keeps no copy simply omits it.
   *
   * Called only AFTER `saveTicket` has resolved — see `persist()`.
   */
  saveToken?(token: StoredToken): void | Promise<void>;

  /**
   * Drop everything. Called on a `dead` verdict and on `end()`, and NEVER on
   * `survived`, `unavailable` or `misconfigured`: clearing the session because
   * one project said "no", because the IdP hiccuped, or because THIS
   * deployment is misconfigured, is the fleet-wide-logout bug this whole module
   * exists to prevent.
   */
  clear(): void | Promise<void>;
}

// ── Results ─────────────────────────────────────────────────────────────────

/** A rotated ticket plus the project access token minted alongside it. */
export interface MintedSession {
  refreshToken: string;
  expiresAt: string;
  token: string;
  expiresIn: number;
  /** Present only after a `start()`, which is the one call that learns who the user is. */
  user?: { email: string; name: string | null };
}

/**
 * Why a session call failed, split the ONLY three ways a caller may act.
 *
 * `IdentitySessionError` exposes two deliberately NON-complementary getters,
 * `refreshTokenIsDead` and `refreshTokenSurvived`, and the gap between them is
 * real. This is that triage, named:
 *
 * - `dead`        — the ticket can never work again. The store is CLEARED for
 *                   you AND the local rotation chain is purged, exactly as a
 *                   sign-out purges it; show a sign-in form. The only verdict
 *                   that ends a session.
 * - `survived`    — the TICKET IS FINE; this human simply holds nothing on this
 *                   project (403 `project_access_denied`, 404 `unknown_project`).
 *                   Answer 403. Do not clear anything.
 * - `unavailable` — the IdP failed, was unreachable, rate-limited us, or has no
 *                   signing key. The ticket's fate is UNKNOWN — a refresh may
 *                   have rotated before the wire broke — so nothing is touched
 *                   and the request should fail 503. RETRYING IS THE RIGHT
 *                   MOVE: the same call may work in a second.
 * - `misconfigured` — the IdP could not read the request (400). The ticket is
 *                   fine and nothing is touched, but RETRYING NEVER HELPS. It
 *                   is this deployment that is wrong — almost always a `project`
 *                   the IdP will not accept as an audience. Kept separate from
 *                   `unavailable` because folding the two makes a permanent
 *                   deploy bug present as an intermittent outage: every request
 *                   answers 503 forever, retries and all, and the logs say
 *                   "identity provider unavailable" about an IdP that is up.
 *
 * ⚠ `refreshTokenSurvived` is true for FIVE reasons and only two of them are
 * authorization answers. `token_signing_unavailable` and `rate_limited` mean
 * "the IdP could not answer right now" and land in `unavailable`;
 * `malformed_request` is `misconfigured`. None of the three ends the session.
 */
export type SessionFailureKind = 'dead' | 'survived' | 'unavailable' | 'misconfigured';

export interface SessionFailure {
  ok: false;
  kind: SessionFailureKind;
  /** Server-side log text. Already redacted by `session.ts` — never holds a ticket. */
  error: string;
  /**
   * Set when the IdP DID rotate the ticket and still returned no access token
   * (a 200 with `token` absent). The rotation is already persisted; this field
   * exists so a caller can see that the session moved on despite the failure.
   */
  rotated?: StoredTicket;
}

export type SessionResult = ({ ok: true } & MintedSession) | SessionFailure;

/** Login can fail two ways a refresh cannot, and the UX must tell them apart. */
export type LoginFailureKind = SessionFailureKind | 'invalid-credentials' | 'inactive';

export interface LoginFailure extends Omit<SessionFailure, 'kind'> {
  kind: LoginFailureKind;
}

export type LoginResult = ({ ok: true } & MintedSession) | LoginFailure;

// ── Options ─────────────────────────────────────────────────────────────────

export interface IdentitySessionOptions {
  /**
   * The IdP's REST base, WITH the `/api` — `https://identity.dev.example.org/api`.
   * Payload mounts custom endpoints under `routes.api`, so a base without it
   * 404s, and a 404 on `/refresh` is reported as `unknown_project`, i.e. it
   * looks like a missing project assignment. Check this before blaming a slug.
   *
   * ⚠ An EMPTY value is tolerated rather than thrown, on purpose: it is read
   * from an env var, and a BFF that constructs its manager at module scope must
   * not crash on boot over one unset variable. Every call then answers
   * `unavailable` with a plain message.
   */
  baseUrl: string;

  /** The project slug tokens must be scoped to (`aud`) — `chat`, `frontend-code`. */
  project: string;

  /** Per-request persistence. See {@link IdentitySessionStore}. */
  store: IdentitySessionStore;

  /** Injectable `Date.now`, for the memo window. Defaults to `Date.now`. */
  clock?: () => number;

  /** Injectable `fetch`, for tests. Defaults to the platform one. */
  fetch?: typeof fetch;

  /**
   * Free-text label for where the session started (`'chat'`). Decoration in the
   * IdP's session list; login only, never checked.
   */
  client?: string;

  /**
   * The END USER's IP, forwarded as `X-Forwarded-For` so the IdP's per-IP
   * rate-limit buckets count the real client and not this BFF's single egress.
   *
   * ⚠ PASS-THROUGH ONLY. It never keys the single-flight or the memo, which key
   * on the TICKET, because the invariant they protect is "one spent ticket, one
   * rotation". Folding the IP in would fragment the flight and reintroduce the
   * double-rotation the IdP reads as theft.
   *
   * 🔴 A BFF IS NOT A PROXY HOP. `IDENTITY_TRUSTED_PROXY_HOPS` counts trusted
   * proxies on the path of EVERY request; raising it to 2 for a BFF lets any
   * caller choose its own rate-limit bucket. Leave it at the default of 1. Full
   * reasoning on `SessionOptions.forwardedFor` in `session.ts` and in README.md.
   */
  forwardedFor?: string;

  // ── Cookie policy. Options, not constants, because the two forks disagreed
  //    about nothing here but a future consumer may. ─────────────────────────

  /** Refresh-ticket TTL ceiling, seconds. Default 14 days (ADR-0001 Amendment 2 §1). */
  ticketTtlSeconds?: number;
  /** Refresh-ticket `maxAge` floor, seconds. Default 60. See {@link StoredTicket.maxAge}. */
  ticketMinMaxAgeSeconds?: number;
  /** Access-token `maxAge` ceiling and fallback, seconds. Default 900. */
  accessTtlSeconds?: number;
  /**
   * How long a spent ticket keeps pointing at its successor. Default 30 000 ms.
   *
   * ⚠ PER MANAGER, OVER A PROCESS-GLOBAL MAP. The window is stamped onto an
   * entry by the manager that WROTE it and the cap is applied by whichever
   * manager writes next, but the map itself is shared by every manager on the
   * same `(baseUrl, project)`. Managers that disagree about these numbers
   * therefore produce a map governed by whoever wrote last. A BFF builds one
   * manager per request from one config, so in practice they always agree —
   * vary them only in tests, and only with `resetIdentitySessionState()`
   * between cases.
   */
  memoMs?: number;
  /** Hard cap on memo entries, oldest-first eviction. Default 1000. See {@link memoMs}. */
  memoMax?: number;
}

const DAY_SECONDS = 24 * 60 * 60;
const DEFAULTS = {
  ticketTtlSeconds: 14 * DAY_SECONDS,
  ticketMinMaxAgeSeconds: 60,
  accessTtlSeconds: MAX_TOKEN_LIFETIME_SEC,
  memoMs: 30_000,
  memoMax: 1000,
} as const;

// ── Process-wide rotation state ─────────────────────────────────────────────

type SettledRotation = ({ ok: true } & MintedSession) | (SessionFailure & { rotated: StoredTicket });

interface MemoEntry {
  result: SettledRotation;
  /** Lazy expiry check, so a stalled event loop cannot serve a stale entry. */
  expiresAtMs: number;
}

/**
 * In-flight refreshes, keyed by `baseUrl` + project + the ticket presented.
 *
 * 🔴 A page load fires many parallel requests all carrying the SAME ticket.
 * Without this, each calls `/refresh`; each rotates; N-1 answers are thrown
 * away and the browser keeps whichever landed last — a retired ticket. The next
 * request presents it, which is the theft signal, and the chain is revoked.
 */
const inFlight = new Map<string, Promise<SessionResult>>();

/**
 * Successful rotations, keyed by the ticket they SPENT.
 *
 * 🔴 NOT AN OPTIMISATION AND NOT REDUNDANT WITH THE MAP ABOVE. Measured in a
 * real browser (chat, 2026): 8 parallel authenticated fetches with an expired
 * access cookie produced 2 calls to `/refresh`, the IdP logged
 * `TICKET REUSE DETECTED`, and it revoked the chain. Server-side simultaneity
 * was never the problem — the DISPATCH-TO-ARRIVAL SPREAD is. Request 8 left the
 * browser before request 1's rotated `Set-Cookie` landed, so it still carried
 * the spent ticket, and it arrived 1.8 s later, long after the flight settled
 * and its entry was deleted. The single-flight only ever covered the ~60 ms
 * round trip.
 *
 * The symptom is nastier than a logout: the browser keeps rendering off its
 * still-valid access token and the person is thrown out minutes later, when it
 * expires — cause and effect too far apart to connect.
 *
 * ⚠ SUCCESSFUL ROTATIONS ONLY. Memoising a failure would pin a transient outage
 * to a ticket for the whole window and answer 503 to requests that would have
 * worked.
 */
const memo = new Map<string, MemoEntry>();

/**
 * Tickets whose chain has been ENDED — signed out, or found dead — with the
 * instant the marker itself expires.
 *
 * 🔴 WHY A MARKER AND NOT JUST A MEMO PURGE. Dropping the memo stops a LATER
 * request from being re-authenticated, but it cannot reach the requests already
 * AWAITING a rotation that was in the air when the sign-out landed. Those
 * awaiters hold their own stores (their own cookie jars); when the flight
 * settles they would each persist a fresh ticket and access token into a
 * browser the user just signed out of, with no IdP call and nothing left to
 * consult. The flight's own `=== flight` guard only stops the MEMO being
 * repopulated — it does not stop a persist.
 *
 * So an ended ticket is remembered for the memo window, and any rotation that
 * settles on it is downgraded to `dead` and never persisted.
 */
const ended = new Map<string, number>();

/** Test seam: drop every flight, memo and ended marker, so one test cannot leak into the next. */
export function resetIdentitySessionState(): void {
  inFlight.clear();
  memo.clear();
  ended.clear();
}

/**
 * A NUL cannot appear in a URL, a project slug or an opaque ticket, so no value
 * can forge another's key.
 *
 * 🔴 `project` is here because a memo entry holds a MINTED ACCESS TOKEN, and
 * that token is scoped to ONE project. Keying on the ticket alone lets two
 * managers on the same IdP with different projects share a flight — and the
 * memo then hands a `chat`-scoped token to the manager whose store writes
 * another product's cookies.
 */
const SEP = '\u0000';
function keyOf(baseUrl: string, project: string, ticket: string): string {
  return `${baseUrl}${SEP}${project}${SEP}${ticket}`;
}

function successorOf(result: SettledRotation): string {
  return result.ok ? result.refreshToken : result.rotated.refreshToken;
}

// ── The manager ─────────────────────────────────────────────────────────────

export interface IdentitySessionManager {
  /**
   * Sign in: password → refresh ticket → FIRST project access token, persisted.
   *
   * 🔴 ONE call on purpose, not two the caller composes. The ticket
   * `loginWithPassword` returns is spent by the `refreshSession` that follows
   * it; never handing it to anybody is the only way to make storing the wrong
   * one impossible. What this persists is already rotated.
   */
  start(credentials: { email: string; password: string }): Promise<LoginResult>;

  /**
   * Trade a refresh ticket for a fresh access token, rotating the ticket, and
   * persist the result.
   *
   * Three layers, in order, each catching what the previous cannot:
   *   1. the memo — a straggler carrying a ticket we already spent;
   *   2. the in-flight map — a request overlapping a call already running;
   *   3. an actual call to the IdP.
   *
   * Every layer persists through THIS manager's store, so each request in a
   * burst writes its own cookies from the one shared outcome.
   */
  renew(refreshToken: string): Promise<SessionResult>;

  /**
   * Sign out. Clears the store FIRST, then purges the local rotation state, and
   * only THEN revokes at the IdP, best-effort.
   *
   * ⚠ The order is load-bearing and this is not the order you might guess. Both
   * local wipes happen BEFORE the round trip, because the browser must end up
   * signed out whatever the network does — a revoke that hangs or 5xxs must not
   * leave a live memo behind, and a straggling rotation must not be handed the
   * session back while the request is still in flight.
   */
  end(refreshToken: string): Promise<void>;

  /**
   * Purge every trace of a ticket chain from the process-wide caches.
   *
   * 🔴 The memo re-persists a session with NO IdP call. On logout, a request the
   * browser dispatched BEFORE the sign-out — still carrying a pre-logout ticket
   * — would otherwise hit the memo and re-set the cookies, re-authenticating a
   * browser the user believes is signed out. Revoking at the IdP does not help:
   * the memo never asks it. It has to be dropped locally.
   */
  forget(refreshToken: string): void;
}

export function createIdentitySession(
  options: IdentitySessionOptions,
): IdentitySessionManager {
  if (!options || typeof options !== 'object') {
    throw new IdentityConfigError('createIdentitySession: an options object is required');
  }
  const { store } = options;
  if (!store || typeof store.saveTicket !== 'function' || typeof store.clear !== 'function') {
    throw new IdentityConfigError(
      'createIdentitySession: `store` must implement `saveTicket` and `clear` ' +
        '(see IdentitySessionStore)',
    );
  }
  if (typeof options.project !== 'string' || options.project.trim().length === 0) {
    throw new IdentityConfigError(
      'createIdentitySession: `project` is required — it is the `aud` every access token is ' +
        'scoped to. There is no fleet-wide token.',
    );
  }

  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.replace(/\/+$/, '') : '';
  const project = options.project.trim().toLowerCase();
  const now = options.clock ?? Date.now;
  const call = { fetch: options.fetch, forwardedFor: options.forwardedFor };
  const ticketTtl = options.ticketTtlSeconds ?? DEFAULTS.ticketTtlSeconds;
  const ticketFloor = options.ticketMinMaxAgeSeconds ?? DEFAULTS.ticketMinMaxAgeSeconds;
  const accessTtl = options.accessTtlSeconds ?? DEFAULTS.accessTtlSeconds;
  const memoMs = options.memoMs ?? DEFAULTS.memoMs;
  const memoMax = options.memoMax ?? DEFAULTS.memoMax;

  function ticketMaxAge(expiresAt: string): number {
    const remainingMs = Date.parse(expiresAt) - now();
    if (!Number.isFinite(remainingMs)) return ticketTtl;
    return Math.min(Math.max(Math.floor(remainingMs / 1000), ticketFloor), ticketTtl);
  }

  function accessMaxAge(expiresIn: number | undefined): number {
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return accessTtl;
    }
    return Math.min(Math.floor(expiresIn), accessTtl);
  }

  function storedTicket(t: { refreshToken: string; expiresAt: string }): StoredTicket {
    return { refreshToken: t.refreshToken, expiresAt: t.expiresAt, maxAge: ticketMaxAge(t.expiresAt) };
  }

  function unavailable(error: string): SessionFailure {
    return { ok: false, kind: 'unavailable', error };
  }

  /**
   * What an awaiter gets when the session ended underneath it. `dead` because
   * that is exactly what happened, and because it is the one verdict whose
   * handling — stop, show a sign-in form — is correct here. The store is NOT
   * touched: `end()` already cleared it, and this request must not write.
   */
  const ENDED_MID_FLIGHT: SessionFailure = {
    ok: false,
    kind: 'dead',
    error: 'the session was ended while this refresh was in flight',
  };

  /**
   * ⚠ TICKET FIRST, TOKEN SECOND, AND AWAITED IN THAT ORDER.
   *
   * The access token is re-mintable from the ticket; the ticket is not
   * re-mintable from anything. If a store throws halfway, the survivable
   * ordering is the one where the ticket is already down.
   */
  async function persist(result: SessionResult): Promise<void> {
    if (result.ok) {
      await store.saveTicket(storedTicket(result));
      await store.saveToken?.({
        token: result.token,
        expiresIn: result.expiresIn,
        maxAge: accessMaxAge(result.expiresIn),
      });
      return;
    }
    if (result.rotated) {
      // A 200 with no access token still SPENT the ticket. Persisting the
      // successor is not optional just because the request failed.
      await store.saveTicket(result.rotated);
      return;
    }
    // 🔴 `dead` ONLY. `survived` means the ticket is fine and the answer was
    // about a project; `unavailable` means the outcome is unknown;
    // `misconfigured` means this deployment is wrong and the user is fine.
    // Clearing on any of them is the fleet-wide logout.
    if (result.kind === 'dead') await store.clear();
  }

  /** Map one refresh-lane `IdentitySessionError` onto the three-way verdict. */
  function triage(err: IdentitySessionError): SessionFailureKind {
    if (err.refreshTokenIsDead) return 'dead';
    if (err.reason === 'project_access_denied' || err.reason === 'unknown_project') {
      return 'survived';
    }
    // 400. The ticket survived, but no amount of retrying fixes a body the IdP
    // will not read — see `misconfigured` on SessionFailureKind.
    if (err.reason === 'malformed_request') return 'misconfigured';
    // The transient half of `refreshTokenSurvived`, plus the gap the getters
    // deliberately leave open (transport failures and 5xx on a refresh, where
    // the ticket MAY have rotated before the wire broke).
    return 'unavailable';
  }

  /** The one place `refreshSession` is called. Shared by `start` and `renew`. */
  async function rotate(refreshToken: string): Promise<SessionResult> {
    let rotated;
    try {
      rotated = await refreshSession(baseUrl, { refreshToken, audience: project }, call);
    } catch (err) {
      if (err instanceof IdentitySessionError) {
        return { ok: false, kind: triage(err), error: err.message };
      }
      return unavailable((err as Error).message);
    }

    if (!rotated.token) {
      return {
        ok: false,
        kind: 'unavailable',
        error: 'identity provider rotated the ticket but minted no access token',
        rotated: storedTicket(rotated),
      };
    }

    return {
      ok: true,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
      token: rotated.token,
      expiresIn: rotated.expiresIn,
    };
  }

  /**
   * Purge a ticket AND EVERY PREDECESSOR THAT STILL POINTS AT IT, to a fixpoint.
   *
   * 🔴 The memo is a CHAIN, not a pair, and a sign-out can arrive holding ANY
   * link of it. After A→B→C:
   *   - ending on C must drop `A→B` too, or a straggler carrying A is served B
   *     and its access token with NO IdP call;
   *   - ending on A must drop `B→C` too, for exactly the same reason in the
   *     other direction — a request carrying B is served C. A logout races the
   *     rotations it is trying to end, so the ticket it holds is routinely
   *     older than the memo's head.
   * Revoking at the IdP does not help either way: the memo never asks it.
   *
   * So this walks the chain in BOTH directions to a fixpoint, marking every
   * ticket it reaches as ended. The loop terminates because each pass deletes
   * at least one entry from a finite map.
   */
  function forget(refreshToken: string): void {
    let frontier = new Set([refreshToken]);
    const seen = new Set<string>();
    while (frontier.size > 0) {
      const next = new Set<string>();
      for (const [key, entry] of memo) {
        const spent = spentOf(key);
        if (spent === undefined) continue;
        const successor = successorOf(entry.result);
        if (frontier.has(spent) || frontier.has(successor)) {
          memo.delete(key);
          // Both ends of the link we just cut are part of this chain.
          next.add(spent);
          next.add(successor);
        }
      }
      for (const ticket of frontier) {
        seen.add(ticket);
        markEnded(ticket);
        // Dropping the flight entry ALSO stops it from re-populating the memo
        // when it settles, via the `=== flight` identity guard below: a
        // sign-out that lands mid-refresh does not leave a memo behind it.
        inFlight.delete(keyOf(baseUrl, project, ticket));
      }
      for (const ticket of seen) next.delete(ticket);
      frontier = next;
    }
  }

  /**
   * Remember that this ticket's chain is over, for the memo window.
   *
   * The window matches the memo's because they close the same hole from two
   * sides: the memo is what a LATER request would find, the marker is what an
   * ALREADY-RUNNING rotation is checked against when it settles.
   */
  function markEnded(refreshToken: string): void {
    const key = keyOf(baseUrl, project, refreshToken);
    ended.delete(key);
    ended.set(key, now() + memoMs);
    while (ended.size > memoMax) {
      const oldest = ended.keys().next();
      if (oldest.done) break;
      ended.delete(oldest.value);
    }
  }

  function chainWasEnded(refreshToken: string): boolean {
    const key = keyOf(baseUrl, project, refreshToken);
    const expiresAtMs = ended.get(key);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= now()) {
      ended.delete(key);
      return false;
    }
    return true;
  }

  /** The ticket a memo key was built from, or `undefined` for another manager's key. */
  function spentOf(key: string): string | undefined {
    const prefix = `${baseUrl}${SEP}${project}${SEP}`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
  }

  function memoise(spentTicket: string, result: SettledRotation): void {
    const key = keyOf(baseUrl, project, spentTicket);
    // Delete first so a re-memoised key moves to the END of the insertion
    // order, which is what makes the cap evict genuinely-oldest entries.
    memo.delete(key);
    memo.set(key, { result, expiresAtMs: now() + memoMs });
    while (memo.size > memoMax) {
      const oldest = memo.keys().next();
      if (oldest.done) break;
      memo.delete(oldest.value);
    }
  }

  function memoised(spentTicket: string): SettledRotation | undefined {
    const key = keyOf(baseUrl, project, spentTicket);
    const entry = memo.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= now()) {
      memo.delete(key);
      return undefined;
    }
    return entry.result;
  }

  function renewUnpersisted(refreshToken: string): Promise<SessionResult> {
    const alreadyRotated = memoised(refreshToken);
    if (alreadyRotated) return Promise.resolve(alreadyRotated);

    const key = keyOf(baseUrl, project, refreshToken);
    const pending = inFlight.get(key);
    if (pending) return pending;

    const flight: Promise<SessionResult> = rotate(refreshToken)
      .then((result) => {
        // Memoised BEFORE the flight entry is dropped, so there is no instant
        // in which a straggler finds neither a flight nor a memo and calls the
        // IdP with a spent ticket.
        //
        // 🔴 The identity guard is the sign-out interlock: if `forget()` purged
        // this ticket mid-flight, do NOT re-populate the memo it just cleared.
        // A dropped in-flight entry IS the "this chain is revoked" signal.
        if (inFlight.get(key) === flight) {
          if (result.ok) memoise(refreshToken, result);
          else if (result.rotated) memoise(refreshToken, { ...result, rotated: result.rotated });
        }
        return result;
      })
      .finally(() => {
        if (inFlight.get(key) === flight) inFlight.delete(key);
      });
    inFlight.set(key, flight);
    return flight;
  }

  return {
    async start(credentials) {
      if (!baseUrl) return unavailable('identity baseUrl is not configured');

      let session: { refreshToken: string; user: { email: string; name: string | null } };
      try {
        session = await loginWithPassword(baseUrl, credentials, {
          ...call,
          ...(options.client ? { client: options.client } : {}),
        });
      } catch (err) {
        if (err instanceof IdentitySessionError) {
          if (err.reason === 'invalid_credentials') {
            return { ok: false, kind: 'invalid-credentials', error: err.message };
          }
          if (err.reason === 'account_inactive') {
            return { ok: false, kind: 'inactive', error: err.message };
          }
          return { ok: false, kind: 'unavailable', error: err.message };
        }
        return unavailable((err as Error).message);
      }

      // The rotation is IMMEDIATE and unconditional: what gets stored is the
      // ticket THIS call returns, never the one the login returned. If it
      // fails, the login ticket is simply abandoned — nobody ever held it and
      // it dies with its own TTL.
      const result = await rotate(session.refreshToken);
      await persist(result);
      return result.ok ? { ...result, user: session.user } : result;
    },

    async renew(refreshToken) {
      if (!baseUrl) return unavailable('identity baseUrl is not configured');
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        // No ticket at all is not an error to log — it is an anonymous request.
        // Reported as `dead` because a sign-in form is the only path forward,
        // but the store is NOT touched: there was nothing to end.
        return { ok: false, kind: 'dead', error: 'no refresh ticket was presented' };
      }
      if (chainWasEnded(refreshToken)) return ENDED_MID_FLIGHT;

      const result = await renewUnpersisted(refreshToken);

      // 🔴 THE INTERLOCK. `end()` may have landed while this rotation was in
      // the air — this request is an AWAITER of a flight that started before
      // the sign-out. Persisting now would write a live ticket and access token
      // into a browser the user has signed out of, from this request's own
      // store, which `end()` never touched and cannot reach. Check AFTER the
      // await, not only before it.
      if (chainWasEnded(refreshToken)) return ENDED_MID_FLIGHT;

      await persist(result);

      // 🔴 A `dead` verdict ENDS the session, so it must purge exactly what a
      // sign-out purges — the SAME `forget()`, not a second path.
      //
      // MEASURED BY THE FIRST ADOPTER (chat, ADR-0001 Phase 2): clearing the
      // store alone is not enough. The memo entry written by the rotation
      // BEFORE this one (A -> B) survives, still pointing at a session with a
      // live access token. A straggler the browser dispatched before the
      // session ended presents A, is served B from the memo with NO IdP call,
      // and is re-cookied into a session that is over — a 200 where a 401
      // belongs, for the rest of the memo window.
      //
      // `forget()` also marks the chain ended, which is what stops that
      // straggler from presenting a ticket the IdP has already revoked.
      if (!result.ok && result.kind === 'dead') forget(refreshToken);

      return result;
    },

    async end(refreshToken) {
      // Store first. A sign-out that hangs on a failed round trip is worse than
      // one that leaves a ticket alive for its remaining minutes.
      await store.clear();
      forget(refreshToken);
      if (!baseUrl || !refreshToken) return;
      try {
        await revokeSession(baseUrl, { refreshToken }, call);
      } catch {
        // Best-effort by contract: the browser is already signed out.
      }
    },

    forget,
  };
}
