/**
 * OLA 11, ITEM 5: a `verify` hold where the model reported a name it could not
 * place in the text (`gate.ts`, `unlocatableSentence`). Nothing says where, or
 * whether, that name is still in `heldText`, so — like an unfinished verify —
 * it is approved only with a real edit, never as-is.
 *
 * The reason comes from the REAL gate (`runAnonymisationGate` with a scripted
 * detector), so a change to its wording fails here instead of silently
 * reopening as-is approval. Synthetic names only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './anonymise/gate'
import type { DetectorFinding, PersonDetector } from './anonymise/types'
import { HoldContentAsIsError, decideOnHold } from './holdReview'

const ORG = 7
const DOC = 77
const REVIEWER = 42
const TEXT = 'Vivo en el pueblo con mi familia. Nos vimos el martes en la plaza.'

/** Stage 3 finds nothing; verify reports names that are not in the text. */
function unlocatedInVerify(names: string[]): PersonDetector {
  let n = 0
  return {
    name: 'scripted',
    async detect() {
      n += 1
      return n === 1 ? [] : names.map((text): DetectorFinding => ({ text, type: 'persona' }))
    },
  }
}

async function gateReason(names: string[]): Promise<{ stage: string; reason: string; heldText: string }> {
  const out = await runAnonymisationGate({ contentKind: 'testimonio', text: TEXT }, { detector: unlocatedInVerify(names), verifyRounds: 1 })
  if (out.status !== 'hold') throw new Error(`expected a hold, got ${out.status}`)
  return { stage: out.stage, reason: out.reason, heldText: out.redactedText ?? TEXT }
}

function fakePayload(row: Record<string, unknown>) {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const payload = {
    find: vi.fn(async (args: { collection: string }) => {
      if (args.collection === 'memberships') {
        return { docs: [{ id: 1, user: REVIEWER, organization: ORG, role: 'investigador', isActive: true }] }
      }
      if (args.collection === 'organizations') return { docs: [{ id: ORG, slug: 'eco', isActive: true }] }
      if (args.collection === 'documents') return { docs: [row] }
      return { docs: [] }
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data)
      return { id: 500 }
    }),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => {
      updated.push(args.data)
      return {}
    }),
    delete: vi.fn(async () => ({ docs: [] })),
    logger: { warn: vi.fn() },
  } as unknown as Payload
  return { payload, created, updated }
}

const user = { id: REVIEWER, isActive: true, isPlatformAdmin: false }
const rowFor = (g: { stage: string; reason: string; heldText: string }) => ({
  id: DOC,
  name: 'x',
  organization: ORG,
  contentKind: 'testimonio',
  anonymisationStatus: 'held',
  anonymisationError: `${g.stage}: ${g.reason}`,
  anonymisationReport: { stages: [], pseudonyms: 0, addresses: 0, model: 'static' },
  anonymisationSurvivors: null,
  heldText: g.heldText,
  extractedText: TEXT,
  updatedAt: '2026-11-10T10:00:00.000Z',
})
const approve = (payload: Payload, text?: string) =>
  decideOnHold({ payload, documentId: DOC, user, decision: 'approve', ...(text === undefined ? {} : { text }) })

beforeEach(() => vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, ''))
afterEach(() => vi.unstubAllEnvs())

describe('a `verify` hold with a name the model could not place', () => {
  for (const names of [['Gumersinda Talavera'], ['Gumersinda Talavera', 'Eustaquio Bermúdez']]) {
    it(`🔴 is not approved as-is (${names.length} name${names.length > 1 ? 's' : ''}), nor with a whitespace "edit"`, async () => {
      const g = await gateReason(names)
      expect(g.stage).toBe('verify')
      const { payload, created, updated } = fakePayload(rowFor(g))
      await expect(approve(payload)).rejects.toThrow(HoldContentAsIsError)
      await expect(approve(payload, `${g.heldText} `)).rejects.toThrow(HoldContentAsIsError)
      expect(created).toHaveLength(0)
      expect(updated).toHaveLength(0)
    })
  }

  it('a real correction is approved', async () => {
    const g = await gateReason(['Gumersinda Talavera'])
    const { payload, updated } = fakePayload(rowFor(g))
    const corrected = g.heldText.replace('martes', 'jueves')
    await expect(approve(payload, corrected)).resolves.toMatchObject({ decision: 'approved' })
    expect(updated[0]!.redactedText).toBe(corrected)
  })

  it('control: a verify hold with located survivors is still approvable as-is', async () => {
    const { payload, updated } = fakePayload(
      rowFor({ stage: 'verify', reason: 'Quedó 1 dato que podría identificar a alguien. Todavía no se agregó a la búsqueda.', heldText: TEXT }),
    )
    await expect(approve(payload)).resolves.toMatchObject({ decision: 'approved' })
    expect(updated[0]!.redactedText).toBe(TEXT)
  })
})
