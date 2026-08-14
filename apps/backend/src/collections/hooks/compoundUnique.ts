/**
 * COMPOUND UNIQUENESS, BY HAND.
 *
 * Three collections here are keyed by a PAIR, not by one column:
 * `permissions` by (project, key), `roles` by (project, slug) and
 * `assignments` by (user, project). Payload 3 has `unique: true` per field and
 * nothing for a pair, so the constraint is enforced in a `beforeValidate` hook
 * that queries for a twin before the write goes through.
 *
 * ⚠ It is a check, not a lock. Two simultaneous creates of the same pair can
 * both pass it. That is acceptable for an internal catalog edited by a handful
 * of admins in the admin panel; if it ever stops being acceptable the real fix
 * is a partial unique index added in a migration, not a bigger hook.
 */

import type { CollectionBeforeValidateHook, CollectionSlug, Where } from 'payload'
import { ValidationError } from 'payload'

/**
 * A relationship value is an id at depth 0 and a populated document deeper in,
 * and the admin panel sends either. Reduce both to the id.
 */
export function toRelationId(value: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') return value === '' ? null : value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

/** Same, for a `hasMany` relationship. Drops anything unreadable. */
export function toRelationIds(value: unknown): (number | string)[] {
  if (!Array.isArray(value)) return []
  const ids: (number | string)[] = []
  for (const entry of value) {
    const id = toRelationId(entry)
    if (id !== null) ids.push(id)
  }
  return ids
}

/** Trimmed, lower-cased, or null when there is nothing left. */
export function normalizedSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

type CompoundUniqueArgs = {
  /** The collection being guarded. */
  collection: CollectionSlug
  /** The two (or more) fields that together must be unique. */
  fields: readonly string[]
  /** Which field the error is attached to in the admin panel. */
  errorPath: string
  /** Plain-language message shown to whoever is editing. */
  message: string
}

export const compoundUnique =
  ({ collection, fields, errorPath, message }: CompoundUniqueArgs): CollectionBeforeValidateHook =>
  async ({ data, operation, originalDoc, req }) => {
    // On update Payload sends only the fields that changed, so the pair being
    // checked has to be reassembled from the stored row plus the patch.
    const merged = { ...(originalDoc ?? {}), ...(data ?? {}) } as Record<string, unknown>

    const clauses: Where[] = []
    for (const field of fields) {
      const raw = merged[field]
      const value = typeof raw === 'string' ? raw : toRelationId(raw)
      // A missing half means the row is incomplete; let the field's own
      // `required` rule report that instead of reporting a phantom duplicate.
      if (value === null || value === undefined || value === '') return data
      clauses.push({ [field]: { equals: value } })
    }

    // Re-saving a row must not collide with itself.
    const selfId = (originalDoc as { id?: number | string } | undefined)?.id
    if (operation === 'update' && selfId !== undefined) {
      clauses.push({ id: { not_equals: selfId } })
    }

    const existing = await req.payload.find({
      collection,
      where: { and: clauses },
      limit: 1,
      depth: 0,
      // The twin may belong to a project this caller cannot read. The
      // constraint is about the data, not about who is looking.
      overrideAccess: true,
      // Same transaction as the write being validated.
      req,
    })

    if (existing.docs.length > 0) {
      throw new ValidationError({ collection, errors: [{ path: errorPath, message }], req })
    }

    return data
  }
