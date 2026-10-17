import { describe, expect, it } from 'vitest'

import { chunkText, countWords } from './chunk'

const words = (n: number, w = 'palabra') => Array.from({ length: n }, () => w).join(' ')

describe('chunkText', () => {
  it('returns one chunk for a short text', () => {
    const text = 'Hola, me llamo Lucía.\n\nVivo en el centro.'
    const chunks = chunkText(text, 250)
    expect(chunks).toEqual([{ start: 0, end: text.length, text }])
  })

  it('returns no chunks for an empty text', () => {
    expect(chunkText('', 250)).toEqual([])
  })

  it('packs whole paragraphs up to the word budget', () => {
    const p = words(100)
    const text = [p, p, p, p, p].join('\n\n')
    const chunks = chunkText(text, 250)
    // 100 + 100 fit; a third would make 300.
    expect(chunks.map((c) => countWords(c.text))).toEqual([200, 200, 100])
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith('\n\n')).toBe(true)
  })

  it('🔴 the chunks cover the text exactly: contiguous, offsets true, nothing lost', () => {
    const text = [
      'ENTREVISTADORA: ¿Y qué pasó?',
      `ENTREVISTADA: ${words(180)}. Luego llegó Teodulfo.`,
      '',
      `ENTREVISTADA: ${words(90)}`,
      `   ${words(300)}. ${words(40)}? ${words(10)}!`,
      '\n\n',
    ].join('\n\n')
    const chunks = chunkText(text, 120)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    let at = 0
    for (const c of chunks) {
      expect(c.start).toBe(at)
      expect(text.slice(c.start, c.end)).toBe(c.text)
      at = c.end
    }
    expect(at).toBe(text.length)
  })

  it('splits an over-long single paragraph at sentence boundaries', () => {
    const s = `${words(60)}.`
    const text = [s, s, s, s, s].join(' ')
    const chunks = chunkText(text, 130)
    expect(chunks.map((c) => countWords(c.text))).toEqual([120, 120, 60])
    for (const c of chunks.slice(0, -1)) expect(c.text.trimEnd().endsWith('.')).toBe(true)
  })

  it('hard-splits a single sentence longer than the budget at word boundaries', () => {
    const text = words(500)
    const chunks = chunkText(text, 200)
    expect(chunks.map((c) => countWords(c.text))).toEqual([200, 200, 100])
    expect(chunks.map((c) => c.text).join('')).toBe(text)
  })

  it('rejects a non-positive budget', () => {
    expect(() => chunkText('x', 0)).toThrow()
  })
})
