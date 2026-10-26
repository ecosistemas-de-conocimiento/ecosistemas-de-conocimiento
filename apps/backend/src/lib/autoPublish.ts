/**
 * 🔴 A PARTICIPANT NEVER PUBLISHES BY HAND (owner rule, 2026-10-24).
 *
 * A participant (`member` role) uploads files and audio and chats. What they
 * contribute is published by the system, subject to review after the fact.
 * There is no moderation team; interns review now and then.
 *
 * ── THE GATE DECIDES ─────────────────────────────────────────────────────────
 *
 *   gate `ready` / reviewer `approved` → published as soon as the draft ingest lands
 *   gate `held`                        → stays a draft, listed in Revisión
 *   reviewer `rejected`                → never published
 *
 * The trigger is the draft ingest's `ingest.completed` callback
 * (`app/api/ai-service/callback/route.ts`). An approval re-ingests the draft
 * (`decideOnHold` in `lib/holdReview.ts`), so the same callback publishes an
 * approved hold too. The move itself is `beginPublish`, unchanged: it re-checks
 * the stored row against the gate in one guarded UPDATE, so this file adds no
 * second, weaker copy of that rule.
 *
 * ⚠ AN UPLOAD BY AN INVESTIGADOR, ADMIN, OWNER OR PLATFORM ADMIN IS NOT TOUCHED.
 * They keep the manual "Publicar" button. An Investigador files other people's
 * testimonies and decides when they are ready to share.
 *
 * ⚠ A PARTICIPANT'S AUDIO IS FILED AS A `testimonio`
 * ({@link fileParticipantAudioAsTestimonio}). Auto-publishing an ungated
 * recording of someone talking would put every name in it in front of the whole
 * ecosistema. A participant's PDF or DOCX stays a `documento` but is filed with
 * `anonymise` set ({@link anonymiseParticipantUpload}, owner ruling 2026-10-26),
 * so it passes the same gate before it can publish.
 *
 * 🔴 PRIVACY: logs carry ids only.
 */

import type { Payload } from 'payload'

import { isPlatformAdminUser } from '../access'
import { corpusTextFor } from './anonymiseDocument'
import { isContentKind } from './contentKind'
import { relationId, roleInOrganization, type OrgRole } from './permissions'
import { beginPublish, type CorpusMover } from './publishDocument'

type Id = number | string

/** Why the system did not publish a draft. */
export type AutoPublishSkip =
  | 'not-found'
  | 'not-a-contribution'
  | 'not-draft'
  | 'not-ingested'
  | 'rejected'
  | 'gate-not-cleared'
  | 'no-organization'
  | 'not-participant'
  | 'failed'

export type AutoPublishOutcome = { published: true } | { published: false; reason: AutoPublishSkip }

/**
 * The row-only half of the rule: may the system publish this draft at all?
 * `null` means yes. Who uploaded it is asked separately.
 *
 * ⚠ `rejected` is checked for every kind. A reviewer's "no" on a published
 * `documento` (`lib/rejectPublished.ts`) must not be undone by a re-ingest.
 */
export function autoPublishBlocker(row: Record<string, unknown>): AutoPublishSkip | null {
  if (!isContentKind(row.contentKind) || row.contentKind === 'conversacion') return 'not-a-contribution'
  if (row.publicationStatus !== 'draft') return 'not-draft'
  if (row.anonymisationStatus === 'rejected') return 'rejected'
  if (row.ingestStatus !== 'ready') return 'not-ingested'
  if (!corpusTextFor(row).ok) return 'gate-not-cleared'
  return null
}

/**
 * Is this upload a participant's? Their role in the document's ecosistema is
 * exactly `member`, and they are not a platform admin.
 *
 * ⚠ Unknown resolves to "no": a missing user or membership leaves the draft
 * with its uploader, which is the private direction.
 */
export async function isParticipantUpload(
  payload: Payload,
  uploaderId: Id,
  organizationId: Id,
): Promise<boolean> {
  const user = await payload
    .findByID({ collection: 'users', id: uploaderId as never, depth: 0, overrideAccess: true })
    .catch(() => null)
  if (!user || isPlatformAdminUser(user)) return false
  return (await roleInOrganization(payload, uploaderId, organizationId)) === 'member'
}

/**
 * Should a new upload be filed as a `testimonio` rather than the `documento`
 * the form declared? Only a participant's audio. See the file header.
 */
export function fileParticipantAudioAsTestimonio(input: {
  declared: string
  kind: unknown
  role: OrgRole | null
  platformAdmin: boolean
}): boolean {
  return (
    input.declared === 'documento' &&
    input.kind === 'audio' &&
    input.role === 'member' &&
    !input.platformAdmin
  )
}

/**
 * Should a new PDF/DOCX `documento` be filed with `anonymise` set? A
 * participant's always. Staff choose at upload.
 */
export function anonymiseParticipantUpload(input: { role: OrgRole | null; platformAdmin: boolean }): boolean {
  return input.role === 'member' && !input.platformAdmin
}

/**
 * Publish one draft if it is a participant's and the gate cleared it.
 *
 * ⚠ NEVER THROWS. It runs inside the ai-service callback, where a throw answers
 * 500 and makes ai-service resend an ingest that already landed. A failure is
 * logged and reported; `beginPublish` stamps `publicationError` on the row.
 */
export async function autoPublishParticipantDocument(args: {
  payload: Payload
  documentId: Id
  /** The ADMIN client for that ecosistema: publishing retires the draft copy. */
  clientFor: (organizationId: Id) => CorpusMover
  callbackUrl?: string
}): Promise<AutoPublishOutcome> {
  const { payload, documentId } = args
  const skip = (reason: AutoPublishSkip): AutoPublishOutcome => ({ published: false, reason })
  try {
    const row = (await payload
      .findByID({ collection: 'documents', id: documentId as never, depth: 0, overrideAccess: true })
      .catch(() => null)) as Record<string, unknown> | null
    if (!row) return skip('not-found')

    const blocked = autoPublishBlocker(row)
    if (blocked) return skip(blocked)

    const organizationId = relationId(row.organization)
    const uploaderId = relationId(row.uploadedBy)
    if (organizationId === null || uploaderId === null) return skip('no-organization')
    if (!(await isParticipantUpload(payload, uploaderId, organizationId))) return skip('not-participant')

    await beginPublish(row as never, {
      payload,
      client: args.clientFor(organizationId),
      ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
    })
    return { published: true }
  } catch (err) {
    payload.logger?.error?.({ err, docId: String(documentId) }, '[auto-publish] could not publish')
    return skip('failed')
  }
}
