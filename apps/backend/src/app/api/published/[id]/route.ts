/**
 * POST /api/published/:id — `{ "decision": "reject", "note"?: "…" }`. A reviewer
 * rejects a testimonio that is already published. Logic: `lib/rejectPublished.ts`.
 *
 *   200 { id, decision, reviewId, anonymisationStatus }
 *   400 malformed body   401   413 body over 8 MiB   404 no such published testimonio, or not yours to review
 *   500 the audit, the retire or the row write failed
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { API_BODY_MAX_BYTES, readCapped, tooLarge } from '@/lib/bodyCap'
import { HoldNotVisibleError } from '@/lib/holdReview'
import { rejectPublished } from '@/lib/rejectPublished'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

const fail = (status: number, message: string): Response =>
  NextResponse.json({ errors: [{ message }] }, { status, headers: NO_STORE })

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const payload = await getPayload({ config: configPromise })
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'Authentication required.')

  const { id } = await ctx.params
  // 🔴 Counted: a multipart label skips the middleware, and `json()` has no cap.
  const bytes = await readCapped(request, API_BODY_MAX_BYTES)
  if (!bytes) return tooLarge(API_BODY_MAX_BYTES)
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null
  } catch {
    // malformed: the 400 below
  }
  if (!body || body.decision !== 'reject') return fail(400, '`decision` must be "reject".')

  try {
    const { getAdminAIClient } = await import('@/lib/aiClient')
    const outcome = await rejectPublished({
      payload,
      documentId: id,
      user,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
      clientFor: (organizationId) => getAdminAIClient(organizationId) as never,
    })
    return NextResponse.json(outcome, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof HoldNotVisibleError) return fail(404, err.message)
    console.error('[published] reject failed', err)
    return fail(500, 'Could not record the decision.')
  }
}
