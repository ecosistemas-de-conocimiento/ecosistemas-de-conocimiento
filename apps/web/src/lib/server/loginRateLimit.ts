// Limits on failed sign-ins, for `/api/auth/login` and the `/sign-in` action
// (audit 2026-11-10, A-11). The backend applies the same two buckets on
// `POST /api/users/login` (`apps/backend/src/lib/loginRateLimit.ts`, which has
// the reasoning behind the numbers); this copy answers in Spanish without a
// backend round trip, and holds if the backend's own counters are reset by a
// deploy.
//
// Payload's per-account lockout (5 failures, 10 minutes; quoted from Payload
// 3.88's `collections/config/defaults.js`) stays as it is. In front of it:
//   - per (IP, email): 4 failures per 10 minutes by default, one below the
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
// ⚠ In-process: one web replica, reset by a deploy. That is what runs today.
// A per-email limit across IPs is not here: new functionality, etapa 2.

import { env } from '$env/dynamic/private';

/** The per-IP ceiling's window. */
export const LOGIN_FAIL_WINDOW_MS = 60 * 60_000;
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

function buckets(ip: string, email: string): Bucket[] {
  return [
    // `|` cannot appear in an IP, so no (IP, email) pair aliases another.
    {
      key: `ip-email:${ip}|${normaliseLoginEmail(email)}`,
      limit: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX', 4),
      windowMs: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S', 600) * 1000,
    },
    { key: `ip:${ip}`, limit: envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX', 100), windowMs: LOGIN_FAIL_WINDOW_MS },
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
      }
    },
  };
}

/** Drop every counter. Tests. */
export function resetLoginRateLimit(): void {
  hits.clear();
}
