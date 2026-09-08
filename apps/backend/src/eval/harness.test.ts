/**
 * The harness, proved on fakes.
 *
 * ⚠ HERMETIC. No Postgres, no ai-service, no inference. `sprint0/00-context.md`
 * is explicit — *"do not loop over real inference while iterating; ~85 s and
 * real money per call"* — so everything that can be checked without paying is
 * checked here, and `run.ts --fake` exercises the rest of the pipeline against
 * the real database with a stub client.
 *
 * ⚠ AND IT CARRIES POSITIVE ASSERTIONS, NOT ONLY NEGATIVE ONES. The repo has
 * been bitten twice by a suite that could not tell "correctly suppressed" from
 * "never produced" (ADR §16.2). So the graph block is asserted to ARRIVE in the
 * user turn, not merely to be absent when there is no provider.
 */

import { describe, expect, it } from 'vitest'
import { prepareTurn, type AIClient, type DomainAdapter } from '@edc/chat-engine/core'

import { parseCsv, type CorpusDoc, type ManifestRow } from './corpus'
import { inlineParams } from './db'
import { CHAT_ENGINE_CONFIG } from './engine'
import { expandGraphQuery, graphContextParagraph, type GraphRetrieval } from './graph'
import { buildQuestions } from './questions'
import { citedDocumentIds, meanOf, scoreAnswer } from './score'
import { contains, containsAny, fold } from './text'

// ── Normalisation ──────────────────────────────────────────────────────────

describe('fold / contains', () => {
  it('folds accents and case', () => {
    expect(contains('Vive en Juchitán, Oaxaca', 'juchitan')).toBe(true)
  })

  it('🔴 flattens typographic quotes — the trap that cost 71 of 191 documents', () => {
    // MANIFEST.csv writes straight quotes; the corpus text writes curly ones.
    expect(contains('el Hospital “José G. Parres”', 'Hospital "José G. Parres"')).toBe(true)
  })

  it('collapses whitespace so a line break inside a name still matches', () => {
    expect(contains('Centro de Salud\n  de Tlayacapan', 'Centro de Salud de Tlayacapan')).toBe(true)
  })

  it('containsAny takes any one surface form', () => {
    expect(containsAny('habla me’phaa en casa', ['tlapaneco', 'me’phaa'])).toBe(true)
    expect(containsAny('habla zapoteco', ['tlapaneco', 'me’phaa'])).toBe(false)
  })

  it('an empty needle never matches — otherwise every answer scores full marks', () => {
    expect(contains('cualquier cosa', '')).toBe(false)
    expect(containsAny('cualquier cosa', ['', '   '])).toBe(false)
  })

  it('fold is idempotent', () => {
    expect(fold(fold('  Él  DIJO “sí”  '))).toBe(fold('  Él  DIJO “sí”  '))
  })
})

// ── MANIFEST.csv ───────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    const rows = parseCsv('a,b\n1,"Huautla de Jiménez, Oaxaca"\n')
    expect(rows).toEqual([{ a: '1', b: 'Huautla de Jiménez, Oaxaca' }])
  })

  it('unescapes a doubled quote', () => {
    const rows = parseCsv('a\n"dijo ""sí"""\n')
    expect(rows[0].a).toBe('dijo "sí"')
  })
})

// ── The SQL bridge ─────────────────────────────────────────────────────────

describe('inlineParams', () => {
  it('renders an id array as ARRAY[…] — the thing the shipped path cannot do', () => {
    expect(inlineParams('WHERE id = ANY($1::int[])', [[160, 247]])).toBe(
      'WHERE id = ANY(ARRAY[160,247]::int[])',
    )
  })

  it('substitutes $10 before $1, so a two-digit placeholder survives', () => {
    const params = Array.from({ length: 11 }, (_, i) => i)
    expect(inlineParams('$1|$10|$11', params)).toBe('0|9|10')
  })

  it('🔴 refuses a string parameter rather than quoting it', () => {
    expect(() => inlineParams('WHERE name = $1', ['ok'])).toThrow(/non-integer/)
    expect(() => inlineParams('WHERE id = ANY($1::int[])', [[1, 'x']])).toThrow(/non-integer/)
  })
})

// ── The copies of apps/web's pure graph functions ──────────────────────────

describe('expandGraphQuery (copy of apps/web/src/lib/graph.ts)', () => {
  it('appends terms the query does not already contain', () => {
    expect(expandGraphQuery('agua', ['sequía', 'pozo'])).toBe('agua sequía pozo')
  })

  it('returns the query unchanged when nothing is added — the skip signal', () => {
    const q = 'agua potable'
    expect(expandGraphQuery(q, [])).toBe(q)
    expect(expandGraphQuery(q, ['AGUA'])).toBe(q)
  })

  it('dedupes accent-insensitively', () => {
    expect(expandGraphQuery('x', ['México', 'Mexico'])).toBe('x México')
  })

  it('skips an oversized term but keeps a later small one (continue, not break)', () => {
    const out = expandGraphQuery('agua', ['a'.repeat(150), 'b'.repeat(100), 'c'.repeat(40)])
    expect(out).toBe(`agua ${'a'.repeat(150)} ${'c'.repeat(40)}`)
  })

  it('caps at MAX_EXPANSION_TERMS', () => {
    const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']
    expect(expandGraphQuery('x', terms).split(' ')).toHaveLength(9) // 'x' + 8
  })
})

const entity = (id: number, label: string, support: number, type = 'tema' as const) => ({
  id,
  type,
  label,
  support,
})

describe('graphContextParagraph (copy of apps/web/src/lib/graph.ts)', () => {
  const retrieval: GraphRetrieval = {
    entities: [entity(1, 'traducción en salud', 36)],
    edges: [
      {
        from: entity(1, 'traducción en salud', 36),
        to: entity(2, 'consentimiento informado', 15),
        relationType: 'relacionado_con',
        support: 6,
      },
    ],
    documents: [{ id: 118, title: 'Biografía oral (SIM_0002)', contentKind: 'documento' }],
    terms: ['consentimiento informado'],
  }

  it('POSITIVE: renders the seed, its support and its neighbour', () => {
    const block = graphContextParagraph(retrieval)
    expect(block).toContain('- traducción en salud (tema): aparece en 36 documentos.')
    expect(block).toContain('Se conecta con: consentimiento informado (tema, 6 documentos).')
  })

  it('follows an edge whose far endpoint is NOT a seed', () => {
    // The one-hop expansion means the neighbour is normally absent from
    // `entities`; an index built from `entities` alone loses the whole clause.
    expect(graphContextParagraph(retrieval)).toContain('consentimiento informado')
  })

  it('🔴 never puts a document title into the prompt', () => {
    expect(graphContextParagraph(retrieval)).not.toContain('SIM_0002')
  })

  it('is empty when nothing matched — the silent fallback', () => {
    expect(graphContextParagraph({ entities: [], edges: [], documents: [], terms: [] })).toBe('')
  })
})

// ── Ground truth ───────────────────────────────────────────────────────────

function manifest(over: Partial<ManifestRow>): ManifestRow {
  return {
    id: '1',
    archivo: 'SIM_0002_x.txt',
    ecosistema: 'traduccion',
    formato: 'biografia_oral',
    nombre: 'Efrén Peralta Guzmán',
    rol: 'intérprete en salud',
    lengua: 'mazateco',
    origen: 'Huautla de Jiménez, Oaxaca',
    residencia: 'Yautepec, Morelos',
    sitio_ancla: 'el Centro de Salud de Tlayacapan',
    cruce_ecosistema: 'no',
    pariente: '',
    ...over,
  }
}

function doc(over: Partial<CorpusDoc> & { text: string }): CorpusDoc {
  return {
    documentId: 118,
    sim: 'SIM_0002',
    name: 'Biografía oral (SIM_0002)',
    manifest: manifest({}),
    ...over,
  }
}

describe('buildQuestions', () => {
  const base = doc({
    text:
      'Me llamo Efrén Peralta Guzmán. Vengo de Huautla de Jiménez y hablo mazateco. ' +
      'Colaboro en el Centro de Salud de Tlayacapan.',
  })
  // Three copies, so a fact reaches the MIN_GLOBAL_SUPPORT of 3.
  const supported = [base, { ...base, documentId: 119 }, { ...base, documentId: 120 }]
  const localSims = [
    'SIM_0002',
    'SIM_0024',
    'SIM_0057',
    'SIM_0077',
    'SIM_0090',
    'SIM_0134',
    'SIM_0183',
    'SIM_0195',
    'SIM_0208',
    'SIM_0249',
  ]
  const all = [
    ...supported,
    ...localSims.slice(1).map((sim, i) => ({ ...base, documentId: 200 + i, sim })),
  ]

  it('drops a global fact no published document supports', () => {
    const { questions, droppedGlobalFacts } = buildQuestions(all)
    const g01 = questions.find((q) => q.id === 'G01')!
    // Only Tlayacapan is in the fixture text; the other two anchor sites are not.
    expect(g01.expected.map((f) => f.label)).toEqual(['Centro de Salud de Tlayacapan'])
    expect(droppedGlobalFacts.some((d) => d.label.includes('Parres'))).toBe(true)
  })

  it('🔴 refuses to build a local question whose document is not published', () => {
    expect(() => buildQuestions(supported)).toThrow(/no PUBLISHED document/)
  })

  it('produces 10 local and 10 global questions', () => {
    const { questions } = buildQuestions(all)
    expect(questions.filter((q) => q.klass === 'global')).toHaveLength(10)
    expect(questions.filter((q) => q.klass === 'local')).toHaveLength(10)
  })
})

// ── Scoring ────────────────────────────────────────────────────────────────

describe('scoreAnswer', () => {
  const docs = [
    doc({ documentId: 118, text: 'Habla mazateco en el Centro de Salud de Tlayacapan.' }),
    doc({ documentId: 999, sim: 'SIM_0999', text: 'Un texto sin ninguno de los hechos.' }),
  ]
  const question = {
    id: 'L01',
    klass: 'local' as const,
    text: '¿…?',
    expected: [
      { label: 'mazateco', aliases: ['mazateco'] },
      { label: 'Tlayacapan', aliases: ['Tlayacapan'] },
    ],
    targetDocumentId: 118,
    support: {},
  }
  const provenance = {
    chunks: [
      { chunkId: 'a', documentId: 'uuid-a', score: 1, corpus: 'eco-1', metadata: { docId: '118' } },
      { chunkId: 'b', documentId: 'uuid-b', score: 1, corpus: 'eco-1', metadata: { docId: '999' } },
    ],
  }

  it('counts only the facts the answer names', () => {
    const s = scoreAnswer(question, 'Habla mazateco.', provenance, docs)
    expect(s.found).toEqual(['mazateco'])
    expect(s.missing).toEqual(['Tlayacapan'])
    expect(s.recall).toBe(0.5)
  })

  it('citation precision counts documents that really contain a fact', () => {
    const s = scoreAnswer(question, 'Habla mazateco.', provenance, docs)
    expect(s.citedDocumentIds).toEqual([118, 999])
    expect(s.citationPrecision).toBe(0.5)
    expect(s.targetCited).toBe(true)
  })

  it('🔴 citation precision is null, not 0, when nothing was cited', () => {
    // "cited badly" and "cited nothing" are different failures.
    expect(scoreAnswer(question, 'x', null, docs).citationPrecision).toBeNull()
  })

  it('reads the PAYLOAD id from metadata.docId, never ai-service\'s documentId', () => {
    expect(citedDocumentIds(provenance)).toEqual([118, 999])
    expect(citedDocumentIds({ chunks: [{ ...provenance.chunks[0], metadata: null }] })).toEqual([])
  })

  it('meanOf ignores nulls and reports null for an empty set', () => {
    expect(meanOf([1, null, 0])).toBe(0.5)
    expect(meanOf([null, null])).toBeNull()
  })
})

// ── The two arms, end to end on a fake client ──────────────────────────────

function fakeClient(): AIClient & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async retrieve(req) {
      if (req.corpus !== 'eco-1') return { matches: [] }
      return {
        matches: [
          {
            documentId: 'uuid-a',
            chunkId: 'c1',
            score: 0.9,
            text: 'Colabora en el Centro de Salud de Tlayacapan.',
            metadata: { docId: '118' },
          },
        ],
      }
    },
    async generateSync(req) {
      seen.push(req.messages[req.messages.length - 1].content)
      return {
        text: 'respuesta',
        modelUsed: 'fake',
        provider: 'fake',
        costUsd: 0,
        traceId: 't',
      }
    },
    async ingest() {
      return { ingested: 0, documentIds: [] }
    },
  }
}

const adapter: DomainAdapter = {
  async scopeHierarchy() {
    return { summaryText: 'Ecosistema: Demo.', corpora: [{ corpus: 'eco-1' }] }
  },
  async searchEntities() {
    return []
  },
  async resolveEntity() {
    return ''
  },
  async syncEntity() {},
  async backfill() {},
  async summary() {
    return ''
  },
}

describe('the two arms', () => {
  const args = (graphProvider?: () => Promise<{ context: string } | null>) => ({
    config: CHAT_ENGINE_CONFIG,
    aiClient: fakeClient(),
    adapter,
    orgId: 'demo',
    userId: 'eval',
    threadId: 't1',
    scope: { refs: [{ kind: 'org' as const }] },
    history: [],
    userMessage: '¿Dónde colabora?',
    ...(graphProvider ? { graphProvider } : {}),
  })

  it('POSITIVE: the graph block reaches the user turn under its own header', async () => {
    const prepared = await prepareTurn(
      args(async () => ({ context: 'BLOQUE-DEL-GRAFO' })),
    )
    const user = prepared.messages[prepared.messages.length - 1].content
    expect(prepared.graphContext).toBe('BLOQUE-DEL-GRAFO')
    expect(user).toContain('Contexto del grafo de conocimiento:')
    expect(user).toContain('BLOQUE-DEL-GRAFO')
    // The block sits between the summary and the retrieved fragments.
    expect(user.indexOf('BLOQUE-DEL-GRAFO')).toBeLessThan(
      user.indexOf('Contexto recuperado de la base de conocimiento:'),
    )
  })

  it('with no provider the turn carries no graph block at all', async () => {
    const prepared = await prepareTurn(args())
    expect(prepared.graphContext).toBe('')
    expect(prepared.messages[prepared.messages.length - 1].content).not.toContain(
      'Contexto del grafo',
    )
  })

  it('🔴 a provider that returns null leaves the turn byte-identical', async () => {
    // This is exactly the shipped state: `/api/graph/retrieve` 500s, the web
    // provider maps a non-2xx to `null`, and the turn is the plain one.
    const withoutProvider = await prepareTurn(args())
    const withNullProvider = await prepareTurn(args(async () => null))
    expect(withNullProvider.messages).toEqual(withoutProvider.messages)
  })

  it('a throwing provider degrades silently rather than breaking the turn', async () => {
    const prepared = await prepareTurn(
      args(async () => {
        throw new Error('graph down')
      }),
    )
    expect(prepared.graphContext).toBe('')
    expect(prepared.matches).toHaveLength(1)
  })
})
