import type { CollectionConfig } from 'payload'

/**
 * Media — Payload's built-in upload collection, used by `documents.mediaFile`.
 * Wired here so `Documents` typechecks; uploads are M6 (PDF/DOCX). Local dev
 * stores files under `./media/` per Payload's `staticDir` default.
 */
export const Media: CollectionConfig = {
  slug: 'media',
  admin: { useAsTitle: 'filename' },
  access: {
    read: ({ req: { user } }) => Boolean(user),
    create: ({ req: { user } }) => Boolean(user),
    update: ({ req: { user } }) => Boolean(user),
    delete: ({ req: { user } }) => Boolean(user),
  },
  upload: {
    // Allow pdf/docx + md for the M4-M6 path; refine later if needed.
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/markdown',
      'text/plain',
    ],
  },
  fields: [{ name: 'alt', type: 'text' }],
}
