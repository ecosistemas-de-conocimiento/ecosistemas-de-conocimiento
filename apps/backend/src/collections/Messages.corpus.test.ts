/**
 * 🔴 `POST /api/messages` IS A CORPUS WRITE, AND THIS IS THE GATE ON IT.
 *
 * A `messages` row used to be inert: it was chat history, read back by its
 * owner, and nothing downstream cared how it got there. That changed the moment
 * `Messages.afterChange` started pushing turns into the ecosistema's SHARED
 * corpus, because two long-standing gaps then composed into one injection:
 *
 *   1. `create` access is "any signed-in user" — Payload's create-time check has
 *      no document to constrain against — and NOTHING verified that `session`
 *      belonged to the caller. Session ids are sequential integers, so another
 *      ecosistema's corpus is guessable, not just reachable.
 *   2. `redactedText` and `corpusStatus` were declared `admin: { readOnly: true }`,
 *      which is a UI affordance and not access control. A request body could
 *      supply both, and `conversationIngest` trusts a stored `redactedText` as
 *      "already gated" — so supplying one SKIPS THE ANONYMISATION GATE.
 *
 * Composed: `POST /api/messages { session: <a stranger's>, role: 'assistant',
 * content: 'x', redactedText: '<anything>' }` put attacker-chosen text into
 * somebody else's shared corpus, labelled as a previous assistant answer, past
 * the gate — into a corpus with NO PER-DOCUMENT DELETE.
 *
 * ⚠ These tests exercise the hook directly rather than through HTTP, for the
 * same reason `Documents.tenancy.test.ts` does: the hook is the rule, and a
 * `beforeValidate` hook runs on every write path Payload has.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { protectMessageCorpusState } from './Messages'

const ANA = 1
const BEN = 2

const ANA_SESSION = 100
const BEN_SESSION = 200

/**
 * `assertSessionOwnedBy` also asks for an active account, an active membership
 * and an active ecosistema (code audit 2026-10-28, item 4). This answers those
 * three reads from a membership map, the way Payload would.
 */
function activeMembershipFinder(memberOf: Record<number, number[]>) {
  return vi.fn(async ({ collection, where }: { collection: string; where: { and: Array<Record<string, { equals?: unknown; in?: unknown[] }>> } }) => {
    const first = where.and[0] ?? {}
    if (collection === 'users') return { docs: [{ id: first.id?.equals, isActive: true }] }
    if (collection === 'memberships') {
      const user = Number(first.user?.equals)
      return { docs: (memberOf[user] ?? []).map((organization, i) => ({ id: i + 1, user, organization, role: 'member', isActive: true })) }
    }
    return { docs: (first.id?.in ?? []).map((id) => ({ id, slug: `eco-${String(id)}`, isActive: true })) }
  })
}

function reqAs(userId: number | null): PayloadRequest {
  const sessions: Record<string, { user: number; organization: number }> = {
    [ANA_SESSION]: { user: ANA, organization: 10 },
    [BEN_SESSION]: { user: BEN, organization: 20 },
  }
  return {
    user: userId === null ? null : { id: userId, isActive: true },
    context: {},
    payload: {
      findByID: vi.fn(async ({ id }: { id: number | string }) => {
        const row = sessions[String(id)]
        if (!row) throw new Error('NotFound')
        return { id, ...row }
      }),
      find: activeMembershipFinder({ [ANA]: [10], [BEN]: [20] }),
    },
  } as unknown as PayloadRequest
}

const run = (
  data: Record<string, unknown>,
  operation: 'create' | 'update',
  originalDoc: Record<string, unknown> | undefined,
  userId: number | null,
) =>
  protectMessageCorpusState({
    data,
    operation,
    originalDoc,
    req: reqAs(userId),
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

const create = (data: Record<string, unknown>, userId: number | null) =>
  run(data, 'create', undefined, userId)

const update = (
  data: Record<string, unknown>,
  originalDoc: Record<string, unknown>,
  userId: number,
) => run(data, 'update', originalDoc, userId)

describe('🔴 the session must be the caller’s own', () => {
  it('refuses a message aimed at someone else’s conversation', async () => {
    // The injection: Ben files a turn in Ana's thread, and the ingest hook then
    // derives ANA's ecosistema corpus from that row.
    await expect(
      create({ session: ANA_SESSION, role: 'user', content: 'hola' }, BEN),
    ).rejects.toThrow()
  })

  it('refuses a session that does not exist, with the SAME message as "not yours"', async () => {
    // ⚠ "Not yours" and "does not exist" must be indistinguishable on the wire,
    // or this becomes an oracle for which session ids exist. Ids are sequential.
    const reason = async (session: number): Promise<string> => {
      try {
        await create({ session, role: 'user', content: 'hola' }, BEN)
      } catch (err) {
        const errors = (err as { data?: { errors?: Array<{ message?: string }> } }).data?.errors
        return errors?.[0]?.message ?? String(err)
      }
      throw new Error('expected a refusal')
    }
    expect(await reason(999)).toBe(await reason(ANA_SESSION))
    expect(await reason(999)).toMatch(/No such conversation/)
  })

  it('refuses a message with no conversation at all', async () => {
    await expect(create({ role: 'user', content: 'hola' }, ANA)).rejects.toThrow()
  })

  it('allows the owner', async () => {
    const next = await create({ session: ANA_SESSION, role: 'user', content: 'hola' }, ANA)
    expect(next.session).toBe(ANA_SESSION)
  })

  it('🔴 the session is immutable, so a turn cannot be re-homed into another ecosistema', async () => {
    // Re-pointing an existing turn would change which corpus it feeds, for a
    // message that may already be embedded somewhere else.
    const next = await update(
      { session: BEN_SESSION, content: 'hola' },
      { session: ANA_SESSION, role: 'user', content: 'hola', corpusStatus: 'pending' },
      ANA,
    )
    expect(next.session).toBe(ANA_SESSION)
  })
})

describe('🔴 the corpus cursor and the gate’s verdict are server-owned', () => {
  const SMUGGLED = {
    redactedText: 'texto que nunca pasó por el filtro',
    corpusStatus: 'pending',
    corpusIngestId: 'ing_forged',
    corpusError: null,
    anonymisationReport: { stages: [], pseudonyms: 0 },
  }

  it('overwrites every one of them on create', async () => {
    // 🔴 A client-supplied `redactedText` is the gate bypass: conversation
    // ingest treats a stored redaction as "already cleared" and enqueues it.
    const next = await create(
      { session: ANA_SESSION, role: 'assistant', content: 'hola', ...SMUGGLED },
      ANA,
    )
    expect(next.redactedText).toBeNull()
    expect(next.corpusIngestId).toBeNull()
    expect(next.corpusError).toBeNull()
    expect(next.anonymisationReport).toBeNull()
  })

  /**
   * 🔴 THIS TEST EXISTS BECAUSE ITS PREDECESSOR ASSERTED THE BUG.
   *
   * The old version asserted `not.toHaveProperty('corpusStatus')` on create,
   * matching a hook that DELETED the key on the belief that Payload would then
   * apply the field's `defaultValue`. Payload applies defaults BEFORE this
   * hook, so deleting the key left a `required` field empty and
   * `POST /api/messages` answered 400 for every caller in the product — the
   * route the web BFF writes every chat turn through.
   *
   * A green suite is not evidence when the assertion is a transcript of the
   * implementation. This one asserts the VALUE the row must start life with,
   * which is a claim about the product and survives a rewrite of the hook.
   */
  it('starts a new turn at `pending`, never absent — an empty required field 400s', async () => {
    const next = await create(
      { session: ANA_SESSION, role: 'assistant', content: 'hola', ...SMUGGLED },
      ANA,
    )
    expect(next.corpusStatus).toBe('pending')
  })

  it('forces `pending` even when the client asks for `skipped`', async () => {
    // `skipped` means "this turn will never be offered to the corpus". Letting a
    // client choose it at creation is a quiet, permanent opt-out of the whole
    // conversation-ingest path — invisible afterwards, because a skipped row
    // looks exactly like one the server decided to skip.
    const next = await create(
      { session: ANA_SESSION, role: 'user', content: 'hola', corpusStatus: 'skipped' },
      ANA,
    )
    expect(next.corpusStatus).toBe('pending')
  })

  it('pins them to the stored values on update', async () => {
    // ⚠ PINNED, not deleted. `corpusStatus` is `required`, and deleting it on an
    // update fails validation on every ordinary PATCH — the same bug that once
    // made every document rename 400.
    const next = await update(
      { content: 'hola', ...SMUGGLED },
      {
        session: ANA_SESSION,
        role: 'assistant',
        content: 'hola',
        corpusStatus: 'ingested',
        corpusIngestId: 'ing_real',
        redactedText: 'lo que el filtro produjo',
      },
      ANA,
    )
    expect(next.corpusStatus).toBe('ingested')
    expect(next.corpusIngestId).toBe('ing_real')
    expect(next.redactedText).toBe('lo que el filtro produjo')
  })

  it('🔴 a client cannot reset an ingested turn to `pending` to force a re-embed', async () => {
    // Re-embedding is the expensive failure this whole design avoids, and it is
    // also how you would get a second copy of one turn into the corpus.
    const next = await update(
      { corpusStatus: 'pending' },
      { session: ANA_SESSION, role: 'user', content: 'hola', corpusStatus: 'ingested' },
      ANA,
    )
    expect(next.corpusStatus).toBe('ingested')
  })
})

describe('editing the text invalidates the redaction', () => {
  it('clears the stored redaction while the turn is still ours to hold', async () => {
    // `redactedText` is the gate's output for the OLD content; keeping it would
    // embed a redaction of something the person no longer said.
    const next = await update(
      { content: 'texto nuevo' },
      {
        session: ANA_SESSION,
        role: 'user',
        content: 'texto viejo',
        corpusStatus: 'held-gate',
        redactedText: 'viejo censurado',
      },
      ANA,
    )
    expect(next.redactedText).toBeNull()
    expect(next.corpusStatus).toBe('pending')
  })

  it('⚠ leaves an already-ingested turn alone, because there is no per-document delete', async () => {
    // Resetting the cursor would APPEND a second copy rather than replace the
    // first. The corpus keeping the older text is a property of
    // retirement-not-deletion, not something this hook can fix.
    const next = await update(
      { content: 'texto nuevo' },
      {
        session: ANA_SESSION,
        role: 'user',
        content: 'texto viejo',
        corpusStatus: 'ingested',
        redactedText: 'viejo censurado',
      },
      ANA,
    )
    expect(next.corpusStatus).toBe('ingested')
    expect(next.redactedText).toBe('viejo censurado')
  })
})

describe('server-side writes', () => {
  it('pass through untouched — that is the ingest pipeline writing its own state', async () => {
    // `overrideAccess: true` with no `req.user`. There is nobody to impersonate,
    // and this is the path the gate itself writes `redactedText` on.
    const next = await run(
      { session: ANA_SESSION, corpusStatus: 'embedding', redactedText: 'censurado' },
      'update',
      { session: ANA_SESSION },
      null,
    )
    expect(next.corpusStatus).toBe('embedding')
    expect(next.redactedText).toBe('censurado')
  })
})
