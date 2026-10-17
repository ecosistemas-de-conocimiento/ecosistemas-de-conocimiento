/**
 * 🔴 A PUBLISHED TESTIMONY'S ORIGINAL STAYS WITH ITS UPLOADER. Audit 2026-10-17.
 *
 * `visibleToCaller` shares a published row with every member of the ecosistema.
 * Before this, that included `extractedText` — the UNREDACTED testimony — and
 * `name`, the uploader's filename. These tests pin the field-level rule and the
 * query narrowing that keeps `where[name]` from becoming an oracle, plus the
 * gate reset on a transcript edit.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import {
  bindDocumentToEcosystem,
  constrainGatedNameQueries,
  gatedNameReadable,
  gatedOriginalReadable,
  gateResetForTextEdit,
  mayReadGatedOriginal,
  whereMentions,
} from './Documents'

const ANA = 1 // the Investigador who uploaded
const BEN = 2 // a colleague in the same ecosistema
const ana = { id: ANA, isActive: true }
const ben = { id: BEN, isActive: true }
const admin = { id: 99, isActive: true, isPlatformAdmin: true }

const testimonio = { contentKind: 'testimonio', uploadedBy: ANA }
const documento = { contentKind: 'documento', uploadedBy: ANA }

const fieldAccess = (
  fn: typeof gatedOriginalReadable,
  user: unknown,
  doc: Record<string, unknown> | undefined,
) => fn({ req: { user } as unknown as PayloadRequest, doc } as never)

describe('mayReadGatedOriginal', () => {
  it('🔴 a colleague cannot read the original of a testimonio', () => {
    expect(mayReadGatedOriginal(ben, testimonio)).toBe(false)
  })

  it('the uploader and a platform admin can', () => {
    expect(mayReadGatedOriginal(ana, testimonio)).toBe(true)
    expect(mayReadGatedOriginal(admin, testimonio)).toBe(true)
  })

  it('a documento is readable by anyone who can see the row', () => {
    expect(mayReadGatedOriginal(ben, documento)).toBe(true)
  })

  it('🔴 fails closed on a conversacion, an unknown kind, or a missing one', () => {
    expect(mayReadGatedOriginal(ben, { contentKind: 'conversacion', uploadedBy: ANA })).toBe(false)
    expect(mayReadGatedOriginal(ben, { contentKind: 'nope', uploadedBy: ANA })).toBe(false)
    expect(mayReadGatedOriginal(ben, { uploadedBy: ANA })).toBe(false)
  })

  it('accepts a populated uploader', () => {
    expect(mayReadGatedOriginal(ana, { contentKind: 'testimonio', uploadedBy: { id: ANA } })).toBe(true)
  })

  it('refuses an anonymous caller and a missing row', () => {
    expect(mayReadGatedOriginal(null, documento)).toBe(false)
    expect(mayReadGatedOriginal(ben, undefined)).toBe(false)
  })
})

describe('field access', () => {
  it('extractedText / bodyMarkdown: no row (a `where` path check) is refused', () => {
    expect(fieldAccess(gatedOriginalReadable, ben, undefined)).toBe(false)
  })

  it('name: a `where` / `sort` path check is allowed for a signed-in caller', () => {
    // `/biblioteca` and the @-mention picker search by title.
    expect(fieldAccess(gatedNameReadable, ben, undefined)).toBe(true)
    expect(fieldAccess(gatedNameReadable, null, undefined)).toBe(false)
  })

  it('🔴 name: hidden on a colleague\'s testimonio row', () => {
    expect(fieldAccess(gatedNameReadable, ben, testimonio)).toBe(false)
    expect(fieldAccess(gatedNameReadable, ana, testimonio)).toBe(true)
    expect(fieldAccess(gatedNameReadable, ben, documento)).toBe(true)
  })
})

describe('🔴 constrainGatedNameQueries — no title oracle', () => {
  const run = (user: unknown, where: unknown, extra: Record<string, unknown> = {}) =>
    constrainGatedNameQueries({
      args: { where, ...extra },
      operation: 'read',
      req: { user } as unknown as PayloadRequest,
    } as never) as { where?: unknown }

  it('narrows a name search to rows whose name the caller may read', () => {
    const where = { name: { like: 'María' } }
    expect(run(ben, where).where).toEqual({
      and: [
        where,
        { or: [{ contentKind: { equals: 'documento' } }, { uploadedBy: { equals: BEN } }] },
      ],
    })
  })

  it('finds `name` nested in and / or', () => {
    const where = { and: [{ organization: { equals: 3 } }, { or: [{ name: { contains: 'x' } }] }] }
    expect(whereMentions(where, 'name')).toBe(true)
    expect(run(ben, where).where).not.toBe(where)
  })

  it('leaves a query that never names `name` alone', () => {
    const where = { organization: { equals: 3 } }
    expect(run(ben, where).where).toBe(where)
  })

  it('leaves a platform admin and a local-API (overrideAccess) read alone', () => {
    const where = { name: { like: 'x' } }
    expect(run(admin, where).where).toBe(where)
    expect(run(ben, where, { overrideAccess: true }).where).toBe(where)
  })
})

// ── The transcript edit ──────────────────────────────────────────────────────

const storedTestimonio = (anonymisationStatus: string) => ({
  id: 5,
  organization: 10,
  uploadedBy: ANA,
  contentKind: 'testimonio',
  kind: 'audio',
  name: 'voz.m4a',
  publicationStatus: 'draft',
  extractedText: 'texto original',
  redactedText: 'texto [Persona A] aprobado',
  anonymisationStatus,
})

describe('🔴 gateResetForTextEdit — new text re-runs the gate', () => {
  it('an APPROVED testimonio with new text loses its approval and its redaction', () => {
    const original = storedTestimonio('approved')
    const next = { ...original, extractedText: 'texto corregido' }
    expect(gateResetForTextEdit(next, original)).toMatchObject({
      anonymisationStatus: 'n/a',
      redactedText: null,
      heldText: null,
      anonymisationSurvivors: null,
    })
  })

  it('a ready or held one too', () => {
    for (const status of ['ready', 'held']) {
      const original = storedTestimonio(status)
      expect(gateResetForTextEdit({ ...original, extractedText: 'nuevo' }, original)).not.toBeNull()
    }
  })

  it('🔴 a REJECTED one stays rejected — an edit is not a way round a reviewer', () => {
    const original = storedTestimonio('rejected')
    expect(gateResetForTextEdit({ ...original, extractedText: 'nuevo' }, original)).toBeNull()
  })

  it('unchanged text (a rename) changes nothing', () => {
    const original = storedTestimonio('approved')
    expect(gateResetForTextEdit({ ...original, name: 'otro' }, original)).toBeNull()
  })

  it('a documento is not gated', () => {
    const original = { ...storedTestimonio('n/a'), contentKind: 'documento' }
    expect(gateResetForTextEdit({ ...original, extractedText: 'nuevo' }, original)).toBeNull()
  })

  it('is applied by bindDocumentToEcosystem on a user PATCH', async () => {
    const original = storedTestimonio('approved')
    const out = (await bindDocumentToEcosystem({
      data: { ...original, extractedText: 'texto corregido' },
      originalDoc: original,
      operation: 'update',
      req: { user: ana } as unknown as PayloadRequest,
    } as never)) as Record<string, unknown>
    expect(out.anonymisationStatus).toBe('n/a')
    expect(out.redactedText).toBeNull()
    expect(out.extractedText).toBe('texto corregido')
  })

  it('is NOT applied to a server-side write (the extractor feeds the gate)', async () => {
    const original = storedTestimonio('approved')
    const out = (await bindDocumentToEcosystem({
      data: { ...original, extractedText: 'texto corregido' },
      originalDoc: original,
      operation: 'update',
      req: {} as unknown as PayloadRequest,
    } as never)) as Record<string, unknown>
    expect(out.anonymisationStatus).toBe('approved')
  })
})
