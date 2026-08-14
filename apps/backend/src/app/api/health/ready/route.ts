/**
 * GET /api/health/ready — READINESS. "Can this service do its job?"
 *
 * Sibling of `/api/health`, which is LIVENESS ("is this process alive?") and
 * must stay dependency-free — see Rule 2 in `lib/readiness.ts`. Conflating the
 * two turns a Postgres blip into a crash-loop.
 *
 * Consumers: uptime monitors and humans. 🔴 Do NOT wire this to a container
 * restart policy or to load-balancer rotation without deciding that separately —
 * under Rule 1 an ai-service blip marks chat `down`, and rotating every replica
 * out at once would turn a partial outage into a total, cascading one.
 *
 *   200 {"status":"ok","checks":{...}}    every declared dependency reachable
 *   503 {"status":"down","checks":{...}}  any declared dependency unreachable
 *
 * ⚠ Assert on `status`, never on a specific check name — check names differ
 *   across services (some report `checks.backend` on dev and
 *   `checks.aiService` on prod). And treat a populated `error` as a signal even
 *   when `status` is `ok`: that is the Rule 4c 1-of-2 window.
 *
 * All logic lives in `@/lib/readiness` so that adopting the shared
 * `@edc/service-kit` later is a swap rather than a rewrite.
 */

import { NextResponse } from 'next/server'

import { getReadiness, httpStatusFor } from '@/lib/readiness'

// Never prerender or cache: the probes must run per request (subject only to the
// 5s in-process cache in the lib), and they must not execute during `next build`.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(): Promise<Response> {
  const report = await getReadiness()
  return NextResponse.json(report, {
    status: httpStatusFor(report),
    headers: { 'cache-control': 'no-store' },
  })
}
