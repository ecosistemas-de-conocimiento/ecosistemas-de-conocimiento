/**
 * 🔴 ONE ROW PER UPLOAD CONSENT (Etapa 1 correction, 2026-11-12;
 * `lib/uploadConsent.ts`): who uploaded, when (`createdAt`), in which
 * ecosistema, on which version of the text, for which kind of material.
 *
 * The folio of the constancia is derived from this row's `id`
 * (`folio` in `lib/uploadConsent.ts`), never stored.
 *
 * 🔴 NEVER ANY TEXT: no file name, no title, no content. And never whose words
 * they are (ADR-0019): `actor` is the platform user who uploaded.
 *
 * 🔴 A DOCUMENT DELETE KEEPS THE RECEIPT: `document` goes NULL
 * (`ON DELETE set null`) and `documentIdSnapshot` keeps which one it was, so
 * the constancia still resolves after a withdrawal.
 *
 * Append-only: created server-side only (`overrideAccess`, from the documents
 * create hook), never created, updated or deleted through the API.
 */

import type { CollectionConfig, Where } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { CONTENT_KINDS } from '../lib/contentKind'

export const ConsentReceipts: CollectionConfig = {
  slug: 'consent-receipts',
  admin: {
    useAsTitle: 'kind',
    defaultColumns: ['kind', 'consentVersion', 'contentKind', 'documentIdSnapshot', 'organization', 'actor', 'createdAt'],
    group: 'Feedback',
    description: 'Cada consentimiento declarado al subir un recurso. Solo se agregan filas.',
  },
  /**
   * 🔴 `where[document.name]` reaches the gated `documents` columns through the
   * relationship. Same rule as `anonymisation-setting-changes`.
   */
  custom: { gatedQueryPrefix: 'document.' },
  access: {
    // 🔴 The uploader's own rows, or a platform admin. NOT `holds:review`: a
    // receipt links `actor` to a document id, and the hold list shows reviewers
    // that id without `uploadedBy` on purpose (`lib/holdReview.ts`), because
    // who filed a testimonio next to what it says helps re-identify the
    // speaker (audit S1, 2026-11-12).
    read: ({ req }) => {
      const user = req.user
      if (!user || !isActiveUser(user)) return false
      if (isPlatformAdminUser(user)) return true
      const own: Where = { actor: { equals: user.id } }
      return own
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    /** NULL once the document is deleted (`ON DELETE set null`). */
    { name: 'document', type: 'relationship', relationTo: 'documents', index: true },
    /** The document's id at upload; survives its delete. */
    { name: 'documentIdSnapshot', type: 'number', required: true, index: true },
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    /** Who uploaded. Never whose words they are. */
    { name: 'actor', type: 'relationship', relationTo: 'users', index: true },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: [{ label: 'Subida', value: 'upload' }],
    },
    { name: 'consentVersion', type: 'number', required: true },
    {
      name: 'contentKind',
      type: 'select',
      required: true,
      options: CONTENT_KINDS.map((value) => ({ label: value, value })),
    },
  ],
  timestamps: true,
}
