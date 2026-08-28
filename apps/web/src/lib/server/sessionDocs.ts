/**
 * The documents attached to ONE conversation — the I/O half.
 *
 * Companion to `./corpora.ts`: that module answers "which corpora may this
 * turn read", this one answers "which documents belong to this conversation".
 * Both are read once per turn and shared by every consumer, so a turn never
 * asks the backend the same question twice.
 *
 * ## Why the caller must be able to tell empty from unknown
 *
 * 🔴 `ok: false` means "we could not find out", and it is NOT the same as an
 * empty list. The draft leg of retrieval post-filters on this list: an empty
 * list drops every draft chunk, which is correct when the conversation really
 * has no documents and catastrophic when we simply failed to read them. The
 * `ok` flag is what lets `makeEngineAIClient` fail CLOSED on the unknown case
 * instead of silently answering as if the conversation were empty.
 *
 * ## ⚠ ONE PLACE, on purpose
 *
 * `sessionDocumentsQuery` is the single expression of the Payload `where`
 * clause. `documents.session` is becoming a `hasMany` relationship (a document
 * can be attached to several conversations); Payload's `[equals]` on a hasMany
 * relationship matches "contains this id", which is what we want — but if that
 * ever proves wrong, this one function is the fix, not a grep across the app.
 */

import { backendFetch } from '$lib/server/auth';

/** The document fields this app reads off a session's document list. */
export interface SessionDocRow {
  id: number | string;
  name: string;
  kind?: string | null;
  ingestStatus?: string | null;
  publicationStatus?: string | null;
}

export interface SessionDocs {
  /** The conversation's documents, in creation order. Empty when `ok` is false. */
  docs: SessionDocRow[];
  /**
   * Did we actually read the list? `false` on any failure — non-2xx, a thrown
   * fetch, an unreadable body. Callers MUST branch on this rather than on
   * `docs.length`; see the module header.
   */
  ok: boolean;
}

const UNKNOWN: SessionDocs = { docs: [], ok: false };

/**
 * The ONE place the "documents of this session" query is written.
 *
 * Same shape the rest of the app uses (`routes/api/sessions/[id]/documents`),
 * deliberately: two spellings of this query would drift, and the drift would
 * show up as drafts that answer in the wrong conversation.
 */
export function sessionDocumentsQuery(sessionId: string): string {
  const qs = new URLSearchParams({
    'where[session][equals]': sessionId,
    limit: '500',
    depth: '0',
    sort: 'createdAt',
  });
  return `/api/documents?${qs.toString()}`;
}

/**
 * Read the documents attached to `sessionId`.
 *
 * Never throws. Every failure path returns `{docs: [], ok: false}` and logs,
 * the same way `./corpora.ts` does — a turn degrades, it does not 500.
 */
export async function fetchSessionDocs(
  token: string | undefined,
  sessionId: string,
): Promise<SessionDocs> {
  if (!sessionId) return UNKNOWN;
  try {
    const res = await backendFetch(token, sessionDocumentsQuery(sessionId), { method: 'GET' });
    if (!res.ok) {
      console.error(
        `[sessionDocs] backend answered ${res.status} for session ${sessionId}; ` +
          'the draft corpus will be skipped this turn rather than answered from ' +
          'another conversation’s documents.',
      );
      return UNKNOWN;
    }
    const body = (await res.json()) as { docs?: unknown };
    if (!Array.isArray(body?.docs)) {
      console.error(
        `[sessionDocs] unreadable document list for session ${sessionId}; ` +
          'treating it as unknown, not as empty.',
      );
      return UNKNOWN;
    }
    const docs: SessionDocRow[] = [];
    for (const row of body.docs) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (r.id == null) continue;
      docs.push({
        id: r.id as number | string,
        name: typeof r.name === 'string' ? r.name : '',
        kind: (r.kind as string | null | undefined) ?? null,
        ingestStatus: (r.ingestStatus as string | null | undefined) ?? null,
        publicationStatus: (r.publicationStatus as string | null | undefined) ?? null,
      });
    }
    return { docs, ok: true };
  } catch (err) {
    console.error(`[sessionDocs] read failed for session ${sessionId}:`, err);
    return UNKNOWN;
  }
}

/**
 * The document ids of this conversation, as the retrieval filter wants them:
 * a set of strings, or `null` when we could not read the list.
 *
 * 🔴 The `null` is load-bearing — it is what makes the draft leg fail closed.
 * Do not collapse it to an empty set.
 */
export function sessionDocumentIdSet(result: SessionDocs): ReadonlySet<string> | null {
  if (!result.ok) return null;
  return new Set(result.docs.map((d) => String(d.id)));
}
