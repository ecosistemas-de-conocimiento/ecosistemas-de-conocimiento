import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { isIngestStatus } from '$lib/ingest';

/**
 * `PATCH /api/documents/[id]/transcript` — correct a machine transcription
 * while it is still a draft, and RE-INDEX it.
 *
 * ── 🔴 THE GATE, AND WHY IT IS RE-READ HERE ─────────────────────────────────
 *
 * Three conditions, all checked against a FRESH read of the row rather than
 * against anything the browser sent:
 *
 *   1. `kind === 'audio'` — this route corrects a transcript. A PDF's text is
 *      an extraction of a file the user already has; editing it would make the
 *      indexed text disagree with the document people can open.
 *   2. `publicationStatus === 'draft'` — once shared, other people may already
 *      have read or cited it. Changing text under a citation is worse than the
 *      typo it fixes.
 *   3. the caller is the UPLOADER — belt to the backend's braces
 *      (`documents.update` access is `uploadedBy`-scoped), and the thing that
 *      turns "not yours" into a clean 403 instead of a Payload error blob.
 *
 * ⚠ Condition 2 IS THIS ROUTE'S OWN. The backend has no draft-only rule on
 * `extractedText`, so nothing else in the stack enforces it. If that gate ever
 * needs to be authoritative rather than advisory, it belongs in
 * `Documents.beforeValidate` — reported, not added, since this app does not own
 * the backend.
 *
 * ── 🔴 HOW THE RE-INGEST HAPPENS: THE EXISTING PATH, NOT A NEW ONE ──────────
 *
 * There is exactly one ingest pipeline (`Documents.extractAndIngestHook` →
 * `runExtractAndIngest` → `enqueueIngestForDoc`) and this route steers it with
 * the same three fields the backend's own retry uses (`planIngestRetry`):
 *
 *   `extractedText` = the corrected text  → the extractor is SKIPPED, because
 *                                           the row already has text. This is
 *                                           what stops a correction from
 *                                           re-running Whisper over a
 *                                           three-hour recording.
 *   `ingestId`      = null                → the "already enqueued" guard opens,
 *                                           so `enqueueIngestForDoc` runs again.
 *   `ingestStatus`  = 'pending'           → the row reads honestly while it
 *                                           waits, and the client polls it.
 *
 * ai-service upserts on `(corpus, document id)`: re-ingesting the same document
 * id DELETES the previous chunks inside one transaction and inserts the new
 * ones. So the corrected text replaces the old one in retrieval rather than
 * sitting beside it — which is the whole point. Verified by reading
 * `services/ai-service/src/workers/ingest.worker.ts`.
 *
 * 🔴 ON A TESTIMONIO THE GATE RE-RUNS. The backend's `gateResetForTextEdit`
 * (collections/Documents.ts) clears `anonymisationStatus` and `redactedText`
 * when this write changes the text, so the next ingest anonymises the
 * CORRECTED text instead of re-using an approval given to the old one. This
 * route cannot do it itself: those columns are locked against API writes.
 *
 * ⚠ AN EMPTY TRANSCRIPT IS REFUSED. Saving one would embed an empty document:
 * retrieval would find nothing, the row would still say `listo`, and the
 * recording would vanish from every answer with nothing looking broken.
 */

/** Cap the stored text. Generous — 4h of speech is well under 400k chars. */
const MAX_TRANSCRIPT_CHARS = 1_000_000;

interface DocRow {
  kind?: unknown;
  publicationStatus?: unknown;
  ingestStatus?: unknown;
  uploadedBy?: unknown;
}

/**
 * The four fields the gate reasons about, and nothing else.
 *
 * ⚠ NOT a micro-optimisation. Payload's default read selects every column, so
 * an unselected read couples this route to the ENTIRE `documents` schema —
 * including columns it never looks at. Observed on the live stack mid-migration:
 * a plain `GET /api/documents/:id` 500'd with `column "session_id" does not
 * exist` while the same row read fine with an explicit `select`. A route that
 * only needs four fields should not break because a fifth one moved.
 */
const GATE_FIELDS = ['kind', 'publicationStatus', 'ingestStatus', 'uploadedBy'] as const;

function gateQuery(): string {
  const qs = new URLSearchParams({ depth: '0' });
  for (const f of GATE_FIELDS) qs.set(`select[${f}]`, 'true');
  return qs.toString();
}

function relationId(raw: unknown): string | null {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return null;
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  let body: { transcript?: unknown } = {};
  try {
    body = (await request.json()) as { transcript?: unknown };
  } catch {
    return json({ error: 'invalid_body' }, { status: 400 });
  }

  const raw = typeof body.transcript === 'string' ? body.transcript : '';
  if (!raw.trim()) return json({ error: 'transcript_empty' }, { status: 400 });
  if (raw.length > MAX_TRANSCRIPT_CHARS) {
    return json({ error: 'transcript_too_long' }, { status: 413 });
  }

  // ── Read the row under the caller's own token, so access control applies ──
  let readRes: Response;
  try {
    readRes = await backendFetch(
      locals.token,
      `/api/documents/${encodeURIComponent(id)}?${gateQuery()}`,
      { method: 'GET' },
    );
  } catch (err) {
    return json(
      {
        error: 'upstream_unreachable',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
      { status: 502 },
    );
  }
  if (readRes.status === 404 || readRes.status === 403) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  if (!readRes.ok) return json({ error: 'upstream_unavailable' }, { status: 502 });

  const row = (await readRes.json().catch(() => ({}))) as DocRow;

  if (row.kind !== 'audio') {
    return json({ error: 'not_a_transcript' }, { status: 409 });
  }
  /**
   * 🔴 THE RAW VALUE, COMPARED TO `'draft'` EXACTLY — deliberately NOT
   * `parsePublicationStatus`.
   *
   * That helper fails toward `draft` for anything it does not recognise, which
   * is the SAFE direction for a badge ("solo tú lo ves" under-claims harmlessly)
   * and the WRONG one for a write gate: it would open editing on a status this
   * app has never heard of. The backend already has one such value — Payload's
   * `unpublishing` — that `PUBLICATION_STATUSES` here does not list.
   *
   * ⚠ A write gate fails CLOSED. Refusing an edit on an anomalous row costs the
   * uploader one retry; allowing one on a possibly-shared document is the thing
   * this route exists to prevent.
   */
  if (row.publicationStatus !== 'draft') {
    // ⚠ 409, not 403. The caller may edit transcripts; this particular one has
    // moved past the state where editing is safe, and that is a different fact.
    return json({ error: 'already_published' }, { status: 409 });
  }
  const uploader = relationId(row.uploadedBy);
  if (uploader !== null && uploader !== String(locals.user.id)) {
    return json({ error: 'not_uploader' }, { status: 403 });
  }
  const ingestStatus = isIngestStatus(row.ingestStatus) ? row.ingestStatus : 'n/a';
  if (ingestStatus !== 'ready' && ingestStatus !== 'transcribed' && ingestStatus !== 'failed') {
    // Still moving. Two writers on one column is not a race worth having.
    return json({ error: 'ingest_in_progress', ingestStatus }, { status: 409 });
  }

  // ── The write. See the header for why these three fields and no others. ──
  let res: Response;
  try {
    res = await backendFetch(locals.token, `/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        extractedText: raw,
        ingestId: null,
        ingestStatus: 'pending',
        ingestError: null,
      }),
    });
  } catch (err) {
    return json(
      {
        error: 'upstream_unreachable',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
      { status: 502 },
    );
  }

  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return json(out, { status: res.status });

  // We report only what the write asked for: the row is queued again. The
  // ingest itself is asynchronous and the client polls for the rest — claiming
  // anything further would be painting a state the server has not reached.
  return json({ ok: true, ingestStatus: 'pending', transcript: raw }, { status: 200 });
};
