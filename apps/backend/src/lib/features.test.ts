/**
 * Per-ecosistema switches: defaults are today's behaviour; a broken or failed
 * read never switches anything off; patches accept known booleans only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  featureEnabled,
  featuresFor,
  invalidateFeatures,
  isLockedFeatureMessage,
  LOCKED_FEATURE_MESSAGE,
  lockedFeatureChange,
  lockedFeatureMessage,
  parseFeaturesPatch,
  PLATFORM_ADMIN_ONLY_FEATURES,
  resolveFeatures,
} from './features'

beforeEach(() => invalidateFeatures())

describe('defaults', () => {
  it('every switch is on except studentView, keepPublicFigures and studentTestimonios (opt-in)', () => {
    expect(FEATURE_DEFAULTS).toEqual({
      audioUpload: true,
      liveMic: true,
      interviewerMode: true,
      graph: true,
      graph3d: true,
      combinedGraph: true,
      chatOrientation: true,
      testimonioTitles: true,
      autoPublishMembers: true,
      studentView: false,
      keepPublicFigures: false,
      studentTestimonios: false,
    })
    expect(FEATURE_KEYS).toHaveLength(12)
  })

  it('NULL, junk and non-booleans read as the defaults', () => {
    expect(resolveFeatures(null)).toEqual(FEATURE_DEFAULTS)
    expect(resolveFeatures([true])).toEqual(FEATURE_DEFAULTS)
    expect(resolveFeatures({ graph: 'no', bogus: false })).toEqual(FEATURE_DEFAULTS)
    expect(resolveFeatures({ graph: false }).graph).toBe(false)
  })
})

describe('parseFeaturesPatch', () => {
  it('keeps known booleans', () => {
    expect(parseFeaturesPatch({ liveMic: false, studentView: true })).toEqual({ liveMic: false, studentView: true })
  })
  it('refuses unknown keys and non-booleans instead of dropping them', () => {
    expect(typeof parseFeaturesPatch({ livemic: false })).toBe('string')
    expect(typeof parseFeaturesPatch({ liveMic: 'false' })).toBe('string')
    expect(typeof parseFeaturesPatch(null)).toBe('string')
  })
})

describe('featuresFor', () => {
  it('reads the column, caches it, and invalidate clears it', async () => {
    const findByID = vi.fn(async () => ({ features: { graph: false } }))
    expect((await featuresFor({ findByID } as never, 3)).graph).toBe(false)
    await featuresFor({ findByID } as never, 3)
    expect(findByID).toHaveBeenCalledTimes(1)
    invalidateFeatures(3)
    await featuresFor({ findByID } as never, 3)
    expect(findByID).toHaveBeenCalledTimes(2)
  })

  it('expires within 60 s', async () => {
    const findByID = vi.fn(async () => ({ features: null }))
    let t = 0
    await featuresFor({ findByID } as never, 4, () => t)
    t = 31_000
    await featuresFor({ findByID } as never, 4, () => t)
    expect(findByID).toHaveBeenCalledTimes(2)
  })

  it('🔴 a failed read is the defaults, never "all off"', async () => {
    const findByID = vi.fn(async () => {
      throw new Error('db down')
    })
    expect(await featuresFor({ findByID } as never, 5)).toEqual(FEATURE_DEFAULTS)
  })

  it('no ecosistema: the default', async () => {
    expect(await featureEnabled({ findByID: vi.fn() } as never, null, 'graph')).toBe(true)
    expect(await featureEnabled({ findByID: vi.fn() } as never, null, 'studentView')).toBe(false)
  })
})

describe('lockedFeatureChange — keepPublicFigures is the platform admin\'s (owner ruling Q16 A)', () => {
  it('names keepPublicFigures and studentTestimonios as the admin-only switches', () => {
    expect([...PLATFORM_ADMIN_ONLY_FEATURES]).toEqual(['keepPublicFigures', 'studentTestimonios'])
  })

  it('studentTestimonios is locked the same way, and each lock names its own switch', () => {
    expect(lockedFeatureChange({}, { studentTestimonios: true })).toBe('studentTestimonios')
    expect(lockedFeatureChange({ studentTestimonios: true }, null)).toBe('studentTestimonios')
    expect(lockedFeatureMessage('keepPublicFigures')).toBe(LOCKED_FEATURE_MESSAGE)
    expect(lockedFeatureMessage('studentTestimonios')).toBe(
      'Solo administración de la plataforma puede cambiar «Testimonios de estudiantes en el reporte».',
    )
    expect(isLockedFeatureMessage(lockedFeatureMessage('studentTestimonios'))).toBe(true)
    expect(isLockedFeatureMessage('No es tuyo.')).toBe(false)
  })

  it('reports a change of the resolved value, in either direction', () => {
    expect(lockedFeatureChange({}, { keepPublicFigures: true })).toBe('keepPublicFigures')
    expect(lockedFeatureChange({ keepPublicFigures: true }, { keepPublicFigures: false })).toBe('keepPublicFigures')
    // Dropping the key resolves to the default (off): that is a change too.
    expect(lockedFeatureChange({ keepPublicFigures: true }, { graph: false })).toBe('keepPublicFigures')
    expect(lockedFeatureChange({ keepPublicFigures: true }, null)).toBe('keepPublicFigures')
  })

  it('is silent when the value stays the same or only other keys move', () => {
    expect(lockedFeatureChange(null, { graph: false })).toBeNull()
    expect(lockedFeatureChange({}, { keepPublicFigures: false })).toBeNull()
    expect(lockedFeatureChange({ keepPublicFigures: true }, { keepPublicFigures: true, liveMic: false })).toBeNull()
  })
})
