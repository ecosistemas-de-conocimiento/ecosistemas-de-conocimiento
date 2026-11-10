// Limits on failed sign-ins, for `/api/auth/login` and the `/sign-in` action
// (audit 2026-11-10, A-11). The backend applies the same two buckets on
// `POST /api/users/login` (`apps/backend/src/lib/loginRateLimit.ts`, which has
// the reasoning behind the numbers); this copy answers in Spanish without a
// backend round trip, and holds if the backend's own counters are reset by a
// deploy.
//
// Payload's per-account lockout (5 failures, 10 minutes; quoted from Payload
// 3.88's `collections/config/defaults.js`) stays as it is. In front of it:
//   - per (IP, email): 4 failures per hour (3600 s) by default, one below the
//     lockout (inferred from the quoted 5), so one IP cannot lock that account
//     within a window, and a shared NAT does not block other accounts;
//   - per IP across every email: 100 failures an hour by default (inferred: far
//     above a room of real people), against password spraying.
//
// Reserve, then refund: `reserveLoginAttempt` counts the attempt before the
// backend sees it, and the caller releases the slot unless the attempt was a
// wrong password or a locked account. Synchronous, so two concurrent sign-ins
// cannot both pass a check that has counted neither.
//
// One IP holds at most its per-IP ceiling of keys: the per-IP bucket is
// checked first, a refused attempt counts nothing, the email is length-capped
// (in `signIn`) and hashed before it is keyed, and a release that empties a
// bucket deletes it. So one IP cannot fill the map to its cap and evict someone
// else's live bucket (re-audit 2026-11-10, N3/N4).
//
// ⚠ Accepted, not fixed: more than 4 concurrent sign-ins to ONE account from
// ONE IP get 429 even with the right password, since each holds a slot until
// its answer refunds it. Only a shared account signed in to at the same instant
// behind one NAT meets it, and a retry a moment later passes (inferred from the
// reserve-then-refund order, not measured).
//
// ⚠ In-process: one web replica, reset by a deploy. That is what runs today.
// A per-email limit across IPs is not here: new functionality, etapa 2.

import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

/** The per-IP ceiling's window. */
export const LOGIN_FAIL_WINDOW_MS = 60 * 60_000;
/**
 * Longer than this is refused before any key is built. 254 is the commonly
 * cited practical maximum for an address (RFC 5321's 256-octet path, less its
 * angle brackets); Payload 3.88's own `email` validation has no length cap
 * (measured, `payload/dist/fields/validations.js`). The backend refuses the
 * same length (`MAX_LOGIN_EMAIL_LENGTH` in `apps/backend/src/lib/loginRateLimit.ts`).
 */
export const MAX_LOGIN_EMAIL_LENGTH = 254;
/** A flood of distinct keys must not grow this without bound. */
const MAX_TRACKED_KEYS = 10_000;

const hits = new Map<string, number[]>();

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Trimmed and lowercased, as Payload does before it looks the user up. */
export function normaliseLoginEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

interface Bucket {
  key: string;
  limit: number;
  windowMs: number;
}

/** sha256, first 128 bits: a fixed-size key whatever was posted (collision ~2^64 addresses; inferred, birthday bound). */
function emailKey(email: string): string {
  return createHash('sha256').update(normaliseLoginEmail(email)).digest('hex').slice(0, 32);
}

function buckets(ip: string, email: string): Bucket[] {
  return [
    // Per IP first, so a refusal by the ceiling is decided before the email is keyed.
    { key: `ip:${ip}`, limit: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX', 100), windowMs: LOGIN_FAIL_WINDOW_MS },
    // `|` cannot appear in an IP, so no (IP, email) pair aliases another.
    {
      key: `ip-email:${ip}|${emailKey(email)}`,
      limit: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX', 4),
      windowMs: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S', 3600) * 1000,
    },
  ];
}

function recent(key: string, windowMs: number, now: number): number[] {
  const kept = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
  if (kept.length === 0) hits.delete(key);
  else hits.set(key, kept);
  return kept;
}

function take(key: string, at: number, kept: number[]): void {
  // Re-insert so the map's order is least-recently-used first.
  hits.delete(key);
  hits.set(key, [...kept, at]);
  if (hits.size > MAX_TRACKED_KEYS) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
}

export type LoginReservation =
  | { ok: true; release(): void }
  | { ok: false; retryAfterSeconds: number };

/**
 * Count one sign-in attempt for this IP and email in both buckets, or refuse
 * it when either is spent (and then count nothing). `release` gives the slots
 * back; call it unless the attempt was a wrong password or a locked account.
 */
export function reserveLoginAttempt(ip: string, email: string): LoginReservation {
  const now = Date.now();
  const all = buckets(ip, email);
  for (const b of all) {
    const kept = recent(b.key, b.windowMs, now);
    if (kept.length >= b.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil(((kept[0] ?? now) + b.windowMs - now) / 1000));
      return { ok: false, retryAfterSeconds };
    }
  }
  for (const b of all) take(b.key, now, hits.get(b.key) ?? []);
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      for (const b of all) {
        const list = hits.get(b.key);
        const i = list?.indexOf(now) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
        // An empty bucket holds no budget: a refund leaves no key behind.
        if (list?.length === 0) hits.delete(b.key);
      }
    },
  };
}

/** The keys held now. Tests. */
export function loginRateLimitKeys(): string[] {
  return [...hits.keys()];
}

/** Drop every counter. Tests. */
export function resetLoginRateLimit(): void {
  hits.clear();
}
