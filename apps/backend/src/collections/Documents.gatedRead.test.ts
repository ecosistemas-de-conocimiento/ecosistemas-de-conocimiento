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

import { AnonymisationReviews } from './AnonymisationReviews'
import {
  bindDocumentToEcosystem,
  constrainGatedQueries,
  constrainGatedQueriesAt,
  Documents,
  storageErrorReason,
  gatedQueryableReadable,
  gatedOriginalReadable,
  gateResetForTextEdit,
  mayReadGatedOriginal,
  mayReadTestimonioTitle,
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

describe('mayReadTestimonioTitle — the generated title follows the text it was made from', () => {
  it('a colleague reads it on a cleared row (made from redactedText)', () => {
    expect(mayReadTestimonioTitle(ben, { ...testimonio, anonymisationStatus: 'ready' })).toBe(true)
    expect(mayReadTestimonioTitle(ben, { ...testimonio, anonymisationStatus: 'approved' })).toBe(true)
  })

  it('🔴 NOT on a held row (made from heldText): uploader and platform admin only', () => {
    expect(mayReadTestimonioTitle(ben, { ...testimonio, anonymisationStatus: 'held' })).toBe(false)
    expect(mayReadTestimonioTitle(ana, { ...testimonio, anonymisationStatus: 'held' })).toBe(true)
    expect(mayReadTestimonioTitle(admin, { ...testimonio, anonymisationStatus: 'held' })).toBe(true)
  })

  it('🔴 fails closed when the status is missing from the projected row', () => {
    expect(mayReadTestimonioTitle(ben, testimonio)).toBe(false)
  })
})

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

  it('name: the no-row path check passes for a signed-in caller — the HOOK does the work', () => {
    // `/biblioteca` and the @-mention picker search by title, so the path check
    // cannot refuse. It also cannot tell a `where` from a `sort`. Both are made
    // safe by `constrainGatedQueries`: a where is narrowed, and a sort is
    // stripped unless the query is narrowed (see the sort cases below).
    expect(fieldAccess(gatedQueryableReadable, ben, undefined)).toBe(true)
    expect(fieldAccess(gatedQueryableReadable, null, undefined)).toBe(false)
  })

  it('🔴 name: hidden on a colleague\'s testimonio row', () => {
    expect(fieldAccess(gatedQueryableReadable, ben, testimonio)).toBe(false)
    expect(fieldAccess(gatedQueryableReadable, ana, testimonio)).toBe(true)
    expect(fieldAccess(gatedQueryableReadable, ben, documento)).toBe(true)
  })

  /** Owner rulings 2026-10-26: a gated documento shares its text redacted only. */
  it('🔴 a documento filed for anonymisation: original hidden from colleagues, title kept', () => {
    const gated = { ...documento, anonymise: true }
    expect(fieldAccess(gatedOriginalReadable, ben, gated)).toBe(false)
    expect(fieldAccess(gatedOriginalReadable, ana, gated)).toBe(true)
    expect(fieldAccess(gatedOriginalReadable, admin, gated)).toBe(true)
    expect(fieldAccess(gatedQueryableReadable, ben, gated)).toBe(true)
    expect(fieldAccess(gatedOriginalReadable, ben, { ...documento, anonymise: false })).toBe(true)
  })

  it('🔴 `anonymise` is force-selected, so a projected row still carries it', () => {
    expect(Documents.forceSelect).toMatchObject({ anonymise: true })
  })

  it('🔴 new text on a gated documento re-runs the gate', () => {
    const original = {
      contentKind: 'documento',
      anonymise: true,
      extractedText: 'viejo',
      anonymisationStatus: 'ready',
      redactedText: 'viejo',
    }
    expect(gateResetForTextEdit({ extractedText: 'nuevo' }, original)).toMatchObject({
      anonymisationStatus: 'n/a',
      redactedText: null,
    })
    expect(gateResetForTextEdit({ extractedText: 'nuevo' }, { ...original, anonymise: false })).toBeNull()
  })
})

describe('🔴 constrainGatedQueries — no title oracle', () => {
  const run = (user: unknown, where: unknown, extra: Record<string, unknown> = {}) =>
    constrainGatedQueries({
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

  // L1: Payload lowercases the combinator keys, so `OR` / `And` are real
  // combinators that a case-sensitive check walked straight past.
  it.each([
    ['OR', { OR: [{ name: { like: 'Mar' } }] }],
    ['And', { And: [{ organization: { equals: 3 } }, { name: { like: 'Mar' } }] }],
    ['nested mixed case', { and: [{ oR: [{ AND: [{ name: { like: 'Mar' } }] }] }] }],
  ])('🔴 finds `name` under %s and narrows it', (_label, where) => {
    expect(whereMentions(where, 'name')).toBe(true)
    expect(run(ben, where).where).toEqual({
      and: [
        where,
        { or: [{ contentKind: { equals: 'documento' } }, { uploadedBy: { equals: BEN } }] },
      ],
    })
  })

  it('🔴 narrows a COUNT too — `/api/documents/count` is the cheapest oracle', () => {
    const where = { OR: [{ name: { like: 'Mar' } }] }
    const out = constrainGatedQueries({
      args: { where },
      operation: 'count',
      req: { user: ben } as unknown as PayloadRequest,
    } as never) as { where?: unknown }
    expect(out.where).not.toBe(where)
  })
})

describe('🔴 constrainGatedQueries — no sort oracle (L2)', () => {
  const run = (user: unknown, args: Record<string, unknown>) =>
    constrainGatedQueries({
      args,
      operation: 'read',
      req: { user } as unknown as PayloadRequest,
    } as never) as { where?: unknown; sort?: unknown }

  it.each([
    ['name', undefined],
    ['-name', undefined],
    ['-createdAt,name', '-createdAt'],
    [['name', 'createdAt'], ['createdAt']],
  ])('strips a sort on name (%j) for a colleague', (sort, expected) => {
    expect(run(ben, { sort, where: { organization: { equals: 3 } } }).sort).toEqual(expected)
  })

  it('keeps it when the query is already narrowed to rows the caller may read', () => {
    expect(run(ben, { sort: 'name', where: { uploadedBy: { equals: BEN } } }).sort).toBe('name')
    expect(
      run(ben, { sort: '-name', where: { and: [{ contentKind: { equals: 'documento' } }] } }).sort,
    ).toBe('-name')
    // A `where` on name is narrowed by the hook itself, so its sort is safe too.
    expect(run(ben, { sort: 'name', where: { name: { like: 'a' } } }).sort).toBe('name')
  })

  it('keeps it for a platform admin, and leaves other sorts alone', () => {
    expect(run(admin, { sort: 'name' }).sort).toBe('name')
    expect(run(ben, { sort: '-createdAt' }).sort).toBe('-createdAt')
  })
})

describe('🔴 the same rule on a relationship path from another collection (L3)', () => {
  const run = (where: unknown, sort?: unknown) =>
    constrainGatedQueriesAt('document.')({
      args: { where, sort },
      operation: 'read',
      req: { user: ben } as unknown as PayloadRequest,
    } as never) as { where?: unknown; sort?: unknown }

  it('narrows `document.name` to documents whose name the caller may read', () => {
    const where = { 'document.name': { like: 'Mar' } }
    expect(run(where).where).toEqual({
      and: [
        where,
        {
          or: [
            { 'document.contentKind': { equals: 'documento' } },
            { 'document.uploadedBy': { equals: BEN } },
          ],
        },
      ],
    })
  })

  it('strips a sort on `document.name`', () => {
    expect(run({ decision: { equals: 'release' } }, '-document.name').sort).toBeUndefined()
  })

  it('is wired on anonymisation-reviews', async () => {
    expect(AnonymisationReviews.hooks?.beforeOperation?.length ?? 0).toBeGreaterThan(0)
    const out = (await AnonymisationReviews.hooks!.beforeOperation![0]!({
      args: { where: { 'document.name': { like: 'Mar' } } },
      operation: 'read',
      req: { user: ben } as unknown as PayloadRequest,
    } as never)) as { where?: unknown }
    expect(JSON.stringify(out.where)).toContain('document.uploadedBy')
  })
})

describe('🔴 who recorded a testimonio stays with the uploader', () => {
  // `uploadedBy` names the investigador who recorded it and `session` links
  // their conversation. The biblioteca hides the contributor on gated rows; the
  // raw API has to as well, by row AND by query.
  const run = (user: unknown, args: Record<string, unknown>, operation = 'read') =>
    constrainGatedQueries({
      args,
      operation,
      req: { user } as unknown as PayloadRequest,
    } as never) as { where?: unknown; sort?: unknown }
  const readableToBen = {
    or: [{ contentKind: { equals: 'documento' } }, { uploadedBy: { equals: BEN } }],
  }

  it('uploadedBy / session: hidden on a colleague\'s testimonio row, shown on a documento', () => {
    expect(fieldAccess(gatedQueryableReadable, ben, testimonio)).toBe(false)
    expect(fieldAccess(gatedQueryableReadable, ana, testimonio)).toBe(true)
    expect(fieldAccess(gatedQueryableReadable, admin, testimonio)).toBe(true)
    expect(fieldAccess(gatedQueryableReadable, ben, documento)).toBe(true)
  })

  it.each([
    ['uploadedBy equals', { uploadedBy: { equals: ANA } }],
    ['uploadedBy in', { uploadedBy: { in: [ANA] } }],
    ['uploadedBy.email', { 'uploadedBy.email': { like: 'ana@' } }],
    ['session equals', { session: { equals: 7 } }],
    ['session.user', { 'session.user': { equals: ANA } }],
    ['OR', { OR: [{ uploadedBy: { equals: ANA } }] }],
    ['nested And', { and: [{ organization: { equals: 3 } }, { And: [{ session: { exists: true } }] }] }],
  ])('🔴 narrows a where on %s to rows the caller may read', (_label, where) => {
    expect(run(ben, { where }).where).toEqual({ and: [where, readableToBen] })
    expect(run(ben, { where }, 'count').where).toEqual({ and: [where, readableToBen] })
  })

  it('leaves "Mis documentos" (uploadedBy = me) and a platform admin alone', () => {
    const mine = { uploadedBy: { equals: BEN } }
    expect(run(ben, { where: mine }).where).toBe(mine)
    const theirs = { uploadedBy: { equals: ANA } }
    expect(run(admin, { where: theirs }).where).toBe(theirs)
    expect(run(ben, { where: theirs, overrideAccess: true }).where).toBe(theirs)
  })

  it.each([
    ['uploadedBy', undefined],
    ['-session', undefined],
    ['-createdAt,uploadedBy.email', '-createdAt'],
  ])('🔴 strips a sort on %j for a colleague', (sort, expected) => {
    expect(run(ben, { sort, where: { organization: { equals: 3 } } }).sort).toEqual(expected)
  })

  it('on anonymisation-reviews, `document.uploadedBy` is narrowed too', async () => {
    const where = { 'document.uploadedBy': { equals: ANA } }
    const out = (await AnonymisationReviews.hooks!.beforeOperation![0]!({
      args: { where },
      operation: 'read',
      req: { user: ben } as unknown as PayloadRequest,
    } as never)) as { where?: unknown }
    expect(out.where).toEqual({
      and: [
        where,
        {
          or: [
            { 'document.contentKind': { equals: 'documento' } },
            { 'document.uploadedBy': { equals: BEN } },
          ],
        },
      ],
    })
  })
})

describe('🔴 the collection config actually wires the gate', () => {
  // Measured: deleting every `access.read: gated*` line and the hook
  // registration used to keep this file green. These fail if that happens.
  const field = (name: string) =>
    (Documents.fields as Array<{ name?: string; access?: { read?: unknown } }>).find(
      (f) => f.name === name,
    )

  it.each([
    'extractedText',
    'bodyMarkdown',
    'heldText',
    'anonymisationSurvivors',
    'audioMeta',
    // L5: the model's raw reply can ride in here.
    'graphError',
  ])('%s reads through gatedOriginalReadable', (name) => {
    expect(field(name)?.access?.read).toBe(gatedOriginalReadable)
  })

  it.each(['name', 'uploadedBy', 'session'])('%s reads through gatedQueryableReadable', (name) => {
    expect(field(name)?.access?.read).toBe(gatedQueryableReadable)
  })

  it('constrainGatedQueries runs before every operation', () => {
    expect(Documents.hooks?.beforeOperation).toContain(constrainGatedQueries)
  })
})

describe('🔴 a storage error never carries the filename into ingestError (L6)', () => {
  it('scrubs the filename, the key and any absolute path', () => {
    const msg = storageErrorReason(
      Object.assign(
        new Error(
          "ENOENT: no such file or directory, open '/app/media/Testimonio de Zelmira.pdf'",
        ),
        { code: 'ENOENT' },
      ),
      7,
      'Testimonio de Zelmira.pdf',
      'eco_1/u_2/Testimonio de Zelmira.pdf',
    )
    expect(msg).not.toContain('Zelmira')
    expect(msg).not.toContain('/app/media')
    expect(msg).toContain('ENOENT')
    expect(msg).toContain('media 7')
  })

  it('also when the message quotes only the storage key', () => {
    const msg = storageErrorReason(
      new Error('object edc/eco_1/u_2/Testimonio de Zelmira.pdf returned no body'),
      7,
      'Testimonio de Zelmira.pdf',
      'eco_1/u_2/Testimonio de Zelmira.pdf',
    )
    expect(msg).not.toContain('Zelmira')
    expect(msg).not.toContain('eco_1')
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
