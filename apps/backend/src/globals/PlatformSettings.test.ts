/**
 * 🔴 A `detectorFallback` change is audited (audit 2026-11-10, P-04): one
 * `anonymisation-setting-changes` row, scope `plataforma`, in the update's
 * transaction. Fake payload; the real-Postgres path is pinned in
 * `lib/anonymisationControls.pg.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

import { auditDetectorFallback, PlatformSettings } from './PlatformSettings'

const run = async (before: unknown, after: unknown, create = vi.fn(async () => ({}))) => {
  const req = { payload: { create }, user: { id: 1 } }
  await auditDetectorFallback({
    doc: { detectorFallback: after },
    previousDoc: { detectorFallback: before },
    req,
  } as never)
  return { create, req }
}

describe('PlatformSettings — detectorFallback is audited', () => {
  it('is wired as an afterChange hook', () => {
    expect(PlatformSettings.hooks?.afterChange).toContain(auditDetectorFallback)
  })

  it.each([
    [null, 'hosted', null, true],
    ['hosted', 'none', true, false],
    ['none', null, false, null],
  ])('%s → %s writes one row (%s → %s), in the request', async (before, after, b, a) => {
    const { create, req } = await run(before, after)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'anonymisation-setting-changes',
        data: { organization: null, document: null, actor: 1, scope: 'plataforma', key: 'detectorFallback', before: b, after: a },
        req,
      }),
    )
  })

  it('no change → no row', async () => {
    const { create } = await run('none', 'none')
    expect(create).not.toHaveBeenCalled()
  })

  it('🔴 a failed audit write fails the save', async () => {
    await expect(run(null, 'hosted', vi.fn(async () => Promise.reject(new Error('db down'))))).rejects.toThrow('db down')
  })
})
