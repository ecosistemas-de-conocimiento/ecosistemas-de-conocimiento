/**
 * 🔴 CONVERSATIONS BECOME CORPUS — APPEND, HOLD, RELEASE. THE THREE RULES.
 *
 * This file pins the three properties `lib/conversationIngest.ts` exists to
 * guarantee, each of which fails SILENTLY and EXPENSIVELY if it regresses:
 *
 *   1. **APPEND, NEVER RE-INGEST.** The naive "ingest the conversation on every
 *      message" re-embeds the whole thread each time: on turn 41 that is 40
 *      turns paid for again, and the corpus fills with near-identical fragments
 *      of the same exchange which then crowd real documents out of retrieval.
 *      The corpus gets bigger, more expensive AND worse. The test that catches
 *      it is `the SECOND run enqueues exactly ONE document` below — assert the
 *      SIZE of the second enqueue, not just that a second one happened.
 *
 *   2. **THE HOLD.** A conversation citing a document only its author can see
 *      must not be retrievable by the whole ecosistema, or the answer cites a
 *      source nobody else can open. ⚠ Citations live in TWO places and one of
 *      them is easy to forget — `provenance` (what retrieval actually returned)
 *      is far more common than `contextRefs` (what somebody @-mentioned).
 *      Reading only `contextRefs` lets a thread grounded in a private draft sail
 *      straight through the hold.
 *
 *   3. **THE RELEASE.** When the LAST cited draft is published the whole
 *      backlog goes out in ONE run. Half a released conversation is worse than
 *      none.
 *
 * ⚠ NO NETWORK AND NO MODEL CALL HERE. `staticDetector` is the seam: the gate
 * runs for real, its detector does not. A test that needed a live model would be
 * a test nobody runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import { staticDetector } from './anonymise'
import type { DetectorFinding, PersonDetector } from './anonymise/types'
import {
  citedDocumentIds,
  citedUnpublishedDocumentIds,
  ingestConversationTurns,
  messageIdFromExternalId,
  releaseConversationsWaitingOn,
  turnExternalId,
  ingestAssistantTurnsEnabled,
  type ConversationIngester,
} from './conversationIngest'

/**
 * ⚠ THE TESTS ABOVE THE LAST BLOCK RUN WITH ASSISTANT TURNS SWITCHED ON. They
 * were written when every assistant answer went into the corpus, and the
 * append / hold / release rules they pin hold for both roles. The production
 * default (OFF) is pinned in `assistant turns stay out of the corpus` at the end.
 */
beforeEach(() => {
  vi.stubEnv('INGEST_ASSISTANT_TURNS', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// The in-memory Payload
// ---------------------------------------------------------------------------

const ECO = 7
const OTHER_ECO = 8
const ANA = 1
const SESSION = 500

type Row = Record<string, unknown> & { id: number | string }

/**
 * Enough of Payload's `where` grammar for the four queries this module makes:
 * `{field:{equals}}`, `{field:{in}}` and `{and:[…]}`. Anything else is a query
 * the module does not run, and faking it would only invite drift.
 */
function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true
  const clause = where as Record<string, unknown>
  if (Array.isArray(clause.and)) return clause.and.every((sub) => matches(row, sub))
  return Object.entries(clause).every(([field, condition]) => {
    const cond = condition as { equals?: unknown; in?: unknown[] }
    const actual = row[field]
    // A `hasMany` relationship (documents.session) matches when ANY of its
    // values does — Payload's semantics for `equals` / `in` on an array field.
    const keys = (Array.isArray(actual) ? actual : [actual]).map((v) =>
      v && typeof v === 'object' ? (v as Row).id : v,
    )
    if ('equals' in cond) return keys.some((k) => String(k) === String(cond.equals))
    if ('in' in cond) return (cond.in ?? []).some((v) => keys.some((k) => String(v) === String(k)))
    return true
  })
}

interface Db {
  sessions: Row[]
  messages: Row[]
  documents: Row[]
  memberships: Row[]
}

function fakePayload(db: Db) {
  const table = (collection: string): Row[] => (db as unknown as Record<string, Row[]>)[collection] ?? []

  return {
    findByID: vi.fn(async ({ collection, id }: { collection: string; id: unknown }) => {
      const row = table(collection).find((r) => String(r.id) === String(id))
      if (!row) throw new Error('NotFound')
      return row
    }),
    find: vi.fn(async ({ collection, where }: { collection: string; where?: unknown }) => ({
      docs: table(collection).filter((row) => matches(row, where)),
    })),
    update: vi.fn(async ({ collection, id, data }: { collection: string; id: unknown; data: Record<string, unknown> }) => {
      const row = table(collection).find((r) => String(r.id) === String(id))
      if (row) Object.assign(row, data)
      return row
    }),
    logger: { warn: vi.fn() },
  } as unknown as Payload
}

type Enqueue = Parameters<ConversationIngester['ingest']['enqueue']>[0]

function fakeClient() {
  const calls: Enqueue[] = []
  const client: ConversationIngester = {
    ingest: {
      enqueue: async (req) => {
        calls.push(req)
        return { ingestId: `ing-${calls.length}` }
      },
    },
  }
  return { client, calls }
}

/** A detector that records how many times it was asked. Never leaves the process. */
function countingDetector(findings: readonly DetectorFinding[] = []): PersonDetector & {
  calls: () => number
} {
  const inner = staticDetector(findings)
  let n = 0
  return {
    name: inner.name,
    calls: () => n,
    async detect(args) {
      n += 1
      return inner.detect(args)
    },
  }
}

/** A session with `messages` turns, ready to run. */
function seed(
  messages: Array<Partial<Row> & { id: number }>,
  extra: Partial<Db> = {},
): Db {
  return {
    sessions: [{ id: SESSION, user: ANA, organization: ECO, title: 'Sobre el acuerdo' }],
    messages: messages.map((m) => ({ session: SESSION, role: 'user', ...m })),
    documents: [],
    memberships: [],
    ...extra,
  }
}

const run = (db: Db, client: ConversationIngester, detector: PersonDetector) =>
  ingestConversationTurns({ payload: fakePayloadFor(db), sessionId: SESSION, client, detector })

/**
 * One payload per Db, memoised, so `update` writes made by the module are
 * visible to the next read in the same test.
 */
const payloads = new WeakMap<Db, Payload>()
function fakePayloadFor(db: Db): Payload {
  const existing = payloads.get(db)
  if (existing) return existing
  const made = fakePayload(db)
  payloads.set(db, made)
  return made
}

// ---------------------------------------------------------------------------
// The join key
// ---------------------------------------------------------------------------

describe('the external id that joins a corpus chunk back to a turn', () => {
  it('round-trips a numeric message id', () => {
    expect(turnExternalId(41)).toBe('msg-41')
    expect(messageIdFromExternalId('msg-41')).toBe(41)
  })

  it('round-trips a string message id, without coercing it to a number', () => {
    // Mongo-style ids exist in other deployments; `Number('abc')` would be NaN
    // and the join back to the row would silently target nothing.
    expect(messageIdFromExternalId(turnExternalId('abc123'))).toBe('abc123')
  })

  it('says a plain numeric id is NOT a message id', () => {
    // 🔴 This is what tells a `documents` row id from a conversation turn in
    // `provenance`. Getting it wrong makes the hold wait forever on a row that
    // does not exist — see the provenance test below.
    expect(messageIdFromExternalId('42')).toBeNull()
    expect(messageIdFromExternalId('doc-42')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// What a conversation cites
// ---------------------------------------------------------------------------

/**
 * A provenance chunk in the shape chat-engine persists it (measured on a local
 * `messages.provenance` row, 2026-10-14).
 *
 * 🔴 `documentId` is ai-service's OWN uuid for its copy of the document; the
 * `documents` row id lives in `metadata.docId`. Fixtures that put the row id in
 * `documentId` hid a bug where a uuid reached an integer-column query.
 */
let uuidSeq = 0
function cite(docId: string | number) {
  uuidSeq += 1
  return {
    chunkId: `chunk-${uuidSeq}`,
    documentId: `0f6cbe38-184a-41c2-bde4-${String(uuidSeq).padStart(12, '0')}`,
    corpus: 'eco-1',
    score: 0.5,
    metadata: { docId: String(docId), kind: 'documento' },
  }
}

describe('🔴 which documents a conversation cites', () => {
  it('reads explicit @-mentions from contextRefs', () => {
    const ids = citedDocumentIds([
      { id: 1, contextRefs: [{ relationTo: 'documents', value: 11 }] },
    ])
    expect(ids).toEqual([11])
  })

  it('ALSO reads provenance — the chunks the answer was actually grounded in', () => {
    // ⚠ THE ONE THAT IS EASY TO FORGET. Nobody @-mentions a document to have it
    // retrieved, so `provenance` is the common case by a wide margin. Reading
    // only `contextRefs` would let a whole thread grounded in someone's private
    // draft sail through the hold — precisely what the hold exists for.
    const ids = citedDocumentIds([
      { id: 2, provenance: { chunks: [cite('22')] } },
    ])
    expect(ids).toEqual([22])
  })

  it('reads a bare provenance array as well as a { chunks } envelope', () => {
    expect(citedDocumentIds([{ id: 3, provenance: [cite(33)] }])).toEqual([33])
  })

  it('merges both sources and de-duplicates across turns', () => {
    const ids = citedDocumentIds([
      { id: 1, contextRefs: [{ relationTo: 'documents', value: 11 }] },
      { id: 2, provenance: { chunks: [cite('11'), cite('12')] } },
    ])
    expect(ids.map(String).sort()).toEqual(['11', '12'])
  })

  it('ignores contextRefs pointing at other collections', () => {
    expect(citedDocumentIds([{ id: 1, contextRefs: [{ relationTo: 'sessions', value: 9 }] }])).toEqual([])
  })

  it('🔴 reads metadata.docId, NEVER the chunk\'s ai-service uuid `documentId`', () => {
    // Regression: the uuid in `documentId` reached `where: { id: { in } }` on
    // the integer `documents.id` and Postgres threw 22P02 after every answer.
    const ids = citedDocumentIds([
      {
        id: 9,
        provenance: {
          chunks: [
            {
              chunkId: 'c1',
              documentId: '0f6cbe38-184a-41c2-bde4-83b254919882',
              metadata: { docId: '119', kind: 'documento' },
            },
          ],
        },
      },
    ])
    expect(ids).toEqual([119])
  })

  it('ignores a chunk with no metadata.docId', () => {
    const ids = citedDocumentIds([
      { id: 9, provenance: { chunks: [{ documentId: '0f6cbe38-184a-41c2-bde4-83b254919882' }] } },
    ])
    expect(ids).toEqual([])
  })

  it('IGNORES `msg-…` provenance ids — a turn grounded in a previous turn', () => {
    // 🔴 A conversation chunk is not a document. Treating `msg-7` as a
    // `documents` id would make `citedUnpublishedDocumentIds` find no row for
    // it, decide "we do not know ⇒ not yet", and hold the conversation FOREVER
    // on a row that can never be published.
    const ids = citedDocumentIds([
      { id: 8, provenance: { chunks: [cite('msg-7'), cite('12')] } },
    ])
    expect(ids.map(String)).toEqual(['12'])
  })
})

describe('🔴 only integer ids reach the documents query', () => {
  it('never hands a non-numeric id to `where: { id: { in } }`, and still HOLDS on it', async () => {
    // `documents.id` is an integer column: any non-numeric string there makes
    // Postgres throw 22P02. A uuid passes a `[A-Za-z0-9_-]+` check, so the
    // guard must be digits-only.
    const db = seed([], { documents: [{ id: 5, publicationStatus: 'published' }] })
    const payload = fakePayloadFor(db)
    const uuid = '0f6cbe38-184a-41c2-bde4-83b254919882'

    const waiting = await citedUnpublishedDocumentIds(payload, [
      { id: 1, contextRefs: [{ relationTo: 'documents', value: uuid }] },
      { id: 2, provenance: { chunks: [cite('5')] } },
    ])

    const find = payload.find as unknown as ReturnType<typeof vi.fn>
    const sent = find.mock.calls.flatMap(
      ([arg]) => ((arg as { where: { id: { in: unknown[] } } }).where.id.in),
    )
    expect(sent.map(String)).toEqual(['5'])
    expect(waiting).toEqual([uuid])
  })
})

// ---------------------------------------------------------------------------
// 🔴 APPEND, NEVER RE-INGEST
// ---------------------------------------------------------------------------

describe('🔴 append, never re-ingest', () => {
  it('the SECOND run enqueues exactly ONE document — the new turn', async () => {
    // 🔴 THE MOST IMPORTANT TEST IN THIS FILE.
    //
    // The naive implementation ("a conversation is one document that grows")
    // re-embeds the whole thread on every message. On turn 41 that is 40 turns
    // of embedding paid for AGAIN — N× the budget — and it leaves the corpus
    // stuffed with near-identical fragments of the same exchange, which then
    // outrank real documents in every retrieval.
    //
    // The property that prevents it is structural: one ai-service document per
    // TURN, keyed `msg-<id>`, with the cursor (`corpusStatus`) on the row. So
    // the assertion is on the SIZE and CONTENT of the second call, not merely
    // on the fact that a second call happened.
    const db = seed([
      { id: 1, role: 'user', content: 'Cual es el acuerdo vigente' },
      { id: 2, role: 'assistant', content: 'El acuerdo vigente cubre el riego' },
      { id: 3, role: 'user', content: 'Y quien lo firmo' },
    ])
    const { client, calls } = fakeClient()
    const detector = countingDetector()

    const first = await run(db, client, detector)
    expect(first.ingested).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])

    // Turn 4 arrives.
    db.messages.push({ id: 4, session: SESSION, role: 'assistant', content: 'Lo firmo la asamblea' })

    const second = await run(db, client, detector)
    expect(second.ingested).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.documents).toHaveLength(1)
    expect(calls[1]!.documents[0]!.id).toBe('msg-4')
  })

  it('a run with nothing outstanding enqueues nothing at all', async () => {
    // Idempotent and cheap to call: the trigger is a plain afterChange hook, so
    // the same message can drive two runs. The second must be a no-op, not a
    // second copy of the turn.
    const db = seed([{ id: 1, role: 'user', content: 'Hola equipo' }])
    const { client, calls } = fakeClient()
    const detector = countingDetector()

    await run(db, client, detector)
    const again = await run(db, client, detector)

    expect(again.ingested).toBe(0)
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 🔴 THE HOLD AND THE RELEASE
// ---------------------------------------------------------------------------

describe('🔴 the hold — a conversation citing an unpublished draft', () => {
  it('enqueues NOTHING, marks every eligible turn held-drafts, and reports waitingOn', async () => {
    // 🔴 The reason is coherence, not privacy: a turn quoting a document only
    // its author can see would be retrievable by the whole ecosistema while the
    // thing it quotes is not. The answer would cite a source nobody can open.
    //
    // ⚠ The draft is cited through PROVENANCE, not contextRefs — the case an
    // implementation that reads only the explicit mentions lets through.
    const db = seed(
      [
        { id: 1, role: 'user', content: 'Que dice el borrador' },
        {
          id: 2,
          role: 'assistant',
          content: 'El borrador propone tres etapas',
          provenance: { chunks: [cite('900')] },
        },
      ],
      { documents: [{ id: 900, publicationStatus: 'draft' }] },
    )
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())

    expect(calls).toHaveLength(0)
    expect(result.ingested).toBe(0)
    expect(result.waitingOn.map(String)).toEqual(['900'])
    expect(db.messages.map((m) => m.corpusStatus)).toEqual(['held-drafts', 'held-drafts'])
  })

  it('holds on a document that is still mid-publish', async () => {
    // ⚠ `published` is the only SHARED state. Releasing while a publish is in
    // flight would make the conversation retrievable before its source is.
    const db = seed(
      [{ id: 1, role: 'user', content: 'Resume el documento', contextRefs: [{ relationTo: 'documents', value: 901 }] }],
      { documents: [{ id: 901, publicationStatus: 'publishing' }] },
    )
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())
    expect(calls).toHaveLength(0)
    expect(result.waitingOn.map(String)).toEqual(['901'])
  })

  it('holds on a cited id with NO ROW at all', async () => {
    // "We do not know whether the ecosistema may see it" resolves to "not yet".
    const db = seed([
      { id: 1, role: 'user', content: 'Segun el documento', contextRefs: [{ relationTo: 'documents', value: 404 }] },
    ])
    const { client, calls } = fakeClient()
    const result = await run(db, client, countingDetector())
    expect(calls).toHaveLength(0)
    expect(result.waitingOn.map(String)).toEqual(['404'])
  })

  it('still holds when only ONE of two cited drafts has been published', async () => {
    // The "LAST of those drafts" rule. Releasing on the first publish would put
    // half the thread in the corpus citing a document still nobody else can open.
    const db = seed(
      [
        {
          id: 1,
          role: 'user',
          content: 'Compara los dos borradores',
          provenance: { chunks: [cite('910'), cite('911')] },
        },
      ],
      {
        documents: [
          { id: 910, publicationStatus: 'published' },
          { id: 911, publicationStatus: 'draft' },
        ],
      },
    )
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())
    expect(calls).toHaveLength(0)
    expect(result.waitingOn.map(String)).toEqual(['911'])
  })
})

describe('🔴 C-15: the hold — a session with an ATTACHED unpublished draft', () => {
  // A turn need not cite a draft to depend on it: an answer can paraphrase an
  // attached draft, or a question can name its title, with no chunk of it in
  // provenance. While the conversation has any unpublished draft attached, it
  // stays out of the shared corpus.
  it('holds an uncited turn while a draft attached to this conversation is unpublished', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Que opinas del plan de Ana para el ejido' }], {
      documents: [{ id: 930, publicationStatus: 'draft', session: [SESSION] }],
    })
    const { client, calls } = fakeClient()
    const result = await run(db, client, countingDetector())
    expect(calls).toHaveLength(0)
    expect(result.waitingOn.map(String)).toEqual(['930'])
    expect(db.messages[0]!.corpusStatus).toBe('held-drafts')
  })

  it('does not hold on a draft attached to ANOTHER conversation', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Una pregunta general' }], {
      documents: [{ id: 931, publicationStatus: 'draft', session: [SESSION + 1] }],
    })
    const { client, calls } = fakeClient()
    const result = await run(db, client, countingDetector())
    expect(result.waitingOn).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('does not hold on an attached document that is already published', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Una pregunta general' }], {
      documents: [{ id: 932, publicationStatus: 'published', session: [SESSION] }],
    })
    const { client, calls } = fakeClient()
    await run(db, client, countingDetector())
    expect(calls).toHaveLength(1)
  })

  it('is released when the attached draft is published', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Que opinas del plan de Ana' }], {
      documents: [{ id: 933, publicationStatus: 'draft', session: [SESSION] }],
    })
    const { client, calls } = fakeClient()
    const detector = countingDetector()
    await run(db, client, detector)
    expect(calls).toHaveLength(0)
    db.documents[0]!.publicationStatus = 'published'
    await releaseConversationsWaitingOn({ payload: fakePayloadFor(db), documentId: 933, client, detector })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1'])
  })
})

describe('🔴 the release — the whole backlog goes out in ONE run', () => {
  it('publishes the last draft, then ingests every held turn in a single enqueue', async () => {
    const db = seed(
      [
        { id: 1, role: 'user', content: 'Que dice el borrador' },
        {
          id: 2,
          role: 'assistant',
          content: 'El borrador propone tres etapas',
          provenance: { chunks: [cite('920')] },
        },
        { id: 3, role: 'user', content: 'Gracias, lo reviso' },
      ],
      { documents: [{ id: 920, publicationStatus: 'draft' }] },
    )
    const { client, calls } = fakeClient()
    const detector = countingDetector()

    await run(db, client, detector)
    expect(calls).toHaveLength(0)
    expect(db.messages.every((m) => m.corpusStatus === 'held-drafts')).toBe(true)

    // The last cited draft is published.
    db.documents[0]!.publicationStatus = 'published'

    await releaseConversationsWaitingOn({
      payload: fakePayloadFor(db),
      documentId: 920,
      client,
      detector,
    })

    // 🔴 ONE call, carrying EVERY turn. Two calls would still be correct-ish;
    // half the thread would not.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(db.messages.every((m) => m.corpusStatus === 'embedding')).toBe(true)
  })

  it('🔴 books each released conversation to ITS OWN ecosistema client', async () => {
    // Held conversations span every ecosistema. One fixed client would book
    // all of them to a single ai-service org.
    const db = seed(
      [{ id: 1, role: 'assistant', content: 'Segun el borrador', provenance: { chunks: [cite('920')] } }],
      { documents: [{ id: 920, publicationStatus: 'draft' }] },
    )
    db.sessions.push({ id: 501, user: ANA, organization: OTHER_ECO, title: 'Otro' })
    db.messages.push({
      id: 2,
      session: 501,
      role: 'assistant',
      content: 'Tambien el borrador',
      provenance: { chunks: [cite('920')] },
    })
    const perOrg = new Map<string, ReturnType<typeof fakeClient>>()
    const resolver = (org: number | string) => {
      const key = String(org)
      if (!perOrg.has(key)) perOrg.set(key, fakeClient())
      return perOrg.get(key)!.client
    }
    const detector = countingDetector()
    await run(db, fakeClient().client, detector)
    await ingestConversationTurns({ payload: fakePayloadFor(db), sessionId: 501, client: resolver, detector })
    db.documents[0]!.publicationStatus = 'published'

    await releaseConversationsWaitingOn({ payload: fakePayloadFor(db), documentId: 920, client: resolver, detector })

    expect(perOrg.get(String(ECO))!.calls.map((c) => c.corpus)).toEqual([`eco-${ECO}`])
    expect(perOrg.get(String(OTHER_ECO))!.calls.map((c) => c.corpus)).toEqual([`eco-${OTHER_ECO}`])
  })

  it('releases via a plain re-run too — held-drafts is a RUNNABLE state', async () => {
    // ⚠ This is the difference between `held-drafts` and `held-gate`: the first
    // resolves by itself the moment the draft is published, so a re-run is
    // exactly the right thing to do.
    const db = seed(
      [{ id: 1, role: 'user', content: 'Resume el borrador', contextRefs: [{ relationTo: 'documents', value: 930 }] }],
      { documents: [{ id: 930, publicationStatus: 'draft' }] },
    )
    const { client, calls } = fakeClient()
    const detector = countingDetector()

    await run(db, client, detector)
    expect(calls).toHaveLength(0)

    db.documents[0]!.publicationStatus = 'published'
    const after = await run(db, client, detector)

    expect(after.ingested).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('a release that fails does not throw — the publish already succeeded', async () => {
    // It runs off the back of a publish that is already done. Turning "your
    // document is now shared" into an error the user cannot act on is the wrong
    // trade; the conversations simply stay held.
    const exploding = {
      find: vi.fn(async () => {
        throw new Error('db is down')
      }),
      logger: { warn: vi.fn() },
    } as unknown as Payload

    await expect(
      releaseConversationsWaitingOn({
        payload: exploding,
        documentId: 1,
        client: fakeClient().client,
      }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 🔴 WHAT EACH TURN CARRIES
// ---------------------------------------------------------------------------

describe('🔴 the metadata every turn carries', () => {
  it('marks an assistant turn `assistant` and a user turn `user`', async () => {
    // 🔴 THE FEEDBACK-LOOP MITIGATION, AND IT IS NOT OPTIONAL. Both questions
    // and answers are ingested, so without this label the model's own prior
    // answers are indistinguishable from sources at retrieval time — and its
    // mistakes get laundered into "documented" over time, silently. The label
    // is what lets a citation say "this came from a previous answer".
    const db = seed([
      { id: 1, role: 'user', content: 'Cuando vence el permiso' },
      { id: 2, role: 'assistant', content: 'El permiso vence al cierre del ciclo' },
    ])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    const byId = new Map(calls[0]!.documents.map((d) => [d.id, d.metadata!]))
    expect(byId.get('msg-1')!.authoredBy).toBe('user')
    expect(byId.get('msg-2')!.authoredBy).toBe('assistant')
  })

  it('labels every turn `conversacion`, and carries the session and title', async () => {
    // ⚠ On the wire `kind` IS the content kind; the file format moved to
    // `format`. A conversation turn's format is `chat`.
    const db = seed([{ id: 1, role: 'user', content: 'Hola, tengo una duda' }])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    const meta = calls[0]!.documents[0]!.metadata!
    expect(meta.kind).toBe('conversacion')
    expect(meta.format).toBe('chat')
    expect(meta.sessionId).toBe(String(SESSION))
    // 🔴 NOT the session title. `sessions.title` is generated from the first
    // thing the person asked, so it is unredacted free text — "¿Puede Ana López
    // pedir la prórroga?" would ride onto the citation card intact, past a gate
    // that only ever read the message bodies.
    expect(meta.title).toBe('Conversación')
    expect(meta.title).not.toBe('Sobre el acuerdo')
    // No person id of any kind travels with a chunk.
    expect(meta).not.toHaveProperty('uploadedBy')
  })

  it('sends turns to publishedCorpus(orgId) — `eco-<orgId>`, never a draft corpus', async () => {
    // ⚠ NEVER POOLED ACROSS TENANTS: even with names gone, "el ingeniero que
    // renunció" identifies someone in a small ecosistema, and no scrubber fixes
    // that. And never a `-draft-` corpus: a conversation belongs to the
    // ecosistema it happened in, not to one person's private space.
    const db = seed([{ id: 1, role: 'user', content: 'Buenos dias' }])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(calls[0]!.corpus).toBe(`eco-${ECO}`)
    expect(calls[0]!.corpus).not.toContain('draft')
    expect(calls[0]!.corpus).not.toBe(`eco-${OTHER_ECO}`)
    expect(calls[0]!.documents[0]!.metadata!.organizationId).toBe(String(ECO))
    expect(calls[0]!.documents[0]!.metadata!.publication).toBe('published')
  })

  it('leaves turns at `embedding`, NOT `ingested`, after a successful enqueue', async () => {
    // Only the ai-service callback may claim success. Writing `ingested` here
    // would make a job that never completed look finished, and nothing would
    // ever retry it.
    const db = seed([{ id: 1, role: 'user', content: 'Necesito el reporte' }])
    const { client } = fakeClient()

    await run(db, client, countingDetector())

    expect(db.messages[0]!.corpusStatus).toBe('embedding')
    expect(db.messages[0]!.corpusIngestId).toBe('ing-1')
  })

  it('marks turns `failed` when the enqueue itself throws, so the next run retries', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Necesito el reporte' }])
    const client: ConversationIngester = {
      ingest: { enqueue: async () => { throw new Error('ai-service down') } },
    }

    const result = await run(db, client, countingDetector())

    expect(result.ingested).toBe(0)
    expect(db.messages[0]!.corpusStatus).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// What never goes in
// ---------------------------------------------------------------------------

describe('turns that are never ingested', () => {
  it('skips `system` turns — they are our own scaffolding', async () => {
    // Ingesting them would mean the assistant retrieving its own instructions
    // and citing them as if a member had said them.
    const db = seed([
      { id: 1, role: 'system', content: 'Eres un asistente del ecosistema' },
      { id: 2, role: 'user', content: 'Hola' },
    ])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-2'])
  })

  it('skips empty turns', async () => {
    const db = seed([
      { id: 1, role: 'user', content: '   ' },
      { id: 2, role: 'assistant', content: '' },
      { id: 3, role: 'user', content: 'Una pregunta real' },
    ])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-3'])
  })

  it('does nothing for a session with no ecosistema — a guessed corpus is a cross-tenant write', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Hola' }])
    delete db.sessions[0]!.organization
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())
    expect(result.ingested).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('does nothing for a session that does not exist', async () => {
    const db = seed([{ id: 1, role: 'user', content: 'Hola' }])
    const { client, calls } = fakeClient()
    const result = await ingestConversationTurns({
      payload: fakePayloadFor(db),
      sessionId: 99999,
      client,
      detector: countingDetector(),
    })
    expect(result.ingested).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 🔴 THE ANONYMISATION GATE
// ---------------------------------------------------------------------------

describe('🔴 the anonymisation gate, per turn', () => {
  it('HOLDS a turn whose detector could not run, and does not enqueue it', async () => {
    // 🔴 A detector that threw is NOT "nothing to redact". People wrote these
    // messages believing they were private, ingestion is silent and automatic,
    // and ai-service has no per-document delete — so an uncertain turn must end
    // in "not ingested yet", never in "ingested, probably fine".
    const db = seed([
      { id: 1, role: 'user', content: 'Turno limpio' },
      { id: 2, role: 'user', content: 'Turno problematico' },
    ])
    const detector: PersonDetector = {
      name: 'exploding',
      async detect({ text }) {
        if (text.includes('problematico')) throw new Error('model unavailable')
        return []
      },
    }
    const { client, calls } = fakeClient()

    const result = await run(db, client, detector)

    expect(result.heldByGate).toBe(1)
    expect(db.messages[1]!.corpusStatus).toBe('held-gate')
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1'])
    // ⚠ Counts and stage names only — the reason never quotes what it found.
    expect(String(db.messages[1]!.corpusError)).not.toContain('problematico')
  })

  it('HOLDS a turn whose VERIFY pass still finds a name', async () => {
    // Stage 4 re-runs the detector over the OUTPUT. It is the only stage that
    // can catch stage 3 having missed something, which is why the gate was
    // built as a detector-plus-replacer rather than a rewriter.
    let pass = 0
    const detector: PersonDetector = {
      name: 'leaky',
      async detect(): Promise<DetectorFinding[]> {
        pass += 1
        // Nothing found on the content pass; a name still standing on verify.
        return pass === 1 ? [] : [{ text: 'Ruiz', type: 'persona' }]
      },
    }
    const db = seed([{ id: 1, role: 'user', content: 'Hablé con Ruiz sobre el pago' }])
    const { client, calls } = fakeClient()

    const result = await run(db, client, detector)

    expect(result.heldByGate).toBe(1)
    expect(calls).toHaveLength(0)
    expect(db.messages[0]!.corpusStatus).toBe('held-gate')
  })

  it('⚠ does NOT retry a held-gate turn on a later run', async () => {
    // 🔴 `held-gate` is deliberately NOT in the runnable set, unlike
    // `held-drafts`. The gate looked at these exact bytes and refused them;
    // running it again buys two more model calls and the same answer.
    const db = seed([{ id: 1, role: 'user', content: 'Turno problematico' }])
    let detectorCalls = 0
    const detector: PersonDetector = {
      name: 'exploding',
      async detect() {
        detectorCalls += 1
        throw new Error('model unavailable')
      },
    }
    const { client, calls } = fakeClient()

    await run(db, client, detector)
    expect(db.messages[0]!.corpusStatus).toBe('held-gate')
    const afterFirst = detectorCalls

    const second = await run(db, client, detector)

    expect(second.heldByGate).toBe(0)
    expect(detectorCalls).toBe(afterFirst)
    expect(calls).toHaveLength(0)
  })

  it('does NOT re-run the detector on a turn that already has redactedText', async () => {
    // ⚠ Re-running the gate would pay for two more model calls AND could produce
    // a DIFFERENT redaction of text that is already partly in the corpus.
    const db = seed([
      { id: 1, role: 'user', content: 'Hablé con María López', redactedText: 'Hablé con [Persona A]' },
    ])
    const detector = countingDetector()
    const { client, calls } = fakeClient()

    await run(db, client, detector)

    expect(detector.calls()).toBe(0)
    // 🔴 And the text sent is the GATE'S OUTPUT, never the raw original.
    expect(calls[0]!.documents[0]!.text).toBe('Hablé con [Persona A]')
    expect(calls[0]!.documents[0]!.text).not.toContain('María')
  })

  it('embeds the redacted text, not the original, and leaves `content` untouched', async () => {
    // The person's own conversation stays exactly as they typed it — it is what
    // the UI shows them. The redaction goes BESIDE it.
    const db = seed([{ id: 1, role: 'user', content: 'Le pregunté a Rosa Méndez por el pago' }])
    const detector = staticDetector([{ text: 'Rosa Méndez', type: 'persona' }])
    const { client, calls } = fakeClient()

    await run(db, client, detector)

    expect(calls[0]!.documents[0]!.text).not.toContain('Rosa Méndez')
    expect(calls[0]!.documents[0]!.text).toContain('[Persona A]')
    expect(db.messages[0]!.content).toBe('Le pregunté a Rosa Méndez por el pago')
    expect(db.messages[0]!.redactedText).toContain('[Persona A]')
  })

  it('feeds the ecosistema roster into the gate — the case where a roster earns its keep', async () => {
    // ⚠ In a CONVERSATION the speakers ARE members, so a dictionary of members
    // does real work. (In a testimony the people named are not users of this
    // system at all, which is why testimonies pass `roster: []`.)
    const db = seed([{ id: 1, role: 'user', content: 'Que opina Carla Ibarra del plan' }], {
      memberships: [
        { id: 1, organization: ECO, isActive: true, personName: 'Carla Ibarra' },
        // ⚠ Another tenant's roster must never leak into this gate run.
        { id: 2, organization: OTHER_ECO, isActive: true, personName: 'Carla Ibarra' },
      ],
    })
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(calls[0]!.documents[0]!.text).not.toContain('Carla Ibarra')
  })
})

// ---------------------------------------------------------------------------
// 🔴 ASSISTANT TURNS — OFF BY DEFAULT (ruling 2026-10-20)
// ---------------------------------------------------------------------------

describe('🔴 assistant turns stay out of the corpus by default', () => {
  // An audit measured an earlier answer as the TOP-1 source in 6 of 14 chat
  // turns, about 10 s after it was written: the assistant citing itself. The
  // ruling stops ingesting answers; questions still go in.
  beforeEach(() => {
    vi.stubEnv('INGEST_ASSISTANT_TURNS', '')
  })

  it('enqueues the user turn only, and marks the answer `skipped`', async () => {
    const db = seed([
      { id: 1, role: 'user', content: 'Cual es el acuerdo vigente' },
      { id: 2, role: 'assistant', content: 'El acuerdo vigente cubre el riego' },
    ])
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())

    expect(result.ingested).toBe(1)
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1'])
    expect(db.messages[1]!.corpusStatus).toBe('skipped')
  })

  it('never sends an answer through the anonymisation gate — that is the saving', async () => {
    const db = seed([
      { id: 1, role: 'user', content: 'Pregunta' },
      { id: 2, role: 'assistant', content: 'Respuesta larga' },
    ])
    const detector = countingDetector()

    await run(db, fakeClient().client, detector)

    // One gate run for the question: detect + verify. None for the answer.
    const perUserTurn = detector.calls()
    db.messages.push({ id: 3, session: SESSION, role: 'assistant', content: 'Otra respuesta' })
    await run(db, fakeClient().client, detector)
    expect(detector.calls()).toBe(perUserTurn)
    expect(db.messages[2]!.redactedText).toBeUndefined()
  })

  it('an answer-only run enqueues nothing at all', async () => {
    const db = seed([{ id: 1, role: 'assistant', content: 'Solo respuesta' }])
    const { client, calls } = fakeClient()

    const result = await run(db, client, countingDetector())

    expect(result.ingested).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('⚠ leaves an answer ALREADY in the corpus alone — its status is the erase bookkeeping', async () => {
    // Retrieval filters old answer chunks out (web lane). Rewriting their row to
    // `skipped` would hide that the chunks still exist.
    const db = seed([
      { id: 1, role: 'assistant', content: 'Vieja respuesta', corpusStatus: 'ingested' },
      { id: 2, role: 'assistant', content: 'En vuelo', corpusStatus: 'embedding' },
      { id: 3, role: 'assistant', content: 'Retenida', corpusStatus: 'held-gate' },
      { id: 4, role: 'user', content: 'Nueva pregunta' },
    ])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(db.messages.map((m) => m.corpusStatus)).toEqual(['ingested', 'embedding', 'held-gate', 'embedding'])
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-4'])
  })

  it('a conversation released from a draft hold sends its questions, not its answers', async () => {
    const db = seed(
      [
        { id: 1, role: 'user', content: 'Que dice el borrador' },
        { id: 2, role: 'assistant', content: 'Segun el borrador', provenance: { chunks: [{ metadata: { docId: '933' } }] } },
      ],
      { documents: [{ id: 933, publicationStatus: 'draft' }] },
    )
    const { client, calls } = fakeClient()
    const detector = countingDetector()

    await run(db, client, detector)
    expect(db.messages.map((m) => m.corpusStatus)).toEqual(['held-drafts', 'skipped'])

    db.documents[0]!.publicationStatus = 'published'
    await releaseConversationsWaitingOn({ payload: fakePayloadFor(db), documentId: 933, client, detector })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.documents.map((d) => d.id)).toEqual(['msg-1'])
  })

  it('`INGEST_ASSISTANT_TURNS=true` puts answers back in, still marked `authoredBy: assistant`', async () => {
    vi.stubEnv('INGEST_ASSISTANT_TURNS', 'true')
    const db = seed([
      { id: 1, role: 'user', content: 'Pregunta' },
      { id: 2, role: 'assistant', content: 'Respuesta' },
    ])
    const { client, calls } = fakeClient()

    await run(db, client, countingDetector())

    expect(calls[0]!.documents.map((d) => [d.id, d.metadata?.authoredBy])).toEqual([
      ['msg-1', 'user'],
      ['msg-2', 'assistant'],
    ])
  })

  it('an explicit `ingestAssistantTurns` argument wins over the env', async () => {
    vi.stubEnv('INGEST_ASSISTANT_TURNS', 'true')
    const db = seed([{ id: 1, role: 'assistant', content: 'Respuesta' }])
    const { client, calls } = fakeClient()

    await ingestConversationTurns({
      payload: fakePayloadFor(db),
      sessionId: SESSION,
      client,
      detector: countingDetector(),
      ingestAssistantTurns: false,
    })

    expect(calls).toHaveLength(0)
  })

  it('reads the switch: only an explicit yes turns it on', () => {
    for (const on of ['true', '1', 'on', 'yes', ' TRUE ']) {
      expect(ingestAssistantTurnsEnabled({ INGEST_ASSISTANT_TURNS: on })).toBe(true)
    }
    for (const off of [undefined, '', 'false', '0', 'off', 'no', 'junk']) {
      expect(ingestAssistantTurnsEnabled({ INGEST_ASSISTANT_TURNS: off })).toBe(false)
    }
  })
})
