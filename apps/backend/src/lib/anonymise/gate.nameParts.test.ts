/**
 * A NAME'S PARTS ARE NAMES TOO (dev, 2026-10-26).
 *
 * Two staff documentos went `ready` with a collaborator's bare first name left
 * in 7 and 12 times. The surname was redacted everywhere. The model reported
 * the full name (and the surname) but never the bare first name, stage 3 only
 * redacts spellings of what was reported, and verify — the same model — did
 * not report it either. Owner ruling Q5: "names get anonymized, independently
 * of number of words".
 *
 * The fix: a multi-word person finding also redacts each of its capitalised
 * name parts wherever they stand as whole words, with the SAME label.
 *
 * ⚠ All text here is synthetic. Every model answer goes through the REAL
 * `parseFindings`, at the fetch boundary where the path has one.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, DETECT_SYSTEM_PROMPT, parseFindings, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import type { PersonDetector } from './types'

type H = { texto: string; tipo: string; identifica?: unknown }

/** Call 1 = stage 3, call 2.. = verify rounds. */
function scripted(perCall: H[][]): PersonDetector {
  let n = 0
  return {
    name: 'scripted',
    async detect({ text }) {
      const hallazgos = perCall[n++] ?? []
      return parseFindings(JSON.stringify({ hallazgos }), text)
    },
  }
}

const persona = (texto: string, identifica?: unknown): H =>
  identifica === undefined ? { texto, tipo: 'persona' } : { texto, tipo: 'persona', identifica }

function gate(text: string, perCall: H[][], verifyRounds?: number) {
  return runAnonymisationGate(
    { contentKind: 'testimonio', text },
    { detector: scripted(perCall), ...(verifyRounds ? { verifyRounds } : {}) },
  )
}

/** A co-authored draft in staff register: the full name once, the first name alone 7 times. */
const DRAFT = [
  'Borrador de relatoría. Autores: Rodolfo Quintanar y Fausto Arellano.',
  '',
  'En la sesión del martes, Fausto abrió la discusión. Según Fausto, el problema es de horarios.',
  'Rodolfo propuso mover las entrevistas. Fausto respondió que eso ya se intentó.',
  'Arellano insistió en preguntar a las participantes.',
  '',
  'Más adelante, Fausto leyó su cuaderno. Se acordó que Fausto y Rodolfo redactarán la',
  'siguiente versión. Fausto enviará las notas. La propuesta de FAUSTO quedó pendiente.',
].join('\n')

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the dev failure: the full name reported, the bare first name never', () => {
  it('redacts every bare "Fausto" with the full name\'s label, and the gate is ready', async () => {
    expect(DRAFT.match(/Fausto/gi)).toHaveLength(8)
    const result = await gate(DRAFT, [
      [persona('Rodolfo Quintanar'), persona('Fausto Arellano'), persona('Arellano')],
      [],
    ])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/fausto|arellano|rodolfo|quintanar/i)
    // Rodolfo Quintanar is A, Fausto Arellano is B (longest first).
    expect(result.redactedText).toContain('Autores: [Persona A] y [Persona B].')
    expect(result.redactedText).toContain('Según [Persona B], el problema')
    expect(result.redactedText).toContain('[Persona B] insistió')
    expect(result.redactedText).toContain('que [Persona B] y [Persona A] redactarán')
    expect(result.redactedText).toContain('La propuesta de [Persona B] quedó')
    expect(result.report.pseudonyms).toBe(2)
  })

  it('a bare first name the model DID report also gets the full name\'s label, not a new one', async () => {
    const result = await gate(DRAFT, [
      [persona('Fausto Arellano'), persona('Fausto'), persona('Rodolfo Quintanar')],
      [],
    ])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/fausto|rodolfo/i)
    expect(result.report.pseudonyms).toBe(2)
  })

  it('surname-only mentions are redacted with the same label', async () => {
    const text =
      'La relatoría es de Marisela Ocampo. Ocampo propuso el calendario. Después, OCAMPO lo corrigió.'
    const result = await gate(text, [[persona('Marisela Ocampo')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(
      'La relatoría es de [Persona A]. [Persona A] propuso el calendario. Después, [Persona A] lo corrigió.',
    )
  })
})

describe('what a name part is', () => {
  it('a part shared by two people gets a label of its own, never one of theirs', async () => {
    const text = 'Llegaron María López y María Pérez. María saludó primero.'
    const result = await gate(text, [[persona('María López'), persona('María Pérez')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Llegaron [Persona A] y [Persona B]. [Persona C] saludó primero.')
  })

  it('a part glued to another capitalised name gets its own label: probably someone else', async () => {
    const text = 'Firmó Fausto Arellano. Ayer Fausto llegó; dijo que Fausto Martínez no vendrá.'
    const result = await gate(text, [[persona('Fausto Arellano')], [persona('[Persona B] Martínez')], []], 2)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // "Ayer" starts the sentence, so that Fausto is the author's.
    expect(result.redactedText).toBe('Firmó [Persona A]. Ayer [Persona A] llegó; dijo que [Persona B] no vendrá.')
  })

  it('a leading title and function words are not name parts', async () => {
    const text =
      'Vino Don Fernando de la Cruz. Fernando habló. Don Pedro escuchó. La cruz del pueblo quedó de pie.'
    const result = await gate(text, [[persona('Don Fernando de la Cruz'), persona('Don Pedro')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // "Cruz" capitalised is a name part; "cruz" in lower case is a word.
    expect(result.redactedText).toBe(
      'Vino [Persona A]. [Persona A] habló. [Persona B] escuchó. La cruz del pueblo quedó de pie.',
    )
  })

  it('a title does not merge another titled person into the label', async () => {
    const text = 'Llegó el Dr. Anselmo Rivas. Anselmo saludó. El Dr. Prieto no vino.'
    const result = await gate(text, [[persona('el Dr. Anselmo Rivas')], [persona('Prieto')], []], 2)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Llegó [Persona A]. [Persona A] saludó. El Dr. [Persona B] no vino.')
  })

  it('a common word that is also a name: capitalised occurrences go, lower-case ones stay', async () => {
    const text = 'Firmó Rosa Benítez. Rosa trajo una flor rosa. ROSA se fue. La Paz Ortiz llegó; queremos paz.'
    const result = await gate(text, [[persona('Rosa Benítez'), persona('Paz Ortiz')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(
      'Firmó [Persona A]. [Persona A] trajo una flor rosa. [Persona A] se fue. La [Persona B] llegó; queremos paz.',
    )
  })

  it('never writes inside a placeholder', async () => {
    const text = 'Persona Domínguez llegó. Persona habló con Domínguez.'
    const result = await gate(text, [[persona('Persona Domínguez')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('[Persona A] llegó. [Persona A] habló con [Persona A].')
  })

  it('a non-person finding spreads nothing', async () => {
    const text = 'Vivo en colonia Las Flores. Flores trajo pan.'
    const result = await gate(text, [[{ texto: 'colonia Las Flores', tipo: 'lugar' }], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Vivo en [Domicilio A]. Flores trajo pan.')
  })
})

describe('verify', () => {
  it('holds on a mid-sentence bare first name it marks non-identifying (pins Q4/Q5)', async () => {
    const text = 'Escribieron Rodolfo Quintanar y Fausto. Luego Fausto corrigió.'
    const result = await gate(text, [[persona('Rodolfo Quintanar')], [persona('Fausto', false)]])
    expect(result.status).toBe('hold')
  })

  it('a name found only by verify spreads its parts too, with one label', async () => {
    const result = await gate(DRAFT, [[persona('Rodolfo Quintanar')], [persona('Fausto Arellano')], []], 2)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/fausto|arellano/i)
    expect(result.redactedText).toContain('Autores: [Persona A] y [Persona B].')
    expect(result.redactedText).toContain('La propuesta de [Persona B] quedó')
    expect(result.report.pseudonyms).toBe(2)
  })

  it('a verify leftover that is a part of a stage-3 name gets that name\'s label', async () => {
    const text = 'Autora: Ximena Arriaga. Ximena coordinó. Luego ximena volvió.'
    // Stage 3 found the full name; the lower-case "ximena" stays for verify.
    const result = await gate(text, [[persona('Ximena Arriaga')], [persona('ximena')], []], 2)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Autora: [Persona A]. [Persona A] coordinó. Luego [Persona A] volvió.')
  })
})

/** A real `@edc/ai-client` over a fake fetch: answers only full names, the dev blind spot. */
function fullNamesOnlyClient(names: readonly string[]) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { unit: { input: { userPrompt: string } } }
    const prompt = body.unit.input.userPrompt
    const hallazgos = names.filter((n) => prompt.includes(n)).map((n) => ({ texto: n, tipo: 'persona' }))
    return new Response(
      JSON.stringify({ text: JSON.stringify({ hallazgos }), modelUsed: 'fake', provider: 'fake', costUsd: 0, traceId: 't' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl }) as unknown as SyncGenerator
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ')

/** The full name in the first chunk only; the first name alone in later chunks. */
const LONG = [
  `Relatoría de Fausto Arellano. ${filler(40)}`,
  `${filler(40)} Fausto propuso cambiar el calendario.`,
  `Fausto ${filler(40)}`,
].join('\n\n')

describe('chunk boundaries and both detector backends', () => {
  it('ai-service path: a bare first name in a chunk where nothing is reported is still redacted', async () => {
    const detector = aiServiceDetector({
      client: fullNamesOnlyClient(['Fausto Arellano']),
      chunkWords: 50,
      concurrency: 1,
    })
    const result = await runAnonymisationGate({ contentKind: 'testimonio', text: LONG }, { detector })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/fausto|arellano/i)
    expect(result.redactedText.match(/\[Persona A\]/g)).toHaveLength(3)
  })

  it('self-hosted path (ANONYMISE_DETECT_URL): same answer, same redaction', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'qwen3-test')
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', '0')
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url)
        const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] }
        const prompt = body.messages.at(-1)?.content ?? ''
        const hallazgos = prompt.includes('Fausto Arellano') ? [{ texto: 'Fausto Arellano', tipo: 'persona' }] : []
        // A qwen3-style answer: an empty think block before the JSON.
        const content = `<think>\n\n</think>\n\n${JSON.stringify({ hallazgos })}`
        return new Response(JSON.stringify({ model: 'qwen3-test', choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    const detector = aiServiceDetector({ chunkWords: 50, concurrency: 1 })
    const result = await runAnonymisationGate({ contentKind: 'testimonio', text: LONG }, { detector })
    expect(urls.every((u) => u === 'http://spark.test/v1/chat/completions')).toBe(true)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/fausto|arellano/i)
  })
})

describe('the material line follows the content kind', () => {
  async function promptFor(contentKind: 'testimonio' | 'conversacion' | 'documento') {
    const prompts: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      prompts.push((JSON.parse(String(init.body)) as { unit: { input: { userPrompt: string } } }).unit.input.userPrompt)
      return new Response(
        JSON.stringify({ text: '{"hallazgos":[]}', modelUsed: 'fake', provider: 'fake', costUsd: 0, traceId: 't' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const client = new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl })
    await aiServiceDetector({ client: client as unknown as SyncGenerator }).detect({ text: 'Hola.', contentKind })
    return prompts[0] ?? ''
  }

  it('a testimonio keeps its line', async () => {
    expect(await promptFor('testimonio')).toMatch(/^Es el testimonio de una persona, transcrito\.\n\n/)
  })

  it('a conversación keeps its line', async () => {
    expect(await promptFor('conversacion')).toMatch(/^Es una conversación entre integrantes de una comunidad\.\n\n/)
  })

  it('a documento is described as a written document that may quote several people', async () => {
    const prompt = await promptFor('documento')
    expect(prompt).not.toMatch(/testimonio|conversación/)
    expect(prompt).toMatch(/^Es un documento escrito/)
    expect(prompt).toMatch(/varias personas/)
  })
})

describe('the prompt', () => {
  const flat = DETECT_SYSTEM_PROMPT.replace(/\s+/g, ' ')

  it('says a first name alone is a finding, also for an author or team member', () => {
    expect(flat).toMatch(/nombre de pila solo/i)
    expect(flat).toMatch(/autores|coautores/i)
  })
})
