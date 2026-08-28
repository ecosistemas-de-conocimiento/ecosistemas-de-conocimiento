/**
 * GET /api/holds?organization=<id>[&limit=<n>]
 *
 * The review queue: documents the anonymisation gate REFUSED, for one
 * ecosistema. Read `lib/holdReview.ts` before changing anything here — the
 * access check lives there, on purpose, because everything after it runs
 * elevated.
 *
 * ⚠ THE LIST CARRIES NO TEXT. A queue is a list of things to open; a list
 * endpoint returning every held transcript would put a whole ecosistema's
 * un-cleared material in one response. Text arrives one document at a time from
 * `GET /api/holds/:id`.
 *
 * ⚠ REFUSALS ARE 404, NOT 403 — unknown ecosistema, deactivated ecosistema, "you
 * are not a member" and "you are a member without `holds:review`" are one
 * indistinguishable answer. A 403 would confirm the ecosistema exists and turn
 * this into an enumeration oracle over every tenant. Same rule as
 * `GET /api/metrics/ecosystem`.
 *
 *   200 { ecosystem: { id }, holds: HeldSummary[] }
 *   400 missing `organization`
 *   401 not signed in
 *   404 no such ecosistema, not yours, or you may not review its holds
 *   500 the read itself failed
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { HoldNotVisibleError, listHeldDocuments } from '@/lib/holdReview'

// Per-caller and per-tenant, and it changes as people review. Never prerender
// it, and never let a shared proxy hold it.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

const fail = (status: number, message: string): Response =>
  NextResponse.json({ errors: [{ message }] }, { status, headers: NO_STORE })

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config: configPromise })

  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'Authentication required.')

  const url = new URL(request.url)
  const organizationId = url.searchParams.get('organization')?.trim()
  if (!organizationId) {
    return fail(400, 'Pass the ecosistema as `?organization=<id>`.')
  }

  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit) ? rawLimit : undefined

  try {
    const result = await listHeldDocuments({
      payload,
      organizationId,
      user,
      ...(limit === undefined ? {} : { limit }),
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof HoldNotVisibleError) {
      // ⚠ Nothing distinguishing is logged or returned. One message for every
      // refusal reason — see the class.
      return fail(404, err.message)
    }
    // ⚠ A genuine failure stays a 500. A malformed id is already turned into
    // `HoldNotVisibleError` inside the lib, so nothing reaching here is an
    // existence signal — and a database outage reported as "no such ecosistema"
    // would send whoever is on call looking for a deleted tenant.
    console.error('[holds] listing held documents failed', err)
    return fail(500, 'Could not list the held documents.')
  }
}
