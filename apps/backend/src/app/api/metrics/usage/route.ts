/**
 * GET /api/metrics/usage?organization=<id>
 *
 * The admin "Uso del chat" panel: the ecosistema's TOTAL conversations, turns,
 * cost, timings and models — computed server-side with an elevated read, and
 * returned as an aggregate with no message text in it.
 *
 * 🔴 Read `lib/chatUsage.ts` before changing anything here, especially before
 * adding a field to the response. The read runs elevated over private
 * conversations; what keeps that safe is that only an aggregate comes back.
 *
 * Gate: platform admins, and admins/owners of THAT ecosistema. Refusals are the
 * same indistinguishable 404 as `GET /api/metrics/ecosystem`.
 *
 *   200 { ecosystem, usage }
 *   400 missing `organization`
 *   401 not signed in
 *   404 no such ecosistema, or not an admin of it
 *   500 the read itself failed
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { chatUsage } from '@/lib/chatUsage'
import { safeErrMessage } from '@/lib/errorSummary'
import { EcosystemNotVisibleError } from '@/lib/ecosystemMetrics'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

const fail = (status: number, message: string): Response =>
  NextResponse.json({ errors: [{ message }] }, { status, headers: NO_STORE })

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config: configPromise })

  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'Authentication required.')

  const organizationId = new URL(request.url).searchParams.get('organization')?.trim()
  if (!organizationId) return fail(400, 'Pass the ecosistema as `?organization=<id>`.')

  try {
    return NextResponse.json(await chatUsage({ payload, organizationId, user }), { headers: NO_STORE })
  } catch (err) {
    // ⚠ Nothing distinguishing is logged or returned for a refusal.
    if (err instanceof EcosystemNotVisibleError) return fail(404, err.message)
    console.error('[metrics] chat usage failed', safeErrMessage(err))
    return fail(500, 'Could not compute the chat usage.')
  }
}
