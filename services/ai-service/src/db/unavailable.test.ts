// Which errors the /v1 handler turns into a 503. The shapes below are what
// postgres.js 3.4.9 and node produce; the PgBouncer FATAL is the one measured
// in the 2026-10-18 local repro (`pooler-login-failure.integration.test.ts`).

import { describe, expect, it } from 'vitest';

import { isDatabaseUnavailableError } from './unavailable.js';

function pgError(code: string, message = 'x'): Error {
  return Object.assign(new Error(message), { name: 'PostgresError', code });
}

/**
 * A node socket error as postgres.js hands it to the caller: `queryError` in
 * `postgres/src/connection.js` defines `query` (and `parameters`, …) on every
 * error it rejects a query with. MEASURED 2026-10-18 on postgres 3.4.9:
 * ECONNREFUSED to port 1 and ENOTFOUND on `.invalid` both carry it.
 */
function driverSocketError(code: string): Error {
  const e = Object.assign(new Error(code), { code });
  Object.defineProperty(e, 'query', { value: 'select 1', enumerable: false });
  return e;
}

/**
 * What undici's `fetch` throws on a DNS failure (MEASURED 2026-10-18, node
 * 26.10): `TypeError('fetch failed')` with the socket error as `cause`. This
 * is the shape OpenRouter failures reach the /v1 handler in (`/v1/embed`).
 */
function fetchError(code: string): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`getaddrinfo ${code} openrouter.ai`), { code }),
  });
}

describe('isDatabaseUnavailableError', () => {
  it.each([
    ['PgBouncer login FATAL', pgError('08P01', 'server login has been failing')],
    ['Postgres starting up', pgError('57P03')],
    ['admin shutdown', pgError('57P01')],
    ['too many connections', pgError('53300')],
    ['driver CONNECTION_CLOSED', Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })],
    ['driver CONNECT_TIMEOUT', Object.assign(new Error('timeout'), { code: 'CONNECT_TIMEOUT' })],
    ['driver socket ECONNREFUSED', driverSocketError('ECONNREFUSED')],
    ['driver socket ENOTFOUND', driverSocketError('ENOTFOUND')],
    ['wrapped in a cause', new Error('query failed', { cause: pgError('08006') })],
  ])('true for %s', (_label, err) => {
    expect(isDatabaseUnavailableError(err)).toBe(true);
  });

  it.each([
    ['unique violation', pgError('23505')],
    ['idle-in-transaction FATAL (our bug, not an outage)', pgError('25P03')],
    ['syntax error', pgError('42601')],
    ['an 08xxx code on a non-Postgres error', Object.assign(new Error('x'), { code: '08P01' })],
    ['a plain Error', new Error('boom')],
    // Not the database: an upstream HTTP call (OpenRouter) failing on the
    // network. The audit of 0a91b46 found these were labelled a DB outage.
    ['a fetch DNS failure (ENOTFOUND in cause)', fetchError('ENOTFOUND')],
    ['a fetch reset (ECONNRESET in cause)', fetchError('ECONNRESET')],
    ['a bare ETIMEDOUT not raised by the driver', Object.assign(new Error('t'), { code: 'ETIMEDOUT' })],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('false for %s', (_label, err) => {
    expect(isDatabaseUnavailableError(err)).toBe(false);
  });
});
