/**
 * The four rules that make a rating trustworthy.
 *
 * A "happy path saves a row" test proves almost nothing here: the whole point
 * of this collection is what it REFUSES. Every rejection below corresponds to a
 * way the ratings table could be quietly poisoned — by rating your own prompt,
 * by rating in someone else's conversation, by filing under a tenant you do not
 * belong to, or by half a star. Each rejection is paired with the acceptance
 * that proves the check has not simply been turned into "deny everything".
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  MAX_STARS,
  MIN_STARS,
  NotRateableError,
  normalizeStars,
  resolveRateableTarget,
} from './Ratings'

const USER_A = 1
const USER_B = 2
const ORG_A = 10
const ORG_B = 20
const SESSION_A = 100
const SESSION_NO_ORG = 101
const ANSWER = 500
const PROMPT = 501
const SYSTEM_TURN = 502
const ORPHAN = 503

/**
 * One conversation owned by USER_A in ORG_A, containing an assistant answer, the
 * user's own prompt and a system turn. Plus a session with no tenant tag, for
 * the multi-organization case.
 */
function fakePayload(): Payload {
  const messages: Record<string, { role: string; session: number | null }> = {
    [ANSWER]: { role: 'assistant', session: SESSION_A },
    [PROMPT]: { role: 'user', session: SESSION_A },
    [SYSTEM_TURN]: { role: 'system', session: SESSION_A },
    [ORPHAN]: { role: 'assistant', session: null },
    600: { role: 'assistant', session: SESSION_NO_ORG },
  }
  const sessions: Record<string, { user: number; organization: number | null }> = {
    [SESSION_A]: { user: USER_A, organization: ORG_A },
    [SESSION_NO_ORG]: { user: USER_A, organization: null },
  }

  return {
    findByID: vi.fn(async ({ collection, id }: { collection: string; id: number | string }) => {
      const table = collection === 'messages' ? messages : sessions
      const row = (table as Record<string, unknown>)[String(id)]
      if (!row) throw new Error('NotFound')
      return { id, ...(row as object) }
    }),
  } as unknown as Payload
}

const target = (over: Partial<Parameters<typeof resolveRateableTarget>[0]> = {}) =>
  resolveRateableTarget({
    payload: fakePayload(),
    messageId: ANSWER,
    userId: USER_A,
    memberOrganizationIds: [ORG_A],
    ...over,
  })

// ---------------------------------------------------------------------------

describe('stars must be a whole number in range', () => {
  it.each([1, 2, 3, 4, 5])('accepts %i', (n) => {
    expect(normalizeStars(n)).toBe(n)
  })

  it('accepts the numeric string a form field sends', () => {
    expect(normalizeStars('4')).toBe(4)
  })

  // ⚠ Payload's `min`/`max` on a number field do NOT reject a fraction. A 4.5
  // that reaches the table makes every average un-reproducible, and nobody
  // notices until someone asks why the mean is 3.47 when only integers were
  // ever clicked.
  it.each([4.5, 0.5, 3.0001])('REJECTS the fraction %s', (n) => {
    expect(normalizeStars(n)).toBeNull()
  })

  it.each([0, -1, 6, 99])('REJECTS %i, outside [1,5]', (n) => {
    expect(normalizeStars(n)).toBeNull()
  })

  it.each([null, undefined, '', 'five', NaN, Infinity, {}])(
    'REJECTS the non-number %s',
    (value) => {
      expect(normalizeStars(value)).toBeNull()
    },
  )

  it('has the bounds the contract promises', () => {
    expect(MIN_STARS).toBe(1)
    expect(MAX_STARS).toBe(5)
  })
})

describe('rule 2 — only assistant answers are rateable', () => {
  it('accepts an assistant turn', async () => {
    await expect(target()).resolves.toMatchObject({ messageId: ANSWER })
  })

  // Rating your own prompt is meaningless, and every aggregate over the table
  // would silently include it.
  it('REFUSES the user\'s own prompt', async () => {
    await expect(target({ messageId: PROMPT })).rejects.toBeInstanceOf(NotRateableError)
  })

  it('REFUSES a system turn — it is not an answer either', async () => {
    await expect(target({ messageId: SYSTEM_TURN })).rejects.toBeInstanceOf(NotRateableError)
  })

  it('REFUSES a message that does not exist', async () => {
    await expect(target({ messageId: 99999 })).rejects.toBeInstanceOf(NotRateableError)
  })

  it('REFUSES an answer with no session behind it', async () => {
    await expect(target({ messageId: ORPHAN })).rejects.toBeInstanceOf(NotRateableError)
  })
})

describe('rule 3 — only in your own conversation', () => {
  // 🔴 Sessions are private. A rating on someone else's message would also be a
  // probe for whether that message exists.
  it('REFUSES an answer in another user\'s session', async () => {
    await expect(
      target({ userId: USER_B, memberOrganizationIds: [ORG_A] }),
    ).rejects.toBeInstanceOf(NotRateableError)
  })

  it('accepts when the ids differ only in type — 1 vs "1"', async () => {
    // Postgres returns numbers, a URL segment returns a string. A `===` here
    // would refuse every legitimate rating from whichever side stringified.
    await expect(target({ userId: '1' })).resolves.toMatchObject({ sessionId: SESSION_A })
  })
})

describe('rule 4 — the tenant is derived, not declared', () => {
  it('takes the organization from the session', async () => {
    await expect(target()).resolves.toMatchObject({ organizationId: ORG_A })
  })

  // 🔴 THE CROSS-TENANT ATTEMPT. The client says "file this under org B"; the
  // session says org A. The session wins, and the client's claim is ignored
  // rather than honoured.
  it('IGNORES a client-declared organization when the session has one', async () => {
    await expect(
      target({ declaredOrganization: ORG_B, memberOrganizationIds: [ORG_A, ORG_B] }),
    ).resolves.toMatchObject({ organizationId: ORG_A })
  })

  // 🔴 And when the caller is not even a member of the tenant the session names,
  // the whole rating is refused — not silently re-homed.
  it('REFUSES when the caller is not a member of the session\'s organization', async () => {
    await expect(target({ memberOrganizationIds: [ORG_B] })).rejects.toBeInstanceOf(
      NotRateableError,
    )
  })

  it('REFUSES a caller with no memberships at all', async () => {
    await expect(target({ memberOrganizationIds: [] })).rejects.toBeInstanceOf(NotRateableError)
  })

  it('falls back to the declared organization only when the session has none', async () => {
    await expect(
      target({ messageId: 600, declaredOrganization: ORG_A, memberOrganizationIds: [ORG_A] }),
    ).resolves.toMatchObject({ organizationId: ORG_A })
  })

  it('still checks membership on that fallback', async () => {
    await expect(
      target({ messageId: 600, declaredOrganization: ORG_B, memberOrganizationIds: [ORG_A] }),
    ).rejects.toBeInstanceOf(NotRateableError)
  })

  it('REFUSES when neither the session nor the request names an organization', async () => {
    // Better a clear error than a rating filed under a guess.
    await expect(target({ messageId: 600, memberOrganizationIds: [ORG_A] })).rejects.toBeInstanceOf(
      NotRateableError,
    )
  })
})

describe('the denormalized session id', () => {
  it('comes from the message, never from the request', async () => {
    // `ratings.session` exists for query convenience. If it could disagree with
    // `message.session`, "how did this conversation score?" would be wrong and
    // there would be no way to tell.
    await expect(target()).resolves.toMatchObject({ sessionId: SESSION_A })
  })
})
