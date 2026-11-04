// Mutation tests for the callback-URL SSRF guard (audit finding [HIGH] SSRF,
// commits "sec(ssrf-callback)": guard + IPv6-group parsing).
//
// `assertSafeCallbackUrl` is the single choke point enforced at BOTH layers:
// enqueue time (generate route / ingest service) and delivery time
// (`attemptDelivery`, re-validated before every fetch). These unit tests pin
// the address matrix; the route/emit tests pin the two enforcement points.
//
// Mutation checks:
//   - delete/neuter the guard  → every "blocked" case below resolves → RED.
//   - revert the IPv6-group parser to a string-shape check → the
//     WHATWG-normalised mapped-IPv4 cases (`::ffff:7f00:1`) resolve → RED.
//   - make `CALLBACK_ALLOW_PRIVATE` relax link-local/metadata/unspecified →
//     the "never relaxed" block below goes green-when-it-should-be-red → RED.
//
// All cases use IP literals or `localhost`, so no external DNS is required.

import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../../config/env.js';
import { assertSafeCallbackUrl, CallbackUrlBlockedError } from './url-guard.js';

const rejects = (url: string) =>
  expect(assertSafeCallbackUrl(url)).rejects.toBeInstanceOf(CallbackUrlBlockedError);

const resolves = (url: string) => expect(assertSafeCallbackUrl(url)).resolves.toBeUndefined();

/** Flip the env switch for one test; `afterEach` always restores it. */
function setAllowPrivate(on: boolean): void {
  (env as { CALLBACK_ALLOW_PRIVATE: boolean }).CALLBACK_ALLOW_PRIVATE = on;
}

afterEach(() => {
  setAllowPrivate(false);
});

describe('assertSafeCallbackUrl — blocked IPv4 targets (default posture)', () => {
  it('rejects loopback', async () => {
    await rejects('http://127.0.0.1:3000/hook');
    await rejects('http://127.8.9.10/hook');
    await rejects('http://0.0.0.0:8080/hook'); // routes to localhost
  });

  it('rejects RFC1918 private ranges', async () => {
    await rejects('http://10.1.2.3/hook');
    await rejects('http://172.16.0.9/hook');
    await rejects('http://172.31.255.254/hook');
    await rejects('http://192.168.0.10/hook');
  });

  it('rejects link-local incl. the cloud metadata endpoint', async () => {
    await rejects('http://169.254.169.254/latest/meta-data/');
    await rejects('http://169.254.0.1/hook');
  });

  it('rejects `localhost` (resolves to loopback, or fails resolution — both refuse)', async () => {
    await rejects('http://localhost:3000/hook');
  });
});

describe('assertSafeCallbackUrl — blocked IPv6 targets (default posture)', () => {
  it('rejects loopback/unspecified', async () => {
    await rejects('http://[::1]/hook');
    await rejects('http://[::]/hook');
  });

  it('rejects IPv4-mapped forms of blocked ranges (dotted AND hex-normalised)', async () => {
    // The WHATWG URL parser normalises `[::ffff:127.0.0.1]` to hostname
    // `::ffff:7f00:1` — a string-shape check on the dotted form misses it.
    await rejects('http://[::ffff:127.0.0.1]/hook');
    await rejects('http://[::ffff:7f00:1]/hook');
    await rejects('http://[::ffff:10.0.0.1]/hook');
    await rejects('http://[::ffff:169.254.169.254]/hook');
    await rejects('http://[::ffff:a9fe:a9fe]/hook'); // 169.254.169.254 in hex
  });

  it('rejects link-local and ULA', async () => {
    await rejects('http://[fe80::1]/hook');
    await rejects('http://[fd00::5]/hook');
    await rejects('http://[fc00::1]/hook');
  });
});

describe('assertSafeCallbackUrl — scheme and shape', () => {
  it('rejects non-http(s) schemes', async () => {
    await rejects('ftp://203.0.113.7/hook');
    await rejects('file:///etc/passwd');
    await rejects('gopher://203.0.113.7/hook');
  });

  it('rejects unparsable input', async () => {
    await rejects('not a url');
    await rejects('');
  });

  it('rejects plain http in production (https only)', async () => {
    const saved = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      await rejects('http://203.0.113.7/hook');
      await resolves('https://203.0.113.7/hook');
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = saved;
    }
  });

  it('the scheme rule is NOT relaxed by CALLBACK_ALLOW_PRIVATE', async () => {
    const saved = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    setAllowPrivate(true);
    try {
      await rejects('http://203.0.113.7/hook');
      await rejects('ftp://10.0.0.7/hook');
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = saved;
    }
  });
});

describe('assertSafeCallbackUrl — public targets stay allowed (no over-blocking)', () => {
  it('accepts public IPv4 literals (TEST-NET ranges)', async () => {
    await resolves('https://203.0.113.7/hook');
    await resolves('http://198.51.100.20:8080/hook'); // http allowed outside production
    // Range edges just OUTSIDE 172.16.0.0/12 are public:
    await resolves('http://172.15.255.255/hook');
    await resolves('http://172.32.0.1/hook');
  });

  it('accepts public IPv6 literals (doc range)', async () => {
    await resolves('http://[2001:db8::1]/hook');
  });
});

// ---------------------------------------------------------------------------
// CALLBACK_ALLOW_PRIVATE=1 — the explicit local/docker-network opt-in.
//
// The local stack (`local-ecosystem` compose, `scripts/up.sh`) addresses every
// consumer by SERVICE NAME on a bridge network, so every callback target
// resolves into 172.16/12 (or 10/8). Without an opt-in the guard makes the
// whole local async surface undeliverable. The switch is OFF by default and
// must stay off in every deployed environment.
// ---------------------------------------------------------------------------
describe('assertSafeCallbackUrl — CALLBACK_ALLOW_PRIVATE=1 relaxes ONLY the local ranges', () => {
  it('accepts loopback and RFC1918 targets', async () => {
    setAllowPrivate(true);
    await resolves('http://127.0.0.1:3003/hook');
    await resolves('http://localhost:3003/hook');
    await resolves('http://10.1.2.3/hook');
    await resolves('http://172.16.0.9/hook'); // the docker bridge range
    await resolves('http://172.31.255.254/hook');
    await resolves('http://192.168.0.10/hook');
  });

  it('accepts IPv6 loopback, ULA, and IPv4-mapped private forms', async () => {
    setAllowPrivate(true);
    await resolves('http://[::1]/hook');
    await resolves('http://[fd00::5]/hook');
    await resolves('http://[::ffff:172.18.0.4]/hook');
  });

  it('STILL rejects link-local, the cloud metadata endpoint, and the unspecified address', async () => {
    setAllowPrivate(true);
    // No container ever lives here, and 169.254.169.254 is the single highest
    // value SSRF target (instance credentials). The switch is a
    // local-network escape hatch, never a blanket disable.
    await rejects('http://169.254.169.254/latest/meta-data/');
    await rejects('http://169.254.0.1/hook');
    await rejects('http://[::ffff:169.254.169.254]/hook');
    await rejects('http://[fe80::1]/hook');
    await rejects('http://0.0.0.0:8080/hook');
    await rejects('http://[::]/hook');
  });

  it('STILL rejects unparsable input and non-http(s) schemes', async () => {
    setAllowPrivate(true);
    await rejects('not a url');
    await rejects('file:///etc/passwd');
  });
});
