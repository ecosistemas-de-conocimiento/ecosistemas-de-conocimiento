/**
 * 🔴 CORPUS ISOLATION — the whole tenant boundary, in one file.
 *
 * ai-service cannot enforce any of this. It reads `{org, project}` from a
 * boot-time API-key map, so every ecosistema reaches it under one key and looks
 * like one org; it will faithfully retrieve from whatever corpus name it is
 * handed. The only thing separating one ecosistema from another — and one
 * person's drafts from their colleague's — is the NAME, and choosing that name
 * is this backend's job.
 *
 * So the whole boundary reduces to one question: **can a caller obtain a corpus
 * name that is not theirs?** Everything below answers "no", including when the
 * caller names the session explicitly — which is the real attack, because
 * `documents.session` and the corpora endpoint both take an id from the request.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  assertSessionOwnedBy,
  corporaForSession,
  draftCorpus,
  publishedCorpus,
  SessionHasNoEcosystemError,
  SessionNotOwnedError,
} from './corpus'

const ECO_A = 10
const ECO_B = 20
const ANA = 1 // in ecosistema A
const BEN = 2 // ALSO in ecosistema A — the same-ecosistema case
const CARLA = 3 // in ecosistema B

const ANA_SESSION = 100
const BEN_SESSION = 101
const CARLA_SESSION = 200
const ORPHAN_SESSION = 300 // no ecosistema

function fakePayload(): Payload {
  const sessions: Record<string, { user: number; organization: number | null }> = {
    [ANA_SESSION]: { user: ANA, organization: ECO_A },
    [BEN_SESSION]: { user: BEN, organization: ECO_A },
    [CARLA_SESSION]: { user: CARLA, organization: ECO_B },
    [ORPHAN_SESSION]: { user: ANA, organization: null },
  }
  return {
    findByID: vi.fn(async ({ id }: { id: number | string }) => {
      const row = sessions[String(id)]
      if (!row) throw new Error('NotFound')
      return { id, ...row }
    }),
  } as unknown as Payload
}

// ---------------------------------------------------------------------------

describe('corpus names', () => {
  it('give an ecosistema exactly one shared corpus', () => {
    expect(publishedCorpus(ECO_A)).toBe('eco-10')
    expect(publishedCorpus(ECO_B)).toBe('eco-20')
  })

  it('give each person their OWN draft corpus inside an ecosistema', () => {
    // ⚠ Keyed on both ids. Colleagues in one ecosistema must not share drafts.
    expect(draftCorpus(ECO_A, ANA)).toBe('eco-10-draft-1')
    expect(draftCorpus(ECO_A, BEN)).toBe('eco-10-draft-2')
    expect(draftCorpus(ECO_A, ANA)).not.toBe(draftCorpus(ECO_A, BEN))
  })

  // 🔴 An id carrying a separator could otherwise address a different corpus:
  // an organization literally named `10-draft-1` would collide with Ana's
  // drafts in ecosistema 10.
  it.each(['10-draft-1', 'a/b', 'a b', 'a:b', '../eco-20', ''])(
    'REFUSE to build a name from the unsafe id %o',
    (bad) => {
      expect(() => publishedCorpus(bad)).toThrow()
      expect(() => draftCorpus(ECO_A, bad)).toThrow()
    },
  )
})

describe('🔴 cross-ecosistema — the corpus a caller can actually obtain', () => {
  it('is their own ecosistema\'s, when they ask about their own session', async () => {
    const corpora = await corporaForSession(fakePayload(), ANA_SESSION, ANA)
    expect(corpora.published).toBe('eco-10')
    expect(corpora.draft).toBe('eco-10-draft-1')
    expect(corpora.all).toEqual(['eco-10', 'eco-10-draft-1'])
  })

  // 🔴 THE ONE THAT MATTERS. Ana explicitly names Carla's session id, which is
  // exactly what a crafted `GET /api/sessions/:id/corpora` does. She must not
  // get ecosistema B's corpus name back.
  it('is REFUSED when Ana explicitly names a session in ecosistema B', async () => {
    await expect(corporaForSession(fakePayload(), CARLA_SESSION, ANA)).rejects.toBeInstanceOf(
      SessionNotOwnedError,
    )
  })

  it('never yields ecosistema B\'s corpus to a member of ecosistema A', async () => {
    const mine = await corporaForSession(fakePayload(), ANA_SESSION, ANA)
    expect(mine.all).not.toContain(publishedCorpus(ECO_B))
    expect(mine.all).not.toContain(draftCorpus(ECO_B, CARLA))
  })
})

describe('🔴 same-ecosistema, cross-person — the risk this model introduces', () => {
  // Ana and Ben are BOTH in ecosistema A. Ana may read the shared corpus, but
  // Ben's unpublished uploads are his alone. A purely per-tenant scheme would
  // have missed this entirely.
  it('REFUSES Ana a corpus list built from Ben\'s session', async () => {
    await expect(corporaForSession(fakePayload(), BEN_SESSION, ANA)).rejects.toBeInstanceOf(
      SessionNotOwnedError,
    )
  })

  it('gives Ana and Ben the SAME shared corpus but DIFFERENT draft corpora', async () => {
    const ana = await corporaForSession(fakePayload(), ANA_SESSION, ANA)
    const ben = await corporaForSession(fakePayload(), BEN_SESSION, BEN)

    expect(ana.published).toBe(ben.published) // one ecosistema, one knowledgebase
    expect(ana.draft).not.toBe(ben.draft) // …and private drafts
    expect(ana.all).not.toContain(ben.draft)
    expect(ben.all).not.toContain(ana.draft)
  })
})

describe('a draft is reachable by its uploader in chat', () => {
  // The workflow is upload → try it in chat → publish. So the uploader's own
  // draft corpus MUST be in the list a chat turn retrieves from.
  it('includes the uploader\'s draft corpus in the retrieval set', async () => {
    const corpora = await corporaForSession(fakePayload(), ANA_SESSION, ANA)
    expect(corpora.all).toContain(draftCorpus(ECO_A, ANA))
  })

  it('lists the shared corpus first, then the private one', async () => {
    // Not cosmetic: `retrieveMulti` reports per-corpus diagnostics in order, and
    // a stable order keeps citation provenance readable.
    const corpora = await corporaForSession(fakePayload(), ANA_SESSION, ANA)
    expect(corpora.all[0]).toBe(corpora.published)
    expect(corpora.all[1]).toBe(corpora.draft)
  })
})

describe('assertSessionOwnedBy', () => {
  it('accepts the owner and reports their ecosistema', async () => {
    await expect(assertSessionOwnedBy(fakePayload(), ANA_SESSION, ANA)).resolves.toEqual({
      organizationId: ECO_A,
    })
  })

  it('compares ids as strings, so 1 and "1" are the same person', async () => {
    // Postgres returns numbers; a URL segment returns a string. A `===` here
    // would refuse every legitimate request from whichever side stringified.
    await expect(assertSessionOwnedBy(fakePayload(), String(ANA_SESSION), '1')).resolves.toEqual({
      organizationId: ECO_A,
    })
  })

  // ⚠ Both refusals must be INDISTINGUISHABLE on the wire, or this is an oracle
  // for which session ids exist — and they are sequential integers.
  it('gives the same message for "not yours" and "does not exist"', async () => {
    const notYours = await assertSessionOwnedBy(fakePayload(), CARLA_SESSION, ANA).catch(
      (e: Error) => e.message,
    )
    const missing = await assertSessionOwnedBy(fakePayload(), 999999, ANA).catch(
      (e: Error) => e.message,
    )
    expect(notYours).toBe(missing)
  })

  it('does not treat a session with no owner as public', async () => {
    const payload = {
      findByID: vi.fn(async () => ({ id: 1, user: null, organization: ECO_A })),
    } as unknown as Payload
    await expect(assertSessionOwnedBy(payload, 1, ANA)).rejects.toBeInstanceOf(SessionNotOwnedError)
  })
})

describe('a session with no ecosistema', () => {
  // It can search nothing, and saying so beats handing back a half-built list
  // that silently retrieves from `eco-null`.
  it('refuses to produce corpora rather than inventing a name', async () => {
    await expect(corporaForSession(fakePayload(), ORPHAN_SESSION, ANA)).rejects.toBeInstanceOf(
      SessionHasNoEcosystemError,
    )
  })
})
