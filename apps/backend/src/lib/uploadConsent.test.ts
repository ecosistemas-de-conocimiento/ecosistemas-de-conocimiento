/**
 * 🔴 The upload consent's version moves with the web wording
 * (`apps/web/src/lib/uploadConsent.ts`); the folio's year is Mexico City's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertUploadConsent,
  CONSENT_VERSION_CHANGED,
  folio,
  isUserCreate,
  UPLOAD_CONSENT_REQUIRED,
  UPLOAD_CONSENT_VERSION,
} from './uploadConsent'

const webConsent = readFileSync(join(__dirname, '../../../web/src/lib/uploadConsent.ts'), 'utf8')

describe('upload consent', () => {
  it('the web page and the backend name the same version', () => {
    const m = webConsent.match(/export const UPLOAD_CONSENT_VERSION = (\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(UPLOAD_CONSENT_VERSION)
  })

  it.each([
    [undefined, 400, UPLOAD_CONSENT_REQUIRED],
    [null, 400, UPLOAD_CONSENT_REQUIRED],
    ['', 400, UPLOAD_CONSENT_REQUIRED],
    [UPLOAD_CONSENT_VERSION - 1, 409, CONSENT_VERSION_CHANGED],
    [UPLOAD_CONSENT_VERSION + 1, 409, CONSENT_VERSION_CHANGED],
    [String(UPLOAD_CONSENT_VERSION), 409, CONSENT_VERSION_CHANGED],
  ])('%j → %i %s', (value, status, message) => {
    try {
      assertUploadConsent(value)
      expect.unreachable()
    } catch (err) {
      expect(err).toMatchObject({ status, message })
    }
  })

  it('the current version passes', () => {
    expect(() => assertUploadConsent(UPLOAD_CONSENT_VERSION)).not.toThrow()
  })

  it('only a signed-in create under access control must carry it', () => {
    expect(isUserCreate({ req: { user: { id: 1 } } })).toBe(true)
    expect(isUserCreate({ req: { user: { id: 1 } }, overrideAccess: false })).toBe(true)
    expect(isUserCreate({ req: { user: { id: 1 } }, overrideAccess: true })).toBe(false)
    expect(isUserCreate({ req: {} })).toBe(false)
  })

  it('folio: EDC-<year in America/Mexico_City>-<id, 6 digits>', () => {
    expect(folio(123, '2026-06-01T12:00:00.000Z')).toBe('EDC-2026-000123')
    // 2027-01-01 03:00 UTC is still 2026-12-31 in Mexico City (UTC-6).
    expect(folio(7, '2027-01-01T03:00:00.000Z')).toBe('EDC-2026-000007')
    expect(folio(1234567, '2027-01-01T07:00:00.000Z')).toBe('EDC-2027-1234567')
  })
})
