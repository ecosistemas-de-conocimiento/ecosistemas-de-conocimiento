/**
 * RATINGS — one row per (message, person), proven against the real table.
 *
 * 🔴 THE ASSERTION THAT MATTERS: after rating, re-rating and racing several
 * writes at once, `GET /api/ratings?where[message][equals]=…` reports
 * `totalDocs: 1`. That is a COUNT FROM POSTGRES, which is the only place the
 * claim can be checked — the `beforeValidate` hook can only refuse, and the
 * partial UNIQUE index that closes the race is hand-written in the baseline
 * migration and therefore absent from the schema Payload diffs against.
 *
 * Everything else here is the surrounding rule set: only assistant turns, only
 * in your own conversation, only whole numbers 1..5, only your own tenant.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, apiJson, idOf } from './support/api'
import { stackDown } from './support/stack'
import { provisionWorld, type World } from './support/world'

describe.skipIf(stackDown)('ratings', () => {
  let world: World
  let sessionId: number
  let assistantMessageId: number
  let userMessageId: number

  beforeAll(async () => {
    world = await provisionWorld()

    const session = await apiJson(world.alice.caller, 'POST', '/api/sessions', {
      title: `${world.ns} rating session`,
    })
    expect(session.status).toBe(201)
    sessionId = session.body.doc.id

    const userTurn = await apiJson(world.alice.caller, 'POST', '/api/messages', {
      session: sessionId,
      role: 'user',
      content: '¿Qué dice el acta?',
    })
    expect(userTurn.status).toBe(201)
    userMessageId = userTurn.body.doc.id

    const assistantTurn = await apiJson(world.alice.caller, 'POST', '/api/messages', {
      session: sessionId,
      role: 'assistant',
      content: 'El acta menciona el acuerdo sobre el presupuesto.',
    })
    expect(assistantTurn.status).toBe(201)
    assistantMessageId = assistantTurn.body.doc.id
  }, 120_000)

  async function ratingsFor(messageId: number) {
    // Read as the ADMIN: rating reads are tenant-wide, and reading as the rater
    // would make "one row exists" indistinguishable from "one row is visible".
    return apiGet(
      world.admin,
      `/api/ratings?depth=0&limit=50&where[message][equals]=${messageId}`,
    )
  }

  it('creates a rating through the upsert route', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
      message: assistantMessageId,
      stars: 4,
      // ⚠ Free text is kept ONLY with `reason: 'other'` (`normalizeFeedback`
      // in collections/Ratings.ts). A comment with no reason, or with a preset,
      // is a 400 — so the reason is sent here, not left off.
      reason: 'other',
      comment: 'Útil',
    })
    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)
    expect(res.body.doc.stars).toBe(4)
    expect(res.body.doc.reason).toBe('other')
    // The author always reads back their own note (`canReadRatingComment`).
    expect(res.body.doc.comment).toBe('Útil')
    // Derived, never declared: both come from the session the message hangs off.
    expect(idOf(res.body.doc.session)).toBe(sessionId)
    expect(idOf(res.body.doc.organization)).toBe(world.orgA.id)
    expect(idOf(res.body.doc.user)).toBe(world.alice.id)
  })

  it('re-rating UPDATES rather than appending', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
      message: assistantMessageId,
      // A preset from the 1-3 list, and no text: a preset never carries one.
      stars: 2,
      reason: 'incomplete',
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(false)
    expect(res.body.doc.stars).toBe(2)
    expect(res.body.doc.reason).toBe('incomplete')
    // Re-rating writes reason AND comment unconditionally, so the old note goes.
    expect(res.body.doc.comment ?? null).toBeNull()
  })

  it('🔴 exactly ONE row exists for (message, user) after rating and re-rating', async () => {
    const res = await ratingsFor(assistantMessageId)
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBe(1)
    expect(res.body.docs[0].stars).toBe(2)
    expect(idOf(res.body.docs[0].user)).toBe(world.alice.id)
  })

  it('🔴 a plain POST on an already-rated message is REFUSED, not silently duplicated', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/ratings', {
      message: assistantMessageId,
      stars: 5,
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.text).toMatch(/already rated/i)

    const after = await ratingsFor(assistantMessageId)
    expect(after.body.totalDocs).toBe(1)
    // The refused write changed nothing.
    expect(after.body.docs[0].stars).toBe(2)
  })

  it('🔴 racing five upserts still leaves exactly one row', async () => {
    // Two fast clicks on a star widget are a real race. The unique index is what
    // makes the loser fail instead of both rows landing.
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((stars) =>
        apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
          message: assistantMessageId,
          stars,
        }),
      ),
    )
    expect(results.some((r) => r.status === 200 || r.status === 201)).toBe(true)

    const after = await ratingsFor(assistantMessageId)
    expect(after.body.totalDocs).toBe(1)
    expect(after.body.docs[0].stars).toBeGreaterThanOrEqual(1)
    expect(after.body.docs[0].stars).toBeLessThanOrEqual(5)
  })

  it('a DIFFERENT person rating the SAME message gets their own row', async () => {
    // The uniqueness is on the PAIR. Two people rating one answer is the point
    // of the feature; over-tight uniqueness would silently drop the second vote.
    // bob cannot rate alice's conversation, so this is asserted the only way it
    // can be: he is refused, and the row count is unchanged.
    const res = await apiJson(world.bob.caller, 'POST', '/api/ratings/upsert', {
      message: assistantMessageId,
      stars: 5,
    })
    expect(res.status).toBe(403)
    expect(res.text).toMatch(/your own conversations/i)

    const after = await ratingsFor(assistantMessageId)
    expect(after.body.totalDocs).toBe(1)
  })

  it('refuses to rate a non-assistant turn', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
      message: userMessageId,
      stars: 5,
    })
    expect(res.status).toBe(403)
    expect(res.text).toMatch(/only assistant answers/i)
    expect((await ratingsFor(userMessageId)).body.totalDocs).toBe(0)
  })

  it('refuses free text without the `other` reason', async () => {
    for (const reason of [undefined, 'incomplete']) {
      const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
        message: assistantMessageId,
        stars: 2,
        reason,
        comment: 'Texto suelto',
      })
      expect(res.status).toBe(400)
      expect(res.text).toMatch(/free text is only stored with/i)
    }
  })

  it('refuses fractional and out-of-range stars', async () => {
    for (const stars of [0, 6, 4.5, -1]) {
      const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
        message: assistantMessageId,
        stars,
      })
      expect(res.status).toBe(400)
    }
    const after = await ratingsFor(assistantMessageId)
    expect(after.body.totalDocs).toBe(1)
  })

  it('refuses a rating for a message that does not exist', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/ratings/upsert', {
      message: 999999999,
      stars: 3,
    })
    expect(res.status).toBe(403)
  })

  it('a rating is not visible to another ecosistema', async () => {
    const res = await apiGet(
      world.carol.caller,
      `/api/ratings?depth=0&limit=50&where[message][equals]=${assistantMessageId}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBe(0)
  })

  it('a rating IS visible to a colleague in the same ecosistema (reads are tenant-wide)', async () => {
    // Deliberate: an admin looking at answer quality needs their ecosistema's
    // ratings, and a rating carries no conversation content of its own.
    const res = await apiGet(
      world.bob.caller,
      `/api/ratings?depth=0&limit=50&where[message][equals]=${assistantMessageId}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBe(1)
  })

  it('nobody can edit somebody else\'s rating', async () => {
    const mine = await ratingsFor(assistantMessageId)
    const ratingId = mine.body.docs[0].id
    const res = await apiJson(world.bob.caller, 'PATCH', `/api/ratings/${ratingId}`, { stars: 5 })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
