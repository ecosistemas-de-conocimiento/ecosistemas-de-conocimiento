/**
 * 🔴 NO COLLECTION HERE CAN BE DUPLICATED, BY ANY ROUTE.
 *
 * Payload's built-in duplicate (`POST /api/<slug>/:id/duplicate`, the local
 * `payload.duplicate`, `payload.create({ duplicateFromID })`) is a `create`
 * whose omitted fields are filled FROM THE SOURCE ROW, read with field read
 * access skipped. So a member who can read a published testimonio — but not
 * its unredacted `extractedText` — could duplicate it with
 * `{ contentKind: 'documento' }` and own a fresh, ungated row holding the
 * original text (measured by an auditor on real Postgres, 2026-10-23).
 *
 * ⚠ `disableDuplicate: true` ALONE DOES NOT CLOSE IT in Payload 3.88. Only the
 * local `payload.duplicate()` and the GraphQL schema read that flag; the REST
 * handler (`payload/dist/collections/endpoints/duplicate.js`) calls
 * `duplicateOperation` without checking it, and `payload.create` accepts
 * `duplicateFromID` directly. Every one of those reaches `createOperation`
 * with `duplicateFromID` set, BEFORE it reads the source row — that is where
 * {@link refuseDuplicate} stops it. The flag stays too: it hides the admin
 * panel's Duplicate button and drops the GraphQL mutation.
 *
 * Nothing in this app duplicates rows (no caller in `apps/web` or the
 * backend), so every collection gets both. Applied centrally in
 * `payload.config.ts` via {@link withoutDuplicate}, so a new collection cannot
 * forget it; `refuseDuplicate.pg.test.ts` asserts every collection carries it.
 */

import type { CollectionBeforeOperationHook, CollectionConfig } from 'payload'
import { APIError } from 'payload'

export const refuseDuplicate: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'create') return
  const from = (args as { duplicateFromID?: unknown }).duplicateFromID
  if (from !== undefined && from !== null && from !== '') {
    throw new APIError('Duplicating is not allowed.', 405)
  }
}

/** `disableDuplicate` plus {@link refuseDuplicate}, run FIRST in `beforeOperation`. */
export function withoutDuplicate(collection: CollectionConfig): CollectionConfig {
  return {
    ...collection,
    disableDuplicate: true,
    hooks: {
      ...collection.hooks,
      beforeOperation: [refuseDuplicate, ...(collection.hooks?.beforeOperation ?? [])],
    },
  }
}
