/**
 * Adapt chat's BFF `AIServiceClient` (the `unit`-shaped wire client) to the
 * `@edc/chat-engine` `AIClient` seam (`generateSync({messages})` +
 * `retrieve({corpus, query, topK, filter})`).
 *
 * Two impedance mismatches handled here:
 *
 *  1. **generate shape.** The engine hands us a full `messages[]` (system +
 *     history + the user-turn-injected message); ai-service takes a real
 *     `systemPrompt` plus ONE rendered user message. `buildChatUnitRequest`
 *     (`./wire.ts`) owns that partition — see its header for what moves where
 *     and why. It used to be a system-role FOLD (everything flattened into the
 *     user message with literal `system:` markers); that is gone.
 *
 *  2. **retrieve shape + filter.** chat's `RetrieveResponse` is `{chunks}`
 *     with `{chunkId, documentId, ordinal, text, score, metadata}`; the engine
 *     wants `{matches}` with `{documentId, chunkId, score, text, metadata}`.
 *     We map it. The engine's `filter` is forwarded to ai-service `/v1/retrieve`
 *     as an extra field even though `@edc/ai-client@0.2.0` (and chat's
 *     local schema) don't type it — a sibling client already does this; the
 *     ai-service `filter` shipped in `d312d10`. chat's local zod schema is
 *     `.strict()`, so we bypass it for the filtered path (raw fetch) and fall
 *     back to the typed client when no filter is present.
 *
 * ── WHAT RETRIEVAL IS SCOPED TO ──────────────────────────────────────────────
 *
 * Two different scopes, and conflating them was a real defect:
 *
 *   · the ecosistema's PUBLISHED corpus is GLOBAL to the ecosistema. Published
 *     documents and testimonies are the shared brain: every conversation, for
 *     everyone, forever. That is the point of publishing and it is not filtered
 *     here.
 *   · the caller's DRAFT corpus is per-person but spans ALL of their
 *     conversations, because ai-service has one draft corpus per user. Drafts
 *     are "the documents here": they belong to the conversation they were
 *     uploaded into. So the draft leg is post-filtered down to the documents
 *     attached to THIS conversation.
 *
 * Two more things this file now refuses to do, both before any network call:
 *
 *   · retrieve from a corpus the BACKEND did not authorise for this turn
 *     (`allowedCorpora`). That kills the engine's unconditional
 *     `chat:thread:{id}` leg — nothing in this product ever ingests there, so
 *     it was a per-turn round-trip to a 404 — and it is defence in depth: the
 *     engine can no longer reach a corpus name we were not handed.
 *   · retrieve drafts when we could not read this conversation's document list.
 *     See `retrieve()` — it fails CLOSED, like `asOf` does.
 */

import type {
  AIClient as EngineAIClient,
  RetrieveRequest as EngineRetrieveRequest,
  RetrieveResult as EngineRetrieveResult,
  SyncGenerationRequest as EngineSyncGenerationRequest,
  SyncGenerationResult as EngineSyncGenerationResult,
  IngestRequest as EngineIngestRequest,
  IngestResult as EngineIngestResult,
} from '@edc/chat-engine/core';
import type { AIServiceClient } from '$lib/server/aiService';
import { buildChatUnitRequest } from './wire';
import { useRegistryPrompt } from './promptSource';
import { buildRetrieveBody } from '$lib/server/retrieval';
import { env } from '$env/dynamic/private';

/** Map the engine's effort tier to ai-service's `effortLevel`. */
function effortLevel(effort: string | undefined): string | undefined {
  // chat's ai-service registry accepts these; pass through unchanged. Unknown
  // values are dropped so a future tier can't break the call.
  if (effort && ['quick', 'standard', 'deep', 'maximum'].includes(effort)) return effort;
  return undefined;
}

/** The BACKEND's id for a chunk's document, or '' when the chunk carries none. */
function backendDocId(chunk: RawRetrieveChunk): string {
  const id = chunk.metadata?.docId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

interface RawRetrieveChunk {
  chunkId: string;
  documentId: string;
  ordinal?: number;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * How many chunks the draft leg asks ai-service for, per requested chunk.
 *
 * ⚠ WITHOUT THE OVER-FETCH THE DRAFT LEG SILENTLY STARVES. ai-service ranks
 * across the caller's WHOLE draft corpus — every conversation they have ever
 * uploaded into. Ask for 5 and a handful of top-scoring drafts from other
 * conversations eat the entire budget; we then filter them all out and this
 * conversation's own documents never appear, even though they were sitting at
 * rank 6. So we ask wide, drop what does not belong here, and truncate back.
 */
const DRAFT_OVERFETCH_FACTOR = 4;
/** Ceiling on the over-fetch, so a large `topK` cannot ask for the world. */
const DRAFT_OVERFETCH_MAX = 50;
/** `RetrieveRequest.topK` is optional; the engine always sends 5 today. */
const DEFAULT_TOPK = 5;

export interface EngineAIClientOptions {
  sessionId: string;
  /** Propagates the request's AbortSignal so a user "Stop" cancels upstream. */
  signal?: AbortSignal;
  /** The validity instant from `GET /api/sessions/:id/corpora`. */
  asOf?: string | null;
  /**
   * The corpus names the BACKEND authorised for this turn. Anything else is
   * refused without a network call — see `retrieve()`.
   *
   * Omitted or empty means "nothing authorised", and therefore no retrieval.
   * That is the same direction `asOf` fails in: a turn with less context, not
   * a turn that reached a corpus nobody granted it.
   */
  allowedCorpora?: readonly string[];
  /**
   * Which of `allowedCorpora` is the ecosistema's SHARED published corpus — the
   * system's brain. It is the ONLY corpus exempt from the per-conversation
   * narrowing below.
   *
   * 🔴 STATED AS AN EXEMPTION, NOT AS A TARGET, AND THAT IS THE WHOLE POINT.
   * The obvious spelling is "narrow the corpus I recognise as the draft one".
   * It fails OPEN: the day the corpora response stops being recognisable, every
   * draft silently goes global again and the only symptom is answers quoting
   * documents from other conversations — which is the defect this exists to
   * fix, reappearing with no error anywhere.
   *
   * Stated this way it fails CLOSED: an unrecognisable response narrows
   * everything, the caller loses their own drafts, and someone reports it. Be
   * wrong in the direction that gets noticed.
   *
   * `null` → every authorised corpus is narrowed, and `retrieve` says so once.
   * `parseCorporaResponse` ($lib/server/retrieval) is the single place that
   * decides; the backend's `/corpora` handler names it in `published`.
   */
  publishedCorpus?: string | null;
  /**
   * Ids of the documents attached to THIS conversation.
   *
   * 🔴 `null` (or omitted) means "we could not read the list", NOT "there are
   * none". The draft leg refuses to retrieve at all in that case.
   */
  sessionDocumentIds?: ReadonlySet<string> | null;
}

/**
 * Build an engine `AIClient` over chat's BFF client + a session-scope tag.
 * See the module header for what retrieval is scoped to.
 */
export function makeEngineAIClient(
  chatClient: AIServiceClient,
  opts: EngineAIClientOptions = { sessionId: '' },
): EngineAIClient {
  const allowedCorpora = new Set(opts.allowedCorpora ?? []);
  const publishedCorpus = opts.publishedCorpus ?? null;
  if (publishedCorpus === null && allowedCorpora.size > 0) {
    console.error(
      '[retrieve] the corpora response did not name the ecosistema\'s shared corpus, ' +
        'so EVERY corpus is being narrowed to this conversation\'s documents. Published ' +
        'content will be missing from answers. Check the `published` field of ' +
        'GET /api/sessions/:id/corpora ($lib/server/retrieval.parseCorporaResponse).',
    );
  }
  // `undefined` and `null` mean the same thing here — unknown — and both fail
  // closed. Normalise once so no branch below has to remember that.
  const sessionDocumentIds = opts.sessionDocumentIds ?? null;

  return {
    async generateSync(req: EngineSyncGenerationRequest): Promise<EngineSyncGenerationResult> {
      // `generateSync` itself asserts `systemPromptApplied === true` whenever
      // the built request carried a `systemPrompt`, so a dropped or unsupported
      // system prompt throws here rather than silently degrading the answer.
      const result = await chatClient.generateSync(
        buildChatUnitRequest({
          messages: req.messages,
          unitKey: opts.sessionId || req.scopeId || req.surface,
          // Off unless PROMPT_SOURCE=registry, so this is today's
          // behaviour until an operator flips it — see `./promptSource`.
          useRegistryPrompt: useRegistryPrompt(),
          ...(effortLevel(req.effort) ? { effortLevel: effortLevel(req.effort)! } : {}),
          ...(req.modelOverride ? { modelOverride: req.modelOverride } : {}),
        }),
        opts.signal ? { signal: opts.signal } : {},
      );
      // ⚠ `warnings` (e.g. BUDGET_SOFT_CAP) is carried as an EXTRA field the
      // engine cannot type: `SyncGenerationResult` in
      // `@edc/chat-engine/core` has no `warnings` key, and that package
      // is published and shared — we must not edit it here. The engine's
      // `respond()` returns the generation object by reference
      // (`return { ...prepared, generation }`), so an extra field rides through
      // untouched and the BFF reads it back off the result. If chat-engine ever
      // starts re-shaping the generation, this field dies silently — the fix
      // then is to add `warnings` to `SyncGenerationResult` in the prototypes.
      const passthrough: EngineSyncGenerationResult & { warnings?: unknown } = {
        text: result.text,
        parsed: result.parsed,
        modelUsed: result.modelUsed ?? 'unknown',
        provider: result.provider ?? 'unknown',
        costUsd: result.costUsd ?? 0,
        traceId: result.traceId ?? '',
      };
      if (result.warnings?.length) passthrough.warnings = result.warnings;
      return passthrough;
    },

    async retrieve(req: EngineRetrieveRequest): Promise<EngineRetrieveResult> {
      // (a) 🔴 THE AUTHORISATION GATE — before any network call.
      //
      // Two jobs at once:
      //  · it drops the engine's unconditional `chat:thread:{sessionId}` leg
      //    (`packages/chat-engine/src/core/retrieve.ts`). Nothing in this
      //    product ever ingests into that corpus — `ingest` below is a no-op —
      //    so every turn was paying for an HTTP round-trip to a guaranteed 404.
      //  · defence in depth: the backend is the sole authority on which corpora
      //    a caller may read (`apps/backend/src/lib/corpus.ts`). A corpus name
      //    that did not come from `GET /api/sessions/:id/corpora` never reaches
      //    ai-service, whatever the engine decides to ask for next.
      if (!allowedCorpora.has(req.corpus)) return { matches: [] };

      // (b) Everything EXCEPT the ecosistema's shared corpus is narrowed to the
      // documents attached to THIS conversation. The caller's draft corpus spans
      // all of their conversations, and drafts belong to the one they were
      // uploaded into. See `EngineAIClientOptions.publishedCorpus` for why this
      // is written as an exemption rather than as "narrow the draft corpus".
      const isDraftLeg = publishedCorpus === null || req.corpus !== publishedCorpus;

      if (isDraftLeg && sessionDocumentIds === null) {
        // 🔴 FAIL CLOSED, exactly like the `asOf` guard below.
        //
        // ⚠ A future reader WILL be tempted to "helpfully" fall back to an
        // unfiltered draft retrieve here. Do not. The two ways to be wrong are
        // not symmetric: losing the caller's own drafts for one turn is a worse
        // answer, while letting another conversation's drafts in is the exact
        // defect this filter exists to fix — a document answering in a
        // conversation it was never attached to.
        console.error(
          `[retrieve] refusing the draft corpus "${req.corpus}" — this conversation's ` +
            'document list could not be read, so we cannot tell which drafts belong ' +
            'here. Check GET /api/documents?where[session][equals]=… ' +
            '($lib/server/sessionDocs).',
        );
        return { matches: [] };
      }

      const topK = req.topK && req.topK > 0 ? req.topK : DEFAULT_TOPK;
      // Over-fetch only on the draft leg — see `DRAFT_OVERFETCH_FACTOR`.
      const upstreamReq: EngineRetrieveRequest = isDraftLeg
        ? { ...req, topK: Math.min(topK * DRAFT_OVERFETCH_FACTOR, DRAFT_OVERFETCH_MAX) }
        : req;

      // 🔴 ALL retrieval goes through the raw path now, filtered or not, so
      // that every call carries `asOf`. The typed client's zod schema is
      // `.strict()` and would reject the extra field — and a retrieve without
      // `asOf` still returns the chunks of UNPUBLISHED documents, because
      // unpublishing only end-dates them. See `$lib/server/retrieval`.
      const chunks = await retrieveScoped(upstreamReq, opts.asOf);

      // ⚠ Post-filter, not an ai-service `filter`. ai-service's `filter` is
      // metadata EQUALITY only — it cannot express "documentId IN (…)" — and
      // the draft chunks carry no `sessionId` in their metadata anyway
      // (`apps/backend/src/collections/Documents.ts`, the ingest call: docId,
      // organizationId, kind, publication, title). So post-filtering is the
      // only thing that works on data already in the corpus.
      //
      // 🔴 Match on `metadata.docId`, never on `documentId`. `documentId` is
      // ai-service's own UUID for its copy; the backend id the session list
      // holds is `metadata.docId`. Matching on the UUID dropped every draft
      // chunk, so attached documents were never cited (measured 2026-10-14).
      const kept =
        isDraftLeg && sessionDocumentIds
          ? chunks.filter((c) => sessionDocumentIds.has(backendDocId(c))).slice(0, topK)
          : chunks;

      return {
        matches: kept.map((c) => ({
          documentId: c.documentId,
          chunkId: c.chunkId,
          score: c.score,
          text: c.text,
          ...(c.metadata ? { metadata: c.metadata } : {}),
        })),
      };
    },

    // apps/web does not ingest from the BFF (the backend's Documents hook owns
    // ingest). The engine's corpus-sync path is unused on this surface; provide
    // a no-op so the seam is satisfied.
    async ingest(_req: EngineIngestRequest): Promise<EngineIngestResult> {
      return { ingested: 0, documentIds: [] };
    },
  };
}

/**
 * Retrieve one corpus, always scoped to `asOf`.
 *
 * Raw fetch rather than the typed client: the local zod schema is `.strict()`
 * and types neither `filter` nor `asOf`.
 *
 * 🔴 FAILS CLOSED. `buildRetrieveBody` returns null when there is no `asOf`,
 * and we then return no chunks instead of retrieving unscoped. That is
 * deliberate: an unscoped retrieve silently includes the chunks of unpublished
 * documents, so "answer with less context" is the correct degradation and
 * "answer with leaked context" is not. Failure is otherwise swallowed by the
 * engine's per-corpus try/catch, so an empty result just drops this corpus.
 */
async function retrieveScoped(
  req: EngineRetrieveRequest,
  asOf: string | null | undefined,
): Promise<RawRetrieveChunk[]> {
  const baseUrl = env.AI_SERVICE_URL?.replace(/\/+$/, '');
  const apiKey = env.AI_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return [];

  const body = buildRetrieveBody({
    corpus: req.corpus,
    query: req.query,
    topK: req.topK,
    filter: req.filter,
    asOf,
  });
  if (!body) {
    console.error(
      `[retrieve] refusing to retrieve corpus "${req.corpus}" without an asOf ` +
        '— unpublished documents would be included. Check GET /api/sessions/:id/corpora.',
    );
    return [];
  }

  const post = (payload: Record<string, unknown>) =>
    fetch(`${baseUrl}/v1/retrieve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  let res = await post(body);
  if (!res.ok) {
    // An ai-service that rejects the extra `filter` field: retry without it so
    // scoped retrieval degrades to unfiltered rather than empty.
    // ⚠ `asOf` is NOT dropped on the retry — that would reintroduce the leak.
    // If the 400 was caused by `asOf` itself, we take the empty result.
    if (res.status === 400 && body.filter !== undefined) {
      const { filter: _dropped, ...withoutFilter } = body;
      res = await post(withoutFilter);
    }
    if (!res.ok) return [];
  }
  const parsed = (await res.json().catch(() => ({}))) as { chunks?: RawRetrieveChunk[] };
  return parsed.chunks ?? [];
}
