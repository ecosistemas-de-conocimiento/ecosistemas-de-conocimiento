// Session-lane tests. Injected `fetch`, no network, no database.
//
// The refresh ticket used throughout is a fixed, obviously-fake value that is
// long enough to trip the redaction guard's 8-character floor — several tests
// assert it never reaches a thrown error's message or its serialized form.

import { describe, expect, it, vi } from 'vitest';
import { IdentitySessionError } from './errors.js';
import { loginWithPassword, refreshSession, revokeSession } from './session.js';

const BASE = 'https://identity.dev.example.org/api';
const TICKET = 'rt_live_00000000000000000000000000000000';
const NEXT_TICKET = 'rt_live_11111111111111111111111111111111';
const PASSWORD = 'correct horse battery staple';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The IdP's error shape on every custom endpoint (Payload's REST convention). */
function idpError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { errors: [{ message }], ...extra });
}

function respondWith(res: Response | (() => Response)) {
  return vi.fn(async () => (typeof res === 'function' ? res() : res));
}

async function caught(promise: Promise<unknown>): Promise<IdentitySessionError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IdentitySessionError);
  return err as IdentitySessionError;
}

/** Everything a consumer might plausibly pipe into a log line. */
function serializations(err: unknown): string {
  const e = err as Error;
  return [e.message, String(e), JSON.stringify(e), e.stack ?? ''].join('\n');
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

function headersOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, string> {
  const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return (call[1].headers ?? {}) as Record<string, string>;
}

describe('loginWithPassword', () => {
  const okBody = {
    refreshToken: NEXT_TICKET,
    expiresAt: '2026-09-04T00:00:00.000Z',
    user: { email: 'ana@example.org', name: 'Ana Ruiz' },
  };

  it('exchanges a password for a ticket and posts to the right URL', async () => {
    const fetchImpl = respondWith(jsonResponse(200, okBody));

    const session = await loginWithPassword(
      BASE,
      { email: 'ana@example.org', password: PASSWORD },
      { fetch: fetchImpl },
    );

    expect(session).toEqual({
      refreshToken: NEXT_TICKET,
      expiresAt: '2026-09-04T00:00:00.000Z',
      user: { email: 'ana@example.org', name: 'Ana Ruiz' },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/identity/login`);
    expect(init.method).toBe('POST');
    // ⚠ No service credential on this lane, ever.
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('X-Service-Token');
  });

  it('normalises the email, keeps the password byte-for-byte, and passes `client`', async () => {
    const fetchImpl = respondWith(jsonResponse(200, okBody));

    await loginWithPassword(
      BASE,
      { email: '  ANA@example.org ', password: '  spaces matter  ' },
      { fetch: fetchImpl, client: ' chat ' },
    );

    expect(bodyOf(fetchImpl)).toEqual({
      email: 'ana@example.org',
      password: '  spaces matter  ',
      client: 'chat',
    });
  });

  it('tolerates a null display name', async () => {
    const fetchImpl = respondWith(
      jsonResponse(200, { ...okBody, user: { email: 'ana@example.org', name: null } }),
    );
    const session = await loginWithPassword(
      BASE,
      { email: 'ana@example.org', password: PASSWORD },
      { fetch: fetchImpl },
    );
    expect(session.user.name).toBeNull();
  });

  it('maps 401 to `invalid_credentials` — the one answer for all three failures', async () => {
    const fetchImpl = respondWith(idpError(401, 'Invalid email or password.'));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('invalid_credentials');
    expect(err.operation).toBe('login');
    expect(err.status).toBe(401);
    expect(err.mustReauthenticate).toBe(true);
    // No ticket was presented, so neither ticket getter may claim anything.
    expect(err.refreshTokenIsDead).toBe(false);
    expect(err.refreshTokenSurvived).toBe(false);
  });

  it('maps 403 to a DIFFERENT reason — a deactivated account is not a wrong password', async () => {
    const fetchImpl = respondWith(idpError(403, 'This account is not active.'));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('account_inactive');
    expect(err.status).toBe(403);
    // ⚠ Retyping the password can never help — bouncing back to the login form
    // would be an infinite loop.
    expect(err.mustReauthenticate).toBe(false);
  });

  it('maps 400 to `malformed_request`', async () => {
    const fetchImpl = respondWith(idpError(400, 'Body must be JSON with non-empty string `email`.'));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );
    expect(err.reason).toBe('malformed_request');
  });

  it('maps 500 to `server_error` and marks it transient', async () => {
    const fetchImpl = respondWith(idpError(500, 'Could not start a session.'));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );
    expect(err.reason).toBe('server_error');
    expect(err.isTransient).toBe(true);
  });

  it('rejects an empty email or password before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      loginWithPassword(BASE, { email: '', password: PASSWORD }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    await expect(
      loginWithPassword(BASE, { email: 'ana@example.org', password: '' }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    await expect(
      loginWithPassword('', { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a 200 with no refreshToken as `response_unusable`', async () => {
    const fetchImpl = respondWith(jsonResponse(200, { user: { email: 'ana@example.org' } }));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );
    expect(err.reason).toBe('response_unusable');
    // No ticket existed to kill, so login must not claim a dead session.
    expect(err.refreshTokenIsDead).toBe(false);
  });
});

describe('refreshSession', () => {
  const rotated = { refreshToken: NEXT_TICKET, expiresAt: '2026-09-04T00:00:00.000Z' };

  it('rotates without an audience and mints nothing', async () => {
    const fetchImpl = respondWith(jsonResponse(200, rotated));

    const next = await refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl });

    expect(next.refreshToken).toBe(NEXT_TICKET);
    expect(next.expiresAt).toBe('2026-09-04T00:00:00.000Z');
    expect(next.token).toBeUndefined();
    // ⚠ The credential travels in the BODY, never the URL — a ticket in a query
    // string lands in access logs, history and every later Referer header.
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE}/v1/identity/refresh`);
    expect(url).not.toContain(TICKET);
    expect(bodyOf(fetchImpl)).toEqual({ refreshToken: TICKET });
  });

  it('rotates AND mints when an audience is sent', async () => {
    const fetchImpl = respondWith(
      jsonResponse(200, {
        ...rotated,
        audience: 'chat',
        token: 'eyJhbGciOiJFZERTQSJ9.body.sig',
        tokenType: 'Bearer',
        expiresIn: 900,
        roles: ['coordinator'],
        perms: ['thread:post'],
      }),
    );

    const next = await refreshSession(
      BASE,
      { refreshToken: TICKET, audience: ' CHAT ' },
      { fetch: fetchImpl },
    );

    expect(bodyOf(fetchImpl)).toEqual({ refreshToken: TICKET, audience: 'chat' });
    expect(next.refreshToken).toBe(NEXT_TICKET);
    expect(next.token).toBe('eyJhbGciOiJFZERTQSJ9.body.sig');
    expect(next.tokenType).toBe('Bearer');
    expect(next.expiresIn).toBe(900);
    expect(next.audience).toBe('chat');
    expect(next.roles).toEqual(['coordinator']);
    expect(next.perms).toEqual(['thread:post']);
  });

  it('401 means THE TICKET IS DEAD — sign the user out', async () => {
    const fetchImpl = respondWith(idpError(401, 'Session expired. Sign in again.'));
    const err = await caught(
      refreshSession(BASE, { refreshToken: TICKET, audience: 'chat' }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('session_expired');
    expect(err.refreshTokenIsDead).toBe(true);
    expect(err.refreshTokenSurvived).toBe(false);
    expect(err.mustReauthenticate).toBe(true);
  });

  it('403 means THE TICKET IS ALIVE — deny one project, keep the session', async () => {
    const fetchImpl = respondWith(idpError(403, 'You have no active assignment on project "chat".'));
    const err = await caught(
      refreshSession(BASE, { refreshToken: TICKET, audience: 'chat' }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('project_access_denied');
    // ⚠ The regression this test exists for: clearing the cookie here signs a
    // person out of every product because ONE assignment was missing.
    expect(err.refreshTokenIsDead).toBe(false);
    expect(err.refreshTokenSurvived).toBe(true);
    expect(err.mustReauthenticate).toBe(false);
  });

  it('404 also leaves the ticket alive — the project is missing, not the session', async () => {
    const fetchImpl = respondWith(idpError(404, 'Unknown project "chatt".'));
    const err = await caught(
      refreshSession(BASE, { refreshToken: TICKET, audience: 'chatt' }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('unknown_project');
    expect(err.refreshTokenIsDead).toBe(false);
    expect(err.refreshTokenSurvived).toBe(true);
  });

  it('503 leaves the ticket alive and is transient — the IdP has no signing key', async () => {
    const fetchImpl = respondWith(idpError(503, 'Token issuance is not configured on this server.'));
    const err = await caught(
      refreshSession(BASE, { refreshToken: TICKET, audience: 'chat' }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('token_signing_unavailable');
    expect(err.refreshTokenSurvived).toBe(true);
    expect(err.isTransient).toBe(true);
  });

  it('500 claims neither — the rotation outcome is genuinely unknown', async () => {
    const fetchImpl = respondWith(idpError(500, 'Could not renew the session.'));
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    expect(err.reason).toBe('server_error');
    expect(err.refreshTokenIsDead).toBe(false);
    expect(err.refreshTokenSurvived).toBe(false);
  });

  it('never discards a rotation to report a missing access token', async () => {
    // Contract violation: `audience` was asked for, the IdP rotated but minted
    // nothing. Throwing here would log the user out over a lesser problem.
    const fetchImpl = respondWith(jsonResponse(200, rotated));
    const next = await refreshSession(
      BASE,
      { refreshToken: TICKET, audience: 'chat' },
      { fetch: fetchImpl },
    );
    expect(next.refreshToken).toBe(NEXT_TICKET);
    expect(next.token).toBeUndefined();
  });

  it('treats a 200 with no successor as a lost session', async () => {
    const fetchImpl = respondWith(jsonResponse(200, { expiresAt: '2026-09-04T00:00:00.000Z' }));
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    expect(err.reason).toBe('response_unusable');
    // The presented ticket was almost certainly spent server-side; re-presenting
    // it would read as theft and revoke the chain.
    expect(err.refreshTokenIsDead).toBe(true);
  });

  it('rejects a blank refreshToken or a present-but-empty audience before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      refreshSession(BASE, { refreshToken: '' }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    await expect(
      refreshSession(BASE, { refreshToken: TICKET, audience: '  ' }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('revokeSession', () => {
  it('resolves to undefined on 204', async () => {
    const fetchImpl = respondWith(new Response(null, { status: 204 }));
    await expect(
      revokeSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/identity/revoke`);
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: TICKET });
  });

  it('resolves for an unknown ticket too — revocation is idempotent, not an oracle', async () => {
    // The IdP answers 204 whether the ticket was live, already revoked or never
    // existed. A client that threw on one of those would rebuild the oracle the
    // endpoint was designed to remove.
    const fetchImpl = respondWith(new Response(null, { status: 204 }));
    await expect(
      revokeSession(BASE, { refreshToken: 'rt_never_existed_0000000000000000' }, { fetch: fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('still throws on 400 — that is the caller’s bug, not a ticket verdict', async () => {
    const fetchImpl = respondWith(idpError(400, 'Body must be JSON with a non-empty string.'));
    const err = await caught(revokeSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));
    expect(err.reason).toBe('malformed_request');
    expect(err.operation).toBe('revoke');
  });

  it('rejects a blank ticket before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      revokeSession(BASE, { refreshToken: '' }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('carries retryAfterSeconds from the body', async () => {
    const fetchImpl = respondWith(
      idpError(429, 'Too many requests. Retry in 42s.', { retryAfterSeconds: 42 }),
    );
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );

    expect(err.reason).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.isTransient).toBe(true);
    expect(err.message).toContain('Retry in 42s');
  });

  it('falls back to the Retry-After header when the body omits the field', async () => {
    const fetchImpl = respondWith(
      jsonResponse(429, { errors: [{ message: 'Too many requests.' }] }, { 'retry-after': '17' }),
    );
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    expect(err.retryAfterSeconds).toBe(17);
    // A 429 never reaches the ticket lookup on the IP bucket, and never rotates
    // on the per-user one — the session is untouched either way.
    expect(err.refreshTokenSurvived).toBe(true);
    expect(err.refreshTokenIsDead).toBe(false);
  });
});

describe('transport failures', () => {
  it('classifies a network failure as status 0 / `unreachable`', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    expect(err.status).toBe(0);
    expect(err.reason).toBe('unreachable');
    expect(err.isTransient).toBe(true);
    // ⚠ Neither getter fires: the request may have rotated before the wire broke.
    expect(err.refreshTokenIsDead).toBe(false);
    expect(err.refreshTokenSurvived).toBe(false);
    expect(err.message).toContain('may or may not have been rotated');
  });

  it('aborts on timeout and reports it as `unreachable`', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const err = await caught(
      loginWithPassword(
        BASE,
        { email: 'ana@example.org', password: PASSWORD },
        { fetch: fetchImpl as unknown as typeof fetch, timeoutMs: 5 },
      ),
    );

    expect(err.status).toBe(0);
    expect(err.reason).toBe('unreachable');
    expect(err.message).toContain('timed out after 5ms');
  });
});

describe('credentials never leave through an error', () => {
  const statuses = [400, 401, 403, 404, 429, 500, 503];

  it.each(statuses)('keeps the refresh ticket out of a %i error', async (status) => {
    // ⚠ The IdP does not echo request bodies, but a misconfigured proxy in front
    // of it might, and `safeJsonParse` folds a non-JSON error body into the
    // message verbatim. Simulate the worst case.
    const fetchImpl = respondWith(
      new Response(`upstream rejected: {"refreshToken":"${TICKET}"}`, { status }),
    );
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    expect(serializations(err)).not.toContain(TICKET);
    expect(err.message).toContain('[redacted]');
  });

  it('keeps the ticket out of a transport error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending ${TICKET}`);
    });
    const err = await caught(revokeSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));
    expect(serializations(err)).not.toContain(TICKET);
  });

  it('keeps the password out of a login error', async () => {
    const fetchImpl = respondWith(new Response(`echo: ${PASSWORD}`, { status: 401 }));
    const err = await caught(
      loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl }),
    );
    expect(serializations(err)).not.toContain(PASSWORD);
  });

  it('stores no response body on the error, so JSON.stringify cannot leak one', async () => {
    const fetchImpl = respondWith(jsonResponse(401, { errors: [{ message: 'nope' }], echo: TICKET }));
    const err = await caught(refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl }));

    // The whole enumerable surface: three facts and the class name. No body, no
    // headers, no cause — nothing that could ever have held a credential.
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'IdentitySessionError',
      reason: 'session_expired',
      operation: 'refresh',
      status: 401,
    });
  });
});

// The optional `forwardedFor` lets a BFF hand the IdP the END USER's IP so the
// IdP's per-IP buckets count the real client, not the BFF's one egress. It is
// additive: absent ⇒ no header ⇒ unchanged.
describe('forwardedFor — forwarding the end-user IP', () => {
  const okLogin = {
    refreshToken: NEXT_TICKET,
    expiresAt: '2026-09-04T00:00:00.000Z',
    user: { email: 'ana@example.org', name: 'Ana Ruiz' },
  };
  const okRefresh = { refreshToken: NEXT_TICKET, expiresAt: '2026-09-04T00:00:00.000Z' };

  it('sets X-Forwarded-For on login when supplied', async () => {
    const fetchImpl = respondWith(jsonResponse(200, okLogin));
    await loginWithPassword(
      BASE,
      { email: 'ana@example.org', password: PASSWORD },
      { fetch: fetchImpl, forwardedFor: '198.51.100.23' },
    );
    expect(headersOf(fetchImpl)['X-Forwarded-For']).toBe('198.51.100.23');
  });

  it('sets X-Forwarded-For on refresh when supplied', async () => {
    const fetchImpl = respondWith(jsonResponse(200, okRefresh));
    await refreshSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl, forwardedFor: '198.51.100.24' });
    expect(headersOf(fetchImpl)['X-Forwarded-For']).toBe('198.51.100.24');
  });

  it('sets X-Forwarded-For on revoke when supplied', async () => {
    const fetchImpl = respondWith(jsonResponse(200, {}));
    await revokeSession(BASE, { refreshToken: TICKET }, { fetch: fetchImpl, forwardedFor: '198.51.100.25' });
    expect(headersOf(fetchImpl)['X-Forwarded-For']).toBe('198.51.100.25');
  });

  it('trims the value and drops a blank one', async () => {
    const set = respondWith(jsonResponse(200, okRefresh));
    await refreshSession(BASE, { refreshToken: TICKET }, { fetch: set, forwardedFor: '  203.0.113.7  ' });
    expect(headersOf(set)['X-Forwarded-For']).toBe('203.0.113.7');

    const blank = respondWith(jsonResponse(200, okRefresh));
    await refreshSession(BASE, { refreshToken: TICKET }, { fetch: blank, forwardedFor: '   ' });
    expect('X-Forwarded-For' in headersOf(blank)).toBe(false);
  });

  it('sends NO X-Forwarded-For when the option is absent — behaviour unchanged', async () => {
    const fetchImpl = respondWith(jsonResponse(200, okLogin));
    await loginWithPassword(BASE, { email: 'ana@example.org', password: PASSWORD }, { fetch: fetchImpl });
    expect('X-Forwarded-For' in headersOf(fetchImpl)).toBe(false);
  });
});
