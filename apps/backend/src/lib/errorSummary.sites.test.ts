/**
 * P-07 at the call sites (audit 2026-11-10): each of these logs an error from
 * a write that carries document text. The error thrown is drizzle's real
 * `DrizzleQueryError` with the text in its params; no log argument may
 * contain it.
 */
import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
vi.mock('./documentColumns', () => import('./documentColumns.testFake'))

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'
const dbError = () =>
  new DrizzleQueryError('update "documents" set "extracted_text" = $1 where "id" = $2', [SECRET, 42], Object.assign(new Error('terminating connection'), { code: '57P01' }))

const throwing = { current: (): never => { throw dbError() } }

vi.mock('payload', async (orig) => ({
  ...(await orig<typeof import('payload')>()),
  getPayload: async () => throwing.current(),
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/collections/Documents', () => ({
  enqueueIngestForDoc: async () => throwing.current(),
  scheduleGraphExtractionForDoc: async () => undefined,
}))

/** Everything every console/logger spy was called with, as one string. */
function logged(...spies: { mock: { calls: unknown[][] } }[]): string {
  return spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' '))
    .join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('P-07 log sites', () => {
  it('🔴 studentNotes.onGraphSettled: a failed promotion logs no row text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { onGraphSettled } = await import('./studentNotes')
    await onGraphSettled(7)
    expect(error).toHaveBeenCalled()
    expect(logged(error)).toContain('DrizzleQueryError(57P01)')
    expect(logged(error)).not.toContain('Lucía')
  })

  it('🔴 driveTranscribedSoon: a failed immediate drive logs no row text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { driveTranscribedSoon, _drainTranscribedDrives } = await import('./driveTranscribedSoon')
    const payload = { findByID: async () => throwing.current(), update: async () => ({}) }
    driveTranscribedSoon(payload as never, 9)
    await new Promise((r) => setImmediate(r))
    await _drainTranscribedDrives()
    expect(error).toHaveBeenCalled()
    expect(logged(error)).not.toContain('Lucía')
  })

  it('🔴 ingestRecovery.driveTranscribedDocument: a throwing gate+ingest logs no row text', async () => {
    const { driveTranscribedDocument } = await import('./ingestRecovery')
    const warn = vi.fn()
    const payload = { update: async () => ({}) }
    await driveTranscribedDocument(
      payload as never,
      { id: 3, organization: 1, uploadedBy: 2, extractedText: SECRET, contentKind: 'testimonio' } as never,
      { log: { warn, info: vi.fn(), error: vi.fn() } as never },
    )
    expect(warn).toHaveBeenCalled()
    expect(logged(warn)).toContain('DrizzleQueryError')
    expect(logged(warn)).not.toContain('Lucía')
  })

  it('🔴 janitorScheduler: a sweep that throws a database error logs no row text', async () => {
    vi.useFakeTimers()
    const { startJanitor, stopJanitor } = await import('./janitorScheduler')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    startJanitor({ logger } as never, {
      prefix: 'p07-test',
      enabledVar: 'X',
      enabled: () => true,
      intervalMs: () => 60_000,
      disabledDetail: '',
      sweep: async () => throwing.current(),
    })
    await vi.advanceTimersByTimeAsync(60_000)
    stopJanitor('p07-test')
    expect(logger.error).toHaveBeenCalled()
    expect(logged(logger.error)).toContain('DrizzleQueryError(57P01)')
    expect(logged(logger.error)).not.toContain('Lucía')
  })
})
