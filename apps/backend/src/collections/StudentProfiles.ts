import type { Access, CollectionConfig } from 'payload'

/**
 * A student's two consent switches in one ecosistema (student view, owner
 * 2026-10-27). Both default OFF:
 *   · `shareWithPeers` — other students may see my name and my topics;
 *   · `shareActivity`  — the ecosistema's responsables may read my activity
 *     report;
 *   · `shareTestimoniosAt` — WHEN I accepted that the report also shows my
 *     testimonios, anonymised (owner ruling Q20: a consent given while
 *     `studentTestimonios` was off does not cover them). NULL = not given or
 *     withdrawn. Set only while the switch is on, cleared on withdrawal and
 *     whenever `shareActivity` goes off;
 *   · `shareTestimoniosVersion` — the consent wording's version at that moment.
 *     Only the CURRENT version counts (`lib/student/testimonioConsent.ts`).
 *
 * 🔴 Server-only. `endpoints/estudiante.ts` is the one reader and writer; it
 * always keys the row on the CALLER, so nobody can flip someone else's consent.
 */
const serverOnly: Access = () => false

export const StudentProfiles: CollectionConfig = {
  slug: 'studentProfiles',
  admin: { group: 'Estudiantes', defaultColumns: ['user', 'organization', 'shareWithPeers', 'shareActivity'] },
  access: { read: serverOnly, create: serverOnly, update: serverOnly, delete: serverOnly },
  fields: [
    { name: 'user', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    { name: 'shareWithPeers', type: 'checkbox', required: true, defaultValue: false },
    { name: 'shareActivity', type: 'checkbox', required: true, defaultValue: false },
    { name: 'shareTestimoniosAt', type: 'date', admin: { date: { pickerAppearance: 'dayAndTime' } } },
    // Which wording `shareTestimoniosAt` was given under (`lib/student/testimonioConsent.ts`).
    // NULL = an older wording, or none: it does not count.
    { name: 'shareTestimoniosVersion', type: 'number' },
  ],
}
