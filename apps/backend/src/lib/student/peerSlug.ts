/**
 * 🔴 THE OPAQUE ID OF A CLASSMATE'S PAGE (`/estudiante/companero/<slug>`).
 *
 * `slug = base64url(HMAC-SHA256(secret, "edc:companero:v1:<org>:<user>"))[:22]`
 * — 132 bits, never the user id, never sequential. The org is inside the MAC,
 * so the same student has a different slug in each ecosistema and a slug from
 * one ecosistema resolves to nobody in another.
 *
 * Nothing is stored. A slug resolves ONLY by recomputing it for each student
 * that `consentingStudents(org, 'share_with_peers')` returns right now, so a
 * peer who switches `shareWithPeers` off (or leaves, or stops being an
 * `estudiante`) stops resolving on the very next request: a 404.
 *
 * `secret` is Payload's own (`payload.secret`, derived from `PAYLOAD_SECRET`).
 * Rotating it changes every slug; old links 404, which is the safe failure.
 */

import crypto from 'node:crypto'

const LENGTH = 22
const SHAPE = /^[A-Za-z0-9_-]{22}$/

export function peerSlug(secret: string, organizationId: number, userId: number): string {
  if (!secret) throw new Error('peerSlug: no secret')
  return crypto
    .createHmac('sha256', secret)
    .update(`edc:companero:v1:${organizationId}:${userId}`)
    .digest('base64url')
    .slice(0, LENGTH)
}

export const isPeerSlug = (raw: unknown): raw is string => typeof raw === 'string' && SHAPE.test(raw)

/** The candidate whose slug this is, compared in constant time; else null. */
export function findBySlug<T extends { id: number }>(
  secret: string,
  organizationId: number,
  slug: unknown,
  candidates: readonly T[],
): T | null {
  if (!isPeerSlug(slug)) return null
  const want = Buffer.from(slug)
  let hit: T | null = null
  for (const c of candidates) {
    const got = Buffer.from(peerSlug(secret, organizationId, c.id))
    if (crypto.timingSafeEqual(got, want) && !hit) hit = c
  }
  return hit
}
