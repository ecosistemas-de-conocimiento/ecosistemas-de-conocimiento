/**
 * GET /api/published?organization=<id> — the published testimonios (and gated documentos) a reviewer
 * may reject after the fact. Logic and access: `lib/rejectPublished.ts`.
 *
 *   200 { items: PublishedSummary[] }   400 no `organization`   401   404 not yours to review
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { HoldNotVisibleError } from '@/lib/holdReview'
import { listPublishedTestimonios } from '@/lib/rejectPublished'

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
    const items = await listPublishedTestimonios({ payload, organizationId, user })
    return NextResponse.json({ items }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof HoldNotVisibleError) return fail(404, err.message)
    console.error('[published] listing failed', err)
    return fail(500, 'Could not list the published testimonios.')
  }
}
