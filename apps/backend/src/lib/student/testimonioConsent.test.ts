/**
 * 🔴 The consent wording (web) and its version (web + backend) move together
 * (owner ruling Q20: a consent covers only the wording shown).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isCurrentTestimonioConsent, TESTIMONIO_CONSENT_VERSION } from './testimonioConsent'

const webConsent = readFileSync(join(__dirname, '../../../../web/src/lib/consent.ts'), 'utf8')

/** sha256 of each version's exact wording. A new wording is a new row here. */
const WORDING_SHA256: Record<number, string> = {
  2: createHash('sha256')
    .update(
      'Compartir mi actividad con el equipo del ecosistema. El equipo del ecosistema (docentes, investigadores y responsables) y la administración de la plataforma también verán mis testimonios publicados, solo en versión anonimizada.',
    )
    .digest('hex'),
}

describe('testimonio consent version', () => {
  it('the web page and the backend name the same version', () => {
    const m = webConsent.match(/export const TESTIMONIO_CONSENT_VERSION = (\d+)/)
    expect(Number(m?.[1])).toBe(TESTIMONIO_CONSENT_VERSION)
  })

  it('🔴 the wording the page shows is the one this version was approved with (change it → bump the version)', () => {
    const m = webConsent.match(/export const CONSENT_ACTIVITY_WITH_TESTIMONIOS =\s*'([^']+)'/)
    expect(m).not.toBeNull()
    expect(createHash('sha256').update(m![1]!).digest('hex')).toBe(WORDING_SHA256[TESTIMONIO_CONSENT_VERSION])
  })

  it.each([
    [{ shareTestimoniosAt: '2026-10-28T00:00:00.000Z', shareTestimoniosVersion: TESTIMONIO_CONSENT_VERSION }, true],
    [{ shareTestimoniosAt: '2026-10-28T00:00:00.000Z', shareTestimoniosVersion: null }, false],
    [{ shareTestimoniosAt: '2026-10-28T00:00:00.000Z' }, false],
    [{ shareTestimoniosAt: '2026-10-28T00:00:00.000Z', shareTestimoniosVersion: 1 }, false],
    [{ shareTestimoniosAt: '2026-10-28T00:00:00.000Z', shareTestimoniosVersion: String(TESTIMONIO_CONSENT_VERSION) }, false],
    [{ shareTestimoniosAt: null, shareTestimoniosVersion: TESTIMONIO_CONSENT_VERSION }, false],
  ])('%j → %s', (row, expected) => {
    expect(isCurrentTestimonioConsent(row)).toBe(expected)
  })
})
