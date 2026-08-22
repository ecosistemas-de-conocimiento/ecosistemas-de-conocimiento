import { describe, expect, it } from 'vitest'

import {
  COMMENT_WITHOUT_OTHER_ERROR,
  HIGH_SCORE_REASONS,
  LOW_SCORE_REASONS,
  normalizeFeedback,
  OTHER_REASON,
  REASON_ERROR,
  reasonsForStars,
} from './Ratings'

/**
 * `reason` and `comment` are one rule, not two. These pin the pair.
 */

const ok = (r: ReturnType<typeof normalizeFeedback>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.value
}

describe('reasonsForStars', () => {
  it('1-3 asks what went wrong; 4-5 asks what worked', () => {
    for (const s of [1, 2, 3]) expect(reasonsForStars(s)).toContain(LOW_SCORE_REASONS[0])
    for (const s of [4, 5]) expect(reasonsForStars(s)).toContain(HIGH_SCORE_REASONS[0])
  })

  it('🔴 never offers a "what went wrong" reason under a high score', () => {
    // Offering `invented` on a 5-star is noise, and it would mix the two
    // populations in every count built on this column.
    for (const s of [4, 5]) {
      for (const bad of LOW_SCORE_REASONS) expect(reasonsForStars(s)).not.toContain(bad)
    }
  })

  it('always offers `other`, last', () => {
    for (const s of [1, 2, 3, 4, 5]) {
      const list = reasonsForStars(s)
      expect(list[list.length - 1]).toBe(OTHER_REASON)
    }
  })
})

describe('normalizeFeedback', () => {
  it('accepts a preset that belongs to the score', () => {
    expect(ok(normalizeFeedback(2, 'invented', undefined)).reason).toBe('invented')
  })

  it('🔴 rejects a preset from the other list', () => {
    const r = normalizeFeedback(5, 'invented', undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(REASON_ERROR)
  })

  it('a rating with no reason at all is valid', () => {
    // Forcing a reason makes people pick the first option to get past it,
    // which poisons exactly the counts this field exists to produce.
    expect(ok(normalizeFeedback(4, undefined, undefined))).toEqual({ reason: null, comment: null })
  })

  it('`other` unlocks free text', () => {
    expect(ok(normalizeFeedback(1, OTHER_REASON, '  citó una ley derogada  '))).toEqual({
      reason: OTHER_REASON,
      comment: 'citó una ley derogada',
    })
  })

  it('🔴 refuses free text attached to a preset', () => {
    // A preset that also carries a sentence is a contradiction nobody reads,
    // and it quietly turns a countable column back into free text.
    const r = normalizeFeedback(1, 'invented', 'actually it was fine')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(COMMENT_WITHOUT_OTHER_ERROR)
  })

  it('`other` with no text is allowed', () => {
    // "None of these fit" is a real signal. Refusing it would push the person
    // to pick a preset that is wrong.
    expect(ok(normalizeFeedback(3, OTHER_REASON, undefined))).toEqual({
      reason: OTHER_REASON,
      comment: null,
    })
  })

  it('blank text counts as no text, not as an empty comment', () => {
    expect(ok(normalizeFeedback(3, OTHER_REASON, '   ')).comment).toBeNull()
  })

  it('rejects a reason that is not in any list', () => {
    expect(normalizeFeedback(2, 'porque-si', undefined).ok).toBe(false)
  })
})
