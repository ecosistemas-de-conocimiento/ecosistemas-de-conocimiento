/**
 * The gate schedules a held testimonio's title from its REDACTED held output,
 * with what verify flagged forbidden (owner ruling 2026-10-24).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const schedule = vi.fn((_args: Record<string, unknown>) => true)
vi.mock('./testimonioTitle', () => ({
  scheduleTestimonioTitle: (args: Record<string, unknown>) => schedule(args),
}))

import { staticDetector } from './anonymise'
import { anonymiseDocumentText } from './anonymiseDocument'

const fakePayload = { update: async () => ({}) }

const missesThenFinds = () =>
  staticDetector((text) =>
    text.includes('[Persona ')
      ? [{ text: 'Beltrán', type: 'persona' as const }]
      : [{ text: 'Ana', type: 'persona' as const }],
  )

const RAW = 'Ana habló con Ana Beltrán en la asamblea.'

const gate = (contentKind: string, organizationId?: number) =>
  anonymiseDocumentText({
    payload: fakePayload as never,
    docId: 5,
    contentKind,
    text: RAW,
    detector: missesThenFinds(),
    ...(organizationId !== undefined ? { organizationId } : {}),
  })

describe('held testimonio title', () => {
  it('🔴 schedules from heldText (never the raw text), survivors forbidden', async () => {
    schedule.mockClear()
    const out = await gate('testimonio', 3)
    expect(out.ok).toBe(false)
    expect(schedule).toHaveBeenCalledTimes(1)
    const args = schedule.mock.calls[0]![0] as { redactedText: string; source: string; forbidden: string[] }
    expect(args.source).toBe('held')
    expect(args.redactedText).not.toBe(RAW)
    expect(args.redactedText).toContain('[Persona A]')
    expect(args.forbidden).toContain('Beltrán')
  })

  it('schedules nothing for a held conversación', async () => {
    schedule.mockClear()
    await gate('conversacion', 3)
    expect(schedule).not.toHaveBeenCalled()
  })
})
