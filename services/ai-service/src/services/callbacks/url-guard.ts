// SSRF guard for tenant-supplied callback URLs.
//
// ai-service POSTs HMAC-signed callbacks to consumer-supplied `callbackUrl`s
// (`POST /v1/generate`, `POST /v1/ingest`) and to `project_configs.callback_url`.
// Without validation, any tenant key turns the service into an SSRF pivot from
// inside the fleet network: cloud metadata (169.254.169.254), Postgres/Redis,
// sibling services, internal port-scanning via `last_error`/`response_status`.
//
// The guard is enforced twice, deliberately:
//   1. At enqueue time (ingest service / generate route) — fail fast with a
//      legible 400 before anything is persisted.
//   2. In `attemptDelivery` immediately before every `fetch` — covers URLs
//      sourced from `project_configs.callback_url` and catches DNS rebinding
//      between enqueue and delivery. The fetch itself runs with
//      `redirect: 'error'` so a public 302 → internal hop cannot bypass it.
//
// Scheme allowlist: `https:` always; `http:` only outside production (local
// consumers don't terminate TLS). Address blocklist: loopback, RFC1918
// private, link-local (incl. the metadata endpoint), `0.0.0.0/8` and IPv6
// ULA — checked against EVERY address the host resolves to.
//
// ── The local-network escape hatch ──────────────────────────────────────────
// `CALLBACK_ALLOW_PRIVATE=1` (env, default OFF) re-allows the ranges a local
// docker stack actually uses: loopback, RFC1918, IPv6 ULA, and their
// IPv4-mapped forms. It is the difference between "the local compose stack can
// deliver callbacks to `http://<service-name>:<port>`" and "the whole async
// surface dead-letters on a developer's machine".
//
// It deliberately does NOT relax:
//   - link-local `169.254.0.0/16` (the cloud metadata endpoint) or `fe80::/10`;
//   - `0.0.0.0/8` and the IPv6 unspecified address;
//   - the scheme allowlist.
// Nothing a developer needs to reach lives in those, so keeping them blocked
// costs nothing and keeps the highest-value SSRF target closed even when a
// deployed environment sets the switch by mistake.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { CodedEnvelopeError } from '../../errors/base.js';
import { env } from '../../config/env.js';

/** Thrown when a callback URL fails the guard. The class declares the 400. */
export class CallbackUrlBlockedError extends CodedEnvelopeError {
  readonly code = 'ERR_CALLBACK_URL_BLOCKED';
  readonly status = 400;
  override name = 'CallbackUrlBlockedError';
  /**
   * Read only OUTSIDE `/v1` — the callback worker and `services/callbacks/*`
   * raise this class too, and Fastify's default handler reads `statusCode`.
   * Kept in step with `status`.
   */
  statusCode = 400;
}

/**
 * Judge an IPv4 address given only its first two octets — the two that decide
 * every range we care about. Shared by the dotted-quad path and the
 * IPv4-mapped-IPv6 path so both answer identically.
 */
function isBlockedIPv4Octets(a: number, b: number, allowPrivate: boolean): boolean {
  // Never relaxed, at any setting of the switch.
  if (a === 0) return true; // 0.0.0.0/8 — "this network"; 0.0.0.0 routes to localhost
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata

  if (allowPrivate) return false;

  return (
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // private 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12 (docker bridge)
    (a === 192 && b === 168) // private 192.168.0.0/16
  );
}

function isBlockedIPv4(addr: string, allowPrivate: boolean): boolean {
  const octets = addr.split('.').map((o) => Number(o));
  if (
    octets.length !== 4 ||
    octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
  ) {
    return true; // unparsable — refuse rather than guess
  }
  return isBlockedIPv4Octets(octets[0]!, octets[1]!, allowPrivate);
}

/**
 * Expand an IPv6 textual address into its 8 hextet values, handling `::`
 * compression and embedded dotted-IPv4 tails. Returns null when unparsable.
 *
 * Needed because the WHATWG URL parser NORMALISES IPv6 literals — a URL
 * written `http://[::ffff:127.0.0.1]/` surfaces as hostname `::ffff:7f00:1`,
 * so a string-shape check on the dotted form would miss the mapped range.
 */
function expandIPv6(addr: string): number[] | null {
  const zone = addr.indexOf('%'); // strip zone index (fe80::1%eth0)
  const a = (zone === -1 ? addr : addr.slice(0, zone)).toLowerCase();
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.includes('.')) {
        // Embedded dotted IPv4 → two hextets (only valid as the tail).
        const octets = g.split('.').map((o) => Number(o));
        if (
          octets.length !== 4 ||
          octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
        ) {
          return null;
        }
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(Number.parseInt(g, 16));
      }
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...(Array(missing).fill(0) as number[]), ...tail];
}

function isBlockedIPv6(addr: string, allowPrivate: boolean): boolean {
  const g = expandIPv6(addr);
  if (!g) return true; // unparsable — refuse rather than guess
  const headZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (headZero && g[5] === 0 && g[6] === 0) {
    if (g[7] === 0) return true; // :: unspecified — never a callback target
    if (g[7] === 1) return !allowPrivate; // ::1 loopback
  }
  if (headZero && g[5] === 0xffff) {
    // IPv4-mapped ::ffff:a.b.c.d — judge the embedded IPv4 by the IPv4 rules.
    return isBlockedIPv4Octets(g[6]! >> 8, g[6]! & 0xff, allowPrivate);
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 — never relaxed
  if ((g[0]! & 0xfe00) === 0xfc00) return !allowPrivate; // ULA fc00::/7
  return false;
}

function isBlockedAddress(addr: string, allowPrivate: boolean): boolean {
  const family = net.isIP(addr);
  if (family === 4) return isBlockedIPv4(addr, allowPrivate);
  if (family === 6) return isBlockedIPv6(addr, allowPrivate);
  return true; // not an IP literal — refuse
}

/**
 * Validate a callback URL before persisting or delivering to it.
 *
 * Throws `CallbackUrlBlockedError` when the scheme is not allowlisted or when
 * ANY address the host resolves to is blocked. Resolution failures are also
 * rejected — an undeliverable URL is refused up front rather than burning the
 * retry schedule.
 *
 * `env.CALLBACK_ALLOW_PRIVATE` is read HERE, per call, not captured at module
 * load: the tests flip it between cases, and reading it late costs nothing.
 */
export async function assertSafeCallbackUrl(raw: string): Promise<void> {
  const allowPrivate = env.CALLBACK_ALLOW_PRIVATE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlBlockedError('callback url is not a valid URL');
  }
  const allowedProtocols =
    env.NODE_ENV === 'production' ? ['https:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new CallbackUrlBlockedError(
      `callback url scheme '${url.protocol}' not allowed (use ${allowedProtocols.join(' or ')})`,
    );
  }
  // `URL.hostname` keeps brackets on IPv6 literals — strip for net.isIP/lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string }>;
  try {
    addresses = net.isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
  } catch {
    throw new CallbackUrlBlockedError(
      `callback url host '${host}' did not resolve`,
    );
  }
  if (addresses.length === 0) {
    throw new CallbackUrlBlockedError(
      `callback url host '${host}' did not resolve`,
    );
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address, allowPrivate)) {
      throw new CallbackUrlBlockedError(
        'callback url blocked (ssrf guard): host resolves to a private, loopback, link-local, or metadata address',
      );
    }
  }
}
