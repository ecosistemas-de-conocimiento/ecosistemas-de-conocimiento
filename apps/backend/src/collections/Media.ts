import type {
  Access,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Where,
} from 'payload'
import { ValidationError } from 'payload'

import { isPlatformAdminUser } from '../access'
import { organizationIdsForUser, relationId } from '../lib/permissions'
import { looksLikeText } from '../lib/extract/text'
import { MATROSKA_HEAD_BYTES, isAudioOnlyMatroska, isMatroska } from '../lib/webmTracks'

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
 * ⚠ WHERE THE BYTES LIVE IS NOW A RUNTIME DECISION, and it does not change one
 * line of the rule above. With `S3_*` set, `@payloadcms/storage-s3` writes to
 * the bucket and serves through the SAME `upload.handlers` chain, which Payload
 * runs strictly AFTER `checkFileAccess`. With those vars absent, files land
 * under `./media/` per Payload's `staticDir` default. See `lib/storage/plugin.ts`
 * for the four plugin options that would break this and are therefore unset.
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
        // 🔴 A `documento` only. The file behind a published testimonio is the
        // RECORDING — the speaker's own voice and every unredacted word. What
        // the ecosistema shares is the gate's `redactedText`, never the source.
        // Same rule as `mayReadGatedOriginal` in `Documents.ts`; the uploader
        // still reaches it through `mine` above.
        { contentKind: { equals: 'documento' } },
        // 🔴 …and not one filed for anonymisation: its file names the people
        // the gate removes. `equals: false` fails closed on NULL.
        { anonymise: { equals: false } },
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
/**
 * The server-side upload size cap.
 *
 * 🔴 THE LAST GATE THAT ACTUALLY BINDS. The browser checks a size before it
 * uploads, and the frontend's BFF checks again per kind — but neither is a
 * security boundary. `POST /api/media` is a plain authenticated REST endpoint,
 * so anything holding a session cookie can skip both and put an arbitrary
 * number of bytes on this server's disk, or in the bucket at our cost.
 *
 * ⚠ ONE CAP FOR EVERY KIND, and it has to be the AUDIO one. This collection
 * cannot see whether a file is "a document" or "a recording" in a way worth
 * trusting, and a recording is legitimately 10-100x a PDF. Applying the
 * document limit here would reject every real audio upload. The per-kind rule
 * (20 MB documents, 200 MB audio) stays where the kind is actually known:
 * `apps/web/src/lib/config.ts` and the BFF route that reads it.
 *
 * So this is a BACKSTOP, not the product rule. It stops the absurd case; the
 * friendly per-kind message still comes from the layer above. Keep it in step
 * with `MAX_AUDIO_UPLOAD_BYTES` — if they drift, the symptom is an upload that
 * passes the frontend and is then refused here with a worse error.
 */
export const MAX_MEDIA_UPLOAD_BYTES = 200 * 1024 * 1024

export const rejectOversizedUpload: CollectionBeforeValidateHook = ({ data, req }) => {
  // `req.file` is what the multipart parser produced; a metadata-only PATCH has
  // none and must pass straight through.
  const size = (req as { file?: { size?: unknown } }).file?.size
  if (typeof size !== 'number' || !Number.isFinite(size)) return data
  if (size <= MAX_MEDIA_UPLOAD_BYTES) return data

  const mb = (n: number) => Math.round(n / (1024 * 1024))
  throw new ValidationError({
    collection: 'media',
    errors: [
      {
        path: 'file',
        message: `This file is ${mb(size)} MB. The maximum is ${mb(MAX_MEDIA_UPLOAD_BYTES)} MB.`,
      },
    ],
    req,
  })
}

/**
 * Allow `video/webm` only when it is really audio.
 *
 * 🔴 WHY `video/webm` IS IN `MEDIA_MIME_TYPES` AT ALL: the live-mic recorder
 * produces WebM/Opus, file-type sniffs every WebM as `video/webm`, and Payload
 * checks that sniffed type before any hook runs. Without it every recording
 * was refused on Stop (dev, 2026-10-24). This hook is the other half: a WebM
 * with a video track, or with no audio track, is refused here, and an accepted
 * one is stored as `audio/webm` so nothing downstream sees a video type.
 */
type UploadedFile = { name?: string; data?: Buffer; tempFilePath?: string }

/** The first `bytes` of the uploaded file, in memory or on a temp path; `null` if neither. */
async function readUploadHead(file: UploadedFile, bytes: number): Promise<Uint8Array | null> {
  if (file.data && file.data.length > 0) return file.data.subarray(0, bytes)
  if (!file.tempFilePath) return null
  // Imported here: collection configs are also loaded where `node:fs` is not.
  const { open } = await import('node:fs/promises')
  const handle = await open(file.tempFilePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The whole uploaded file, in memory or on a temp path; `null` if neither. */
async function readUploadBytes(file: UploadedFile): Promise<Uint8Array | null> {
  if (file.data && file.data.length > 0) return file.data
  if (!file.tempFilePath) return null
  const { readFile } = await import('node:fs/promises')
  return readFile(file.tempFilePath)
}

export const audioOnlyWebm: CollectionBeforeValidateHook = async ({ data, req }) => {
  const file = (req as { file?: UploadedFile }).file
  if (!file) return data
  const head = await readUploadHead(file, MATROSKA_HEAD_BYTES)
  if (!head || !isMatroska(head)) return data
  if (!isAudioOnlyMatroska(head)) {
    throw new ValidationError({
      collection: 'media',
      errors: [{ path: 'file', message: 'Only audio WebM files are accepted.' }],
      req,
    })
  }
  const next = { ...(data ?? {}) } as Record<string, unknown>
  if (next.mimeType === 'video/webm') next.mimeType = 'audio/webm'
  return next
}

/**
 * csv and html must really be text, and html is stored as `text/plain`.
 *
 * 🔴 WHY: neither format has a magic number, so file-type detects nothing and
 * Payload accepts them on the EXTENSION alone (`getFileTypeFallback`). This
 * hook is the content check: a binary, an executable or a `#!` script renamed
 * `.csv` is refused. And an html file served as `text/html` from this origin
 * would run its scripts in the admin's session, so it is stored as text/plain
 * (the bucket's Content-Type) and `mediaResponseHeaders` covers the
 * local-disk path, which derives the type from the extension.
 */
export const textUploadsAreText: CollectionBeforeValidateHook = async ({ data, req }) => {
  const file = (req as { file?: UploadedFile }).file
  if (!file) return data
  // `text/html; charset=utf-8` is still html: compare the bare type.
  const rawType = (data as { mimeType?: unknown } | undefined)?.mimeType
  const mimeType = typeof rawType === 'string' ? rawType.split(';')[0].trim().toLowerCase() : ''
  const isHtml = mimeType === 'text/html' || /\.html?$/i.test(file.name ?? '')
  const isCsv = mimeType === 'text/csv' || /\.csv$/i.test(file.name ?? '')
  if (!isHtml && !isCsv) return data
  // The WHOLE file: a text head over a binary tail passed an 8 KB sniff.
  const bytes = await readUploadBytes(file)
  if (!bytes || !looksLikeText(bytes)) {
    throw new ValidationError({
      collection: 'media',
      errors: [{ path: 'file', message: 'This file is not plain text.' }],
      req,
    })
  }
  // 🔴 Windows browsers send a `.csv` as `application/vnd.ms-excel`, which the
  // `mimeTypes` allow-list refuses. The bytes are text, so store it as csv.
  return { ...(data ?? {}), mimeType: isHtml ? 'text/plain' : 'text/csv' }
}

/**
 * 🔴 NO STORED FILE IS EVER SERVED AS A PAGE. Local disk derives the type from
 * the extension, so an `.html` would go out as `text/html`; `nosniff` stops a
 * browser guessing its way back to it.
 */
export function mediaResponseHeaders({ headers }: { headers: Headers }): Headers {
  const type = (headers.get('content-type') ?? '').toLowerCase()
  if (type.startsWith('text/html') || type.startsWith('application/xhtml')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8')
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

export const bindMediaToEcosystem: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  const original = (originalDoc ?? {}) as Record<string, unknown>

  // ⚠ `prefix` IS IMMUTABLE FOR EVERYONE, overrideAccess writers included, and
  // for a different reason than `uploadedBy`: it is not a permission, it is a
  // RECORD OF WHERE THE BYTES ALREADY ARE. Rewriting it moves no object — it
  // only stops the serve route computing the key the upload actually used, and
  // the file 404s while sitting perfectly intact in the bucket.
  if (operation !== 'create' && typeof original.prefix === 'string') {
    next.prefix = original.prefix
  }

  if (!user) {
    // Seed / ingest writes still get a deterministic key rather than dropping
    // objects at the bucket root, where nothing can be accounted for.
    if (operation === 'create') {
      next.prefix = mediaObjectPrefix(relationId(next.organization), relationId(next.uploadedBy))
    }
    return next
  }

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

  next.prefix = mediaObjectPrefix(relationId(next.organization), user.id)

  return next
}

// ---------------------------------------------------------------------------
// The object key prefix
// ---------------------------------------------------------------------------

/**
 * WHERE AN OBJECT LANDS IN THE BUCKET: `eco_{orgId}/u_{uploaderId}/{filename}`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THE PREFIX IS NOT AN ACCESS BOUNDARY. IT NEVER GRANTS OR DENIES ANYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Anyone holding a working bucket credential can read every key under every
 * prefix — a prefix is a naming convention, not a wall. The ONLY thing standing
 * between a user and someone else's file is `mediaVisibleToCaller` above,
 * evaluated per request by Payload. If you ever find yourself reasoning "they
 * can't reach it, it's under a different eco_ prefix", stop: that sentence is
 * false, and it is exactly how a bucket-layout change becomes a data leak.
 *
 * ── WHY HAVE ONE AT ALL, THEN: OPERABILITY ─────────────────────────────────
 *
 * Everything below is a question that gets asked with a bucket listing, not a
 * database query, usually while something is on fire:
 *
 *   · WHICH ECOSISTEMA IS EATING THE DISK. This whole migration happened
 *     because audio is 10–100× a PDF. "Who is consuming the storage" stops
 *     being answerable the moment every object sits in one flat namespace, and
 *     a flat bucket cannot be summed per tenant without joining every key back
 *     to a row.
 *   · OFFBOARDING AN ECOSISTEMA is one prefix sweep instead of a paginated
 *     `ListObjectsV2` over the whole bucket cross-referenced against Postgres.
 *   · LIFECYCLE / RETENTION rules are expressed per prefix by every S3
 *     implementation. Without one, no rule can distinguish tenants.
 *   · ORPHANS ARE ATTRIBUTABLE. `POST /api/media` always precedes
 *     `POST /api/documents`, so every file is briefly an orphan and stays one
 *     forever if the second call fails. `u_{uploaderId}` says whose it was
 *     without a lookup.
 *
 * ── WHY THE ECOSISTEMA SEGMENT IS BEST-EFFORT, AND WHY THAT IS FINE ────────
 *
 * `organization` on a media row is deliberately nullable: `POST /api/media`
 * carries only the file, so a member of several ecosistemas leaves it unset
 * (see `bindMediaToEcosystem`). Those objects land under `eco_none/`.
 *
 * 🔴 THIS IS PRECISELY WHY THE PREFIX COULD NEVER BE A SECURITY BOUNDARY EVEN
 * IF SOMEONE WANTED IT TO BE: the field it is derived from is allowed to be
 * null, and a nullable column is a terrible thing to hang a tenancy check on.
 * As an operability label a partial answer is still useful — most uploads do
 * carry an ecosistema, and `eco_none/` is itself a legible bucket of "needs
 * attribution".
 *
 * ⚠ IT IS COMPUTED ONCE, AT CREATE, AND FROZEN. Both inputs are immutable after
 * create, so the stored prefix always matches the key the upload really wrote.
 */
export function mediaObjectPrefix(
  organizationId: number | string | null,
  uploaderId: number | string | null,
): string {
  const eco = organizationId === null ? 'eco_none' : `eco_${organizationId}`
  const uploader = uploaderId === null ? 'u_none' : `u_${uploaderId}`
  return `${eco}/${uploader}`
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
 * `audio/3gpp`, `audio/x-ms-wma`, `audio/aiff`, `audio/x-aiff` and
 * `video/x-matroska`. (`video/webm` IS listed: the live-mic recording sniffs
 * as it. See `audioOnlyWebm`.) audio-service decodes them, but nothing in this
 * product uploads them today and every entry here is a file type that lands on
 * the backend's local disk. Add them when something actually sends them.
 */
export const MEDIA_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // ⚠ No magic number: accepted on the extension, then `textUploadsAreText`
  // checks the bytes. html is stored and served as text/plain.
  'text/csv',
  'text/html',
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
  // ⚠ The live-mic recorder's WebM/Opus sniffs as this. `audioOnlyWebm` refuses
  // any WebM that really has a video track, and stores the rest as audio/webm.
  'video/webm',
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
    modifyResponseHeaders: mediaResponseHeaders,
    /**
     * 🔴 SIZE IS ENFORCED IN `beforeValidate` BELOW, not here — this Payload
     * version exposes no typed per-collection size option, only `abortOnLimit`
     * and friends on the app-level parser. Doing it in a hook is explicit and
     * testable, and it cannot silently stop applying on an upgrade.
     *
     * THE LAST GATE THAT ACTUALLY BINDS. The browser checks a size before it
     * uploads, and the BFF checks again per kind — but neither is a security
     * boundary. `POST /api/media` is a plain authenticated REST endpoint, so
     * anything with a session cookie can skip both and put an arbitrary number
     * of bytes on this server's disk (or in the bucket, at our cost).
     *
     * ⚠ ONE CAP FOR EVERY KIND, and it has to be the AUDIO one. Payload applies
     * `filesize` to the collection, not per mime type, and a recording is
     * legitimately 10–100× a PDF. Setting the document limit here would reject
     * every real audio upload; the per-kind distinction (20 MB documents,
     * 200 MB audio) stays where it can see the kind, in
     * `apps/web/src/lib/config.ts` and the BFF route that reads it.
     *
     * So this number is a BACKSTOP, not the product rule: it stops the absurd
     * case, and the friendly per-kind message still comes from the layer above.
     * Keep it in step with `MAX_AUDIO_UPLOAD_BYTES` — if they drift, the
     * symptom is an audio upload that passes the frontend's check and is then
     * refused here with a far less helpful error.
     */
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
    {
      /**
       * The object-key prefix. See `mediaObjectPrefix` — OPERABILITY ONLY, and
       * NOT an access boundary.
       *
       * ⚠ DECLARED HERE RATHER THAN LEFT TO THE PLUGIN, ON PURPOSE.
       * `@payloadcms/plugin-cloud-storage` injects a `prefix` field of its own,
       * but only when the plugin is active. Since this app runs with the plugin
       * OFF on local disk and ON with S3, letting the plugin own the field would
       * make the Postgres schema differ between the two modes — and schema push
       * is off here, so the column would simply be missing in one of them and
       * every insert would fail. Declaring it unconditionally keeps one schema
       * and one migration. The plugin merges with an existing `prefix` field
       * rather than replacing it (`plugin-cloud-storage/dist/fields/getFields.js`).
       *
       * ⚠ Read at serve time by `getFilePrefix`, which looks the row up by
       * filename to rebuild the key. Stale value ⇒ the object 404s while sitting
       * intact in the bucket. Hence the immutability in `bindMediaToEcosystem`.
       */
      name: 'prefix',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description:
          'Object-storage key prefix, derived on upload. Operability only — never an access boundary.',
      },
    },
    { name: 'alt', type: 'text' },
  ],
  hooks: {
    beforeValidate: [rejectOversizedUpload, audioOnlyWebm, textUploadsAreText, bindMediaToEcosystem],
  },
}
