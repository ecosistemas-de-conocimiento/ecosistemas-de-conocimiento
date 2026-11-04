// Browser-user SESSIONS for @edc/identity-client.
//
// Three calls, mirroring the three endpoints a consumer's BFF needs to run one
// human's session against the identity provider:
//
//   loginWithPassword → POST /v1/identity/login   password in, refresh ticket out
//   refreshSession    → POST /v1/identity/refresh ticket in, NEW ticket out,
//                                                 plus a ≤900s project access
//                                                 token when you ask for one
//   revokeSession     → POST /v1/identity/revoke  sign out; idempotent, always 204
//
// ⚠ EVERY SUCCESSFUL REFRESH RETURNS A NEW TICKET AND KILLS THE OLD ONE. There
//   is no non-rotating refresh in this system. A consumer that forgets to
//   persist the new value has already logged its user out, and its NEXT call
//   with the stale value is read as theft: the IdP revokes the entire chain, so
//   every other tab and every other product signs out too. Rewrite the cookie on
//   every single 200. This is the one thing a consumer can get wrong silently.
//
// ⚠ NO SERVICE TOKEN, AND THAT IS THE POINT. The credential is the user's
//   password (login) or their refresh ticket (refresh / revoke), carried in the
//   JSON body. This module never touches `X-Service-Token`, so a BFF route wired
//   to it cannot leak the shared service credential even by accident.
//
// ⚠ SERVER-SIDE ALL THE SAME. A refresh ticket is a long-lived credential for a
//   user's whole session across products — 14 days by default. It belongs in an httpOnly,
//   Secure, SameSite cookie the browser's own JavaScript cannot read. If it
//   reaches the page, one XSS is a fortnight of impersonation across every
//   product.

import {
  IdentityConfigError,
  IdentitySessionError,
  type IdentitySessionOperation,
  type IdentitySessionFailureReason,
} from './errors.js';
import { responseMessage, sendRequest, type HttpCallOptions } from './serviceRequest.js';

/**
 * The injectable knobs for a session call.
 *
 * ⚠ THERE IS NO `serviceToken` HERE, AND THERE MUST NEVER BE. These endpoints
 * are reached on behalf of a browser user; adding a shared service
 * credential to the shape would invite a consumer to put one in the same config
 * object it hands to a login form handler.
 *
 * ⚠ THERE IS NO `baseUrl` HERE EITHER — it is the first positional argument.
 * The service lane hides `baseUrl` inside an options bag because the credential
 * has to sit next to it anyway; here, forgetting the URL is the likeliest
 * mistake and a positional argument makes it a compile error rather than a
 * runtime one.
 */
export interface SessionOptions extends HttpCallOptions {
  /**
   * Free-text label for where the session was started (`'chat'`,
   * `'edc-bff'`). Shows up in the IdP's session list so a human can tell
   * their own devices apart. Trimmed and capped at 64 characters server-side.
   *
   * ⚠ DECORATION, NEVER AUTHORIZATION. The IdP does not check it, and a rotated
   * ticket inherits the label from the ticket it replaced — so `refreshSession`
   * and `revokeSession` ignore this field entirely. Only login sets it.
   */
  client?: string;

  /**
   * The END USER's IP address, to forward to the IdP as `X-Forwarded-For` so its
   * per-IP rate-limit buckets count the real client, not this BFF's single
   * egress. A BFF terminates the browser connection, so without this every one
   * of its users shares one IP bucket at the IdP.
   *
   * Optional and OFF by default: when this is absent no `X-Forwarded-For` header
   * is sent and behaviour is exactly as before. When present it is trimmed and,
   * if non-empty, set as the header on the outgoing request.
   *
   * 🔴 DO NOT RAISE `IDENTITY_TRUSTED_PROXY_HOPS` TO MAKE THIS WORK. An earlier
   * version of this comment said a BFF "adds one hop" and that the IdP should
   * therefore be set to 2. That is wrong and it disables every per-IP limit the
   * IdP has, including the service-token brute-force cap.
   *
   * The setting counts TRUSTED PROXIES ON THE PATH OF EVERY REQUEST. A BFF is
   * not one: it is an ordinary client of the IdP, and everyone else reaches the
   * IdP's Traefik without passing through it. At 2 the IdP trusts the
   * second-from-right `X-Forwarded-For` entry on every request, so any caller
   * picks its own bucket key — a fresh budget per request and a way to burn
   * someone else's. This client also SETS the header rather than appending to
   * it, so it does not lengthen the list the way a real hop does.
   *
   * ⚠ DEPLOY REALITY, not something this client can enforce: with Traefik
   * configured without `forwardedHeaders.trustedIPs` it OVERWRITES an incoming
   * `X-Forwarded-For`, so the value sent here may never reach the IdP at all.
   * Sending it stays correct and harmless — it is what starts working when the
   * IdP side is fixed — but do not count it as a live control. See the
   * `forwardedFor` section of README.md.
   */
  forwardedFor?: string;
}

/** The user identity the IdP echoes back on a successful login. */
export interface IdentitySessionUser {
  /** Lowercased, trimmed. The cross-product join key (ADR-0001 §1). */
  email: string;
  /** `"First Last"`, or `null` when the account has neither part set. */
  name: string | null;
}

/** What `POST /v1/identity/login` hands back. */
export interface IdentitySession {
  /**
   * ⚠ THE CREDENTIAL. Store it in an httpOnly cookie and nowhere else — not in
   * a log, not in a JWT you sign yourself, not in localStorage.
   */
  refreshToken: string;
  /** ISO-8601 instant the ticket dies on its own. Use it to size the cookie's `Max-Age`. */
  expiresAt: string;
  user: IdentitySessionUser;
}

/**
 * A refresh that rotated the ticket and nothing else — no `audience` was asked
 * for, so no access token was minted.
 *
 * The `token`-family fields are declared as `undefined` rather than omitted so
 * that `if (session.token)` narrows {@link RefreshedSession} instead of failing
 * to compile.
 */
export interface RotatedSession {
  /** ⚠ THE NEW CREDENTIAL. The one you sent is already dead. Persist this now. */
  refreshToken: string;
  /** ISO-8601. The rotation extends the window — resize the cookie too. */
  expiresAt: string;
  audience?: undefined;
  token?: undefined;
  tokenType?: undefined;
  expiresIn?: undefined;
  roles?: undefined;
  perms?: undefined;
}

/** A refresh that also minted a project access token, because `audience` was sent. */
export interface RotatedSessionWithToken {
  /** ⚠ THE NEW CREDENTIAL. The one you sent is already dead. Persist this now. */
  refreshToken: string;
  /** ISO-8601 expiry of the REFRESH TICKET — not of `token`. */
  expiresAt: string;
  /** The project slug the access token is scoped to, normalized by the IdP. */
  audience: string;
  /**
   * The EdDSA access token to forward to that one product. Scoped to `audience`
   * alone: it will not open any other project, platform admin or not.
   */
  token: string;
  /**
   * `'Bearer'` today. Typed as `string` on purpose — a client that hard-failed
   * on an unexpected value would turn a server-side addition into an outage,
   * and `Authorization: ${tokenType} ${token}` works either way.
   */
  tokenType: string;
  /** Access-token lifetime in seconds. ADR-0001 caps it at 900. */
  expiresIn: number;
  /** Role slugs held in `audience`'s project. */
  roles: string[];
  /** Effective permission slugs in `audience`'s project — already flattened. */
  perms: string[];
}

/** What `POST /v1/identity/refresh` hands back. Discriminate on `token`. */
export type RefreshedSession = RotatedSession | RotatedSessionWithToken;

/**
 * Exchange a password for a refresh ticket.
 *
 * ```ts
 * const session = await loginWithPassword(process.env.IDENTITY_URL!, { email, password })
 * res.cookie('fleet_session', session.refreshToken, {
 *   httpOnly: true, secure: true, sameSite: 'lax',
 *   expires: new Date(session.expiresAt),
 * })
 * ```
 *
 * ⚠ EVERY AUTHENTICATION FAILURE COMES BACK AS ONE `invalid_credentials`. Wrong
 * password, unknown account and locked-out account are deliberately
 * indistinguishable — telling them apart would make this endpoint an
 * account-enumeration oracle. Show the user one message. Do not "helpfully"
 * offer a password reset only for known addresses; that leaks the same bit.
 *
 * `account_inactive` (403) is the one distinct answer, and it is safe to
 * distinguish because the caller already proved they own the account.
 *
 * @throws {IdentityConfigError} before any network call, on a missing `baseUrl`,
 *   email or password.
 * @throws {IdentitySessionError} on anything else.
 */
export async function loginWithPassword(
  baseUrl: string,
  credentials: { email: string; password: string },
  options: SessionOptions = {},
): Promise<IdentitySession> {
  const fetchImpl = requireSessionConfig('loginWithPassword', baseUrl, options, [
    ['credentials.email', credentials?.email],
    ['credentials.password', credentials?.password],
  ]);

  // Email is the user key and is normalized on write, so it is normalized
  // on read too — otherwise "Ana@example.org" cannot sign in. The IdP does this
  // itself; doing it here as well keeps the two in agreement and stops a stray
  // space in a form field from becoming a support ticket.
  const email = credentials.email.trim().toLowerCase();
  const client = typeof options.client === 'string' ? options.client.trim() : '';

  const { status, body, headers } = await post('loginWithPassword', 'login', fetchImpl, baseUrl, {
    path: 'login',
    // ⚠ The password is NOT trimmed. Leading and trailing whitespace are part of
    // a password, and silently eating them here would lock out anyone whose
    // password has one.
    payload: { email, password: credentials.password, ...(client ? { client } : {}) },
    options,
    secrets: [credentials.password],
  });

  if (status < 200 || status >= 300) {
    throw sessionError('loginWithPassword', 'login', status, body, headers, [credentials.password]);
  }

  const raw = asRecord(body);
  const refreshToken = nonEmptyString(raw.refreshToken);
  const expiresAt = nonEmptyString(raw.expiresAt);
  if (!refreshToken || !expiresAt) {
    throw new IdentitySessionError(
      'response_unusable',
      'login',
      'loginWithPassword: the identity provider answered 200 with no usable `refreshToken`. ' +
        'No session was started.',
      status,
    );
  }

  const user = asRecord(raw.user);
  return {
    refreshToken,
    expiresAt,
    user: {
      email: nonEmptyString(user.email) ?? email,
      name: typeof user.name === 'string' ? user.name : null,
    },
  };
}

/**
 * Rotate a refresh ticket, and optionally mint a project access token with it.
 *
 * ```ts
 * // In a BFF route that proxies to one product:
 * const next = await refreshSession(process.env.IDENTITY_URL!, {
 *   refreshToken: req.cookies.fleet_session,
 *   audience: 'chat',
 * })
 * setSessionCookie(res, next)          // ⚠ ALWAYS, on every single call
 * forward(req, { Authorization: `${next.tokenType} ${next.token}` })
 * ```
 *
 * ⚠ PERSIST `refreshToken` BEFORE YOU DO ANYTHING ELSE WITH THE RESULT. The
 * ticket you passed in is dead the instant this resolves. Dropping the new one —
 * an early `return`, a thrown render, a cookie write behind a condition — logs
 * the user out, and the next attempt with the old value looks like a stolen
 * credential, which revokes the whole chain.
 *
 * ⚠ 401 AND 403 MEAN OPPOSITE THINGS HERE, and this is the mistake that signs
 * people out of every product:
 *
 * ```ts
 * catch (err) {
 *   if (err instanceof IdentitySessionError) {
 *     if (err.refreshTokenIsDead) return clearCookieAndRedirectToLogin()  // 401
 *     if (err.refreshTokenSurvived) return res.status(403).send(…)        // 403/404
 *     return res.status(503).send(…)   // unreachable / 5xx: outcome unknown
 *   }
 *   throw err
 * }
 * ```
 *
 * A 403 says the ticket is FINE and the user simply holds nothing on that one
 * project. The IdP mints the access token before it rotates, precisely so that
 * answer can be given without ending the session. Clearing the cookie on it
 * would sign a person out of every product because one assignment was missing.
 *
 * Omit `audience` when you only want to keep the session warm — a session-ping
 * route, or a page that needs no product token yet.
 *
 * @throws {IdentityConfigError} before any network call, on a missing `baseUrl`
 *   or `refreshToken`, or an `audience` that is present but not a non-empty string.
 * @throws {IdentitySessionError} on anything else.
 */
export async function refreshSession(
  baseUrl: string,
  args: { refreshToken: string; audience?: string },
  options: SessionOptions = {},
): Promise<RefreshedSession> {
  const fetchImpl = requireSessionConfig('refreshSession', baseUrl, options, [
    ['args.refreshToken', args?.refreshToken],
  ]);

  // `audience` is optional, but an EXPLICIT empty/blank one is a caller bug, and
  // catching it here beats spending a network round trip to be told 400.
  // `undefined` means "no token wanted"; `''` means the caller built the value
  // from something that was missing.
  const wantsToken = args.audience !== undefined;
  if (wantsToken && (typeof args.audience !== 'string' || args.audience.trim().length === 0)) {
    throw new IdentityConfigError(
      'refreshSession: `args.audience` was provided but is not a non-empty string. ' +
        'Omit it entirely to refresh without minting an access token.',
    );
  }
  const audience = wantsToken ? (args.audience as string).trim().toLowerCase() : undefined;
  const presented = args.refreshToken.trim();

  const { status, body, headers } = await post('refreshSession', 'refresh', fetchImpl, baseUrl, {
    path: 'refresh',
    payload: {
      refreshToken: presented,
      ...(audience === undefined ? {} : { audience }),
    },
    options,
    secrets: [presented],
  });

  if (status < 200 || status >= 300) {
    throw sessionError('refreshSession', 'refresh', status, body, headers, [presented]);
  }

  const raw = asRecord(body);
  const refreshToken = nonEmptyString(raw.refreshToken);
  const expiresAt = nonEmptyString(raw.expiresAt);
  if (!refreshToken || !expiresAt) {
    // ⚠ THE SESSION IS PROBABLY GONE. A 200 means the server rotated; without a
    // usable successor in the body there is nothing left to store, and the
    // ticket still in the cookie is spent. Re-presenting it would trip reuse
    // detection and revoke the chain, so this is reported as a dead session —
    // the user signs in again, which is the only recoverable path.
    throw new IdentitySessionError(
      'response_unusable',
      'refresh',
      'refreshSession: the identity provider answered 200 with no usable `refreshToken`. ' +
        'The ticket you sent has almost certainly been rotated already — treat this session as ' +
        'lost, clear the cookie, and do NOT retry with the old value.',
      status,
    );
  }

  const token = nonEmptyString(raw.token);
  if (!token) {
    // ⚠ NEVER THROW AWAY A ROTATION. If `audience` was asked for and no token
    // came back, the IdP has still rotated the ticket — discarding this response
    // to raise "no token" would log the user out to report a lesser problem.
    // Hand back the rotation; `token` is `undefined` and the caller's narrowing
    // forces them to notice.
    return { refreshToken, expiresAt };
  }

  return {
    refreshToken,
    expiresAt,
    audience: nonEmptyString(raw.audience) ?? audience ?? '',
    token,
    tokenType: nonEmptyString(raw.tokenType) ?? 'Bearer',
    expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 0,
    roles: stringArray(raw.roles),
    perms: stringArray(raw.perms),
  };
}

/**
 * Sign out: kill a refresh ticket and every ticket descended from it.
 *
 * ```ts
 * res.clearCookie('fleet_session')            // first — see below
 * await revokeSession(process.env.IDENTITY_URL!, { refreshToken: presented })
 *   .catch((err) => log.warn({ err }, 'revoke failed; cookie already cleared'))
 * ```
 *
 * ⚠ CLEAR YOUR OWN COOKIE FIRST, THEN CALL THIS. The user's browser must end up
 * signed out whatever the network does; a logout that hangs on a failed round
 * trip is worse than one that leaves a ticket alive for its remaining minutes.
 *
 * Resolves for ANY ticket the IdP accepts the shape of — unknown, already
 * revoked, or live. It is idempotent and it is not an oracle: those three cases
 * are indistinguishable on purpose, so this endpoint cannot be used to sort real
 * ticket values out of a list of guesses.
 *
 * It still throws on `malformed_request` (400) and `rate_limited` (429) — those
 * say something about YOUR call, not about any ticket — and on `unreachable`.
 *
 * @throws {IdentityConfigError} before any network call, on a missing `baseUrl`
 *   or `refreshToken`.
 * @throws {IdentitySessionError} on 400, 429, a 5xx, or a transport failure.
 */
export async function revokeSession(
  baseUrl: string,
  args: { refreshToken: string },
  options: SessionOptions = {},
): Promise<void> {
  const fetchImpl = requireSessionConfig('revokeSession', baseUrl, options, [
    ['args.refreshToken', args?.refreshToken],
  ]);

  const presented = args.refreshToken.trim();
  const { status, body, headers } = await post('revokeSession', 'revoke', fetchImpl, baseUrl, {
    path: 'revoke',
    payload: { refreshToken: presented },
    options,
    secrets: [presented],
  });

  if (status < 200 || status >= 300) {
    throw sessionError('revokeSession', 'revoke', status, body, headers, [presented]);
  }
}

// --- internals ----------------------------------------------------------------

/**
 * Validate everything a session call needs, and resolve `fetch`, BEFORE any
 * network traffic. Mirrors `requireServiceConfig` minus the service token.
 *
 * A caller bug (an empty password from an unvalidated form, a `baseUrl` read
 * from a missing env var) must surface as {@link IdentityConfigError} rather
 * than as a 400 that looks like the IdP misbehaving.
 */
function requireSessionConfig(
  label: string,
  baseUrl: string,
  options: SessionOptions,
  required: Array<[name: string, value: unknown]>,
): typeof fetch {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new IdentityConfigError(
      `${label}: \`baseUrl\` is required, e.g. https://identity.dev.example.org/api`,
    );
  }
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new IdentityConfigError(`${label}: \`${name}\` is required and must be a non-empty string`);
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new IdentityConfigError(
      `${label}: no global fetch found and none was injected via \`options.fetch\` — Node 20+ required.`,
    );
  }
  return fetchImpl;
}

/**
 * POST JSON to one session endpoint.
 *
 * ⚠ THE CREDENTIAL GOES IN THE BODY, NEVER IN THE URL. A refresh ticket in a
 * query string lands in the reverse proxy's access log, the browser's history
 * and every `Referer` header the page emits afterwards.
 */
async function post(
  label: string,
  operation: IdentitySessionOperation,
  fetchImpl: typeof fetch,
  baseUrl: string,
  args: {
    path: 'login' | 'refresh' | 'revoke';
    payload: Record<string, unknown>;
    options: SessionOptions;
    secrets: string[];
  },
) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/identity/${args.path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  // Optional, additive: forward the end user's IP only when the caller supplies
  // it. Absent ⇒ no header ⇒ unchanged behaviour. See SessionOptions.forwardedFor.
  const forwardedFor =
    typeof args.options.forwardedFor === 'string' ? args.options.forwardedFor.trim() : '';
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;

  return sendRequest(
    label,
    fetchImpl,
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(args.payload),
    },
    args.options,
    // Network, timeout and abort. `status: 0` matches the service lane's
    // convention so a consumer reading both families sees one meaning for it.
    (message) =>
      new IdentitySessionError(
        'unreachable',
        operation,
        redact(
          message +
            (operation === 'refresh'
              ? ' ⚠ The ticket may or may not have been rotated before the wire broke — retry at' +
                ' most once, and treat a 401 on that retry as an ordinary logout.'
              : ''),
          args.secrets,
        ),
        0,
      ),
  );
}

/**
 * Turn a non-2xx session response into a typed error.
 *
 * The status→reason mapping depends on WHICH call was made: a 401 from `/login`
 * means "those credentials are wrong", a 401 from `/refresh` means "this session
 * is over". One table, so the two can never drift.
 */
function sessionError(
  label: string,
  operation: IdentitySessionOperation,
  status: number,
  body: unknown,
  headers: Headers,
  secrets: string[],
): IdentitySessionError {
  const reason = reasonFor(operation, status);
  const detail = responseMessage(body);
  const retryAfterSeconds = reason === 'rate_limited' ? retryAfter(body, headers) : undefined;

  const explanation = EXPLANATIONS[reason];
  const suffix =
    reason === 'rate_limited' && retryAfterSeconds !== undefined
      ? ` Retry in ${retryAfterSeconds}s.`
      : '';

  return new IdentitySessionError(
    reason,
    operation,
    // ⚠ `detail` is server-controlled text. It is redacted before it is stored
    // on the error, because `safeJsonParse` folds a non-JSON error body into a
    // message verbatim — and a misconfigured proxy that echoes a request body
    // would otherwise put a live refresh ticket into a consumer's logs.
    redact(
      `${label}: ${explanation} (${status})${detail ? `: ${detail}` : ''}${suffix}`,
      secrets,
    ),
    status,
    retryAfterSeconds,
  );
}

/** The one status→reason table. See `IdentitySessionFailureReason` for meanings. */
function reasonFor(
  operation: IdentitySessionOperation,
  status: number,
): IdentitySessionFailureReason {
  if (status === 0) return 'unreachable';
  if (status === 400) return 'malformed_request';
  if (status === 401) return operation === 'login' ? 'invalid_credentials' : 'session_expired';
  if (status === 403) return operation === 'login' ? 'account_inactive' : 'project_access_denied';
  // ⚠ Only `/refresh` has a project to fail to find. A 404 anywhere else means
  // the endpoint is not mounted where `baseUrl` says it is — a configuration
  // problem, not an authorization answer, and reporting it as one would send a
  // consumer hunting for a missing project assignment that does not exist.
  if (status === 404) return operation === 'refresh' ? 'unknown_project' : 'server_error';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'token_signing_unavailable';
  return 'server_error';
}

const EXPLANATIONS: Record<IdentitySessionFailureReason, string> = {
  invalid_credentials:
    'the identity provider rejected these credentials — wrong password, unknown account or ' +
    'locked out, and it will not say which',
  account_inactive: 'the credentials are correct but the account is deactivated',
  session_expired:
    'the refresh ticket is no longer usable — unknown, revoked, expired or already rotated. ' +
    'The user must sign in again',
  project_access_denied:
    'the session is still valid, but this user has no active assignment on that project',
  unknown_project:
    'the session is still valid, but that project is unknown or inactive (check `baseUrl` ends ' +
    'in /api before blaming the slug)',
  token_signing_unavailable:
    'the session is still valid, but the identity provider has no signing key configured and ' +
    'cannot mint access tokens',
  malformed_request: 'the identity provider could not read the request body',
  rate_limited: 'rate limited by the identity provider',
  response_unusable: 'the identity provider answered without a usable refresh ticket',
  server_error: 'the identity provider failed',
  unreachable: 'the identity provider could not be reached',
};

/** 429 detail: the body field the IdP sends, or the standard header behind it. */
function retryAfter(body: unknown, headers: Headers): number | undefined {
  const fromBody = (body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) return fromBody;
  const header = Number.parseInt(headers.get('retry-after') ?? '', 10);
  return Number.isFinite(header) ? header : undefined;
}

/**
 * Replace every credential this call handled with `[redacted]`.
 *
 * ⚠ THE WHOLE POINT OF THIS FILE'S ERROR HANDLING. An error object is the thing
 * a consumer pipes straight into a log aggregator, and a refresh ticket in a log
 * line is a fortnight of cross-product impersonation sitting in a search index.
 *
 * Values shorter than 8 characters are skipped: a 4-character password is
 * already lost, and blanking every occurrence of a short string would mangle
 * unrelated words in the message and hide the real error.
 */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
