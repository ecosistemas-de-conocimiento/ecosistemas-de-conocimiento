import { describe, expect, it } from 'vitest'

import { estimateWindows, parseReextractIds } from './reextractWikilinkNotes'

describe('parseReextractIds', () => {
  it('unset means every note', () => {
    expect(parseReextractIds(undefined)).toBeUndefined()
  })
  it('accepts only decimal ids separated by commas', () => {
    expect(parseReextractIds('101')).toEqual([101])
    expect(parseReextractIds('101,102,7')).toEqual([101, 102, 7])
  })
  it('🔴 refuses set-but-empty, exponent, hex, spaces, stray commas, signs and zero', () => {
    for (const bad of ['', ' ', '1e2', '0x10', '1, 2', '1,,2', '1,', ',1', '-1', '+1', '1.0', '0', 'abc']) {
      expect(() => parseReextractIds(bad), JSON.stringify(bad)).toThrow(/REEXTRACT_IDS/)
    }
  })
})

describe('estimateWindows', () => {
  it('counts windows as the splitter would, capped', () => {
    expect(estimateWindows(0, 100, 8)).toBe(0)
    expect(estimateWindows(250, 100, 8)).toBe(3)
    expect(estimateWindows(10_000, 100, 8)).toBe(8)
  })
})
