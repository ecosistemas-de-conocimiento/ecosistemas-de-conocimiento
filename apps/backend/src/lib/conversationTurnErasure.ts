/**
 * ERASE a deleted conversation's turns from ai-service, after commit.
 *
 * Audit 2026-10-17 §3 item 2, ruled by Rodrigo on 2026-10-20: deleting a
 * conversation must ERASE what reached the shared corpus, not only retire it.
 * Before this, `Sessions.beforeDelete` only stamped `validTo` on each turn
 * (`msg-<messageId>` in `eco-<orgId>`): the text and the vectors stayed, and a
 * retrieve without `asOf` still returned them (measured on dev by the
 * 2026-10-20 dev lane).
 *
 * ── TWO STEPS, ON PURPOSE ────────────────────────────────────────────────────
 *
 *   1. RETIRE, IN THE TRANSACTION (`retireIngestedTurns`, `collections/Sessions.ts`).
 *      It hides the turns at once and it is harmless if the delete rolls back:
 *      the turns stop being retrieved, and the conversation keeps every row,
 *      so nothing is lost. A failed retire aborts the delete.
 *   2. ERASE, AFTER COMMIT (this file). `admin.deleteDocument` removes the
 *      document AND its chunks in one call, so the two can never disagree.
 *      🔴 Never delete chunks or documents separately, and never by SQL.
 *      An erase cannot be undone, so it runs only once `txid_status` says the
 *      delete committed, the same machinery as `lib/conversationUploads.ts`
 *      (read its header: txid, not "the row is gone", decides).
 *
 * ── WHAT IT CHECKS AFTER COMMIT ──────────────────────────────────────────────
 *
 *   · `aborted` → nothing. The turns stay retired, the conversation survives.
 *   · still `in progress` when the budget ends → nothing; every id is logged.
 *   · the SESSION still exists (a bulk delete commits the other rows when one
 *     row fails, Payload 3.88; see `conversationUploads.ts`) → nothing.
 *   · per turn: the `messages` row must be gone. A turn whose row survived is
 *     skipped.
 *   · ai-service's own `CORPUS_NOT_FOUND` / `DOCUMENT_NOT_FOUND` → already
 *     erased (`isDocumentAbsent`, which refuses a bare 404 from an ai-service
 *     that lacks the route).
 *   · any other failure → logged with ids. The turn stays retired, so it is
 *     hidden from every `asOf` retrieve, but its text is still stored.
 *     `scripts/check-turn-corpus.ts` finds and erases those.
 *
 * ⚠ A TURN STILL `embedding` WHEN THE CONVERSATION GOES can land at
 * ai-service after this ran: the erase reads it as absent, then the ingest
 * creates it, live. The callback ignores it (no `messages` row). The check
 * script finds it as `orphan-live`.
 *
 * 🔴 PRIVACY: logs carry ids only, never turn text.
 */

import type { Payload } from 'payload'

import { rowExists, waitForOutcome, type AfterCommitDeps, type TxOutcome } from './conversationUploads'

type Id = number | string

export interface TurnErasurePlan {
  sessionId: Id
  /** The delete's transaction (`txid_current()`), or null when there was none. */
  xid: string | null
  organizationId: Id
  /** `publishedCorpus(organizationId)`: turns only ever enter the shared corpus. */
  corpus: string
  /** The `messages` ids whose `msg-<id>` documents to erase. */
  messageIds: Id[]
}

interface TurnDeleter {
  admin: { deleteDocument(corpus: string, externalId: string): Promise<unknown> }
}

export interface TurnErasureDeps extends Pick<AfterCommitDeps, 'txStatus' | 'attempts' | 'intervalMs'> {
  payload: Payload
  /** The ecosistema's admin ai-service client. Injected by tests. */
  corpusClient?: (organizationId: Id) => Promise<TurnDeleter> | TurnDeleter
}

export type TurnErasureOutcome = TxOutcome | 'no-transaction' | 'session-survived'

const turnIdsOf = (plan: TurnErasurePlan): string[] => plan.messageIds.map((id) => `msg-${String(id)}`)

function planIds(plan: TurnErasurePlan): Record<string, unknown> {
  return { sessionId: String(plan.sessionId), corpus: plan.corpus, turnIds: turnIdsOf(plan) }
}

async function defaultClient(organizationId: Id): Promise<TurnDeleter> {
  const { getAdminAIClient } = await import('./aiClient')
  return getAdminAIClient(organizationId) as unknown as TurnDeleter
}

/**
 * Start the erase in the background. ⚠ Logs every id BEFORE the wait: a
 * restart while it polls loses the closure, and this line is then the only
 * trace of which turns were retired and not erased.
 */
export function scheduleTurnErasure(
  payload: Payload,
  plan: TurnErasurePlan,
  deps: Omit<TurnErasureDeps, 'payload'> = {},
): void {
  const { sessionId, ...rest } = planIds(plan)
  payload.logger.info({ sessionId, xid: plan.xid, ...rest }, '[sessions] scheduled post-commit turn erasure')
  void eraseTurnsAfterCommit(plan, { payload, ...deps }).catch((err) => {
    payload.logger.warn(
      { ...planIds(plan), err: String(err) },
      '[sessions] post-commit turn erasure failed; these turns are retired but NOT erased',
    )
  })
}

/** THE AFTER-COMMIT HALF. Never throws: the rows are gone, a failure can only be logged. */
export async function eraseTurnsAfterCommit(
  plan: TurnErasurePlan,
  deps: TurnErasureDeps,
): Promise<TurnErasureOutcome> {
  const { payload } = deps
  const log = payload.logger
  const allIds = planIds(plan)

  let outcome: TxOutcome | 'no-transaction' = 'no-transaction'
  if (plan.xid) {
    outcome = await waitForOutcome(plan.xid, deps)
    if (outcome === 'aborted') {
      log.info(allIds, '[sessions] delete rolled back; its turns stay retired and were not erased')
      return outcome
    }
    if (outcome === 'gave-up') {
      log.warn(
        allIds,
        '[sessions] could not learn whether the delete committed; these turns are retired but NOT erased',
      )
      return outcome
    }
  }

  if (await rowExists(payload, 'sessions', plan.sessionId)) {
    log.warn(allIds, '[sessions] the conversation survived its delete; its turns are retired but NOT erased')
    return 'session-survived'
  }

  let client: TurnDeleter
  try {
    client = await (deps.corpusClient ?? defaultClient)(plan.organizationId)
  } catch (err) {
    log.warn({ ...allIds, err: String(err) }, '[sessions] no ai-service client; these turns are retired but NOT erased')
    return outcome
  }

  const { isDocumentAbsent } = await import('./publishDocument')
  const erasedTurnIds: string[] = []
  const absentTurnIds: string[] = []
  for (const messageId of plan.messageIds) {
    const turnId = `msg-${String(messageId)}`
    try {
      if (await rowExists(payload, 'messages', messageId)) continue
      await client.admin.deleteDocument(plan.corpus, turnId)
      erasedTurnIds.push(turnId)
    } catch (err) {
      if (isDocumentAbsent(err)) {
        absentTurnIds.push(turnId)
        continue
      }
      log.warn(
        { ...allIds, turnId, err: String(err) },
        '[sessions] could not erase a deleted conversation’s turn; it is retired but NOT erased',
      )
    }
  }

  // What was DONE: a planned id missing from both lists was skipped or failed.
  log.info({ ...allIds, erasedTurnIds, absentTurnIds }, '[sessions] post-commit turn erasure finished')
  return outcome
}
