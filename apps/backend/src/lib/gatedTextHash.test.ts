import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { gatedTextHash, matchesHeldTextHash, normaliseGatedText, sameGatedText } from './gatedTextHash'

describe('gated text normalisation (R78)', () => {
  it('ignores whitespace runs, ends and case', () => {
    expect(normaliseGatedText('  Ana\n\thabló  CON Beltrán. ')).toBe('ana habló con beltrán.')
    expect(sameGatedText('Ana habló.', 'ana  habló. ')).toBe(true)
    expect(sameGatedText('Ana habló.', 'Ana hablo.')).toBe(false)
    expect(gatedTextHash('Ana habló.')).toBe(gatedTextHash(' ANA   habló.\n'))
  })

  it('drops invisible format characters (\\p{Cf}: zero-width space/joiner, BOM)', () => {
    expect(sameGatedText('Ana habló.', 'Ana\u200B ha\u200Dbló.\uFEFF')).toBe(true)
    expect(normaliseGatedText('\u200B \u200D')).toBe('')
  })

  it('treats NFC and NFD spellings as the same words', () => {
    expect(sameGatedText('habló', 'habló')).toBe(true)
  })

  it('still matches a hold hashed before normalisation (raw SHA-256)', () => {
    const raw = createHash('sha256').update('Ana Habló', 'utf8').digest('hex')
    expect(matchesHeldTextHash(raw, 'Ana Habló')).toBe(true)
    expect(matchesHeldTextHash(gatedTextHash('Ana Habló'), 'ana habló ')).toBe(true)
    expect(matchesHeldTextHash(gatedTextHash('Ana Habló'), 'Texto nuevo')).toBe(false)
  })
})
