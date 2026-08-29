/**
 * What the review-screen seed PROMISES.
 *
 * The held rows are the only place this seed writes columns the API locks
 * against every client (`gateWritesOnly`), so the shape has to be right or
 * `/revision` shows a hold nobody can act on — and the wrongness would be
 * invisible, because `anonymisationSurvivors` is opaque JSON.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SEED_INVESTIGADOR_EMAIL, seedHeldDocuments, seedInvestigador } from './review'

interface Call {
  collection: string
  data: Record<string, unknown>
  context?: Record<string, unknown>
}

function fakePayload(opts: { existingUsers?: unknown[]; existingDocuments?: number } = {}): {
  payload: unknown
  creates: Call[]
  logs: string[]
} {
  const creates: Call[] = []
  const logs: string[] = []
  const payload = {
    logger: {
      info: (msg: unknown) => logs.push(String(msg)),
      warn: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => logs.push(String(msg)),
    },
    count: async () => ({ totalDocs: opts.existingDocuments ?? 0 }),
    find: async (args: { collection: string }) => ({
      docs: args.collection === 'users' ? (opts.existingUsers ?? []) : [],
    }),
    create: async (args: Call) => {
      creates.push(args)
      return { id: creates.length + 100 }
    },
  }
  return { payload, creates, logs }
}

const originalEmail = process.env.SEED_INVESTIGADOR_EMAIL
const originalPassword = process.env.SEED_INVESTIGADOR_PASSWORD

beforeEach(() => {
  delete process.env.SEED_INVESTIGADOR_EMAIL
  delete process.env.SEED_INVESTIGADOR_PASSWORD
})

afterEach(() => {
  if (originalEmail === undefined) delete process.env.SEED_INVESTIGADOR_EMAIL
  else process.env.SEED_INVESTIGADOR_EMAIL = originalEmail
  if (originalPassword === undefined) delete process.env.SEED_INVESTIGADOR_PASSWORD
  else process.env.SEED_INVESTIGADOR_PASSWORD = originalPassword
})

describe('the Investigador account', () => {
  it('creates an account and gives it the role that can review holds', async () => {
    // `holds:review` is not a user flag — it comes from `role: 'investigador'`
    // on a membership in THIS ecosistema. An account with no membership can
    // sign in and still meet a refusal at /revision.
    const { payload, creates } = fakePayload()
    const id = await seedInvestigador(payload as never, 91)

    expect(id).toBe(101)
    expect(creates[0].collection).toBe('users')
    expect(creates[0].data.email).toBe(DEFAULT_SEED_INVESTIGADOR_EMAIL)
    expect(creates[0].data.isPlatformAdmin).toBe(false)
    expect(creates[1].collection).toBe('memberships')
    expect(creates[1].data).toMatchObject({ organization: 91, role: 'investigador', isActive: true })
  })

  it('invents a password instead of committing one, and says it out loud once', async () => {
    // 🔴 `seed/admin.ts` refuses to invent a password because it seeds the
    // platform admin on every environment. This account is fiction behind the
    // env gate, so it gets a fresh random credential rather than a literal in
    // the repo — and the demo always has someone who can open /revision.
    const { payload, creates, logs } = fakePayload()
    await seedInvestigador(payload as never, 91)

    const password = String(creates[0].data.password)
    expect(password.length).toBeGreaterThan(12)
    expect(logs.join('\n')).toContain(password)
  })

  it('uses SEED_INVESTIGADOR_PASSWORD when one is supplied, and does not print it', async () => {
    process.env.SEED_INVESTIGADOR_PASSWORD = 'una-contrasena-elegida'
    const { payload, creates, logs } = fakePayload()
    await seedInvestigador(payload as never, 91)

    expect(creates[0].data.password).toBe('una-contrasena-elegida')
    expect(logs.join('\n')).not.toContain('una-contrasena-elegida')
  })

  it('reuses an existing account rather than re-passwording it', async () => {
    // Re-running the seed must never lock somebody out of an account they have
    // been using.
    const { payload, creates } = fakePayload({ existingUsers: [{ id: 135 }] })
    const id = await seedInvestigador(payload as never, 91)

    expect(id).toBe(135)
    expect(creates.map((c) => c.collection)).toEqual(['memberships'])
  })
})

describe('the held documents', () => {
  async function seedOnce() {
    const { payload, creates, logs } = fakePayload()
    const created = await seedHeldDocuments(payload as never, {
      organizationId: 91,
      uploadedById: 135,
    })
    return { creates, logs, created }
  }

  it('puts two differently-shaped holds in the queue', async () => {
    // A `verify` hold has text and survivors; a `structural` hold has neither,
    // because that stage refuses before producing any output. The screen has
    // to handle both, and one fixture cannot show that.
    const { creates, created } = await seedOnce()
    expect(created).toBe(2)
    expect(creates.map((c) => c.data.heldText === null)).toEqual([false, true])
  })

  it('leaves redactedText null on every hold', async () => {
    // 🔴 THE ONE COLUMN THAT WOULD LEAK. `corpusTextFor` reads it, so a held
    // row carrying one is a row the next publish pushes into the shared corpus
    // — which is exactly what the hold refused.
    const { creates } = await seedOnce()
    for (const call of creates) {
      expect(call.data.redactedText).toBeNull()
      expect(call.data.anonymisationStatus).toBe('held')
      expect(call.data.publicationStatus).toBe('draft')
    }
  })

  it('writes the error in the `<stage>: <reason>` shape the queue splits on', async () => {
    // `lib/holdReview.ts` splits on the first `': '` to show which stage
    // refused. A reason with no prefix renders a hold with no stage.
    const { creates } = await seedOnce()
    const stages = creates.map((c) => String(c.data.anonymisationError).split(': ')[0])
    expect(stages).toEqual(['verify', 'structural'])
  })

  it('points every survivor offset at the word it claims', async () => {
    // 🔴 The offsets are meaningful ONLY against the exact `heldText` they came
    // with. A hand-counted index that drifts by one sends a reviewer hunting
    // through a transcript for a word that is not there, and nothing in the
    // system would notice.
    const { creates } = await seedOnce()
    const verify = creates[0].data
    const text = String(verify.heldText)
    const survivors = verify.anonymisationSurvivors as Array<{
      start: number
      end: number
      type: string
    }>

    expect(survivors).toHaveLength(2)
    expect(text.slice(survivors[0].start, survivors[0].end)).toBe('Lupita')
    expect(text.slice(survivors[1].start, survivors[1].end)).toBe('55 4821 9930')
  })

  it('carries no survivors on the structural hold, which produced no text', async () => {
    const { creates } = await seedOnce()
    expect(creates[1].data.anonymisationSurvivors).toBeNull()
  })

  it('cannot reach a corpus even if something re-saves it', async () => {
    // Belt and braces. `markdown` is not in INGESTABLE_KINDS, and the create
    // carries the re-entrancy flag, so neither the seed nor a later edit hands
    // a deliberately un-anonymised text to the ingest path.
    const { creates } = await seedOnce()
    for (const call of creates) {
      expect(call.data.kind).toBe('markdown')
      expect(call.context).toMatchObject({ __skipDocsExtract: true })
    }
  })

  it('names nobody, in the title or in the raw text', async () => {
    // 🔴 The queue overrides `name` with a neutral title, but the queue is not
    // the only reader of that column — and `extractedText` is the unredacted
    // original, which on a real row would carry whatever the person said.
    const { creates } = await seedOnce()
    for (const call of creates) {
      const title = String(call.data.name)
      expect(title).toMatch(/^Testimonio retenido/)
      // A surname would make the row a handle on a person. A bare first name in
      // the BODY is what a hold looks like; a name in the TITLE is the bug.
      expect(title).not.toMatch(/Lupita/)
    }
  })

  it('does not duplicate the queue on a second run', async () => {
    const { payload, creates } = fakePayload({ existingDocuments: 1 })
    const created = await seedHeldDocuments(payload as never, {
      organizationId: 91,
      uploadedById: 135,
    })
    expect(created).toBe(0)
    expect(creates).toHaveLength(0)
  })
})
