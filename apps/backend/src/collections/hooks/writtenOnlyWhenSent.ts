/**
 * 🔴 A WHOLE-ROW PAYLOAD UPDATE NEVER WRITES A GATE OR PUBLICATION COLUMN BACK
 * (audit 2026-11-11, second pass).
 *
 * Payload 3.88 fills every field the caller did not send with the value it
 * READ (`getFallbackValue` in `fields/hooks/beforeValidate/promise.js`), and
 * `@payloadcms/drizzle` writes every key that is not `undefined`. So an update
 * of `name` that read the row before a reviewer's reject (`rejectPublished`)
 * and wrote after it put the row back to `published` / `ready` with the
 * rejected `redactedText`, and the next publish shared it.
 * `Documents.gateColumnsStaleWrite.pg.test.ts`.
 *
 * The rule: on update, a column is written only when a server caller
 * (`overrideAccess`) SENT it in `data`, or a hook changed it from what was
 * read (`gateResetForTextEdit`). Otherwise it is dropped from the UPDATE and
 * the stored value stands. Every one of these columns is server-only
 * (`gateWritesOnly`, or pinned by `bindDocumentToEcosystem`), so a client's
 * value never counts as sent.
 *
 * ⚠ "Sent" is recorded in the field's `beforeValidate` hook, BEFORE Payload's
 * fallback fills it, keyed by row id in `req.context`. A hook that writes the
 * same value it read is indistinguishable from the fallback and is dropped:
 * a no-op either way, unless a concurrent write changed it in between.
 */

import type { FieldHook, Validate } from 'payload'

const SENT = '__gateColumnsSent'

type SentMap = Record<string, Set<string>>

const sentOf = (context: Record<string, unknown>): SentMap => {
  const existing = context[SENT] as SentMap | undefined
  if (existing) return existing
  const map: SentMap = {}
  context[SENT] = map
  return map
}

const rowKey = (doc: unknown): string | null => {
  const id = (doc as { id?: unknown } | null | undefined)?.id
  return id === undefined || id === null ? null : String(id)
}

/**
 * Hooks and a validator wrapper for one column. `validate` wraps the field's
 * own validator so a dropped (absent) value passes on update.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each field type has its own validator signature
export function writtenOnlyWhenSent<V extends (value: any, options: any) => ReturnType<Validate>>(field: string, validate: V) {
  const record: FieldHook = ({ operation, originalDoc, overrideAccess, req, siblingData }) => {
    if (operation !== 'update') return undefined
    const key = rowKey(originalDoc)
    if (key === null) return undefined
    const map = sentOf(req.context as Record<string, unknown>)
    const fields = (map[key] ??= new Set<string>())
    if (overrideAccess === true && (siblingData as Record<string, unknown>)[field] !== undefined) fields.add(field)
    else fields.delete(field)
    return undefined
  }
  const drop: FieldHook = ({ operation, originalDoc, previousValue, req, siblingData, value }) => {
    if (operation !== 'update') return undefined
    const key = rowKey(originalDoc)
    if (key === null) return undefined
    const sent = sentOf(req.context as Record<string, unknown>)[key]?.has(field) === true
    if (!sent && (value ?? null) === (previousValue ?? null)) delete (siblingData as Record<string, unknown>)[field]
    return undefined
  }
  const wrapped = ((value: unknown, args: { operation?: string }) => {
    if (args.operation === 'update' && value === undefined) return true
    return validate(value, args)
  }) as unknown as V
  return { hooks: { beforeValidate: [record], beforeChange: [drop] }, validate: wrapped }
}
