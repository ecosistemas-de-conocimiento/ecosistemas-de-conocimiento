/**
 * 🔴 THE AUDIT TRAIL FOR EVERY HUMAN OVERRIDE OF THE ANONYMISATION GATE.
 *
 * ── WHY THIS COLLECTION EXISTS ───────────────────────────────────────────────
 *
 * The gate is fail-closed and has no `force` flag (`lib/anonymise/gate.ts`).
 * A review screen puts one back — deliberately, because holds are common and a
 * product that can only refuse is not a product. But an override with no record
 * is the same thing as no gate at all: nobody could ever answer "who decided
 * this testimony was safe, and what did the gate actually say when they
 * decided?" And ai-service has no per-document delete, so by the time anyone
 * asks, the answer cannot be acted on anyway — only understood.
 *
 * So the decision is written here BEFORE the text is released, one row per
 * decision, and the row carries the exact `GateReport` the human was looking at.
 * Not a reference to the document's CURRENT report — a COPY. The row's report is
 * overwritten by the next gate run, and an audit that says "approved against
 * whatever the report says today" records nothing.
 *
 * ── APPEND-ONLY, BY ACCESS CONTROL ───────────────────────────────────────────
 *
 * `create` is server-side only (`overrideAccess: true` from
 * `lib/holdReview.ts`), `update` and `delete` are `false` for everyone including
 * platform admins. An audit log that its own subjects can edit is decoration.
 *
 * ── 🔴 WHAT IS NOT HERE, AND WILL NOT BE ─────────────────────────────────────
 *
 * NOTHING THAT IDENTIFIES THE SPEAKER. No `subject`, no `speaker`, no
 * `onBehalf`, no `consent` — the same absence, for the same reason, as on
 * `documents` (see `collections/Documents.ts`). `reviewer` names a USER of this
 * platform, which is the person who made the decision; it says nothing about
 * whose words were in the testimony, and the system still never learns that.
 *
 * ⚠ The redacted text itself is NOT copied here either. It lives on the
 * `documents` row, which is already access-controlled; a second copy in a
 * collection with different access rules is a second thing to get wrong.
 */

import type { CollectionBeforeOperationHook, CollectionConfig } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { organizationIdsForUserWithPermission, PERMISSIONS } from '../lib/permissions'

/** What a reviewer decided. Two outcomes, no third. */
export const REVIEW_DECISIONS = ['approved', 'rejected'] as const

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

export const AnonymisationReviews: CollectionConfig = {
  slug: 'anonymisation-reviews',
  admin: {
    useAsTitle: 'decision',
    defaultColumns: ['decision', 'document', 'reviewer', 'createdAt'],
    group: 'Feedback',
    description:
      'Every human decision on a document the anonymisation gate held. Append-only.',
  },
  hooks: {
    /**
     * 🔴 `where[document.name]` / `sort=document.name` reach the gated
     * `documents.name` through the relationship, and the narrowing on
     * `documents` never sees them. Same for `document.uploadedBy` and
     * `document.session` (who recorded a testimonio). Same rule, applied at
     * this path.
     * Imported lazily: `Documents.ts` is a large module graph.
     */
    beforeOperation: [
      (async (hookArgs: Parameters<CollectionBeforeOperationHook>[0]) =>
        (await import('./Documents')).constrainGatedQueriesAt('document.')(
          hookArgs,
        )) as CollectionBeforeOperationHook,
    ],
  },
  access: {
    /**
     * ⚠ Read is gated on `holds:review` IN THE ECOSISTEMA THE ROW BELONGS TO,
     * not on membership alone. The log says which colleague released which
     * document, which is exactly the kind of thing that should be visible to the
     * people responsible for the corpus and to nobody else.
     *
     * ⚠ NO MEMBERSHIPS ⇒ `false`, never an empty `in` constraint — same rule and
     * same reasoning as `access/index.ts`.
     */
    read: async ({ req }) => {
      const user = req.user
      if (!user) return false
      // ⚠ DEACTIVATION IS THE REVOKE SWITCH, and it has to bite here like it does
      // everywhere else (`access/index.ts`, `lib/holdReview.ts`).
      // `membershipsForUser` filters inactive memberships and organizations but
      // NOT a deactivated user, so without this a switched-off Investigador with
      // a live session could still read the audit log — who released which
      // document, plus the reviewer's free-text note.
      if (!isActiveUser(user)) return false
      if (isPlatformAdminUser(user)) return true
      const ids = await organizationIdsForUserWithPermission(
        req.payload,
        user.id,
        PERMISSIONS.holdsReview,
      )
      if (ids.length === 0) return false
      return { organization: { in: ids } }
    },
    /**
     * 🔴 NOBODY CREATES ONE THROUGH THE API. The only writer is
     * `lib/holdReview.ts`, which runs elevated and writes the audit row and the
     * release in one place. A hand-written review row would be an audit entry
     * for a decision that never happened.
     */
    create: () => false,
    // 🔴 Append-only. An audit log its own subjects can rewrite is decoration.
    update: () => false,
    delete: () => false,
  },
  fields: [
    {
      name: 'document',
      type: 'relationship',
      relationTo: 'documents',
      required: true,
      index: true,
      admin: { description: 'The held document this decision was about.' },
    },
    {
      /**
       * ⚠ DENORMALIZED ON PURPOSE. Read access filters on it, and resolving the
       * tenant through the document relationship on every access check would put
       * a join inside the access rule — which is where they go wrong.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      /**
       * 🔴 WHO DECIDED. A user of this platform, never the person the testimony
       * came from — the system does not know that and this row does not change
       * it. See the file header.
       */
      name: 'reviewer',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
    },
    {
      name: 'decision',
      type: 'select',
      required: true,
      index: true,
      options: [
        { value: 'approved', label: 'APROBADO — liberado al corpus' },
        { value: 'rejected', label: 'RECHAZADO — nunca se ingiere' },
      ],
    },
    {
      /** Which stage refused, copied off the hold at decision time. */
      name: 'gateStage',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      /**
       * The hold's reason, copied. ⚠ Counts only — the gate never writes the
       * text that triggered it, and this is a verbatim copy of what it wrote.
       */
      name: 'gateReason',
      type: 'textarea',
      admin: { readOnly: true },
    },
    {
      /**
       * 🔴 A COPY OF THE REPORT THE HUMAN WAS LOOKING AT, not a pointer to the
       * document's current one. The row's report is overwritten by the next gate
       * run; an audit entry that resolved to "whatever it says today" would
       * record nothing at all.
       *
       * ⚠ Counts and rule names only, like every other copy of a `GateReport`.
       */
      name: 'gateReport',
      type: 'json',
      admin: { readOnly: true },
    },
    {
      /**
       * Whether the reviewer CHANGED the text before approving it.
       *
       * ⚠ A flag, not a diff. A diff of a redaction is a list of the strings
       * that were removed, which is the re-identification map this design
       * refuses to keep — filed under "just an audit detail".
       */
      name: 'textEdited',
      type: 'checkbox',
      defaultValue: false,
      admin: { readOnly: true },
    },
    {
      /**
       * The reviewer's own words about why.
       *
       * ⚠ FREE TEXT A HUMAN TYPES, AND THEREFORE THE ONE PLACE IN THIS FILE A
       * SPEAKER'S NAME COULD LAND. It is kept because a rejection with no reason
       * is useless to the next person, and it is treated exactly like
       * `ratings.comment`: the UI must say plainly that it is not private, and
       * the copy must tell the reviewer not to write names in it. There is no
       * way to enforce that in a schema — the honest move is to say so here and
       * on the screen rather than to pretend the field is safe.
       */
      name: 'note',
      type: 'textarea',
      maxLength: 1000,
      admin: {
        description:
          'Por qué. ⚠ No es privado: lo leen quienes revisan retenciones. No escribas nombres aquí.',
      },
    },
  ],
  timestamps: true,
}
