import { NextResponse } from 'next/server'

/**
 * GET /api/health — LIVENESS only. "Is this process alive?"
 *
 * 🔴 DO NOT add a dependency check here. This is deliberate, not an omission,
 * and an earlier comment on this file inviting a "database round-trip" was
 * wrong. Rule 2 of the health-check design:
 *
 *   - Liveness drives the container restart-on-unhealthy policy. If
 *     Postgres is down, restarting this backend does not help — it converts one
 *     outage into a crash-loop, which is strictly worse and much harder to
 *     diagnose.
 *   - Dependency checking belongs in the READINESS sibling, `/api/health/ready`
 *     (`src/app/api/health/ready/route.ts`), which uptime monitors consume.
 *
 * A constant is the correct implementation of this route.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' })
}
