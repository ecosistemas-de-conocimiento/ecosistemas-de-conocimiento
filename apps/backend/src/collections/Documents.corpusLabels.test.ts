/**
 * 🔴 `documents.lengua` IS STORED AND SHOWN ONLY ON A `documento`.
 *
 * `lengua` is the language of the person a document is about — the corpus
 * manifest keeps it in the same row as `nombre`, `edad` and `rol`. On a source
 * document filed by its own author that restates what the text already says. On
 * an anonymous Voz it is a re-identification key: of the 34 `(tema, lengua)`
 * cells the 59 seeded testimonios fall into, 18 hold exactly one testimonio, so
 * a two-label filter points at ONE person more often than not. That is the
 * scenario `plan/adr-corpus-graph.md` §7.3 answers for the graph with
 * `GRAPH_MIN_SUPPORT`, and a plain column has no such threshold.
 *
 * The rule is enforced twice, as ADR §5.3 enforces the person rule twice: a
 * `beforeValidate` hook nulls the column, and field `read` access hides it.
 * Both are asserted here.
 *
 * ⚠ AND SO IS THE POSITIVE CASE, deliberately. ADR §16.2's lesson: a suite of
 * only negative assertions cannot tell "correctly suppressed" from "never
 * produced". If the field stopped being stored at all, every "not on a
 * testimonio" test below would still pass.
 */

import { describe, expect, it } from 'vitest'
import type { CollectionBeforeValidateHook, FieldAccess } from 'payload'

import { enforceLenguaDocumentoOnly, lenguaReadable } from './Documents'

type HookArgs = Parameters<CollectionBeforeValidateHook>[0]

function write(args: {
  data: Record<string, unknown>
  operation?: 'create' | 'update'
  originalDoc?: Record<string, unknown>
}): Record<string, unknown> {
  const result = enforceLenguaDocumentoOnly({
    data: args.data,
    operation: args.operation ?? 'create',
    originalDoc: args.originalDoc,
    req: {} as HookArgs['req'],
    collection: {} as HookArgs['collection'],
    context: {} as HookArgs['context'],
  } as HookArgs)
  return (result ?? {}) as Record<string, unknown>
}

function canRead(doc: Record<string, unknown>): boolean {
  return (lenguaReadable as FieldAccess)({
    doc,
    req: {},
  } as unknown as Parameters<FieldAccess>[0]) as boolean
}

describe('enforceLenguaDocumentoOnly — the write half', () => {
  it('✅ KEEPS the language on a documento (the thing the rule suppresses must exist)', () => {
    const next = write({ data: { contentKind: 'documento', lengua: 'mixteco' } })
    expect(next.lengua).toBe('mixteco')
  })

  it('nulls it on every kind that is not a documento', () => {
    for (const contentKind of ['testimonio', 'conversacion']) {
      const next = write({ data: { contentKind, lengua: 'mixteco' } })
      expect(next.lengua, contentKind).toBeNull()
    }
  })

  it('🔴 fails CLOSED on an unreadable content kind — not open', () => {
    for (const contentKind of [undefined, null, '', 'Documento', 'documentos', 42, {}]) {
      const next = write({ data: { contentKind, lengua: 'totonaco' } })
      expect(next.lengua, `contentKind=${JSON.stringify(contentKind)}`).toBeNull()
    }
  })

  it('leaves a write that never names the column completely alone', () => {
    // Blanking here would clear a correctly-stored value on every unrelated
    // PATCH — a rename would silently drop the label.
    const next = write({ data: { name: 'renamed' }, operation: 'update', originalDoc: { contentKind: 'documento' } })
    expect('lengua' in next).toBe(false)
  })

  it('🔴 on update it trusts the STORED kind, not the one in the body', () => {
    // Payload merges the request body over the stored row before
    // `beforeValidate`, so `data.contentKind` is whatever the caller typed.
    const next = write({
      data: { contentKind: 'documento', lengua: 'zapoteco' },
      operation: 'update',
      originalDoc: { contentKind: 'testimonio' },
    })
    expect(next.lengua).toBeNull()
  })

  it('falls back to the merged kind when no original row was handed to the hook', () => {
    const next = write({
      data: { contentKind: 'documento', lengua: 'mixe' },
      operation: 'update',
      originalDoc: undefined,
    })
    expect(next.lengua).toBe('mixe')
  })

  it('does not touch `tema`, which is allowed on every content kind', () => {
    // The theme is four values over 250 documents and is already printed in
    // Spanish in a seeded Voz's own title. It identifies nobody.
    const next = write({ data: { contentKind: 'testimonio', tema: 'dengue', lengua: 'mixteco' } })
    expect(next.tema).toBe('dengue')
    expect(next.lengua).toBeNull()
  })

  it('does not mutate the object it was handed', () => {
    const data = { contentKind: 'testimonio', lengua: 'mixteco' }
    write({ data })
    expect(data.lengua).toBe('mixteco')
  })
})

describe('lenguaReadable — the read half', () => {
  it('✅ shows it on a documento', () => {
    expect(canRead({ contentKind: 'documento', lengua: 'mixteco' })).toBe(true)
  })

  it('hides it on a testimonio and a conversacion', () => {
    // This gate is the only thing standing between the column and every
    // signed-in member's devtools: `apps/web/src/routes/api/documents/[id]`
    // relays the whole Payload row to the browser with no field selection.
    expect(canRead({ contentKind: 'testimonio', lengua: 'mixteco' })).toBe(false)
    expect(canRead({ contentKind: 'conversacion' })).toBe(false)
  })

  it('🔴 fails CLOSED on an unreadable content kind', () => {
    for (const contentKind of [undefined, null, '', 'Documento', 7]) {
      expect(canRead({ contentKind }), `contentKind=${JSON.stringify(contentKind)}`).toBe(false)
    }
    expect(canRead({})).toBe(false)
  })
})
