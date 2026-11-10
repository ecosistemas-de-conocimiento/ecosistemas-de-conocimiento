/**
 * GET /api/metrics/ecosystem?organization=<id>
 *
 * The admin "Contribuciones" tiles, computed server-side and returned as
 * integers. This is the ONLY correct way to count conversations and messages in
 * an ecosistema — a client-side count through the generic REST list silently
 * returns the CALLER'S conversations instead, because sessions are private and
 * Payload ANDs that rule into the query rather than refusing it.
 *
 * 🔴 Read `lib/ecosystemMetrics.ts` before changing anything here, especially
 * before adding a field to the response. The counting runs elevated, and the
 * only thing that keeps that safe is that nothing but numbers comes back.
 *
 * ⚠ REFUSALS ARE 404, NOT 403 — unknown ecosistema, deactivated ecosistema and
 * "you are not a member" are one indistinguishable answer. A 403 would confirm
 * the ecosistema exists and turn this into an enumeration oracle over every
 * tenant on the installation. Same rule as `GET /api/sessions/:id/corpora`.
 *
 *   200 { ecosystem, conversations, documents, ratings }
 *   400 missing `organization`
 *   401 not signed in
 *   404 no such ecosistema, or not yours
 *   500 the counting itself failed
 *
 * Authentication is the caller's ordinary Payload session — the SvelteKit BFF
 * already sends `Authorization: JWT <token>` on every backend call.
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { EcosystemNotVisibleError, ecosystemMetrics } from '@/lib/ecosystemMetrics'
import { safeErrMessage } from '@/lib/errorSummary'

// Per-caller and per-tenant, and it changes as people use the product. Never
// prerender it, and never let a shared proxy hold it.
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
  if (!organizationId) {
    return fail(400, 'Pass the ecosistema as `?organization=<id>`.')
  }

  try {
    const metrics = await ecosystemMetrics({ payload, organizationId, user })
    return NextResponse.json(metrics, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof EcosystemNotVisibleError) {
      // ⚠ Nothing distinguishing is logged or returned. The message is the same
      // string for every refusal reason — see the class.
      return fail(404, err.message)
    }
    // ⚠ A genuine failure stays a 500 rather than being folded into the 404.
    // A malformed id is already turned into `EcosystemNotVisibleError` inside
    // the lib, so nothing that reaches here is an existence signal — and a
    // database outage reported as "no such ecosistema" would send whoever is
    // on call looking for a deleted tenant.
    console.error('[metrics] ecosystem metrics failed', safeErrMessage(err))
    return fail(500, 'Could not compute the metrics.')
  }
}
