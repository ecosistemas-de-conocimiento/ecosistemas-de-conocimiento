/**
 * 🔴 THE PER-RESOURCE UPLOAD CONSENT (Etapa 1 correction, 2026-11-12).
 *
 * The wording lives in ONE place, `apps/web/src/lib/uploadConsent.ts`, next to
 * the same version number. The page sends the version it showed as
 * `uploadConsentVersion` in the `POST /api/documents` body (JSON, or the
 * multipart `_payload`); the virtual `documents.uploadConsentVersion` field
 * (no column) refuses any other, and `recordUploadConsent` writes exactly one
 * `consent-receipts` row in the create's own transaction.
 *
 * It records that THE PERSON UPLOADING declared, on this version of the text,
 * that the material may be treated as the privacy notice describes. It never
 * records whose words they are (ADR-0019), and never any text.
 *
 * Exempt: server creates (`overrideAccess`, or no user): a note's revision
 * (`lib/studentNotes.ts`, covered by the original's receipt) and the seeds.
 *
 * ⚠ CHANGE THE WORDING → BUMP THE VERSION, here AND in the web file.
 * `uploadConsent.test.ts` fails when the two numbers differ.
 */
import { APIError, type CollectionAfterChangeHook, type Field, type FieldHook } from 'payload'

import { relationId } from './permissions'

export const UPLOAD_CONSENT_VERSION = 1

/** The error messages of the contract (Payload's `{ errors: [{ message }] }`). */
export const UPLOAD_CONSENT_REQUIRED = 'upload_consent_required'
export const CONSENT_VERSION_CHANGED = 'consent_version_changed'

type ConsentCheck = { overrideAccess?: boolean; req: { user?: unknown } }

/** A create that must carry the consent: a signed-in caller under access control. */
export function isUserCreate({ overrideAccess, req }: ConsentCheck): boolean {
  return Boolean(req.user) && overrideAccess !== true
}

/** Throws the contract's 400 / 409 for a user create without the current version. */
export function assertUploadConsent(value: unknown): void {
  if (value === undefined || value === null || value === '') throw new APIError(UPLOAD_CONSENT_REQUIRED, 400)
  if (value !== UPLOAD_CONSENT_VERSION) throw new APIError(CONSENT_VERSION_CHANGED, 409)
}

const checkOnCreate: FieldHook = ({ operation, overrideAccess, req, value }) => {
  if (operation === 'create' && isUserCreate({ overrideAccess, req })) assertUploadConsent(value)
  // Virtual: nothing to store, nothing to read back.
  return undefined
}

/** `documents.uploadConsentVersion`: virtual, write-only, checked on create. */
export const uploadConsentVersionField: Field = {
  name: 'uploadConsentVersion',
  type: 'number',
  virtual: true,
  admin: { hidden: true },
  hooks: { beforeValidate: [checkOnCreate], afterRead: [() => undefined] },
}

/**
 * Writes the receipt with the create's own `req`: if it fails, the document is
 * not created either. 🔴 NEVER ANY TEXT: no name, no title, no content.
 */
export const recordUploadConsent: CollectionAfterChangeHook = async ({ doc, operation, overrideAccess, req }) => {
  if (operation !== 'create' || !isUserCreate({ overrideAccess, req })) return doc
  await req.payload.create({
    collection: 'consent-receipts',
    data: {
      document: doc.id,
      documentIdSnapshot: doc.id,
      organization: relationId(doc.organization),
      actor: (req.user as { id: number | string }).id,
      kind: 'upload',
      // The field hook already refused anything else.
      consentVersion: UPLOAD_CONSENT_VERSION,
      contentKind: doc.contentKind,
    },
    overrideAccess: true,
    req,
  } as never)
  return doc
}

/** `EDC-<year in America/Mexico_City>-<receipt id, 6 digits>`. */
export function folio(receiptId: number | string, createdAt: string | Date): string {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric' }).format(
    new Date(createdAt),
  )
  return `EDC-${year}-${String(receiptId).padStart(6, '0')}`
}
