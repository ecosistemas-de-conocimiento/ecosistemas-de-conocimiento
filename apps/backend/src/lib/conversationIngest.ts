/**
 * CONVERSATIONS BECOME CORPUS — turn by turn, and never the thread twice.
 *
 * ── 🔴 THE ONE THING THIS FILE EXISTS TO GET RIGHT ───────────────────────────
 *
 * **Append the new turns. Never re-ingest the thread.**
 *
 * The naive version of "ingest a conversation on every message" re-embeds the
 * whole conversation each time. On turn 41 that is 40 turns of embedding paid
 * for again — 40x the budget — and it leaves the corpus full of near-identical
 * fragments of the same exchange, which then crowd real documents out of every
 * retrieval. The corpus gets bigger, more expensive and WORSE.
 *
 * Two things make appending structural here rather than a rule someone has to
 * remember:
 *
 *   1. **One ai-service document per TURN**, with the stable external id
 *      `msg-{messageId}`. A conversation is not one document that grows; it is N
 *      documents that arrive one at a time. Turn 41 enqueues exactly one.
 *   2. **The cursor lives on the row.** `messages.corpusStatus` says whether a
 *      turn has been through this, so "what is left to do" is a query, not a
 *      diff against something we remember.
 *
 * ── WHEN A CONVERSATION ENTERS — THE OWNER'S RULE ────────────────────────────
 *
 * There is no "mark this conversation as done" button, because that asks the
 * user to do bookkeeping for the corpus's benefit. Instead:
 *
 *   · A conversation citing NO unpublished drafts is ingested AS IT GOES.
 *   · A conversation citing unpublished drafts is HELD. When the LAST of those
 *     drafts is published, the whole conversation goes in one run.
 *
 * ⚠ The reason for the hold is not privacy, it is coherence: a chat turn that
 * quotes a document only its author can see would be retrievable by the whole
 * ecosistema while the thing it quotes is not. The answer would cite a source
 * nobody else can open.
 *
 * ── BOTH QUESTIONS AND ANSWERS GO IN, AND THAT HAS A COST ────────────────────
 *
 * The owner chose to ingest user turns AND assistant turns. The cost is a
 * feedback loop: the assistant retrieves its own prior answers and cites them as
 * sources, so its mistakes become "documented" over time, silently.
 *
 * ⚠ THE MITIGATION IS `metadata.authoredBy`, and it is not optional. Every
 * assistant turn is marked, so retrieval and citations can say *"this came from
 * a previous answer"* rather than presenting it as a source. That makes the loop
 * visible instead of silent. See `lib/contentKind.ts`.
 *
 * ── EVERY TURN GOES THROUGH THE ANONYMISATION GATE ───────────────────────────
 *
 * People wrote these messages believing they were private, ingestion is
 * automatic and silent, and there is no per-user review step. So the gate
 * carries the whole weight of that promise — see `lib/anonymise/types.ts`. A
 * conversation is the case where the membership roster genuinely helps, because
 * the speakers ARE members; a testimony is the case where it does not.
 */

import type { Payload } from 'payload'

import { chunkMetadata } from './contentKind'
import { publishedCorpus } from './corpus'
import { relationId } from './permissions'
import type { PersonDetector } from './anonymise/types'

/**
 * Where one chat turn stands with respect to the corpus.
 *
 *   pending      not yet considered, or waiting for the next run
 *   held-drafts  🔴 the conversation cites a draft nobody else can see
 *   held-gate    🔴 the anonymisation gate refused this turn
 *   embedding    enqueued at ai-service; the callback will move it
 *   ingested     in the ecosistema's corpus
 *   failed       ai-service reported a failure. Retried on the next run.
 *   skipped      never eligible — a `system` turn, or an empty one
 *
 * ⚠ `held-drafts` AND `held-gate` ARE DIFFERENT STATES ON PURPOSE. The first
 * resolves by itself the moment the last cited draft is published, and a re-run
 * is exactly the right thing to do. The second will not: the gate looked at this
 * text and refused it, and running it again over the same bytes buys two more
 * model calls and the same answer. So the release path re-scans the first and
 * deliberately leaves the second alone.
 */
export const MESSAGE_CORPUS_STATES = [
  'pending',
  'held-drafts',
  'held-gate',
  'embedding',
  'ingested',
  'failed',
  'skipped',
] as const

export type MessageCorpusState = (typeof MESSAGE_CORPUS_STATES)[number]

/**
 * ⚠ THE STATES A RUN PICKS UP. Everything else is either done, in flight, or
 * deliberately parked. Getting `ingested` into this list is how you would
 * re-embed the whole thread — the exact failure this file is built around.
 */
const RUNNABLE_STATES: readonly MessageCorpusState[] = [
  'pending',
  'held-drafts',
  'failed',
]

/** The external id one turn carries at ai-service. The join back to the row. */
export function turnExternalId(messageId: number | string): string {
  return `msg-${messageId}`
}

/** The `messages` row id behind an external id, or null if it is not a turn. */
export function messageIdFromExternalId(externalId: string): number | string | null {
  const match = /^msg-(.+)$/.exec(externalId.trim())
  if (!match) return null
  const raw = match[1]
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

interface MessageRow {
  id: number | string
  role?: unknown
  content?: unknown
  redactedText?: unknown
  corpusStatus?: unknown
  contextRefs?: unknown
  provenance?: unknown
  createdAt?: unknown
}

interface SessionRow {
  id: number | string
  user?: unknown
  organization?: unknown
  title?: unknown
}

/** Minimal slice of `@edc/ai-client` this file uses. Keeps it testable. */
export interface ConversationIngester {
  ingest: {
    enqueue(req: {
      corpus: string
      documents: Array<{
        id: string
        text: string
        title: string
        metadata?: Record<string, unknown>
      }>
      language?: string
      callbackUrl?: string
    }): Promise<{ ingestId: string }>
  }
}

const CORPUS_LANGUAGE = process.env.CORPUS_LANGUAGE?.trim() || 'spanish'

// ---------------------------------------------------------------------------
// Which drafts is this conversation waiting on?
// ---------------------------------------------------------------------------

/**
 * The document ids a conversation CITES, from both places a citation can live.
 *
 * ⚠ TWO SOURCES, AND ONE OF THEM IS EASY TO FORGET.
 *
 *   · `messages.contextRefs` — what the person @-mentioned. Explicit.
 *   · `messages.provenance`  — the chunks retrieval actually returned and the
 *     answer was grounded in. IMPLICIT, and far more common: nobody @-mentions
 *     a document to have it retrieved.
 *
 * Reading only `contextRefs` would let a whole thread grounded in someone's
 * private draft sail through the hold, which is precisely the case the hold
 * exists for.
 */
export function citedDocumentIds(messages: readonly MessageRow[]): Array<number | string> {
  const found = new Map<string, number | string>()

  for (const message of messages) {
    const refs = Array.isArray(message.contextRefs) ? message.contextRefs : []
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue
      const { relationTo, value } = ref as { relationTo?: unknown; value?: unknown }
      if (relationTo !== 'documents') continue
      const id = relationId(value)
      if (id !== null) found.set(String(id), id)
    }

    // `provenance` is the persisted citation payload: an array of retrieved
    // chunks, each carrying the `documentId` its corpus knows it by — which is
    // the `documents` row id, because that is what we send as the ingest id.
    const provenance = message.provenance
    const chunks = Array.isArray(provenance)
      ? provenance
      : provenance && typeof provenance === 'object'
        ? ((provenance as { chunks?: unknown }).chunks ?? [])
        : []
    if (!Array.isArray(chunks)) continue
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue
      const raw = (chunk as { documentId?: unknown }).documentId
      if (typeof raw !== 'string' && typeof raw !== 'number') continue
      const text = String(raw)
      // ⚠ Skip our own conversation chunks. A turn grounded in a PREVIOUS TURN
      // cites `msg-…`, not a document, and treating that as a document id would
      // make the hold wait forever on a row that does not exist.
      if (messageIdFromExternalId(text) !== null) continue
      found.set(text, /^\d+$/.test(text) ? Number(text) : text)
    }
  }

  return [...found.values()]
}

/**
 * Of the documents this conversation cites, which are NOT yet shared with the
 * ecosistema.
 *
 * ⚠ `published` is the only shared state — `publishing` and `unpublishing` are
 * in-flight and visible to the uploader alone. A conversation released while a
 * publish is still in flight would be retrievable before the thing it quotes is.
 */
export async function citedUnpublishedDocumentIds(
  payload: Payload,
  messages: readonly MessageRow[],
): Promise<Array<number | string>> {
  const cited = citedDocumentIds(messages)
  if (cited.length === 0) return []

  const rows = await payload.find({
    collection: 'documents',
    where: { id: { in: cited } },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })

  const published = new Set(
    (rows.docs as unknown as Array<{ id: number | string; publicationStatus?: unknown }>)
      .filter((row) => row.publicationStatus === 'published')
      .map((row) => String(row.id)),
  )

  // ⚠ A cited id with NO ROW is treated as unpublished, i.e. it HOLDS. The
  // document was deleted, or the id is junk; either way we cannot show that the
  // ecosistema may see it, and the gate's whole posture is that "we do not know"
  // resolves to "not yet".
  return cited.filter((id) => !published.has(String(id)))
}

// ---------------------------------------------------------------------------
// The roster — the half of the gate that only works for conversations
// ---------------------------------------------------------------------------

/**
 * Names and emails of the ecosistema's people, for the gate's deterministic
 * stage.
 *
 * ⚠ THIS IS THE CASE WHERE THE ROSTER EARNS ITS KEEP, and it is worth saying so
 * next to the code that builds it: in a CONVERSATION the speakers are members,
 * so a dictionary of members does real work. In a TESTIMONY the people named are
 * not users of this system at all and this list would be empty of them — which
 * is why testimonies pass `roster: []` and lean on the content scrub instead.
 */
export async function rosterForOrganization(
  payload: Payload,
  organizationId: number | string,
): Promise<string[]> {
  const memberships = await payload.find({
    collection: 'memberships',
    where: { and: [{ organization: { equals: organizationId } }, { isActive: { equals: true } }] },
    depth: 1,
    pagination: false,
    overrideAccess: true,
  })

  const names = new Set<string>()
  for (const row of memberships.docs as unknown as Array<{
    personName?: unknown
    user?: unknown
  }>) {
    if (typeof row.personName === 'string' && row.personName.trim()) {
      names.add(row.personName.trim())
    }
    const user = row.user
    if (user && typeof user === 'object') {
      const { displayName, email } = user as { displayName?: unknown; email?: unknown }
      if (typeof displayName === 'string' && displayName.trim()) names.add(displayName.trim())
      if (typeof email === 'string' && email.trim()) names.add(email.trim())
    }
  }
  // Longest first, so "María López" is matched before the bare "María" that is
  // a substring of it. Otherwise the surname survives on its own.
  return [...names].sort((a, b) => b.length - a.length)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ConversationIngestResult {
  /** How many turns were enqueued on THIS run. Never the size of the thread. */
  ingested: number
  /** Ids of cited drafts still keeping the conversation out of the corpus. */
  waitingOn: Array<number | string>
  /** Turns the anonymisation gate refused. Not retried. */
  heldByGate: number
}

/**
 * Ingest whatever is outstanding in one conversation.
 *
 * ⚠ IDEMPOTENT AND CHEAP TO CALL. Every run is "what is not `ingested` yet",
 * so calling it on every message, or twice for the same message, appends the
 * same turns exactly once. That is what lets the trigger be a plain
 * `afterChange` hook with no coordination.
 */
export async function ingestConversationTurns(args: {
  payload: Payload
  sessionId: number | string
  client: ConversationIngester
  callbackUrl?: string
  /** Test seam for the gate's model call. */
  detector?: PersonDetector
}): Promise<ConversationIngestResult> {
  const { payload, sessionId, client } = args
  const empty: ConversationIngestResult = { ingested: 0, waitingOn: [], heldByGate: 0 }

  const session = (await payload
    .findByID({ collection: 'sessions', id: sessionId as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as unknown as SessionRow | null
  if (!session) return empty

  const organizationId = relationId(session.organization)
  if (organizationId === null) {
    // No ecosistema means no corpus name can be derived, and a guessed one is a
    // cross-tenant write. Nothing to do, and nothing to fix at runtime.
    return empty
  }

  const all = (
    await payload.find({
      collection: 'messages',
      where: { session: { equals: sessionId } },
      // depth 0 keeps `contextRefs` as `{relationTo, value}` pairs, which is
      // what `citedDocumentIds` reads.
      depth: 0,
      pagination: false,
      sort: 'createdAt',
      overrideAccess: true,
    })
  ).docs as unknown as MessageRow[]

  /**
   * ⚠ SAY SO ON THE ROW. A `system` turn or an empty one is never eligible, and
   * leaving it at `pending` forever means the admin panel shows a backlog that
   * will never move — indistinguishable from a stuck pipeline. `skipped` is the
   * honest terminal state, and writing it once takes the row out of every future
   * scan.
   */
  await Promise.all(
    all
      .filter(
        (message) =>
          (!isIngestableRole(message.role) || !hasText(message.content)) &&
          corpusStateOf(message) !== 'skipped',
      )
      .map((message) => writeMessage(payload, message.id, { corpusStatus: 'skipped' })),
  )

  const outstanding = all.filter(
    (message) =>
      isIngestableRole(message.role) &&
      hasText(message.content) &&
      RUNNABLE_STATES.includes(corpusStateOf(message)),
  )
  if (outstanding.length === 0) return empty

  // 🔴 THE HOLD, AND IT IS CHECKED AGAINST THE WHOLE THREAD, NOT JUST THE NEW
  // TURNS. A draft cited on turn 3 keeps turn 41 out too: releasing the tail of
  // a conversation whose head quotes a private document would put half an
  // exchange in the corpus, citing something nobody else can open.
  const waitingOn = await citedUnpublishedDocumentIds(payload, all)
  if (waitingOn.length > 0) {
    await Promise.all(
      outstanding.map((message) =>
        writeMessage(payload, message.id, {
          corpusStatus: 'held-drafts',
          corpusError: `waiting on ${waitingOn.length} unpublished draft(s)`,
        }),
      ),
    )
    return { ...empty, waitingOn }
  }

  const roster = await rosterForOrganization(payload, organizationId)
  const title = typeof session.title === 'string' && session.title.trim() ? session.title : 'Conversación'

  const documents: Array<{
    id: string
    text: string
    title: string
    metadata: Record<string, unknown>
  }> = []
  const enqueuedIds: Array<number | string> = []
  let heldByGate = 0

  for (const message of outstanding) {
    const original = String(message.content)

    // ⚠ REUSE A DECISION ALREADY MADE. A turn that cleared the gate on an
    // earlier run keeps its `redactedText`; re-running the gate would pay for
    // two more model calls and could return a DIFFERENT redaction of text that
    // is already partly in the corpus.
    let text = typeof message.redactedText === 'string' ? message.redactedText.trim() : ''

    if (!text) {
      const gated = await anonymiseDocumentTextForMessage({
        payload,
        messageId: message.id,
        text: original,
        roster,
        ...(args.detector ? { detector: args.detector } : {}),
      })
      if (!gated.ok) {
        heldByGate += 1
        continue
      }
      text = gated.text
    }

    documents.push({
      id: turnExternalId(message.id),
      text,
      title,
      metadata: chunkMetadata({
        docId: turnExternalId(message.id),
        organizationId,
        contentKind: 'conversacion',
        format: 'chat',
        // Conversations enter the ecosistema's SHARED corpus — the one they came
        // from. ⚠ Never pooled across tenants: even with names gone, "el
        // ingeniero que renunció en marzo" identifies someone in a small
        // ecosistema, and no scrubber fixes that.
        publication: 'published',
        title,
        // 🔴 THE FEEDBACK-LOOP MITIGATION. Without this an assistant answer is
        // indistinguishable from a source document at retrieval time, and the
        // model's own errors get laundered into "documented" over time.
        authoredBy: message.role === 'assistant' ? 'assistant' : 'user',
        sessionId,
      }),
    })
    enqueuedIds.push(message.id)
  }

  if (documents.length === 0) return { ...empty, heldByGate }

  const corpus = publishedCorpus(organizationId)

  let ingestId: string
  try {
    // ⚠ ONE CALL FOR EVERYTHING OUTSTANDING. In the steady state that is a
    // single turn; on release it is the whole backlog, which is what "the whole
    // conversation ingests in one run" means. Either way each turn is its own
    // document with its own id, so nothing is embedded twice.
    const result = await client.ingest.enqueue({
      corpus,
      documents,
      language: CORPUS_LANGUAGE,
      ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
    })
    ingestId = result.ingestId
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await Promise.all(
      enqueuedIds.map((id) =>
        writeMessage(payload, id, {
          corpusStatus: 'failed',
          corpusError: `ingest_enqueue_failed: ${reason}`.slice(0, 500),
        }),
      ),
    )
    return { ...empty, heldByGate }
  }

  await Promise.all(
    enqueuedIds.map((id) =>
      writeMessage(payload, id, {
        // `embedding`, not `ingested`: the callback is what confirms the chunks
        // exist. Claiming success here would leave a failed enqueue looking done.
        corpusStatus: 'embedding',
        corpusIngestId: ingestId,
        corpusError: null,
      }),
    ),
  )

  return { ingested: documents.length, waitingOn: [], heldByGate }
}

/**
 * 🔴 THE RELEASE. Called when a document finishes publishing.
 *
 * "When the LAST of those drafts is published, the whole conversation goes in
 * one run" is implemented by simply re-running every conversation that was
 * waiting on THIS document. `ingestConversationTurns` re-checks the full cited
 * set itself, so a conversation still waiting on a second draft holds again and
 * nothing here has to count.
 *
 * ⚠ Never throws. It runs off the back of a publish that has already succeeded;
 * turning "your document is now shared" into an error because a conversation
 * could not be embedded would be the wrong trade.
 */
export async function releaseConversationsWaitingOn(args: {
  payload: Payload
  documentId: number | string
  client: ConversationIngester
  callbackUrl?: string
  detector?: PersonDetector
}): Promise<void> {
  const { payload, documentId } = args
  try {
    const held = await payload.find({
      collection: 'messages',
      where: { corpusStatus: { equals: 'held-drafts' } },
      depth: 0,
      pagination: false,
      overrideAccess: true,
    })

    const sessionIds = new Map<string, number | string>()
    for (const row of held.docs as unknown as Array<{ session?: unknown }>) {
      const id = relationId(row.session)
      if (id !== null) sessionIds.set(String(id), id)
    }

    for (const sessionId of sessionIds.values()) {
      await ingestConversationTurns({
        payload,
        sessionId,
        client: args.client,
        ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
        ...(args.detector ? { detector: args.detector } : {}),
      })
    }
  } catch (err) {
    payload.logger?.warn?.(
      { documentId: String(documentId), err: String(err) },
      '[conversation] could not release conversations waiting on this document; they stay held.',
    )
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * ⚠ `system` TURNS ARE NOT INGESTED. They are our own scaffolding — prompts and
 * notices we wrote — so putting them in the corpus would mean the assistant
 * retrieving its own instructions and citing them as if a member had said them.
 */
function isIngestableRole(role: unknown): boolean {
  return role === 'user' || role === 'assistant'
}

function hasText(content: unknown): boolean {
  return typeof content === 'string' && content.trim().length > 0
}

function corpusStateOf(message: MessageRow): MessageCorpusState {
  const raw = message.corpusStatus
  return typeof raw === 'string' && (MESSAGE_CORPUS_STATES as readonly string[]).includes(raw)
    ? (raw as MessageCorpusState)
    : 'pending'
}

function writeMessage(
  payload: Payload,
  id: number | string,
  data: Record<string, unknown>,
): Promise<unknown> {
  return payload.update({
    collection: 'messages',
    id: id as never,
    data,
    overrideAccess: true,
    // Re-entrancy guard: these writes are on `messages`, whose afterChange hook
    // is what triggers ingestion. Without the flag a status write would start
    // another run, which would write another status.
    context: { __skipConversationIngest: true },
  })
}

/**
 * The gate, for one chat turn.
 *
 * ⚠ It writes to `messages`, not `documents`, so it cannot reuse
 * `anonymiseDocumentText` as-is — that function persists onto a `documents` row.
 * The GATE ITSELF is shared; only the persistence differs, which is the right
 * seam: the rules for a conversation and a testimony are deliberately identical.
 */
async function anonymiseDocumentTextForMessage(args: {
  payload: Payload
  messageId: number | string
  text: string
  roster: readonly string[]
  detector?: PersonDetector
}): Promise<{ ok: true; text: string } | { ok: false }> {
  const { payload, messageId, text, roster } = args

  const { runAnonymisationGate, aiServiceDetector } = await import('./anonymise')
  const detector = args.detector ?? aiServiceDetector()

  let result: Awaited<ReturnType<typeof runAnonymisationGate>>
  try {
    result = await runAnonymisationGate({ contentKind: 'conversacion', text, roster }, { detector })
  } catch (err) {
    // An unexpected throw is a HOLD, never a pass. A bug in the redactor is the
    // last thing that should be allowed to fail open.
    await writeMessage(payload, messageId, {
      corpusStatus: 'held-gate',
      corpusError: `gate_crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    })
    return { ok: false }
  }

  if (result.status === 'hold') {
    await writeMessage(payload, messageId, {
      corpusStatus: 'held-gate',
      // ⚠ Counts only. The gate's reason never quotes what it found.
      corpusError: `${result.stage}: ${result.reason}`.slice(0, 500),
      anonymisationReport: result.report,
    })
    return { ok: false }
  }

  await writeMessage(payload, messageId, {
    // Beside the original, never over it. `messages.content` stays exactly as
    // the person typed it — it is their conversation, and it is what the UI
    // shows them.
    redactedText: result.redactedText,
    anonymisationReport: result.report,
    corpusError: null,
  })
  return { ok: true, text: result.redactedText }
}
