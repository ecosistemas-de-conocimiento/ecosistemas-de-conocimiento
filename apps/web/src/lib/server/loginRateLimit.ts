// Failed sign-ins per browser IP, for `/api/auth/login` and the `/sign-in`
// action (audit 2026-11-10, A-11). The backend counts the same thing on
// `POST /api/users/login` (`apps/backend/src/lib/loginRateLimit.ts`); this copy
// answers in Spanish without a backend round trip, and holds if the backend's
// own counter is reset by a deploy.
//
// Payload's per-account lockout (5 failures, 10 minutes; quoted from Payload
// 3.88's `collections/config/defaults.js`) stays as it is. This caps how many
// failures one IP may spend across every account in an hour.
//
// 15 an hour by default: keeping one account locked takes 5 failures every 10
// minutes, 30 an hour (inferred from the quoted lockout), so one IP gets at
// most 3 lockouts an hour. Successes are not counted. ⚠ A workshop behind one
// NAT shares the 15; raise `IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX` for a big room.
//
// ⚠ In-process: one web replica, reset by a deploy. That is what runs today.
// A per-email limit is not here: new functionality, etapa 2.

import { env } from '$env/dynamic/private';

export const LOGIN_FAIL_WINDOW_MS = 60 * 60_000;
/** A flood of distinct IPs must not grow this without bound. */
const MAX_TRACKED_IPS = 10_000;

const failures = new Map<string, number[]>();

function limit(): number {
  const parsed = Number.parseInt(env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 15;
}

function recent(ip: string, now: number): number[] {
  const kept = (failures.get(ip) ?? []).filter((at) => at > now - LOGIN_FAIL_WINDOW_MS);
  if (kept.length === 0) failures.delete(ip);
  else failures.set(ip, kept);
  return kept;
}

/** Has this IP spent its failures? Counts nothing. */
export function loginBlocked(ip: string): boolean {
  return recent(ip, Date.now()).length >= limit();
}

/** Count one failed sign-in against this IP. */
export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const kept = recent(ip, now);
  if (kept.length >= limit()) return;
  // Re-insert so the map's order is least-recently-failed first.
  failures.delete(ip);
  failures.set(ip, [...kept, now]);
  if (failures.size > MAX_TRACKED_IPS) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
}

/** Drop every counter. Tests. */
export function resetLoginRateLimit(): void {
  failures.clear();
}
