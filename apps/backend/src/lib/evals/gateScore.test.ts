import { describe, expect, it } from 'vitest'

import { docIdList, nameList } from '../../collections/EvalItems'
import { countTerm, scoreGateTerms } from './gateScore'

describe('countTerm', () => {
  it('counts whole words only, case-sensitive', () => {
    expect(countTerm('Lucía y Luciano; lucía', 'Lucía')).toBe(1)
    expect(countTerm('el DIF y el DIFusor', 'DIF')).toBe(1)
    expect(countTerm('calle Fresno 18, Fresno 180', 'Fresno 18')).toBe(1)
    expect(countTerm('nada', '')).toBe(0)
  })
})

describe('scoreGateTerms', () => {
  const input = 'Herminia Salas y Herminia fueron al DIF. El DIF ayudó en Cuautla.'
  it('a private term leaks when ANY occurrence survives (stricter than Q24)', () => {
    const [h] = scoreGateTerms(input, '[Persona A] [Persona A] y Herminia fueron', ['Herminia'], [])
    expect(h).toMatchObject({ before: 2, after: 1, ok: false })
  })
  it('a public term is hidden when fewer occurrences survive (Q24 count_out >= count_in)', () => {
    const v = scoreGateTerms(input, 'fueron al DIF. El [Dato omitido] ayudó en Cuautla.', [], ['DIF', 'Cuautla'])
    expect(v.map((t) => t.ok)).toEqual([false, true])
  })
  it('a term missing from the input is absent (null), never a pass', () => {
    expect(scoreGateTerms(input, input, ['Brandon'], ['UNAM']).map((t) => t.ok)).toEqual([null, null])
  })
})

describe('EvalItems list normalisers', () => {
  it('names: split, trim, dedupe; doc ids: positive integers only', () => {
    expect(nameList('Ana, Luis\nAna; ')).toEqual(['Ana', 'Luis'])
    expect(nameList([1, ' x '])).toEqual(['x'])
    expect(docIdList('391, 392 abc -4 391')).toEqual([391, 392])
    expect(docIdList([5, '6', 0, 1.5])).toEqual([5, 6])
  })
})
