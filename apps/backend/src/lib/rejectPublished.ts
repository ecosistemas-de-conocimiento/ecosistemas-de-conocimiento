/**
 * 🔴 REJECTING A TESTIMONIO THAT IS ALREADY PUBLISHED.
 *
 * A participant's testimonio is published as soon as the gate clears it
 * (`lib/autoPublish.ts`, owner rule 2026-10-24). Review comes after, now and
 * then, by interns. So a reviewer needs the same "reject" on a published row
 * that `decideOnHold` (`lib/holdReview.ts`) gives on a held one.
 *
 * ── THE ORDER IS THE SAFETY PROPERTY ─────────────────────────────────────────
 *
 *   1. The audit row, FIRST, the same rule as `decideOnHold`: a recorded
 *      rejection that did not land is harmless; a withdrawal nobody recorded is not.
 *   2. Retire the shared copy (`retireFrom`, the unpublish rule: sharing stops
 *      first). A failure throws and leaves the row `published`, which is true.
 *   3. The row: a `rejected` draft, its redaction cleared, exactly what a
 *      rejected hold looks like. `autoPublishBlocker` and `beginPublish` refuse
 *      a `rejected` row, so nothing publishes it again.
 *
 * ⚠ NO DRAFT RE-INGEST. A rejected testimonio is never embedded anywhere; the
 * draft copy was already retired when it was published (`confirmPublish`).
 *
 * ⚠ REFUSALS ARE `HoldNotVisibleError` (404), like every other review route:
 * unknown id, not your ecosistema, not a reviewer, not a published testimonio.
 */

import type { Payload } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { HoldNotVisibleError } from './holdReview'
import { organizationIdsForUserWithPermission, PERMISSIONS, relationId } from './permissions'
import { publishedCorpus } from './corpus'
import { retireFrom, type CorpusMover } from './publishDocument'

type Id = number | string

/** Same question as `holdReview.ts` asks: where may this caller review? */
async function mayReviewIn(payload: Payload, user: unknown, organizationId: Id): Promise<boolean> {
  if (!isActiveUser(user)) return false
  if (isPlatformAdminUser(user)) return true
  const id = (user as { id?: Id } | null)?.id
  if (id === undefined || id === null) return false
  const ids = await organizationIdsForUserWithPermission(payload, id, PERMISSIONS.holdsReview)
  return ids.some((org) => String(org) === String(organizationId))
}

export interface PublishedSummary {
  id: string
  /** 🔴 `testimonioTitle` (made from redacted text) or a neutral label. Never `name`. */
  title: string
  updatedAt: string | null
}

/** The published testimonios of one ecosistema, newest first. No text. */
export async function listPublishedTestimonios(args: {
  payload: Payload
  organizationId: Id
  user: unknown
  limit?: number
}): Promise<PublishedSummary[]> {
  const { payload, organizationId } = args
  if (!(await mayReviewIn(payload, args.user, organizationId))) throw new HoldNotVisibleError()
  const found = await payload
    .find({
      collection: 'documents',
      where: {
        and: [
          { organization: { equals: organizationId } },
          { contentKind: { equals: 'testimonio' } },
          { publicationStatus: { equals: 'published' } },
        ],
      },
      limit: Math.min(Math.max(args.limit ?? 50, 1), 200),
      sort: '-updatedAt',
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => null)
  if (!found) throw new HoldNotVisibleError()
  return (found.docs as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    title:
      typeof row.testimonioTitle === 'string' && row.testimonioTitle.trim()
        ? row.testimonioTitle.trim()
        : 'Testimonio',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
  }))
}

export async function rejectPublished(args: {
  payload: Payload
  documentId: Id
  user: unknown
  note?: string
  /** The ADMIN client for that ecosistema: retiring is an admin route. */
  clientFor: (organizationId: Id) => CorpusMover
  now?: Date
}): Promise<{ id: string; decision: 'rejected'; reviewId: string; anonymisationStatus: 'rejected' }> {
  const { payload, documentId, user } = args
  const row = (await payload
    .findByID({ collection: 'documents', id: documentId as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as Record<string, unknown> | null
  if (!row || row.contentKind !== 'testimonio' || row.publicationStatus !== 'published') {
    throw new HoldNotVisibleError()
  }
  const organizationId = relationId(row.organization)
  const reviewerId = (user as { id?: Id } | null)?.id
  if (organizationId === null || reviewerId === undefined || reviewerId === null) throw new HoldNotVisibleError()
  if (!(await mayReviewIn(payload, user, organizationId))) throw new HoldNotVisibleError()

  const review = await payload.create({
    collection: 'anonymisation-reviews',
    data: {
      // `row.id`, not the URL's string: see the same note in `decideOnHold`.
      document: row.id,
      organization: organizationId,
      reviewer: reviewerId,
      decision: 'rejected',
      gateStage: null,
      gateReason: 'rejected after publication',
      gateReport: (row.anonymisationReport as Record<string, unknown> | null) ?? null,
      textEdited: false,
      note: typeof args.note === 'string' ? args.note.slice(0, 1000) : null,
    } as never,
    overrideAccess: true,
  })

  await retireFrom(args.clientFor(organizationId), publishedCorpus(organizationId), row.id as Id, args.now ?? new Date())

  await payload.update({
    collection: 'documents',
    // ⚠ Still published: a concurrent unpublish or a second reviewer makes this a no-op.
    where: { and: [{ id: { equals: row.id } }, { publicationStatus: { equals: 'published' } }] },
    data: {
      publicationStatus: 'draft',
      publicationError: null,
      publishIngestId: null,
      anonymisationStatus: 'rejected',
      redactedText: null,
      heldText: null,
      anonymisationSurvivors: null,
      testimonioTitle: null,
      ingestError: 'anonymisation_rejected: a reviewer refused this document.',
    } as never,
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  return { id: String(row.id), decision: 'rejected', reviewId: String(review.id), anonymisationStatus: 'rejected' }
}
