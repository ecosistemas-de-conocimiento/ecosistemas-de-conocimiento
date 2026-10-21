// CONTRACT suite for `createIdentitySession`. Injected `fetch`, a Map-backed
// store, an injected clock: no IdP, no database, no timers, no network.
//
// These are not unit tests of an implementation detail. Each one pins a rule a
// consumer cannot break without losing sessions in production:
//
//   1. rotate → persist ORDERING — the ticket is written before anything else,
//      and before the caller ever sees the result;
//   2. 401 vs 403 BRANCHING — one clears the store, the other must not;
//   3. SINGLE-FLIGHT — two concurrent refreshes of one ticket make ONE call,
//      because the IdP treats the second as theft and revokes the chain;
//   4. the SPENT-TICKET MEMO — a straggler carrying an already-rotated ticket is
//      served the memoised outcome instead of presenting a dead ticket;
//   5. CLOCK-BASED EXPIRY — the memo window and the cookie `maxAge` clamp.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdentitySession,
  resetIdentitySessionState,
  type IdentitySessionStore,
  type StoredTicket,
  type StoredToken,
} from './sessionManager.js';

const BASE = 'https://identity.dev.example.org/api';
const TICKET = 'rt_live_00000000000000000000000000000000';
const NEXT_TICKET = 'rt_live_11111111111111111111111111111111';
const THIRD_TICKET = 'rt_live_22222222222222222222222222222222';
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.fake.token';
/** 14 days after NOW, so `ticketMaxAge` lands on the ceiling. */
const EXPIRES_AT = '2026-09-19T00:00:00.000Z';
const NOW = Date.parse('2026-09-05T00:00:00.000Z');

/**
 * The store the whole suite runs on: a `Map`, plus an ordered log of every
 * call, because ORDER is half of the contract.
 */
function mapStore() {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const store: IdentitySessionStore = {
    saveTicket(ticket: StoredTicket) {
      calls.push('saveTicket');
      values.set('ticket', ticket.refreshToken);
      values.set('ticketMaxAge', String(ticket.maxAge));
    },
    saveToken(token: StoredToken) {
      calls.push('saveToken');
      values.set('token', token.token);
      values.set('tokenMaxAge', String(token.maxAge));
    },
    clear() {
      calls.push('clear');
      values.clear();
    },
  };
  return { store, values, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function idpError(status: number, message: string): Response {
  return jsonResponse(status, { errors: [{ message }] });
}

const ROTATED_OK = {
  refreshToken: NEXT_TICKET,
  expiresAt: EXPIRES_AT,
  audience: 'chat',
  token: TOKEN,
  tokenType: 'Bearer',
  expiresIn: 900,
  roles: ['member'],
  perms: ['chat:use'],
};

/** A manager wired to a fixed clock and a scripted `fetch`. */
function manager(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createIdentitySession>[0]> = {},
) {
  const { store, values, calls } = mapStore();
  const session = createIdentitySession({
    baseUrl: BASE,
    project: 'chat',
    store,
    clock: () => NOW,
    fetch: fetchImpl,
    ...overrides,
  });
  return { session, store, values, calls };
}

beforeEach(() => {
  resetIdentitySessionState();
});

describe('construction', () => {
  it('rejects a manager with no project — there is no fleet-wide token', () => {
    expect(() =>
      createIdentitySession({ baseUrl: BASE, project: '', store: mapStore().store }),
    ).toThrow(/`audience` \(or deprecated `project`\) is required/);
  });

  it('rejects a store that cannot persist a ticket', () => {
    expect(() =>
      createIdentitySession({
        baseUrl: BASE,
        project: 'chat',
        store: {} as unknown as IdentitySessionStore,
      }),
    ).toThrow(/`store` must implement/);
  });

  it('tolerates an empty baseUrl and answers `unavailable` rather than crashing on boot', async () => {
    const fetchImpl = vi.fn();
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch, { baseUrl: '' });
    const result = await session.renew(TICKET);
    expect(result).toEqual({ ok: false, kind: 'unavailable', error: expect.stringContaining('baseUrl') });
    expect(fetchImpl).not.toHaveBeenCalled();
    // ⚠ A missing env var must not clear anybody's session.
    expect(calls).toEqual([]);
  });
});

describe('rotate → persist ordering', () => {
  it('persists the NEW ticket, never the presented one, and the ticket before the token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session, values, calls } = manager(fetchImpl as unknown as typeof fetch);

    const result = await session.renew(TICKET);

    expect(result.ok).toBe(true);
    expect(values.get('ticket')).toBe(NEXT_TICKET);
    expect(values.get('token')).toBe(TOKEN);
    // 🔴 The ticket is the value that cannot be re-minted. It goes down first.
    expect(calls).toEqual(['saveTicket', 'saveToken']);
  });

  it('has already persisted by the time the caller sees the result', async () => {
    let persistedWhenResolved: string | undefined;
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session, values } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET).then(() => {
      persistedWhenResolved = values.get('ticket');
    });

    expect(persistedWhenResolved).toBe(NEXT_TICKET);
  });

  it('persists the rotation even when the IdP minted NO access token', async () => {
    // A 200 with no `token` still SPENT the presented ticket. Dropping the
    // successor here strands the browser on a dead ticket, and its next request
    // reads as theft.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { refreshToken: NEXT_TICKET, expiresAt: EXPIRES_AT }),
    );
    const { session, values, calls } = manager(fetchImpl as unknown as typeof fetch);

    const result = await session.renew(TICKET);

    expect(result.ok).toBe(false);
    expect(values.get('ticket')).toBe(NEXT_TICKET);
    expect(calls).toEqual(['saveTicket']);
  });

  it('start() stores the ticket the REFRESH returned, never the one login returned', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/login')
        ? jsonResponse(200, {
            refreshToken: TICKET,
            expiresAt: EXPIRES_AT,
            user: { email: 'ana@example.org', name: 'Ana' },
          })
        : jsonResponse(200, ROTATED_OK),
    );
    const { session, values } = manager(fetchImpl as unknown as typeof fetch);

    const result = await session.start({ email: 'Ana@example.org', password: 'hunter2hunter2' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user).toEqual({ email: 'ana@example.org', name: 'Ana' });
    expect(values.get('ticket')).toBe(NEXT_TICKET);
  });
});

describe('401 vs 403 branching', () => {
  it('401 on refresh is `dead` and CLEARS the store', async () => {
    const fetchImpl = vi.fn(async () => idpError(401, 'Invalid session.'));
    const { session, values, calls } = manager(fetchImpl as unknown as typeof fetch);
    values.set('ticket', TICKET);

    const result = await session.renew(TICKET);

    expect(result).toMatchObject({ ok: false, kind: 'dead' });
    expect(calls).toEqual(['clear']);
    expect(values.size).toBe(0);
  });

  it('403 on refresh is `survived` and TOUCHES NOTHING', async () => {
    // 🔴 The regression this test exists for: clearing here signs a person out
    // of every product in the fleet because one project assignment was missing.
    const fetchImpl = vi.fn(async () => idpError(403, 'No access to that project.'));
    const { session, values, calls } = manager(fetchImpl as unknown as typeof fetch);
    values.set('ticket', TICKET);

    const result = await session.renew(TICKET);

    expect(result).toMatchObject({ ok: false, kind: 'survived' });
    expect(calls).toEqual([]);
    expect(values.get('ticket')).toBe(TICKET);
  });

  it('404 (unknown project) is `survived` too — the session is fine', async () => {
    const fetchImpl = vi.fn(async () => idpError(404, 'Unknown project.'));
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew(TICKET)).toMatchObject({ ok: false, kind: 'survived' });
    expect(calls).toEqual([]);
  });

  it.each([
    [429, 'rate limited'],
    [503, 'no signing key'],
    [500, 'boom'],
  ])('%i is `unavailable` and touches nothing — the outcome is unknown', async (status, msg) => {
    const fetchImpl = vi.fn(async () => idpError(status, msg));
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew(TICKET)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(calls).toEqual([]);
  });

  it('400 is `misconfigured`, NOT `unavailable` — retrying never fixes a bad audience', async () => {
    // 🔴 Folding 400 into `unavailable` turns a permanent deploy bug (a project
    // slug the IdP will not accept) into an endless 503 loop that logs
    // "identity provider unavailable" about an IdP that is up.
    const fetchImpl = vi.fn(async () => idpError(400, 'Malformed request.'));
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew(TICKET)).toMatchObject({ ok: false, kind: 'misconfigured' });
    // The ticket is FINE. Nothing is cleared.
    expect(calls).toEqual([]);
  });

  it('a transport failure is `unavailable`, not `dead` — the ticket may have rotated', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew(TICKET)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(calls).toEqual([]);
  });

  it('start() separates wrong-password (401) from deactivated (403)', async () => {
    const invalid = vi.fn(async () => idpError(401, 'Invalid credentials.'));
    const inactive = vi.fn(async () => idpError(403, 'Account deactivated.'));

    expect(
      await manager(invalid as unknown as typeof fetch).session.start({
        email: 'a@b.io',
        password: 'nopenopenope',
      }),
    ).toMatchObject({ kind: 'invalid-credentials' });

    expect(
      await manager(inactive as unknown as typeof fetch).session.start({
        email: 'a@b.io',
        password: 'nopenopenope',
      }),
    ).toMatchObject({ kind: 'inactive' });
  });

  it('no ticket at all is `dead` without touching the store or the network', async () => {
    const fetchImpl = vi.fn();
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew('')).toMatchObject({ ok: false, kind: 'dead' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('single-flight per ticket', () => {
  it('EIGHT parallel refreshes of one ticket make ONE call to the IdP', async () => {
    // 🔴 The IdP revokes the whole chain when one ticket is rotated twice
    // concurrently (refreshTokens.ts RefreshRotationRaceLost). Serializing is
    // the consumer's job — the IdP cannot tell a double-firing browser from a
    // thief racing the real user.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, ROTATED_OK);
    });
    const { session, values } = manager(fetchImpl as unknown as typeof fetch);

    const flights = Array.from({ length: 8 }, () => session.renew(TICKET));
    release();
    const results = await Promise.all(flights);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(values.get('ticket')).toBe(NEXT_TICKET);
  });

  it('every request in the burst persists through ITS OWN store', async () => {
    // Two requests = two cookie jars. The flight is shared; the writes are not.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, ROTATED_OK);
    });
    const a = manager(fetchImpl as unknown as typeof fetch);
    const b = manager(fetchImpl as unknown as typeof fetch);

    const flights = [a.session.renew(TICKET), b.session.renew(TICKET)];
    release();
    await Promise.all(flights);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.values.get('ticket')).toBe(NEXT_TICKET);
    expect(b.values.get('ticket')).toBe(NEXT_TICKET);
  });

  it('DIFFERENT tickets are not collapsed into one flight', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await Promise.all([session.renew(TICKET), session.renew(THIRD_TICKET)]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failed flight is not memoised — the next request retries', async () => {
    // Memoising a failure would pin a transient outage to a ticket for the
    // whole window and 503 requests that would have worked.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(idpError(500, 'boom'))
      .mockResolvedValueOnce(jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    expect(await session.renew(TICKET)).toMatchObject({ kind: 'unavailable' });
    expect(await session.renew(TICKET)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('spent-ticket memo', () => {
  it('a straggler carrying the SPENT ticket is served the memo, with no IdP call', async () => {
    // 🔴 Measured in a real browser: request 8 left before request 1's rotated
    // Set-Cookie landed, and arrived 1.8 s later — long after the flight
    // settled. The single-flight only ever covered the round trip.
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET);
    const straggler = manager(fetchImpl as unknown as typeof fetch);
    const late = await straggler.session.renew(TICKET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(late).toMatchObject({ ok: true, refreshToken: NEXT_TICKET });
    // The straggler re-persists the SAME pair, so its response carries correct
    // cookies instead of stale ones.
    expect(straggler.values.get('ticket')).toBe(NEXT_TICKET);
    expect(straggler.values.get('token')).toBe(TOKEN);
  });

  it('memoises the rotated-no-token outcome too', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { refreshToken: NEXT_TICKET, expiresAt: EXPIRES_AT }),
    );
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET);
    const late = await session.renew(TICKET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(late).toMatchObject({ ok: false, rotated: { refreshToken: NEXT_TICKET } });
  });

  it('forget() drops the memo so a signed-out browser cannot be re-authenticated', async () => {
    // The memo re-persists with NO IdP call, so revoking at the IdP does not
    // close this window. It has to be dropped locally.
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET);
    session.forget(NEXT_TICKET); // sign out on the SUCCESSOR, as a logout does

    const straggler = manager(fetchImpl as unknown as typeof fetch);
    const late = await straggler.session.renew(TICKET);

    // The memo is gone AND the chain is marked ended, so the straggler is told
    // the session is over rather than being handed a fresh one — and it never
    // reaches the IdP with a ticket whose chain was just revoked.
    expect(late).toMatchObject({ ok: false, kind: 'dead' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(straggler.values.size).toBe(0);
  });

  it('end() clears the store BEFORE it talks to the IdP, and survives a revoke failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { session, values, calls } = manager(fetchImpl as unknown as typeof fetch);
    values.set('ticket', TICKET);

    await expect(session.end(TICKET)).resolves.toBeUndefined();

    expect(calls).toEqual(['clear']);
    expect(values.size).toBe(0);
  });

  it('🔴 forget() walks the WHOLE chain, so A→B→C survives a sign-out on C', async () => {
    // The bug: dropping only `B→C` leaves `A→B` memoised. A straggler still
    // carrying A is then served B and its access token with NO IdP call, so the
    // browser is re-authenticated for the rest of the memo window AFTER sign-out.
    // Revoking at the IdP cannot help — the memo never asks it.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...ROTATED_OK, refreshToken: NEXT_TICKET }))
      .mockResolvedValueOnce(jsonResponse(200, { ...ROTATED_OK, refreshToken: THIRD_TICKET }))
      .mockImplementation(async () => idpError(401, 'Invalid session.'));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET); // A -> B
    await session.renew(NEXT_TICKET); // B -> C
    await session.end(THIRD_TICKET); // sign out on C

    const straggler = manager(fetchImpl as unknown as typeof fetch);
    const late = await straggler.session.renew(TICKET); // still carrying A

    expect(late).toMatchObject({ ok: false, kind: 'dead' });
    expect(straggler.values.get('token')).toBeUndefined();
    expect(straggler.values.get('ticket')).toBeUndefined();
  });

  it('🔴 forget() walks FORWARD too: ending on A also drops B→C', async () => {
    // A logout races the rotations it is ending, so the ticket it holds is
    // routinely OLDER than the memo's head. Purging predecessors only leaves
    // B→C alive, and a request carrying B is served C with no IdP call.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...ROTATED_OK, refreshToken: NEXT_TICKET }))
      .mockResolvedValueOnce(jsonResponse(200, { ...ROTATED_OK, refreshToken: THIRD_TICKET }))
      .mockImplementation(async () => idpError(401, 'Invalid session.'));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET); // A -> B
    await session.renew(NEXT_TICKET); // B -> C
    session.forget(TICKET); // sign out holding the OLDEST link

    const straggler = manager(fetchImpl as unknown as typeof fetch);
    const late = await straggler.session.renew(NEXT_TICKET); // carrying B

    expect(late).toMatchObject({ ok: false, kind: 'dead' });
    expect(straggler.values.get('token')).toBeUndefined();
  });

  it("🔴 a `dead` renew purges the chain too, so the PREDECESSOR's memo cannot re-authenticate", async () => {
    // MEASURED BY THE FIRST ADOPTER (chat, ADR-0001 Phase 2): a 200 where a 401
    // belongs. `renew()` cleared the store on `dead` but never purged the memo,
    // so the entry A→B — written by the rotation BEFORE the one that died —
    // survived, still holding a live access token. A straggler the browser had
    // dispatched before the session ended presented A, was served B from the
    // memo with NO IdP call, and was re-cookied into a session that is over.
    //
    // HANDOFF-P2 § "the exact call sequence" already promised the contract this
    // pins: `'dead'` means "store already cleared + memo purged".
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...ROTATED_OK, refreshToken: NEXT_TICKET }))
      .mockImplementation(async () => idpError(401, 'Invalid session.'));
    const { session, calls } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET); // A -> B, memoised
    const died = await session.renew(NEXT_TICKET); // B is dead: session over

    expect(died).toMatchObject({ ok: false, kind: 'dead' });
    expect(calls).toContain('clear');

    const straggler = manager(fetchImpl as unknown as typeof fetch);
    const late = await straggler.session.renew(TICKET); // still carrying A

    expect(late).toMatchObject({ ok: false, kind: 'dead' });
    expect(straggler.values.get('ticket')).toBeUndefined();
    expect(straggler.values.get('token')).toBeUndefined();
    expect(straggler.calls).toEqual([]); // nothing persisted, not even a re-clear
    // The chain is marked ended, so the straggler never presents a revoked
    // ticket to the IdP either.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('🔴 an awaiter of an IN-FLIGHT rotation does not persist after end()', async () => {
    // The flight started BEFORE the sign-out, so purging the memo cannot reach
    // it. Its awaiter holds its own cookie jar, which end() never touched —
    // without the interlock it writes a live session into a signed-out browser.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, ROTATED_OK);
    });
    const awaiter = manager(fetchImpl as unknown as typeof fetch);
    // Its own fetch: revoke must not queue behind the gated refresh above.
    const loggingOut = manager(
      vi.fn(async () => jsonResponse(204, {})) as unknown as typeof fetch,
    );

    const pending = awaiter.session.renew(TICKET); // in the air…
    await loggingOut.session.end(TICKET); // …sign-out lands mid-flight
    release();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, kind: 'dead' });
    expect(awaiter.values.size).toBe(0);
    expect(awaiter.calls).toEqual([]); // not even a clear — end() already did it
  });

  it('the ended marker expires with the memo window', async () => {
    let clock = NOW;
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { store, values } = mapStore();
    const session = createIdentitySession({
      baseUrl: BASE,
      project: 'chat',
      store,
      clock: () => clock,
      fetch: fetchImpl as unknown as typeof fetch,
      memoMs: 30_000,
    });

    session.forget(TICKET);
    expect(await session.renew(TICKET)).toMatchObject({ ok: false, kind: 'dead' });
    expect(fetchImpl).not.toHaveBeenCalled();

    clock = NOW + 30_001;
    expect(await session.renew(TICKET)).toMatchObject({ ok: true });
    expect(values.get('ticket')).toBe(NEXT_TICKET);
  });

  it('🔴 two managers with DIFFERENT projects never share a flight or a memo', async () => {
    // One refresh ticket is fleet-wide; the `audience` on the call is not. A key
    // without the project hands a chat-scoped access token to the manager whose
    // store writes another product's cookies.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { audience: string };
      return jsonResponse(200, { ...ROTATED_OK, audience: body.audience, token: `tok_${body.audience}` });
    });
    const chat = manager(fetchImpl as unknown as typeof fetch, { project: 'chat' });
    const frontendCode = manager(fetchImpl as unknown as typeof fetch, { project: 'frontend-code' });

    await Promise.all([chat.session.renew(TICKET), frontendCode.session.renew(TICKET)]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(chat.values.get('token')).toBe('tok_chat');
    expect(frontendCode.values.get('token')).toBe('tok_frontend-code');
  });

  it('evicts oldest-first at the cap', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch, { memoMax: 1 });

    await session.renew(TICKET);
    await session.renew(THIRD_TICKET); // evicts TICKET's entry
    await session.renew(TICKET); // must go back to the IdP

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('clock-based expiry', () => {
  it('a memo entry past its window is not served', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    let clock = NOW;
    const { store } = mapStore();
    const session = createIdentitySession({
      baseUrl: BASE,
      project: 'chat',
      store,
      clock: () => clock,
      fetch: fetchImpl as unknown as typeof fetch,
      memoMs: 30_000,
    });

    await session.renew(TICKET);
    clock = NOW + 29_999;
    await session.renew(TICKET);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still inside the window

    clock = NOW + 30_001;
    await session.renew(TICKET);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clamps the ticket maxAge to the ceiling and the token maxAge to 900', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session, values } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET);

    expect(values.get('ticketMaxAge')).toBe(String(14 * 24 * 60 * 60));
    expect(values.get('tokenMaxAge')).toBe('900');
  });

  it('an ALREADY-EXPIRED ticket gets the floor, never a maxAge that deletes the cookie', async () => {
    // 🔴 Clock skew in a container would otherwise write maxAge <= 0, which
    // deletes the cookie and throws away the only copy of a ticket that is
    // probably fine.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...ROTATED_OK, expiresAt: '2026-09-04T00:00:00.000Z' }),
    );
    const { session, values } = manager(fetchImpl as unknown as typeof fetch);

    await session.renew(TICKET);

    expect(values.get('ticketMaxAge')).toBe('60');
  });

  it('an unparseable expiresAt falls back to the configured TTL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...ROTATED_OK, expiresAt: 'not-a-date' }),
    );
    const { session, values } = manager(fetchImpl as unknown as typeof fetch, {
      ticketTtlSeconds: 4242,
    });

    await session.renew(TICKET);

    expect(values.get('ticketMaxAge')).toBe('4242');
  });

  it('an over-long expiresIn is capped, and a missing one falls back', async () => {
    const long = vi.fn(async () => jsonResponse(200, { ...ROTATED_OK, expiresIn: 99_999 }));
    expect(await run(long)).toBe('900');

    const missing = vi.fn(async () => jsonResponse(200, { ...ROTATED_OK, expiresIn: undefined }));
    expect(await run(missing)).toBe('900');

    async function run(fetchImpl: ReturnType<typeof vi.fn>) {
      resetIdentitySessionState();
      const { session, values } = manager(fetchImpl as unknown as typeof fetch);
      await session.renew(TICKET);
      return values.get('tokenMaxAge');
    }
  });
});

describe('the wire', () => {
  it('sends the presented ticket and the configured audience in the BODY, never the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch, { project: 'Frontend-Code' });

    await session.renew(TICKET);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/identity/refresh`);
    expect(url).not.toContain(TICKET);
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: TICKET,
      audience: 'frontend-code',
    });
  });

  it('forwards the end user IP so the IdP buckets per person, not per BFF', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, ROTATED_OK));
    const { session } = manager(fetchImpl as unknown as typeof fetch, {
      forwardedFor: '203.0.113.7',
    });

    await session.renew(TICKET);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('the IP is a pass-through and does NOT key the flight', async () => {
    // 🔴 Keying on the IP would fragment the flight: two requests on one ticket
    // seen at slightly different IPs would each rotate it, and the loser trips
    // reuse detection — the exact logout storm the flight prevents.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, ROTATED_OK);
    });
    const a = manager(fetchImpl as unknown as typeof fetch, { forwardedFor: '203.0.113.7' });
    const b = manager(fetchImpl as unknown as typeof fetch, { forwardedFor: '198.51.100.9' });

    const flights = [a.session.renew(TICKET), b.session.renew(TICKET)];
    release();
    await Promise.all(flights);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never leaks the presented ticket into a failure message', async () => {
    const fetchImpl = vi.fn(async () => idpError(500, `echo of ${TICKET}`));
    const { session } = manager(fetchImpl as unknown as typeof fetch);

    const result = await session.renew(TICKET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(TICKET);
  });
});
