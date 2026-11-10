import { describe, expect, it, vi } from 'vitest'

import { NOT_CONSENT_HELD } from './consentHold'
import { BACKFILL_WHERE, backfillLengua, type BackfillCandidate, type LenguaIngester } from './backfillLengua'

function fakePayload(docs: BackfillCandidate[]) {
  return { find: vi.fn(async (_args: unknown) => ({ docs })) }
}

function fakeClients() {
  const calls: Array<{ org: string; req: Parameters<LenguaIngester['ingest']['enqueue']>[0] }> = []
  const clientFor = (org: number | string): LenguaIngester => ({
    ingest: {
      enqueue: async (req) => {
        calls.push({ org: String(org), req })
        return { ingestId: `ing-${calls.length}` }
      },
    },
  })
  return { calls, clientFor }
}

const DOC: BackfillCandidate = {
  id: 11,
  name: 'Informe de partería',
  kind: 'pdf',
  contentKind: 'documento',
  anonymise: false,
  extractedText: 'Las parteras acompañan los nacimientos.',
  lengua: ' mixe ',
  organization: 1,
}

describe('backfillLengua (C-3)', () => {
  it('🔴 DRY RUN BY DEFAULT: enqueues nothing, reports the plan and its size', async () => {
    const { calls, clientFor } = fakeClients()
    const report = await backfillLengua(fakePayload([DOC]) as never, clientFor)
    expect(calls).toHaveLength(0)
    expect(report).toMatchObject({ apply: false, candidates: 1, planned: 1, enqueued: 0, lastId: '11' })
    expect(report.chars).toBe(DOC.extractedText!.length)
  })

  it('asks only for published documentos with a lengua, by id, for one ecosistema when given', async () => {
    const payload = fakePayload([])
    await backfillLengua(payload as never, fakeClients().clientFor, { organizationId: 3, afterId: 40 })
    const args = payload.find.mock.calls[0]![0] as unknown as { where: { and: unknown[] }; sort: string }
    expect(args.where.and).toEqual([
      ...BACKFILL_WHERE,
      NOT_CONSENT_HELD,
      { organization: { equals: 3 } },
      { id: { greater_than: 40 } },
    ])
    expect(args.sort).toBe('id')
  })

  it('with apply: re-ingests into the PUBLISHED corpus under the same id, lengua in metadata', async () => {
    const { calls, clientFor } = fakeClients()
    const sleep = vi.fn(async () => {})
    const report = await backfillLengua(fakePayload([DOC, { ...DOC, id: 12 }]) as never, clientFor, {
      apply: true,
      delayMs: 500,
      sleep,
    })
    expect(report.enqueued).toBe(2)
    expect(calls[0]!.org).toBe('1')
    expect(calls[0]!.req.corpus).toBe('eco-1')
    expect(calls[0]!.req.documents[0]).toMatchObject({
      id: '11',
      title: 'Informe de partería',
      metadata: expect.objectContaining({ docId: '11', lengua: 'mixe', publication: 'published' }),
    })
    // No callback: the row is already published and ready.
    expect(calls[0]!.req).not.toHaveProperty('callbackUrl')
    // Paced: one pause between two enqueues.
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(500)
  })

  it('🔴 a row held for consent: excluded by the query, and skipped per row when a payload ignores it', async () => {
    const { calls, clientFor } = fakeClients()
    const payload = fakePayload([{ ...DOC, consentHeld: true }, { ...DOC, id: 12, consentHeld: false }])
    const report = await backfillLengua(payload as never, clientFor, { apply: true, delayMs: 0 })
    expect((payload.find.mock.calls[0]![0] as { where: { and: unknown[] } }).where.and).toContainEqual(NOT_CONSENT_HELD)
    expect(calls.map((c) => c.req.documents[0]!.id)).toEqual(['12'])
    expect(report).toMatchObject({ enqueued: 1, skipped: 1, skippedIds: ['11'] })
  })

  it('skips a gated or text-less row instead of publishing the original', async () => {
    const { calls, clientFor } = fakeClients()
    const report = await backfillLengua(
      fakePayload([
        { ...DOC, id: 20, contentKind: 'testimonio', redactedText: null, anonymisationStatus: 'held' },
        { ...DOC, id: 21, extractedText: '' },
        { ...DOC, id: 22, lengua: '' },
      ]) as never,
      clientFor,
      { apply: true, delayMs: 0 },
    )
    expect(calls).toHaveLength(0)
    expect(report.skippedIds).toEqual(['20', '21', '22'])
  })

  it('🔴 P-13 (review R4-04): a gated documento re-ingests under its gated title, never its name', async () => {
    const { calls, clientFor } = fakeClients()
    const gated = {
      ...DOC,
      anonymise: true,
      anonymisationStatus: 'ready',
      redactedText: 'Las parteras acompañan los nacimientos.',
    }
    await backfillLengua(
      fakePayload([
        { ...gated, id: 30, name: 'Entrevista a Juan Pérez.pdf', anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' } },
        { ...gated, id: 31, name: 'Notas de Juan Pérez.pdf' },
      ]) as never,
      clientFor,
      { apply: true, delayMs: 0 },
    )
    const sent = calls.map((c) => [c.req.documents[0]!.title, (c.req.documents[0]!.metadata as { title?: unknown }).title])
    expect(sent).toEqual([
      ['Entrevista a [Persona A].pdf', 'Entrevista a [Persona A].pdf'],
      ['Documento', 'Documento'],
    ])
    expect(JSON.stringify(calls)).not.toContain('Pérez')
  })

  it('an enqueue error is counted and the run goes on', async () => {
    let n = 0
    const clientFor = (): LenguaIngester => ({
      ingest: {
        enqueue: async () => {
          n += 1
          if (n === 1) throw Object.assign(new Error('rate'), { status: 429 })
          return { ingestId: 'ok' }
        },
      },
    })
    const report = await backfillLengua(fakePayload([DOC, { ...DOC, id: 12 }]) as never, clientFor, {
      apply: true,
      delayMs: 0,
    })
    expect(report).toMatchObject({ errors: 1, enqueued: 1, errorIds: ['11'] })
  })
})
