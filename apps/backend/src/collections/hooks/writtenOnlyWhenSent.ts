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
 * (`overrideAccess`) SENT it in `data`, a user SENT it and the field's update
 * access let it through (`userAccess`, only `ingestStatus` today), or a hook
 * changed it from what was read (`gateResetForTextEdit`). Otherwise it is
 * dropped from the UPDATE and the stored value stands. Without `userAccess` a
 * column is server-only (`gateWritesOnly`, or pinned by
 * `bindDocumentToEcosystem`), so a client's value never counts as sent.
 *
 * Also on `anonymise`, `contentKind`, the `keep*` switches, `publishIngestId`
 * and `ingestStatus` (audit 2026-11-12): a rename that read the row before a
 * re-gate (`regateMemberDocumentos`, `autoPublishBackfill`, the
 * `…/anonimizacion` PATCH) put back `anonymise = false` or
 * `contentKind = 'documento'`, and the next publish sent the original.
 * `Documents.switchColumnsStaleWrite.pg.test.ts`.
 *
 * Also on `testimonioTitle`, `anonymisationReport`, `anonymisationSurvivors` and
 * `ingestId` (audit 2026-11-12, P1-P3): a rename racing an approval put back
 * the title made from the cleared `heldText`, which every member then read on
 * the published row; one racing the gate's final write put back a report made
 * under `keepDocumentAuthor`, whose `redactedTitle` the next publish sent with
 * the author's name. `Documents.titleColumnsStaleWrite.pg.test.ts`.
 *
 * Also on the keep logs `authorsKept`, `citedAuthorsKept` and
 * `publicFiguresKept` (audit 2026-11-12, K3): a rename racing the gate's final
 * write under `keepDocumentAuthor` put back `authorsKept = NULL`, so turning
 * the switch off only refreshed the report (`regatePlan`) and the author's
 * name stayed in `redactedText` for the next publish. Same test file.
 *
 * ⚠ Compared DEEPLY (`isDeepStrictEqual` over a JSON round trip): a `json`
 * column's fallback is a parsed object, never `===` to what was read.
 *
 * ⚠ "Sent" is recorded in the field's `beforeValidate` hook, BEFORE Payload's
 * fallback fills it, keyed by row id in `req.context`. A hook that writes the
 * same value it read is indistinguishable from the fallback and is dropped:
 * a no-op either way, unless a concurrent write changed it in between.
 */

import { isDeepStrictEqual } from 'node:util'

import type { FieldAccess, FieldHook, Validate } from 'payload'

const SENT = '__gateColumnsSent'

type SentMap = Record<string, Set<string>>

const sentOf = (context: Record<string, unknown>): SentMap => {
  const existing = context[SENT] as SentMap | undefined
  if (existing) return existing
  const map: SentMap = {}
  context[SENT] = map
  return map
}

/** Null for absent; an object or array as plain JSON, so a clone equals its source. */
const normalised = (value: unknown): unknown =>
  value === undefined || value === null ? null : typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value

const rowKey = (doc: unknown): string | null => {
  const id = (doc as { id?: unknown } | null | undefined)?.id
  return id === undefined || id === null ? null : String(id)
}

/**
 * Hooks and a validator wrapper for one column. `validate` wraps the field's
 * own validator so a dropped (absent) value passes on update. With
 * `userAccess` (the field's update access), the result also carries
 * `access.update`: the same rule, and a user's value it lets through counts as
 * sent. Payload runs field access after the `beforeValidate` hooks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each field type has its own validator signature
export function writtenOnlyWhenSent<V extends (value: any, options: any) => ReturnType<Validate>>(
  field: string,
  validate: V,
  userAccess?: FieldAccess,
) {
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
    if (!sent && isDeepStrictEqual(normalised(value), normalised(previousValue))) delete (siblingData as Record<string, unknown>)[field]
    return undefined
  }
  const wrapped = ((value: unknown, args: { operation?: string }) => {
    if (args.operation === 'update' && value === undefined) return true
    return validate(value, args)
  }) as unknown as V
  const hooks = { beforeValidate: [record], beforeChange: [drop] }
  if (!userAccess) return { hooks, validate: wrapped }
  const update: FieldAccess = async (args) => {
    const allowed = await userAccess(args)
    const key = rowKey(args.doc)
    if (allowed && key !== null && (args.siblingData as Record<string, unknown> | undefined)?.[field] !== undefined)
      (sentOf(args.req.context as Record<string, unknown>)[key] ??= new Set<string>()).add(field)
    return allowed
  }
  return { hooks, validate: wrapped, access: { update } }
}
