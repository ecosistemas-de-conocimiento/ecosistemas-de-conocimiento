/**
 * Tolerant reading of one extraction reply. The cases are the shapes measured
 * on dev (2026-10-26, `graph_error` of docs 385–405): every failure was VALID
 * JSON that missed the strict schema — an extra `id` per entity, a top-level
 * array, a list with more items than `maxItems`.
 */
import { describe, expect, it } from 'vitest'

import { readWindowReply } from './extract'
import { salvageJson } from './reply'

const entity = (etiqueta: string, extra: Record<string, unknown> = {}) => ({
  tipo: 'tema',
  etiqueta,
  ...extra,
})

describe('salvageJson', () => {
  it('reads a code-fenced reply', () => {
    expect(salvageJson('```json\n{"entidades":[]}\n```')).toMatchObject({ value: { entidades: [] } })
  })

  it('ignores prose before and after the JSON', () => {
    const r = salvageJson('Aquí está el grafo:\n{"entidades":[],"relaciones":[]}\nEspero que sirva.')
    expect(r).toMatchObject({ value: { entidades: [], relaciones: [] }, truncated: false })
  })

  it('repairs trailing commas', () => {
    expect(salvageJson('{"entidades":[{"tipo":"tema","etiqueta":"agua",},],}')).toMatchObject({
      value: { entidades: [{ etiqueta: 'agua' }] },
    })
  })

  it('closes a reply cut off mid-array at the last complete value', () => {
    const r = salvageJson('{"entidades":[{"tipo":"tema","etiqueta":"agua"},{"tipo":"tema","etiq')
    expect(r).toMatchObject({ value: { entidades: [{ etiqueta: 'agua' }] }, truncated: true })
  })

  it('is not fooled by brackets inside strings', () => {
    const r = salvageJson('{"entidades":[{"tipo":"tema","etiqueta":"a } ] b"}],"relaciones":[]} fin')
    expect(r).toMatchObject({ value: { entidades: [{ etiqueta: 'a } ] b' }] } })
  })

  it('reports an error class, not the text, when nothing parses', () => {
    const r = salvageJson('no hay json aquí')
    expect(r).toEqual({ error: 'no JSON value found' })
  })
})

describe('readWindowReply', () => {
  it('uses `parsed` when ai-service vouched for it', () => {
    const r = readWindowReply({ parsed: { entidades: [entity('agua')], relaciones: [] } })
    expect(r).toMatchObject({ window: { entities: [{ etiqueta: 'agua' }] }, source: 'parsed' })
  })

  it('🔴 an empty but well-formed reply is a valid window with 0 entities, not a miss', () => {
    for (const text of ['{"entidades":[],"relaciones":[]}', '{"entidades":[]}', '{}', '[]']) {
      const r = readWindowReply({ text })
      expect(r).toMatchObject({ window: { entities: [], relations: [] } })
    }
  })

  it('measured on dev: strips an `id` per entity and resolves relations by id OR label', () => {
    const text = JSON.stringify({
      entidades: [
        entity('Bertrand Russell', { id: 'entidad_1', tipo: 'persona' }),
        entity('teoría de las descripciones', { id: 'entidad_2' }),
        entity('denotación', { id: 'entidad_3' }),
      ],
      relaciones: [
        { desde: 'entidad_1', hacia: 'entidad_2', tipo: 'relacionado_con' },
        { desde: 'denotación', hacia: 'entidad_2', tipo: 'parte_de' },
      ],
    })
    const r = readWindowReply({ text })
    if (!('window' in r)) throw new Error(`miss: ${r.miss}`)
    expect(r.source).toBe('text')
    expect(r.window.entities.map((e) => e.etiqueta)).toEqual([
      'Bertrand Russell',
      'teoría de las descripciones',
      'denotación',
    ])
    expect(r.window.relations).toEqual([
      { desde: 'Bertrand Russell', hacia: 'teoría de las descripciones', tipo: 'relacionado_con' },
      { desde: 'denotación', hacia: 'teoría de las descripciones', tipo: 'parte_de' },
    ])
  })

  it('measured on dev: unwraps `[ {entidades, relaciones} ]`', () => {
    const text = JSON.stringify([{ entidades: [entity('hegemonía')], relaciones: [] }])
    expect(readWindowReply({ text })).toMatchObject({ window: { entities: [{ etiqueta: 'hegemonía' }] } })
  })

  it('measured on dev: reads a bare array of entities', () => {
    const text = JSON.stringify([entity('argumentación', { id: 'tema_1', menciones: 1 })])
    expect(readWindowReply({ text })).toMatchObject({
      window: { entities: [{ etiqueta: 'argumentación' }], relations: [] },
    })
  })

  it('reads a reply that omits `relaciones`', () => {
    const text = JSON.stringify({ entidades: [entity('polifonía')] })
    expect(readWindowReply({ text })).toMatchObject({ window: { relations: [] } })
  })

  it('caps the lists at the schema maxItems (15 entities, 20 relations)', () => {
    const entidades = Array.from({ length: 30 }, (_, i) => entity(`concepto número ${i}`))
    const relaciones = Array.from({ length: 40 }, (_, i) => ({
      desde: `concepto número ${i % 15}`,
      hacia: `concepto número ${(i + 1) % 15}`,
      tipo: 'relacionado_con',
    }))
    const r = readWindowReply({ text: JSON.stringify({ entidades, relaciones }) })
    if (!('window' in r)) throw new Error('miss')
    expect(r.window.entities).toHaveLength(15)
    expect(r.window.relations).toHaveLength(20)
  })

  it('a cut-off reply that kept no entity is a miss, not an empty graph', () => {
    const r = readWindowReply({ text: '{"entidades":[{"tipo":"tema","etiq' })
    expect(r).toHaveProperty('miss')
  })

  it('🔴 a miss carries only shape info — never the reply text', () => {
    const secret = 'Juana Pérez Hernández'
    const cases = [
      { text: `{"entidades":[{"tipo":"persona","etiqueta":"${secret}","fragm` },
      { text: JSON.stringify({ [secret]: 1, entidades: 'nope' }) },
      { text: JSON.stringify([{ nombre: secret }]) },
      { text: `${secret} dijo algo` },
      { text: '' },
      {},
    ]
    for (const c of cases) {
      const r = readWindowReply(c)
      if (!('miss' in r)) throw new Error(`expected a miss for ${JSON.stringify(c).length}`)
      expect(r.miss).not.toContain('Juana')
      expect(r.miss).not.toContain('nombre')
      expect(r.miss).toMatch(/response length \d+|no text/)
    }
  })

  it('names the known keys and counts the rest', () => {
    const r = readWindowReply({ text: JSON.stringify({ entidades: 'x', foo: 1, bar: 2 }) })
    expect(r).toMatchObject({ miss: expect.stringContaining('keys [entidades, +2 other]') })
  })
})
