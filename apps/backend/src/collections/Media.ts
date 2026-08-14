import type {
  Access,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Where,
} from 'payload'

import { isPlatformAdminUser } from '../access'
import { organizationIdsForUser, relationId } from '../lib/permissions'

/**
 * Media — Payload's built-in upload collection, and the collection that holds
 * THE ACTUAL FILE BYTES behind `documents.mediaFile`.
 *
 * 🔴 THIS COLLECTION IS A SECOND COPY OF THE DOCUMENT VISIBILITY RULE, and it
 * has to be, because Payload enforces access per collection. `Documents` can be
 * airtight and the file still be world-readable to any signed-in account — which
 * is exactly what this collection used to be (`Boolean(user)` on all four
 * operations). A member of ecosistema A could fetch the file of a DRAFT document
 * belonging to someone in ecosistema B, and could delete any file in the system.
 *
 * ⚠ THE FILE ROUTE IS COVERED, not just the REST row. Payload's static handler
 * (`uploads/checkFileAccess`) runs `access.read` and ANDs the returned WHERE
 * constraint into the lookup by filename, so a constraint here reaches
 * `GET /api/media/file/:filename` as well as `GET /api/media/:id`. That is the
 * route that serves bytes, and it is the one that mattered.
 *
 * Local dev stores files under `./media/` per Payload's `staticDir` default.
 */

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * 🔴 WHO MAY READ A FILE. The mirror of `visibleToCaller` in `Documents.ts`,
 * expressed over the media row.
 *
 *   · THE UPLOADER, always and unconditionally — including while a document is
 *     mid-publish, and including a file no document points at yet.
 *   · EVERY OTHER MEMBER of the ecosistema, but ONLY the files attached to a
 *     document that is actually `published` there.
 *
 * ── WHY THIS NEEDS A QUERY AND NOT A COLUMN ─────────────────────────────────
 *
 * The publication state lives on `documents`, and the relationship points
 * documents → media. There is no forward field on a media row to constrain on,
 * so the set of "media the ecosistema has published" is resolved by asking
 * `documents` for it and turning the answer into an id constraint. The
 * alternative — mirroring `publicationStatus` onto the media row — means two
 * sources of truth for the one rule that must never disagree, kept in step by a
 * hook that can fail halfway through a publish.
 *
 * ⚠ THE PAIRING IS CHECKED, NOT JUST THE ID. Each shared clause requires the
 * media row's `uploadedBy` to be the SAME PERSON as the publishing document's
 * `uploadedBy`. Without that, `documents.mediaFile` — which is client-supplied
 * and unvalidated — becomes an escalation: point a new document at a media id
 * you cannot read, publish it, and your whole ecosistema (you included) can now
 * read someone else's private file. Clauses are grouped per uploader so the
 * constraint stays bounded by the size of the ecosistema, not by its document
 * count.
 *
 * ⚠ Returns a WHERE CONSTRAINT, never a boolean, for the same reason
 * `visibleToCaller` does: it reaches the query, so a list comes back filtered
 * and a file you may not see 404s instead of 403-ing.
 *
 * ⚠ COST: one extra `documents` query per media read, on top of the two that
 * resolve memberships. Uploads are not a hot path and correctness here is worth
 * more than the round trip; if it ever shows up in a profile, cache it on `req`
 * — do NOT replace it with a cheaper boolean.
 */
export const mediaVisibleToCaller: Access = async ({ req }) => {
  const user = req.user
  if (!user) return false
  if (isPlatformAdminUser(user)) return true

  // ⚠ UNCONDITIONAL, AND FIRST. A file whose document is still a draft, is
  // mid-publish, was deleted, or was never created at all stays reachable by the
  // person who uploaded it — see the orphan note on `bindMediaToEcosystem`.
  const mine: Where = { uploadedBy: { equals: user.id } }

  const organizationIds = await organizationIdsForUser(req.payload, user.id)
  // ⚠ No memberships ⇒ only your own files. NOT an empty `in: []`, which an ORM
  // may optimise away into "no constraint" — and the failure mode there is every
  // ecosistema's files returned to someone in none.
  if (organizationIds.length === 0) return mine

  // Read with `overrideAccess: true` and an EXPLICIT tenancy predicate. This
  // query IS part of the access decision; running it under `visibleToCaller`
  // would answer a subtly different question (what this person may see) than the
  // one being asked (what this ecosistema has published).
  const published = await req.payload.find({
    collection: 'documents',
    where: {
      and: [
        { publicationStatus: { equals: 'published' } },
        { organization: { in: organizationIds } },
        { mediaFile: { exists: true } },
      ],
    },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })

  // uploader id → the media ids they published in one of my ecosistemas.
  const byUploader = new Map<string, { uploader: number | string; mediaIds: Array<number | string> }>()
  for (const row of published.docs as unknown as Array<Record<string, unknown>>) {
    const mediaId = relationId(row.mediaFile)
    const uploader = relationId(row.uploadedBy)
    // A document with no uploader cannot vouch for anybody's file. Skip it
    // rather than fall back to "anyone in the ecosistema".
    if (mediaId === null || uploader === null) continue
    const key = String(uploader)
    const bucket = byUploader.get(key)
    if (bucket) bucket.mediaIds.push(mediaId)
    else byUploader.set(key, { uploader, mediaIds: [mediaId] })
  }

  if (byUploader.size === 0) return mine

  const shared: Where[] = [...byUploader.values()].map(({ uploader, mediaIds }) => {
    const byUploaderClause: Where = { uploadedBy: { equals: uploader } }
    const byIdClause: Where = { id: { in: mediaIds } }
    return { and: [byUploaderClause, byIdClause] } satisfies Where
  })

  return { or: [mine, ...shared] } satisfies Where
}

/**
 * Only the uploader edits or removes a file.
 *
 * ⚠ NO ADMIN/OWNER CLAUSE, and that is deliberate rather than an omission:
 * `Documents.uploaderOnly` has none either, so an ecosistema admin cannot delete
 * a colleague's document row. Giving them the file but not the row would leave
 * a document pointing at nothing, which is worse than either rule on its own.
 * If the product decides admins may curate the corpus, both collections change
 * together.
 */
export const mediaUploaderOnly: Access = ({ req: { user } }) => {
  if (!user) return false
  if (isPlatformAdminUser(user)) return true
  return { uploadedBy: { equals: user.id } } satisfies Where
}

// ---------------------------------------------------------------------------
// The upload gate
// ---------------------------------------------------------------------------

/**
 * 🔴 STAMP THE UPLOADER (and the ecosistema when it is unambiguous) SERVER-SIDE.
 *
 * `create` access is "any signed-in user" because Payload's create-time check
 * has no row to constrain against. Everything that decides who may later read
 * the file therefore has to be written here, from `req.user`, never from the
 * request body — a client-supplied `uploadedBy` would hand the attacker the one
 * clause that is unconditional.
 *
 * ⚠ `uploadedBy` IS IMMUTABLE. Re-pointing it on update is the same attack in
 * two steps: upload a file as yourself, then reassign it to the colleague whose
 * published document you want your bytes attached to.
 *
 * ⚠ THE ORPHAN CASE — a file with no document, or whose document was deleted —
 * RESOLVES TO "UPLOADER ONLY", and it does so BY CONSTRUCTION rather than by a
 * special case. This is not a corner: `POST /api/media` always happens BEFORE
 * `POST /api/documents` (the BFF uploads the bytes, then creates the row
 * referencing the returned id), so EVERY file is an orphan for the width of that
 * round trip, and stays one forever if the second call fails. The shared clause
 * in `mediaVisibleToCaller` is built from actual published `documents` rows, so
 * a file no such row points at simply matches nothing and falls through to
 * `uploadedBy`. Defaulting the other way — "no document, so no restriction" —
 * would mean the safest moment to steal a file is the second before it is
 * attached to anything.
 *
 * ⚠ `organization` IS BEST-EFFORT AND INFORMATIONAL. `POST /api/media` carries
 * only the file: no session, no ecosistema, nothing to derive from except the
 * uploader's memberships. When there is exactly one it is stamped; when the
 * person belongs to several it is left null, because REFUSING would break
 * uploads outright for multi-ecosistema members (unlike `Documents`, which can
 * fall back to the session id in the body). It is therefore NOT part of the read
 * rule — a nullable column is a terrible thing to hang a tenancy check on. The
 * tenancy boundary is enforced on the `documents` side of the query above, where
 * `organization` is `required: true`.
 *
 * ⚠ Writes with `overrideAccess: true` and no user — the seed, the ingest
 * pipeline — pass through untouched, exactly as in `bindDocumentToEcosystem`.
 */
export const bindMediaToEcosystem: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  if (!user) return next

  const original = (originalDoc ?? {}) as Record<string, unknown>

  if (operation !== 'create') {
    next.uploadedBy = original.uploadedBy
    next.organization = original.organization
    return next
  }

  next.uploadedBy = user.id

  const organizationIds = await organizationIdsForUser(req.payload, user.id)
  if (organizationIds.length === 1) {
    next.organization = organizationIds[0]
  } else {
    // Ambiguous or absent. Leave it unset rather than guess a tenant — the read
    // rule does not depend on it, and a wrong value here would be a lie the
    // admin panel repeats.
    delete next.organization
  }

  return next
}

// ---------------------------------------------------------------------------
// Accepted uploads
// ---------------------------------------------------------------------------

/**
 * What may be uploaded at all.
 *
 * The four document types are the M4–M6 path. The audio list mirrors
 * `plan/audio-ingest-integration.md` §3.1, which is itself a subset of
 * `services/audio-service/app/audio/formats.py::ACCEPTED_MIME_TYPES` — the
 * service that actually transcribes these files.
 *
 * ⚠ THE LIST IS GENEROUS ON PURPOSE, AND IT IS NOT THE REAL GATE. Browsers
 * disagree wildly about `.m4a` (`audio/mp4`, `audio/x-m4a`, `audio/aac`, or
 * nothing at all), so a narrow allowlist here rejects real recordings from real
 * phones. The authoritative check is audio-service's `ffprobe` pass: a file has
 * to contain a decodable audio stream, which no MIME string can fake.
 *
 * ⚠ DELIBERATELY NOT MIRRORED from audio-service: `application/octet-stream`,
 * which browsers and curl send for anything they cannot sniff — accepting it
 * would make this allowlist decorative. Also left out: `audio/amr`,
 * `audio/3gpp`, `audio/x-ms-wma`, `audio/aiff`, `audio/x-aiff`, `video/webm`
 * and `video/x-matroska`. audio-service decodes them, but nothing in this
 * product uploads them today and every entry here is a file type that lands on
 * the backend's local disk. Add them when something actually sends them.
 */
export const MEDIA_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
  // Audio.
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  // The audio track of a phone or screen recording. ffmpeg's `-vn` drops the
  // video stream, so these cost the transcription pipeline nothing.
  'video/mp4',
  'video/quicktime',
] as const

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    useAsTitle: 'filename',
    defaultColumns: ['filename', 'mimeType', 'uploadedBy', 'organization'],
  },
  access: {
    read: mediaVisibleToCaller,
    // Any signed-in account may upload; who it belongs to is decided by
    // `bindMediaToEcosystem`, not by the request body.
    create: ({ req: { user } }) => Boolean(user),
    update: mediaUploaderOnly,
    delete: mediaUploaderOnly,
  },
  upload: {
    mimeTypes: [...MEDIA_MIME_TYPES],
  },
  fields: [
    {
      /**
       * ⚠ THE WHOLE OF THE UNCONDITIONAL READ CLAUSE, and the owner for update
       * and delete. Stamped from `req.user` on create and immutable after —
       * never accepted from a request body.
       */
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { readOnly: true, description: 'Taken from the session. Immutable.' },
    },
    {
      /**
       * Best-effort tenancy label. Stamped when the uploader belongs to exactly
       * one ecosistema. NOT part of the read rule — see `bindMediaToEcosystem`.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      admin: {
        readOnly: true,
        description:
          'Derived on upload when unambiguous. Informational — the read rule goes through the owning document.',
      },
    },
    { name: 'alt', type: 'text' },
  ],
  hooks: {
    beforeValidate: [bindMediaToEcosystem],
  },
}
