import { describe, expect, it, vi } from 'vitest'

import {
  TESTIMONIO_TITLE_INPUT_CHARS,
  TESTIMONIO_TITLE_UNIT_TYPE,
  buildTitlePrompt,
  cleanTitle,
  generateTestimonioTitle,
  refreshTestimonioTitle,
  scheduleTestimonioTitle,
  type TitleGenerator,
  type TitleStore,
} from './testimonioTitle'

function fakeClient(answers: Array<string | Error>) {
  const calls: Array<Parameters<TitleGenerator['generate']['sync']>[0]> = []
  const client: TitleGenerator = {
    generate: {
      sync: vi.fn(async (req) => {
        calls.push(req)
        const next = answers.shift()
        if (next === undefined) throw new Error('no more answers')
        if (next instanceof Error) throw next
        return { text: next }
      }),
    },
  }
  return { client, calls }
}

function fakeStore(others: string[] = [], written = 1) {
  const writes: Array<{ docId: unknown; title: string | null; redactedText: string; source?: string }> = []
  const store: TitleStore = {
    otherTitles: vi.fn(async () => others),
    write: vi.fn(async (docId, title, redactedText, source) => {
      writes.push({ docId, title, redactedText, ...(source && source !== 'redacted' ? { source } : {}) })
      return written
    }),
  }
  return { store, writes }
}

const REDACTED =
  '[Persona A] cuenta que su hijo dejó la escuela porque no había maestro que le enseñara en señas. ' +
  'Ella fue cada semana a la dirección hasta que llegó una intérprete.'

describe('cleanTitle', () => {
  it('keeps a plain 4–9 word title, first letter capital, no final period', () => {
    expect(cleanTitle('una madre pide intérprete de señas para su hijo.')).toBe(
      'Una madre pide intérprete de señas para su hijo',
    )
  })

  it('strips quotes, a "Título:" label and a leading "Testimonio sobre"', () => {
    expect(cleanTitle('Título: «La escuela sin intérprete de señas»')).toBe('La escuela sin intérprete de señas')
    expect(cleanTitle('"Testimonio sobre el regreso a la escuela sin apoyo"')).toBe(
      'El regreso a la escuela sin apoyo',
    )
  })

  it('takes the first non-empty line only', () => {
    expect(cleanTitle('\n  La espera de una intérprete en la escuela\nOtra cosa')).toBe(
      'La espera de una intérprete en la escuela',
    )
  })

  it('🔴 refuses any bracket, so a placeholder like [Persona A] never reaches a title', () => {
    expect(cleanTitle('[Persona A] pide intérprete en la escuela')).toBeNull()
    expect(cleanTitle('La escuela de [Domicilio B] sin intérprete')).toBeNull()
    expect(cleanTitle('Lo que vivió [Dato omitido] con el dengue')).toBeNull()
  })

  it('🔴 refuses a capitalised word the redacted source does not contain (an invented or redacted name)', () => {
    const source = 'En Cuautla la escuela no tiene intérprete. [Persona A] fue a la dirección.'
    expect(cleanTitle('La escuela de Cuautla no tiene intérprete', source)).toBe(
      'La escuela de Cuautla no tiene intérprete',
    )
    expect(cleanTitle('Doña Ofelia pide intérprete en Cuautla', source)).toBeNull()
    expect(cleanTitle('La escuela de Cuautla no tiene intérprete')).toBeNull() // no source: fail closed
  })

  it('a town and a language MAY appear (owner ruling 10-24), when the source has them', () => {
    const source = 'Soy de Tlapa. Hablo mixteco y en la clínica nadie me entendía.'
    expect(cleanTitle('Hablar mixteco en la clínica de Tlapa', source)).toBe('Hablar mixteco en la clínica de Tlapa')
  })

  it('🔴 refuses a title containing a forbidden string (a span the gate flagged on a hold)', () => {
    const source = 'Fuimos con Ofelia Ramos al centro de salud por el dengue.'
    expect(cleanTitle('Ir con ofelia ramos al centro de salud', source, ['Ofelia Ramos'])).toBeNull()
    expect(cleanTitle('Ir al centro de salud por el dengue', source, ['Ofelia Ramos'])).toBe(
      'Ir al centro de salud por el dengue',
    )
  })

  it('refuses too short, too long, or empty answers', () => {
    expect(cleanTitle('Dengue')).toBeNull()
    expect(cleanTitle('')).toBeNull()
    expect(
      cleanTitle('una historia muy larga sobre muchas cosas que pasaron en la escuela durante varios años seguidos'),
    ).toBeNull()
  })
})

describe('buildTitlePrompt', () => {
  it('carries the redacted text, capped, and the titles already used', () => {
    const long = 'palabra '.repeat(5000)
    const prompt = buildTitlePrompt(long, ['La escuela sin intérprete'])
    expect(prompt).toContain('- La escuela sin intérprete')
    expect(prompt.length).toBeLessThan(TESTIMONIO_TITLE_INPUT_CHARS + 1000)
  })
})

describe('generateTestimonioTitle', () => {
  it('asks the model once with the redacted text and returns the cleaned title', async () => {
    const { client, calls } = fakeClient(['La espera de una intérprete en la escuela'])
    const title = await generateTestimonioTitle({ client, redactedText: REDACTED, avoid: [] })
    expect(title).toBe('La espera de una intérprete en la escuela')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.unit.unitType).toBe(TESTIMONIO_TITLE_UNIT_TYPE)
    expect(calls[0]!.unit.input.userPrompt).toContain(REDACTED)
  })

  it('retries once when the answer breaks a rule, then gives up with null', async () => {
    const { client, calls } = fakeClient(['[Persona A] y la escuela', 'La escuela de Cuautla sin maestro'])
    expect(await generateTestimonioTitle({ client, redactedText: REDACTED, avoid: [] })).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('retries once when the answer repeats a title already used in the ecosistema', async () => {
    const { client, calls } = fakeClient([
      'La escuela sin intérprete de señas',
      'Una madre insiste hasta conseguir intérprete escolar',
    ])
    const title = await generateTestimonioTitle({
      client,
      redactedText: REDACTED,
      avoid: ['la escuela sin intérprete de señas'],
    })
    expect(title).toBe('Una madre insiste hasta conseguir intérprete escolar')
    expect(calls).toHaveLength(2)
  })

  it('a model failure is null, never a throw', async () => {
    const { client } = fakeClient([new Error('402 budget'), new Error('402 budget')])
    await expect(generateTestimonioTitle({ client, redactedText: REDACTED, avoid: [] })).resolves.toBeNull()
  })

  it('an empty redacted text is null with no model call', async () => {
    const { client, calls } = fakeClient(['x'])
    expect(await generateTestimonioTitle({ client, redactedText: '   ', avoid: [] })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('refreshTestimonioTitle', () => {
  it('writes the title guarded on the exact redacted text it was made from', async () => {
    const { client } = fakeClient(['La espera de una intérprete en la escuela'])
    const { store, writes } = fakeStore(['Otro título ya usado aquí'])
    const out = await refreshTestimonioTitle({ docId: 7, organizationId: 1, redactedText: REDACTED, client, store })
    expect(out).toEqual({ status: 'written', title: 'La espera de una intérprete en la escuela' })
    expect(store.otherTitles).toHaveBeenCalledWith(1, 7)
    expect(writes).toEqual([{ docId: 7, title: 'La espera de una intérprete en la escuela', redactedText: REDACTED }])
  })

  it('🔴 a failed generation writes NULL, so the UI falls back to "Testimonio · <tema>"', async () => {
    const { client } = fakeClient([new Error('down'), new Error('down')])
    const { store, writes } = fakeStore()
    const out = await refreshTestimonioTitle({ docId: 7, organizationId: 1, redactedText: REDACTED, client, store })
    expect(out.status).toBe('failed')
    expect(writes).toEqual([{ docId: 7, title: null, redactedText: REDACTED }])
  })

  it('a HELD row is titled from its heldText, guarded on `held`, survivors forbidden', async () => {
    const held = 'Fuimos con Ofelia Ramos al centro de salud por el dengue.'
    const { client } = fakeClient(['Ir con ofelia ramos al centro de salud', 'Ir al centro de salud por el dengue'])
    const { store, writes } = fakeStore()
    const out = await refreshTestimonioTitle({
      docId: 8,
      organizationId: 1,
      redactedText: held,
      client,
      store,
      source: 'held',
      forbidden: ['Ofelia Ramos'],
    })
    expect(out).toEqual({ status: 'written', title: 'Ir al centro de salud por el dengue' })
    expect(writes).toEqual([{ docId: 8, title: 'Ir al centro de salud por el dengue', redactedText: held, source: 'held' }])
  })

  it('reports stale when the row changed under it (re-gated, held, rejected)', async () => {
    const { client } = fakeClient(['La espera de una intérprete en la escuela'])
    const { store } = fakeStore([], 0)
    const out = await refreshTestimonioTitle({ docId: 7, organizationId: 1, redactedText: REDACTED, client, store })
    expect(out.status).toBe('stale')
  })
})

describe('scheduleTestimonioTitle', () => {
  it('never runs for a documento or a conversación', async () => {
    const run = vi.fn(async () => ({ status: 'written' as const, title: 'x' }))
    expect(scheduleTestimonioTitle({ contentKind: 'documento', docId: 1, organizationId: 1, redactedText: 'x', run })).toBe(false)
    expect(scheduleTestimonioTitle({ contentKind: 'conversacion', docId: 1, organizationId: 1, redactedText: 'x', run })).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs detached for a testimonio and swallows any failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(scheduleTestimonioTitle({ contentKind: 'testimonio', docId: 1, organizationId: 1, redactedText: 'x', run })).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(run).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('TESTIMONIO_TITLES=off turns it off', () => {
    const run = vi.fn()
    process.env.TESTIMONIO_TITLES = 'off'
    try {
      expect(scheduleTestimonioTitle({ contentKind: 'testimonio', docId: 1, organizationId: 1, redactedText: 'x', run })).toBe(false)
    } finally {
      delete process.env.TESTIMONIO_TITLES
    }
    expect(run).not.toHaveBeenCalled()
  })
})
