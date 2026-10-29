/**
 * 🔴 ERASE A DOCUMENT WHOSE INGEST LANDED AFTER ITS ROW WAS DELETED.
 *
 * Audit 2026-10-28, retention cluster. The document twin of `eraseLateTurn`
 * (`lib/conversationTurnErasure.ts`).
 *
 * Deleting a `documents` row erases it from both corpora
 * (`retireDeletedDocument`, `afterDelete`). But ai-service creates the document
 * only in its ingest worker. A delete while the ingest is still queued finds
 * nothing to erase, and the ingest then creates it, LIVE, under a row that no
 * longer exists. The ingest callback is the first moment EDC can see it.
 *
 * ⚠ SAFE TO ERASE ON "ROW GONE" ALONE: `documents` ids come from a serial and
 * are never reused, so no live row can own that external id once its row is
 * gone. The caller decides "gone" from a real not-found, never from an error.
 *
 * ⚠ ONLY FROM AN EDC CORPUS NAME, read from the signed envelope's `corpus`:
 * `eco-<id>` (shared) or `eco-<id>-draft-<user>` (draft). The client is that
 * ecosistema's (`X-AI-Org`). Anything else is skipped with a warning.
 *
 * THROWS on a real failure, so the callback answers 500 and ai-service
 * retries. Before throwing it retires the copy (closes its validity window), so
 * the document at least stops being retrieved meanwhile. ai-service's own
 * not-found is success.
 *
 * 🔴 PRIVACY: logs carry ids only, never document text.
 */

type Id = number | string

interface DocumentDeleter {
  admin: {
    deleteDocument(corpus: string, externalId: string): Promise<unknown>
    setDocumentValidity(
      corpus: string,
      externalId: string,
      bounds: { validFrom?: string | null; validTo?: string | null },
    ): Promise<unknown>
  }
}

/** The ecosistema id of an EDC corpus, shared or draft; null for anything else. */
export function organizationOfDocumentCorpus(corpus: string): string | null {
  return /^eco-(\d+)(?:-draft-[A-Za-z0-9_]+)?$/.exec(corpus)?.[1] ?? null
}

export type LateDocumentOutcome = 'erased' | 'absent' | 'skipped'

async function defaultClient(organizationId: Id): Promise<DocumentDeleter> {
  const { getAdminAIClient } = await import('./aiClient')
  return getAdminAIClient(organizationId) as unknown as DocumentDeleter
}

export async function eraseLateDocument(args: {
  documentId: string
  corpus: string | undefined
  log: { warn(obj: Record<string, unknown>, msg: string): void; info(obj: Record<string, unknown>, msg: string): void }
  corpusClient?: (organizationId: Id) => Promise<DocumentDeleter> | DocumentDeleter
  now?: Date
}): Promise<LateDocumentOutcome> {
  const { documentId, corpus } = args
  const organizationId = corpus ? organizationOfDocumentCorpus(corpus) : null
  if (organizationId == null || !/^\d+$/.test(documentId)) {
    args.log.warn(
      { documentId, corpus: corpus ?? null },
      '[callback] a document landed after its row was deleted, outside an EDC corpus; NOT erased',
    )
    return 'skipped'
  }
  const client = await (args.corpusClient ?? defaultClient)(organizationId)
  const { isDocumentAbsent, retireFrom } = await import('./publishDocument')
  try {
    await client.admin.deleteDocument(corpus as string, documentId)
  } catch (err) {
    if (isDocumentAbsent(err)) return 'absent'
    // Hide it while ai-service retries the callback. A retire failure must not
    // mask the delete failure that caused it.
    await retireFrom(client as never, corpus as string, documentId, args.now ?? new Date()).catch(() => undefined)
    throw err
  }
  args.log.info({ documentId, corpus }, '[callback] erased a document that landed after its row was deleted')
  return 'erased'
}
