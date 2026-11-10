/**
 * P-07 (audit 2026-11-10): no log line interpolates a database error's text.
 *
 * drizzle's `DrizzleQueryError` puts the failed query's params (a whole
 * testimony) into `message`, `String(err)` and `stack`. The Payload logger's
 * `err` serializer redacts an error object, not text a caller already turned
 * into a string. Each case below throws that error, built as production
 * builds it (see `errorSummary.test.ts`), through the real code path, and
 * reads every line the logger or `log` received.
 */
import { createRequire } from 'node:module'

import { CapabilityNegotiationError } from '@edc/ai-client'
import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureEcosystemBudgets, provisionEcosystemOrg } from './provisionEcosystem'
import { eraseTurnsAfterCommit, scheduleTurnErasure } from './conversationTurnErasure'
import { repairHeldPublished } from './repairHeldPublished'
import { repairPendingPublished } from './repairPendingPublished'
import { regateMemberDocumentos } from './regateMemberDocumentos'

const { negotiate } = vi.hoisted(() => ({ negotiate: vi.fn() }))
vi.mock('./aiClient', () => ({ getAppAIClient: () => ({ capabilities: { negotiate } }) }))

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'

const requireFromPg = createRequire(
  createRequire(createRequire(import.meta.url).resolve('@payloadcms/db-postgres')).resolve('pg'),
)

function dbError(code = '57P01'): Error {
  const { DatabaseError } = requireFromPg('pg-protocol') as {
    DatabaseError: new (message: string, length: number, name: string) => Error & Record<string, unknown>
  }
  const cause = new DatabaseError(`value too long, near "${SECRET}"`, 0, 'error')
  cause.code = code
  cause.detail = `Key (extracted_text)=(${SECRET}) already exists.`
  return new DrizzleQueryError(
    'update "documents" set "extracted_text" = $1, "redacted_text" = $2 where "documents"."id" = $3',
    [SECRET, `[Persona 1] ${SECRET}`, 42],
    cause,
  )
}

/** A logger whose every call lands in `lines`, as the JSON a transport would write. */
function capture() {
  const lines: string[] = []
  const push = (...args: unknown[]) => void lines.push(JSON.stringify(args))
  return { lines, logger: { info: vi.fn(push), warn: vi.fn(push), error: vi.fn(push), debug: vi.fn(push) } }
}

function expectWithheld(lines: string[]) {
  expect(lines.length, 'the failure was logged').toBeGreaterThan(0)
  const all = lines.join('\n')
  expect(all).not.toContain('Lucía')
  expect(all).not.toContain('Failed query')
  expect(all).toContain('DrizzleQueryError(57P01)')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('provisionEcosystem', () => {
  it('🔴 listing the ecosistemas fails: the line names the error, not the row', async () => {
    const { lines, logger } = capture()
    const payload = { find: async () => Promise.reject(dbError()) }
    await ensureEcosystemBudgets(payload, { logger })
    expectWithheld(lines)
  })

  it('🔴 a provision or readiness failure that is a database error is withheld too', async () => {
    const { lines, logger } = capture()
    await provisionEcosystemOrg(7, { logger, client: async () => ({ tenant: { provision: () => Promise.reject(dbError()) } }) })
    await provisionEcosystemOrg(7, { logger, client: () => Promise.reject(dbError()) })
    await ensureEcosystemBudgets(
      { find: async () => ({ docs: [{ id: 1 }] }) },
      {
        logger,
        client: async () => ({ tenant: { provision: async () => ({}), readiness: () => Promise.reject(dbError()) } }),
      },
    )
    expect(lines.filter((l) => l.includes('DrizzleQueryError(57P01)'))).toHaveLength(3)
    expectWithheld(lines)
  })

  it('an ordinary error keeps its message', async () => {
    const { lines, logger } = capture()
    await provisionEcosystemOrg(7, { logger, client: async () => ({ tenant: { provision: () => Promise.reject(new Error('HTTP 503')) } }) })
    expect(lines.join('')).toContain('HTTP 503')
  })
})

describe('conversationTurnErasure', () => {
  const plan = { sessionId: 7, xid: null, organizationId: 42, corpus: 'eco-42', messageIds: [1, 2] }
  const payloadWith = (logger: ReturnType<typeof capture>['logger'], findByID = async () => null) =>
    ({ logger, findByID }) as never

  it('🔴 no ai-service client (a database error): withheld', async () => {
    const { lines, logger } = capture()
    await eraseTurnsAfterCommit(plan, { payload: payloadWith(logger), corpusClient: () => Promise.reject(dbError()) })
    expectWithheld(lines)
  })

  it('🔴 one turn fails to erase: withheld', async () => {
    const { lines, logger } = capture()
    const deleteDocument = () => Promise.reject(dbError())
    await eraseTurnsAfterCommit(plan, { payload: payloadWith(logger), corpusClient: () => ({ admin: { deleteDocument } }) })
    expectWithheld(lines)
  })

  it('🔴 the whole background erase throws: withheld', async () => {
    const { lines, logger } = capture()
    scheduleTurnErasure(payloadWith(logger, () => Promise.reject(dbError())), plan)
    await vi.waitFor(() => expect(lines.some((l) => l.includes('post-commit turn erasure failed'))).toBe(true))
    expectWithheld(lines.filter((l) => l.includes('failed')))
  })
})

describe('capabilityCheck', () => {
  // A capability error is an HTTP answer, never a database error: the catch
  // rethrows anything else. Its message stays; drizzle text in it would not.
  const run = async () => {
    const mod = await import('./capabilityCheck')
    mod._resetCapabilityCheckForTests()
    const { lines, logger } = capture()
    await mod.checkAIServiceCapabilities(logger as never)
    return lines
  }

  it('an unreachable ai-service keeps its message', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
    vi.stubEnv('AI_SERVICE_API_KEY', 'k')
    negotiate.mockRejectedValueOnce(
      new CapabilityNegotiationError('ai-service at http://ai.test is unreachable.', {
        consumer: 'edc-backend',
        baseUrl: 'http://ai.test',
        missing: [],
        status: 'unreachable',
      }),
    )
    expect((await run()).join('')).toContain('ai-service at http://ai.test is unreachable.')
  })

  it('🔴 a message that quotes a failed query is withheld', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
    vi.stubEnv('AI_SERVICE_API_KEY', 'k')
    vi.stubEnv('AI_CAPABILITY_MODE', 'warn')
    negotiate.mockRejectedValueOnce(
      new CapabilityNegotiationError(dbError().message, {
        consumer: 'edc-backend',
        baseUrl: 'http://ai.test',
        missing: ['orgDelegation'],
        status: 'missing',
      }),
    )
    const all = (await run()).join('')
    expect(all).not.toContain('Lucía')
    expect(all).toContain('CapabilityNegotiationError')
  })
})

describe('the repair and re-gate scripts', () => {
  const failingUpdate = { update: () => Promise.reject(dbError()) }
  const deleter = { admin: { setDocumentValidity: async () => ({}), deleteDocument: async () => ({}) } } as never

  it('🔴 repairHeldPublished: a failed row update is withheld', async () => {
    const lines: string[] = []
    const row = {
      id: 1, organization: 1, uploadedBy: 2, contentKind: 'testimonio', publicationStatus: 'published',
      anonymisationStatus: 'held', redactedText: null, heldText: 'x',
    }
    const report = await repairHeldPublished({ find: async () => ({ docs: [row] }), ...failingUpdate } as never, {
      apply: true,
      clientFor: () => deleter,
      log: (l) => lines.push(l),
    })
    expect(report.failed).toEqual([1])
    expectWithheld(lines.filter((l) => l.includes('NOT repaired')))
  })

  it('🔴 repairPendingPublished: a failed live check is withheld', async () => {
    const lines: string[] = []
    const report = await repairPendingPublished(
      { find: async () => ({ docs: [{ id: 5, organization: 1 }] }), update: async () => ({}) } as never,
      () => Promise.reject(dbError()),
      { delayMs: 0, log: (l) => lines.push(l) },
    )
    expect(report.errorIds).toEqual(['5'])
    expectWithheld(lines.filter((l) => l.startsWith('error')))
  })

  it('🔴 regateMemberDocumentos: a failed row update is withheld', async () => {
    const lines: string[] = []
    const row = { id: 3, organization: 1, uploadedBy: 2, contentKind: 'documento', anonymise: false, publicationStatus: 'published' }
    const report = await regateMemberDocumentos({ find: async () => ({ docs: [row] }), ...failingUpdate } as never, {
      apply: true,
      isParticipant: async () => true,
      clientFor: () => deleter,
      gate: async () => ({}),
      log: (l) => lines.push(l),
    })
    expect(report.failed).toEqual(['3'])
    expectWithheld(lines.filter((l) => l.includes('NOT processed')))
  })
})
