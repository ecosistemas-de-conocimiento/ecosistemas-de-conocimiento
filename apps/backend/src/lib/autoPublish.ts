/**
 * 🔴 A PARTICIPANT NEVER PUBLISHES BY HAND (owner rule, 2026-10-24).
 *
 * A participant (`member` or `estudiante` role) uploads files and audio and chats. What they
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
import { corpusTextFor, rowMustPassGate } from './anonymiseDocument'
import { isContentKind } from './contentKind'
import { featureEnabled } from './features'
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
  /** An ungated `documento` (no `anonymise`): never shared by the system. */
  | 'not-gated'
  | 'no-organization'
  | 'not-participant'
  /** The ecosistema switched `autoPublishMembers` off (`lib/features.ts`). */
  | 'disabled'
  | 'failed'
  /** A note revision (`lib/studentNotes.ts` `promoteRevision`). */
  | 'graph-pending'
  | 'busy'
  | 'withdrawn'
  /** 🔴 The note or its revision is held for consent (`lib/consentHold.ts`): nothing sent, nothing written. */
  | 'consent-held'

export type AutoPublishOutcome = { published: true } | { published: false; reason: AutoPublishSkip }

/**
 * The row-only half of the rule: may the system publish this draft at all?
 * `null` means yes. Who uploaded it is asked separately.
 *
 * ⚠ `rejected` is checked for every kind. A reviewer's "no" on a published
 * `documento` (`lib/rejectPublished.ts`) must not be undone by a re-ingest.
 *
 * 🔴 AN UNGATED ROW NEVER AUTO-PUBLISHES (audit 2026-10-28, item 8). A
 * `documento` without `anonymise` never passed the gate: a legacy upload from
 * before the 10-26 ruling, or a staff upload whose uploader was later demoted
 * to `member`. `corpusTextFor` returns its raw text as `ok`, so without this
 * check the system shared every name in it. It stays a draft for staff.
 */
export function autoPublishBlocker(row: Record<string, unknown>): AutoPublishSkip | null {
  if (!isContentKind(row.contentKind) || row.contentKind === 'conversacion') return 'not-a-contribution'
  if (row.publicationStatus !== 'draft') return 'not-draft'
  if (row.anonymisationStatus === 'rejected') return 'rejected'
  if (row.ingestStatus !== 'ready') return 'not-ingested'
  if (!rowMustPassGate(row)) return 'not-gated'
  if (!corpusTextFor(row).ok) return 'gate-not-cleared'
  return null
}

/**
 * A participant role: `member`, or `estudiante` (owner ruling 2026-10-27 —
 * a student is a member with a different view). Their uploads go through the
 * gate and are published by the system; they never publish by hand.
 */
export function isParticipantRole(role: OrgRole | null): boolean {
  return role === 'member' || role === 'estudiante'
}

/**
 * Is this upload a participant's? Their role in the document's ecosistema is
 * `member` or `estudiante` ({@link isParticipantRole}), and they are not a platform admin.
 *
 * ⚠ Unknown resolves to "no": a missing user or membership leaves the draft
 * with its uploader, which is the private direction.
 *
 * 🔴 A DEACTIVATED (OR NULL) ACCOUNT IS NOT A PARTICIPANT. Its upload still in
 * flight when the account was switched off stays a draft (audit 2026-11-10).
 */
export async function isParticipantUpload(
  payload: Payload,
  uploaderId: Id,
  organizationId: Id,
): Promise<boolean> {
  const user = await payload
    .findByID({ collection: 'users', id: uploaderId as never, depth: 0, overrideAccess: true })
    .catch(() => null)
  if (!user || user.isActive !== true || isPlatformAdminUser(user)) return false
  return isParticipantRole(await roleInOrganization(payload, uploaderId, organizationId))
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
    isParticipantRole(input.role) &&
    !input.platformAdmin
  )
}

/**
 * Should a new `documento` (any declared `kind` but audio) be filed with `anonymise` set? A
 * participant's always. Staff choose at upload.
 */
export function anonymiseParticipantUpload(input: { role: OrgRole | null; platformAdmin: boolean }): boolean {
  return isParticipantRole(input.role) && !input.platformAdmin
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
    // Off: the participant's draft stays a draft, for staff to publish.
    if (!(await featureEnabled(payload, organizationId, 'autoPublishMembers'))) return skip('disabled')

    // 🔴 A note's "Publicar cambios" revision is promoted onto the published
    // note, never published as a second document (`lib/studentNotes.ts`).
    if (relationId(row.revisionOf) !== null) {
      const { promoteRevision } = await import('./studentNotes')
      const skipped = await promoteRevision({
        payload,
        revision: row,
        client: args.clientFor(organizationId),
        ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
      })
      return skipped ? skip(skipped === 'not-cleared' ? 'gate-not-cleared' : skipped) : { published: true }
    }

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
