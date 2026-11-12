import { errSummary, safeErrMessage } from '$lib/errorSummary';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  getAIClient,
  httpStatusFor,
  logBudgetFailure,
  logAIWarnings,
  sanitizeStreamErrorFrame,
  type AIWarning,
} from '$lib/server/aiService';
import { backendFetch } from '$lib/server/auth';
import {
  buildChatUnitRequest,
  CHAT_ENGINE_CONFIG,
  chatEngineConfigFor,
  chatKindFilterAvailable,
  chatOrientScope,
  chatTurnMode,
  chatTurnHybrid,
  chatTurnRetrievalPolicy,
  engineOrgId,
  makeChatDomainAdapter,
  makeEngineAIClient,
  queryExpansionEnabled,
  useRegistryPrompt,
  withQueryExpansion,
  type ChatTurnMode,
} from '$lib/server/engine';
import { fetchSessionCorpora } from '$lib/server/corpora';
import { fetchSessionDocs, sessionDocumentIdSet } from '$lib/server/sessionDocs';
import { turnAttachments, withPinnedRefs } from './pinned';
import {
  fetchPublishedTitleScan,
  matchDocumentTitle,
  titleRetrievalFilter,
  withTitleRef,
} from '$lib/server/titleMatch';
import { ecosystemName, sessionMeta } from '$lib/server/ecosystem';
import { fetchEcosystemSettings } from '$lib/server/features';
import { fetchScopeDocumentIds, parseAlcance } from '$lib/server/estudiante';
import { makeGraphProvider, makeOverviewGraphProvider } from '$lib/server/graph';
import { regroupTurn, type SummarySource } from '$lib/server/engine/sources';
import { documentListText, isCorpusOverview, withoutRetrieval } from '$lib/server/engine/overview';
import { ATTACHMENT_RELEVANCE_RULE, FOLLOW_UP_RULE, withTurnRules } from '$lib/server/engine/prompt';
import { withFencedChunks, withFencedRefs } from '$lib/server/engine/chunkFence';
import { withCondenseDeadline } from '$lib/server/engine/condenseDeadline';
import { fetchOrientationTurns, orientationBlock, withOrientation } from '$lib/server/engine/orientation';
import { fetchLenguaIndex } from '$lib/server/lenguas';
import { lenguaTurn } from '$lib/lengua';
import { stampDraftProvenance } from '$lib/publication';
import { citedBrowserProvenance, toBrowserMessage } from '$lib/server/citationProvenance';
import { backendTitleFetcher, testimonioDocIds, withTestimonioTitles } from '$lib/server/testimonioTitles';
import { ANSWER_NOT_SAVED_CODE, ANSWER_NOT_SAVED_MESSAGE } from '$lib/aiMessages';
import {
  ANSWER_TRUNCATED_CODE,
  AnswerTruncatedError,
  assertAnswer,
  EMPTY_ANSWER_CODE,
  EmptyAnswerError,
  isEmptyAnswerCode,
  isTruncatedAnswerCode,
  parseCitedOrdinals,
  prepareTurn,
  streamOutcome,
  type ContextRef,
  type ContextScope,
  type Provenance,
} from '@edc/chat-engine/core';

/** The turn was refused because the session row could not be read (no kind). */
const SESSION_UNAVAILABLE_CODE = 'session_unavailable';

/**
 * 🔴 The model answered with no visible text (dev 2026-11-10: 3 of 6 turns,
 * model `unknown`, 0 tokens). Never saved: the backend refuses an empty
 * `content`, and that refusal was the ANSWER_NOT_SAVED the person got after
 * 18–58 s. The turn fails with `EMPTY_ANSWER_CODE` instead, which the browser
 * shows as a failed answer with "Reintentar". The user's own message, saved
 * by the browser before the turn, stays.
 */
const EMPTY_ANSWER_MESSAGE = 'ai-service returned an empty answer; nothing was saved.';

/**
 * The model spent the output cap before writing anything (ai-service's
 * `CompletionTruncated`, or an empty `done` with `finishReason: 'length'`).
 * Never saved, like an empty answer, but its own code: asking again hits the
 * same cap, so the browser shows it without "Reintentar".
 */
const ANSWER_TRUNCATED_MESSAGE = 'ai-service hit the output limit before writing an answer; nothing was saved.';

/** Every code an ai-service failure carries: the tag, the flat `code`, the nested `{ error: { code } }`. */
function failureCodes(err: unknown): unknown[] {
  const e = err as { bodyError?: unknown; body?: unknown } | null;
  const body = (e?.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; error?: unknown };
  const nested = body.error && typeof body.error === 'object' ? (body.error as { code?: unknown }).code : undefined;
  return [e?.bodyError, body.code, body.error, nested];
}

/**
 * The code a failed turn with no answer goes out with, or `undefined` when it
 * is some other failure: `ANSWER_TRUNCATED_CODE` for an empty answer at the
 * output cap, `EMPTY_ANSWER_CODE` for any other empty answer. Read from the
 * engine's typed errors or an upstream code in any spelling.
 */
function noAnswerCode(err: unknown): typeof EMPTY_ANSWER_CODE | typeof ANSWER_TRUNCATED_CODE | undefined {
  if (err instanceof AnswerTruncatedError) return ANSWER_TRUNCATED_CODE;
  if (err instanceof EmptyAnswerError) return EMPTY_ANSWER_CODE;
  const codes = failureCodes(err);
  if (codes.some(isTruncatedAnswerCode)) return ANSWER_TRUNCATED_CODE;
  if (codes.some(isEmptyAnswerCode)) return EMPTY_ANSWER_CODE;
  return undefined;
}

/** The terminal error a turn with no answer ends with, on either transport. */
function noAnswerBody(code: typeof EMPTY_ANSWER_CODE | typeof ANSWER_TRUNCATED_CODE | string) {
  return code === ANSWER_TRUNCATED_CODE
    ? { code: ANSWER_TRUNCATED_CODE, message: ANSWER_TRUNCATED_MESSAGE }
    : { code: EMPTY_ANSWER_CODE, message: EMPTY_ANSWER_MESSAGE };
}

function logEmptyAnswer(sessionId: string, transport: 'sync' | 'stream', code: string = EMPTY_ANSWER_CODE): void {
  console.error(`[generate] empty answer for session ${sessionId} (${transport}); not saved, the turn fails with ${code}.`);
}

/** Max characters of each chunk's passage persisted on the provenance. */
const PASSAGE_TEXT_CAP = 1200;

/**
 * BFF — chat turns now run through `@edc/chat-engine`.
 *
 * THE USER-TURN FIX (spec §0): factual context (deterministic organization +
 * document summary, retrieved chunks, `@`-cited entities) is assembled by the
 * engine into the USER turn, NOT the system prompt. The old PROMPT_TEMPLATE
 * that inlined docs/chunks into a behavioral system message is gone; the engine
 * owns context assembly. `buildChatUnitRequest` then splits the engine's
 * `messages[]` into a REAL ai-service system prompt (behavioural block) + one
 * rendered user message (history + context-bearing user turn) — see
 * `$lib/server/engine/wire.ts`.
 *
 * Pipeline per turn:
 *   1. Read the turn's scope from the backend ONCE — which corpora, as of
 *      when, which ecosistema, and which documents are attached to this
 *      conversation. One `Promise.all`, shared by everything below.
 *   2. Build the Domain Adapter (ecosistema + this conversation's documents).
 *   3. `prepareTurn()` — condense → deterministic summary → scoped retrieve
 *      (each search also run on the question's rewordings, unless
 *      `QUERY_EXPANSION=off`) → resolve `@`-refs → assemble the user turn.
 *   4. Generate: sync (`respond`-style) or stream (drive the existing SSE proxy
 *      with the engine-assembled messages).
 *   5. Persist the assistant turn (+ provenance) and round-trip the message id.
 *
 * ── WHAT A TURN CAN RETRIEVE ─────────────────────────────────────────────────
 *
 * Two scopes, and they are deliberately different:
 *   · the ecosistema's PUBLISHED corpus — GLOBAL. Published documents and
 *     testimonies are the shared brain: retrievable in every conversation, by
 *     every member, forever. Nothing narrows it.
 *   · the caller's DRAFT corpus — private to them, but ai-service gives them
 *     ONE draft corpus across all of their conversations. So the draft leg is
 *     narrowed to the documents attached to THIS conversation; a draft belongs
 *     to the conversation it was uploaded into.
 *
 * Both rules live in `$lib/server/engine/aiClient`, which also refuses any
 * corpus the backend did not authorise for this turn.
 *
 * Backward-compatible: a caller that omits `contextRefs`/`scope` still gets a
 * working turn (ecosistema-wide summary + retrieval).
 */

interface IncomingBody {
  sessionId: string;
  /** Untrusted: read only through `conversationRows`. */
  messages?: unknown;
  /** `@`-mention refs attached to the latest user turn. */
  contextRefs?: ContextRef[];
  /** Per-thread context scope. One tenancy level, so this is org-wide. */
  scope?: ContextScope;
  /** Deprecated: docs are resolved server-side now. Ignored. */
  docs?: unknown;
  /**
   * Restrict retrieval to documentos about speakers of this language — an
   * ai-service metadata `filter: { lengua }`. A string, normalised by
   * `lenguaTurn`; it names a value, never a tenant or a corpus.
   */
  lengua?: unknown;
  /**
   * Student view: `mios` | `companeros` narrows every retrieval leg to the
   * documents the backend's `/api/estudiante/alcance` returns (404 unless
   * `studentView` is on and the caller is an estudiante). Absent = ecosistema.
   */
  alcance?: unknown;
  /**
   * Generales only: the person's per-conversation "Hazme preguntas" switch
   * (`$lib/entrevista`). Only literal `true` turns it on; anything else is off.
   */
  entrevista?: unknown;
  /**
   * The browser's id for this turn (`runTurn`), stamped on the saved answer
   * as `generationMeta.turnId`. A retry of a turn whose answer is already
   * saved gets that answer back: no second paid answer, no second saved row.
   */
  turnId?: unknown;
}

/** The "Hazme preguntas" switch: on only for literal `true` (default off). */
function entrevistaOf(raw: unknown): boolean {
  return raw === true;
}

/** A usable `turnId`, or `undefined`. It names a turn, nothing else. */
function turnIdOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w-]{1,100}$/.test(raw) ? raw : undefined;
}

/**
 * The assistant answer already saved for `turnId` in this session, as the
 * browser may see it (provenance allowlist). `null` when there is none or the
 * read fails: the turn then runs as usual.
 */
async function findSavedTurn(
  token: string | undefined,
  sessionId: string,
  turnId: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!turnId) return null;
  try {
    const qs = new URLSearchParams({
      'where[session][equals]': sessionId,
      'where[role][equals]': 'assistant',
      sort: '-createdAt',
      limit: '100',
      depth: '0',
    });
    const res = await backendFetch(token, `/api/messages?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) return null;
    const docs = ((await res.json()) as { docs?: Record<string, unknown>[] }).docs ?? [];
    const row = docs.find(
      (d) => d.id != null && (d.generationMeta as { turnId?: unknown } | null)?.turnId === turnId,
    );
    if (!row) return null;
    const browser = toBrowserMessage(row);
    // The testimonio titles, per read (`$lib/server/testimonioTitles`).
    return {
      ...browser,
      provenance: await withTestimonioTitles(
        (browser.provenance as Provenance | null) ?? null,
        backendTitleFetcher(token),
      ),
    };
  } catch {
    return null;
  }
}

/** A saved answer in the shape a finished turn returns. */
function savedTurnResult(row: Record<string, unknown>): Record<string, unknown> {
  const meta = (row.generationMeta ?? {}) as Record<string, unknown>;
  return {
    text: typeof row.content === 'string' ? row.content : '',
    messageId: String(row.id),
    provenance: row.provenance ?? null,
    traceId: meta.traceId,
    modelUsed: meta.modelUsed,
    provider: meta.provider,
    costUsd: meta.costUsd,
  };
}

async function persistAssistantMessage(
  token: string | undefined,
  sessionId: string,
  content: string,
  generationMeta: Record<string, unknown>,
  provenance: unknown,
): Promise<string | null> {
  try {
    const coerced = /^\d+$/.test(sessionId) ? Number(sessionId) : sessionId;
    const res = await backendFetch(token, '/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        session: coerced,
        role: 'assistant',
        content,
        generationMeta,
        ...(provenance ? { provenance } : {}),
      }),
    });
    if (!res.ok) {
      console.error(
        `[generate] could not save the answer for session ${sessionId} (backend ${res.status}); ` +
          'the turn returns messageId: null and the ANSWER_NOT_SAVED warning.',
      );
      return null;
    }
    const body = (await res.json()) as { doc?: { id?: number | string } };
    if (body.doc?.id == null) {
      console.error(`[generate] the backend saved the answer for session ${sessionId} but returned no id.`);
      return null;
    }
    return String(body.doc.id);
  } catch (err) {
    // Name only: the message can carry backend detail.
    console.error(
      `[generate] could not save the answer for session ${sessionId} ` +
        `(${(err as Error)?.name ?? 'Error'}); the turn returns messageId: null.`,
    );
    return null;
  }
}

/**
 * The turn's warnings plus `ANSWER_NOT_SAVED` when the save failed (audit
 * C-14). The UI shows it under the answer — see `$lib/aiMessages`.
 */
function withSaveWarning(
  warnings: AIWarning[] | undefined,
  messageId: string | null,
): AIWarning[] | undefined {
  if (messageId !== null) return warnings;
  return [...(warnings ?? []), { code: ANSWER_NOT_SAVED_CODE, message: ANSWER_NOT_SAVED_MESSAGE }];
}

async function bumpLastUsedAt(token: string | undefined, sessionId: string): Promise<void> {
  try {
    await backendFetch(token, `/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ lastUsedAt: new Date().toISOString() }),
    });
  } catch {
    /* best-effort */
  }
}

// ── budget-failure reporting ───────────────────────────────────────────────

/**
 * The requester's org key for the ownership carve-out, which decides whether a
 * budget failure may show real amounts.
 *
 * `null` on purpose, for every user. `locals.user` carries no ai-service tenant
 * key, `App.Locals` carries none, and the engine turn below uses
 * `engineOrgId()` — a deployment-wide constant, not a verified per-user claim.
 * Comparing a user against a constant would hand every user the tenant's budget
 * figures on the strength of no evidence at all. So we assert nothing, and
 * everyone gets the canonical message.
 *
 * When a verified per-user tenant claim exists, resolve it off `locals.user`
 * here. That single change flips owners onto the detailed path.
 */
const REQUESTER_ORG_KEY: string | null = null;

/**
 * Streaming branch — proxy ai-service's `/v1/generate/stream` SSE to the
 * browser, intercepting the terminal `done` frame to persist the assistant
 * turn (with provenance) and stamp the backend `messageId` + `provenance`
 * onto the frame the client receives (so the UI can render citations).
 *
 * `sentSystemPrompt` is the `unit.systemPrompt` we put on the wire. If it was
 * set but the terminal frame's `systemPromptApplied` is not exactly `true`, the
 * model answered WITHOUT chat's instructions: we emit an error frame and do NOT
 * persist the turn, mirroring the loud throw the sync path gets from
 * `assertSystemPromptApplied`. Silently keeping an uninstructed answer is the
 * failure this migration exists to remove.
 */
function streamGenerate(
  upstream: Response,
  token: string | undefined,
  sessionId: string,
  /** The browser-safe provenance for the COMPLETE answer (cited sources only). */
  provenanceFor: (answer: string) => unknown,
  sentSystemPrompt: string | undefined,
  /** Extra `generationMeta` fields for this turn (C-6: `expansionCostUsd`, `turnId`). */
  extraMeta: Record<string, unknown> = {},
  turnId?: string,
): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.body!.getReader();

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      // The deltas so far: the answer when a `done` frame carries no text.
      let streamed = '';
      const emit = (frame: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''));
            if (dataLines.length === 0) {
              controller.enqueue(encoder.encode(`${frame}\n\n`));
              continue;
            }
            let evt: { type?: string; text?: string } & Record<string, unknown>;
            try {
              evt = JSON.parse(dataLines.join('\n'));
            } catch {
              continue;
            }
            if (evt.type === 'done') {
              if (sentSystemPrompt && evt.systemPromptApplied !== true) {
                const detail = `systemPromptApplied=${String(evt.systemPromptApplied)}`;
                console.error(
                  `[generate] ai-service did not apply chat's system prompt (${detail}); ` +
                    'discarding the uninstructed answer.',
                );
                emit({
                  type: 'error',
                  code: 'SYSTEM_PROMPT_NOT_APPLIED',
                  message:
                    'ai-service did not apply the system prompt chat sent ' +
                    `(${detail}). The answer was generated without chat's instructions ` +
                    'and has been discarded.',
                });
                continue;
              }
              // Saved meanwhile by another request for this turn: return that one.
              const already = await findSavedTurn(token, sessionId, turnId);
              if (already) {
                emit({ type: 'done', ...savedTurnResult(already) });
                continue;
              }
              const outcome = streamOutcome(evt, streamed);
              if (!outcome.ok) {
                logEmptyAnswer(sessionId, 'stream', outcome.code);
                emit({ type: 'error', ...noAnswerBody(outcome.code) });
                continue;
              }
              evt.text = outcome.text;
              const provenance = provenanceFor(evt.text);
              // Titles on the browser copy only; the saved one never carries
              // them. Read alongside the save, not after it.
              const titledP = withTestimonioTitles(
                (provenance as Provenance | null) ?? null,
                backendTitleFetcher(token),
              );
              titledP.catch(() => {});
              const messageId = await persistAssistantMessage(
                token,
                sessionId,
                evt.text,
                {
                  traceId: evt.traceId,
                  modelUsed: evt.modelUsed,
                  provider: evt.provider,
                  costUsd: evt.costUsd,
                  ...extraMeta,
                },
                provenance,
              );
              void bumpLastUsedAt(token, sessionId);
              // `warnings` rides the terminal frame (e.g. BUDGET_SOFT_CAP).
              // Log it once here, then let it through to the browser via the
              // spread below — the client keeps it on the result.
              logAIWarnings(evt.warnings, 'generate:stream');
              const warnings = withSaveWarning(evt.warnings as AIWarning[] | undefined, messageId);
              emit({
                ...evt,
                messageId,
                provenance: await titledP,
                ...(warnings ? { warnings } : {}),
              });
            } else if (evt.type === 'error') {
              const noAnswer = isTruncatedAnswerCode(evt.code)
                ? ANSWER_TRUNCATED_CODE
                : isEmptyAnswerCode(evt.code)
                  ? EMPTY_ANSWER_CODE
                  : undefined;
              if (noAnswer) {
                // ai-service's own empty-completion (or truncated) frame,
                // before or after partial text: the same failure as an empty `done`.
                logEmptyAnswer(sessionId, 'stream', noAnswer);
                emit({ type: 'error', ...noAnswerBody(noAnswer) });
                continue;
              }
              // Budget failures arrive HERE on the streaming transport, not as
              // an HTTP status — see `sanitizeStreamErrorFrame`.
              emit(sanitizeStreamErrorFrame(evt, { requesterOrgKey: REQUESTER_ORG_KEY }));
            } else {
              if (evt.type === 'delta' && typeof evt.text === 'string') streamed += evt.text;
              emit(evt);
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          // Name and code only: the browser gets no text we did not write.
          emit({ type: 'error', code: 'STREAM_INTERRUPTED', message: errSummary(err) });
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(out, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * Sync turns being answered right now, by `<userId>:<sessionId>:<turnId>`. Each holds a
 * copy of the answer's response, or `null` when the request failed.
 */
const inflightTurns = new Map<string, Promise<Response | null>>();

/**
 * 🔴 A sync retry that arrives while the SAME turn is still being answered
 * waits for that answer instead of paying for a second one. `runTurn` resends
 * the turn when its connection drops (dev 2026-10-24, session 180), and the
 * first request may still be generating. The saved-answer check below cannot
 * see an answer that is not saved yet. One web process on dev and staging, so
 * an in-memory map covers it.
 */
/**
 * 🔴 The browser's `messages[]`, validated at runtime (audit 2026-10-28 item
 * 10). The body is typed, never checked, and the engine appends history rows
 * after the real system prompt: a `system` row from the browser would read as
 * an instruction. Only `user`/`assistant` rows with string content are kept;
 * anything else (other roles, non-objects, non-string content, a non-array) is
 * dropped.
 */
function conversationRows(raw: unknown): { role: 'user' | 'assistant'; content: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: unknown) => {
    if (!m || typeof m !== 'object') return [];
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return [];
    return [{ role, content }];
  });
}

export const POST: RequestHandler = async (event) => {
  let key: string | null = null;
  if (event.url.searchParams.get('stream') !== '1') {
    const body = (await event.request.clone().json().catch(() => null)) as IncomingBody | null;
    const turnId = turnIdOf(body?.turnId);
    // The user too: a turn id is unguessable, but an answer is never handed across accounts.
    if (event.locals.user && turnId) key = `${String(event.locals.user.id)}:${String(body?.sessionId)}:${turnId}`;
  }
  if (!key) return answerTurn(event);

  const running = inflightTurns.get(key);
  if (running) {
    const done = await running;
    if (done) return done.clone();
  }
  const own = Promise.resolve(answerTurn(event));
  const shared = own.then(
    (res) => (res.ok ? res.clone() : null),
    () => null,
  );
  inflightTurns.set(key, shared);
  try {
    return await own;
  } finally {
    if (inflightTurns.get(key) === shared) inflightTurns.delete(key);
  }
};

const answerTurn: RequestHandler = async ({ request, locals, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const stream = url.searchParams.get('stream') === '1';

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    throw error(400, 'Invalid JSON body.');
  }

  // A retry of a turn whose answer is already saved: hand that answer back.
  // ⚠ Started now, awaited after the session reads below: one backend round
  // trip off every turn's wait. A saved turn wastes those three reads.
  const turnId = turnIdOf(body.turnId);
  const startedAt = Date.now();
  const alreadyP = findSavedTurn(locals.token, body.sessionId, turnId);
  const sessionReadsP = Promise.all([
    fetchSessionCorpora(locals.token, body.sessionId),
    sessionMeta(locals.token, body.sessionId),
    fetchSessionDocs(locals.token, body.sessionId),
  ]);
  // Neither may reject unobserved while the other is awaited.
  sessionReadsP.catch(() => {});
  const already = await alreadyP;
  if (already) {
    const result = savedTurnResult(already);
    if (!stream) return json(result);
    return new Response(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  // Fail fast on a misconfigured server, before any backend round trip. The
  // client actually used is the ecosistema's, picked once its id is known.
  let chatClient;
  try {
    chatClient = getAIClient();
  } catch (err) {
    throw error(500, `Server misconfigured: ${(err as Error).message}`);
  }

  // Split the latest user turn off the history; the engine assembles the user
  // turn with injected context, so we pass `history` (everything before) + the
  // raw `userMessage` separately.
  const allMessages = conversationRows(body.messages);
  const lastUserIdx = [...allMessages].map((m) => m.role).lastIndexOf('user');
  const userMessage = lastUserIdx >= 0 ? allMessages[lastUserIdx]!.content : '';
  const history = (lastUserIdx >= 0 ? allMessages.slice(0, lastUserIdx) : allMessages).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const scope: ContextScope = body.scope ?? { refs: [{ kind: 'org' }] };

  // 🔴 Ask the backend which corpora this caller may read, and as of when.
  // ONE call per turn, shared by the adapter (which corpora) and the AIClient
  // (the `asOf` every retrieve must carry). We never compose a corpus name
  // ourselves — that is how a client reaches another ecosistema's corpus — and
  // we never retrieve without `asOf`, because unpublishing a document only
  // end-dates its chunks: an unscoped retrieve still returns them.
  // Alongside it: WHICH ecosistema this conversation is in, read off the
  // session row (immutable, membership-checked on create). The deterministic
  // summary names it, so taking "the first organization" would put another
  // ecosistema's name and description into the turn for anyone with two
  // memberships.
  // Alongside those: the documents attached to THIS conversation. Read once,
  // in the same round trip, and used twice — the deterministic summary names
  // them, and the draft retrieval leg filters on them. Reading it once is what
  // keeps those two honest with each other: the summary used to list this
  // conversation's documents while retrieval reached every draft the caller had
  // ever uploaded anywhere, and the model could not tell them apart.
  // The session read also carries the conversation's kind (`$lib/sessionKind`),
  // which picks the engine config below.
  const [{ corpora, asOf, draftCorpus, publishedCorpus }, meta, sessionDocs] = await sessionReadsP;
  // 🔴 Fail closed: without the session row there is no kind, and guessing one
  // would run a Resonancias conversation on the Generales config (or the
  // reverse). Refuse the turn; nothing has been generated or spent yet.
  if (!meta.ok) {
    console.error(`[generate] could not read session ${body.sessionId}; refusing the turn (no kind).`);
    throw error(502, {
      code: SESSION_UNAVAILABLE_CODE,
      message: 'No se pudo leer la conversación. Inténtalo de nuevo.',
    });
  }
  // 🔴 R77: an eval run's conversation answers the in-process runner only (the
  // one caller that sets `locals.evalTap`; no browser request can). The
  // backend also refuses its turns once the run is not running (`Messages`).
  if (meta.evalRun !== null && !locals.evalTap) {
    throw error(403, { message: 'Esta conversación es de una evaluación.' });
  }
  const { organizationId, kind } = meta;
  if (!asOf) {
    console.error(
      `[generate] no asOf for session ${body.sessionId}; answering WITHOUT retrieval ` +
        'rather than risking unpublished content in the answer.',
    );
  }
  // `null` when the list could not be read — NOT an empty set. The draft leg
  // then retrieves nothing at all rather than guessing. See `$lib/server/sessionDocs`.
  const sessionDocumentIds = sessionDocumentIdSet(sessionDocs);
  // Per-ecosistema switches (backend `lib/features.ts`): `chatOrientation` and
  // `interviewerMode` are enforced HERE, where the turn is built. Started now
  // so it overlaps; a failed read is today's behaviour. The same read carries
  // the ecosistema's answer style (owner ruling 2026-10-28); a failed read is
  // no style.
  const settingsP = fetchEcosystemSettings(locals.token, organizationId);
  const featuresP = settingsP.then((s) => s.features);

  // Each ecosistema is its own ai-service org (`X-AI-Org: eco-<id>`): its own
  // budget, usage and corpora. ⚠ Without an ecosistema id the turn falls back
  // to the key's own org — its corpora live under the ecosistema's org, so
  // retrieval comes back empty and the spend lands on the shared org. Loud.
  if (organizationId != null && organizationId !== '') {
    chatClient = getAIClient(organizationId);
  } else {
    console.warn(
      `[generate] no ecosistema for session ${body.sessionId}; using the base ai-service org ` +
        '(no X-AI-Org). Retrieval will find nothing and spend is not attributed to an ecosistema.',
    );
  }

  // The lengua filter, and the ecosistema's languages for the summary line.
  // The read starts now and overlaps with the engine's condense call; the
  // adapter awaits it only when it builds the summary. Best-effort.
  const lengua = lenguaTurn(body.lengua);
  // 🔴 A scope that cannot be read is an EMPTY scope, never the whole ecosistema.
  const alcance = parseAlcance(body.alcance);
  const scopeDocumentIds = alcance
    ? organizationId != null && organizationId !== ''
      ? ((await fetchScopeDocumentIds(locals.token, String(organizationId), alcance)) ?? new Set<string>())
      : new Set<string>()
    : undefined;
  const lenguaFacets =
    organizationId != null && organizationId !== ''
      ? fetchLenguaIndex(locals.token, organizationId).then((r) => r.index.lenguas)
      : null;

  // The ecosistema's published document titles, for "tell me about <title>"
  // (UX #35, `$lib/server/titleMatch`). Starts now, awaited when the inline
  // refs are built. Best-effort: a failed read pins nothing.
  const publishedTitles = fetchPublishedTitleScan(locals.token, organizationId);

  // Build the Domain Adapter + the engine's AIClient over this app's BFF client.
  const baseAdapter = withFencedRefs(makeChatDomainAdapter({
    token: locals.token,
    sessionId: body.sessionId,
    corpora,
    organizationId,
    // Hand over the list we just read so the adapter does not fetch it again.
    // 🔴 `null` on a failed read: the adapter must not re-read it (I-08).
    documents: sessionDocs.ok ? sessionDocs.docs : null,
    ...(lenguaFacets ? { lenguaFacets: () => lenguaFacets } : {}),
    ...(lengua.lengua ? { lenguaFilter: lengua.lengua } : {}),
  }));
  // CHAT_RETRIEVAL_MODE=hybrid AND ai-service has `metadataFilterIn` → one
  // hybrid `/v1/retrieve/multi` call, drafts filtered server-side. Otherwise
  // the dense per-corpus path. Default dense. See `$lib/server/engine/hybrid`.
  // A student scope post-filters on the dense path; hybrid is not offered.
  const hybrid = scopeDocumentIds ? false : await chatTurnHybrid();
  const unfencedAI = makeEngineAIClient(chatClient, {
    sessionId: body.sessionId,
    signal: request.signal,
    asOf,
    // Only what the backend authorised. Everything except the ecosistema's
    // shared corpus is narrowed to this conversation's documents — stated as an
    // exemption so an unreadable response loses context loudly instead of
    // leaking drafts quietly. See `EngineAIClientOptions.publishedCorpus`.
    allowedCorpora: corpora,
    publishedCorpus,
    sessionDocumentIds,
    hybrid,
    ...(scopeDocumentIds ? { scopeDocumentIds } : {}),
  });
  // 🔴 PROMPT-INJECTION FENCE (audit 2026-10-17 §3 item 3), a partial
  // mitigation. Retrieved chunks from every leg that goes through this client
  // (published and draft legs, hybrid `retrieveMulti`, the graph provider's
  // widened retrieve) reach the prompt as `[N] <fuente>…</fuente>`; the
  // adapter above (`withFencedRefs`) fences attached documents (`@`-mentioned,
  // pinned, named by title) as `<fuente tipo="adjunto">`, with no number: a
  // fence id once put "document:266" in front of the model, and it cited
  // "[266]" (dev, 2026-10-24). Common tag look-alikes and every `[N]` inside the
  // text are neutralised — a
  // cheap fold, not a guarantee (see `neutraliseFenceTags`). The graph block
  // and the summary are NOT fenced.
  // `restorePassages` puts the original passage text back on the provenance
  // before it is persisted.
  // 🔴 Conversation turns (questions and answers) are dropped from every leg,
  // always (owner ruling 2026-10-21: documents only), each leg over-fetching
  // so the turn keeps its source count. See `$lib/turnChunks`.
  // ai-service with `metadataFilterIn` drops turns BEFORE ranking too
  // (`SOURCE_KINDS_FILTER`); the fence's post-filter stays either way.
  const fenced = withFencedChunks(unfencedAI, { kindFilter: await chatKindFilterAvailable() });
  const engineAI = fenced.client;

  // 🔴 ORIENTATION, NEVER SOURCES (owner ruling 2026-10-21, #4 choice A).
  // Earlier conversation turns, anonymised at ingest, reach the model ONLY as
  // a labelled background block outside the `<fuente>` fence: never an `[N]`,
  // never in the provenance. One small extra retrieve over the published
  // corpus, through the UNFENCED client (the fenced one drops every turn),
  // started now so it overlaps the engine's condense call. This conversation's
  // own turns are excluded. `CHAT_ORIENT_SCOPE` = ecosistema | own | off.
  // See `$lib/server/engine/orientation`.
  const orientScope = !scopeDocumentIds && (await featuresP).chatOrientation ? chatOrientScope() : 'off';
  const adapter =
    orientScope === 'off'
      ? baseAdapter
      : withOrientation(
          baseAdapter,
          fetchOrientationTurns({
            client: unfencedAI,
            scope: orientScope,
            corpus: publishedCorpus ?? null,
            orgId: engineOrgId(),
            sessionId: body.sessionId,
            userId: locals.user.id != null ? String(locals.user.id) : null,
            query: userMessage,
          }).then(orientationBlock),
        );

  // 🔴 THE SECOND RETRIEVAL PATH — GraphRAG (ADR §8).
  //
  // Runs CONCURRENTLY with the vector retrieve inside `prepareTurn`, called
  // with the CONDENSED query, and fused by RRF. It contributes two things: a
  // deterministic Spanish block summarising the ecosistema's graph (no model
  // call — this is where the win on GLOBAL questions comes from, e.g. "¿qué
  // temas se repiten entre los testimonios?"), and at most ONE extra
  // ai-service retrieve widened by the graph's own terms.
  //
  // ⚠ IT READS THE ECOSISTEMA'S PUBLISHED CORPUS, and says so by naming it.
  // Everything except that corpus is narrowed to this conversation's documents
  // (see `makeEngineAIClient`), so a graph leg that did not declare its scope
  // would be silently narrowed and its hits would simply vanish.
  //
  // `null` when the conversation has no readable ecosistema — the turn then
  // carries no `graphProvider` at all and is byte-identical to today's.
  // Everything else about it is best-effort: the engine wraps the call in
  // `.catch(() => null)`, so an unreachable or slow graph produces a normal
  // answer with no message to the user (ADR §8.2).
  // ⚠ Skipped under a lengua filter — see `LenguaTurn.graph`.
  // ⚠ And under a student scope: the graph block spans the whole ecosistema.
  const graphProvider = !lengua.graph || scopeDocumentIds ? null : makeGraphProvider({
    token: locals.token,
    organizationId,
    aiClient: engineAI,
    orgId: engineOrgId(),
    scopeId: body.sessionId,
    corpora,
    publishedCorpus,
  });

  // QUERY EXPANSION — the engine's retrieve also searches 2 rewordings and one
  // hypothetical answer of the condensed question, fused by RRF. One extra
  // `quick` model call per turn. Only the ENGINE's client is wrapped: the graph
  // provider above keeps the plain `engineAI`, so its widened retrieve does not
  // pay for a second expansion. `QUERY_EXPANSION=off` turns it off. See
  // `$lib/server/engine/expand`.
  // C-6: the expansion call's cost is summed here and saved next to the
  // answer's as `generationMeta.expansionCostUsd`, so the admin cost counts it.
  // ⚠ An expansion that outlives its 5 s deadline reports after the turn's
  // metadata was built, and is missed. Condense is not counted at all.
  const userId = String(locals.user.id ?? locals.user.email ?? 'user');
  let expansionCostUsd = 0;
  const turnAI = queryExpansionEnabled()
    ? withQueryExpansion(engineAI, {
        surface: CHAT_ENGINE_CONFIG.surface,
        orgId: engineOrgId(),
        scopeId: body.sessionId,
        userId,
        onExpansion: (trace) => {
          if (Number.isFinite(trace.costUsd) && trace.costUsd > 0) expansionCostUsd += trace.costUsd;
        },
      })
    : engineAI;
  const turnMeta = (): Record<string, unknown> => ({
    ...(expansionCostUsd > 0 ? { expansionCostUsd } : {}),
    ...(turnId ? { turnId } : {}),
  });

  // The full engine turn spec (condense → summary → scoped retrieve → @-refs →
  // user-turn injection). Identical shape for both transports: both run
  // `prepareTurn` and `regroupTurn`; streaming then drives the SSE proxy, sync
  // calls `generateSync` as the engine's `respond()` would. Best-effort throughout — a failing context step degrades to
  // empty inside the engine and never breaks the turn.
  const retrievalPolicy = chatTurnRetrievalPolicy(hybrid);
  // A message that names exactly one published document pins it for this turn.
  const { docs: published, truncated: publishedTruncated } = await publishedTitles;
  // Skipped under a student scope: a title pin could name a document outside it.
  const titleMatch = scopeDocumentIds ? null : matchDocumentTitle(userMessage, published);
  // `@`-mentions, then the document the message names by title, then every
  // document pinned ("fijar") in this conversation. See `./pinned.ts`: the
  // docs panel promises pinned documents are sent.
  const inlineRefs = withPinnedRefs(withTitleRef(body.contextRefs, titleMatch), sessionDocs);
  // The same documents as source cards, when the answer uses them (owner
  // ruling 2026-10-24; `citedBrowserProvenance`). Names come from the server's
  // own reads, never the browser's ref label.
  const attachments = turnAttachments({
    refs: inlineRefs,
    userRefs: body.contextRefs,
    titleMatch,
    userMessage,
    sessionDocs,
    published,
  });
  // …and narrows retrieval to it, so its chunks are the turn's only `[N]`
  // sources (see `$lib/server/titleMatch`). No match: the lengua filter alone.
  const retrievalFilter = titleRetrievalFilter(lengua.retrievalFilter, titleMatch);
  // Which config runs this turn (owner rulings 2026-10-26 and 2026-10-27):
  // - Resonancias: ALWAYS the corpus-informed interviewer, whatever the message
  //   says and whatever `interviewerMode` says.
  // - Generales: answers; the heuristic interviewer (`$lib/server/engine/turnMode`:
  //   the caller's own story, or their own testimonio attached) runs only when
  //   the ecosistema's `interviewerMode` switch is on AND the person switched
  //   "Hazme preguntas" on in this conversation (owner ruling 2026-10-27,
  //   `entrevista`, default off). Either off → every turn answers.
  // "Hazme preguntas" in effect: the same gate as the switch itself (`showsEntrevista`).
  const askBack = kind === 'generales' && entrevistaOf(body.entrevista) && (await featuresP).interviewerMode;
  const turnMode: ChatTurnMode =
    askBack
      ? chatTurnMode({
          userMessage,
          history,
          sessionDocs: sessionDocs.docs,
          callerId: locals.user.id != null ? String(locals.user.id) : null,
        })
      : 'answer';
  // 🔴 CORPUS OVERVIEW (`$lib/server/engine/overview`): "resumen del corpus"
  // gets no passage retrieval (it matched "Corpus Christi" on dev) but the
  // graph view's top entities and the published-documents list, each a
  // numbered source. Only where the normal graph path would run, on an
  // answering Generales turn, with no title match.
  const overview =
    kind === 'generales' &&
    turnMode === 'answer' &&
    // An attached document (@-mention, pinned, or the title match, which
    // rides as one) makes the turn about it, not the whole corpus.
    attachments.length === 0 &&
    graphProvider !== null &&
    isCorpusOverview(userMessage);
  const summarySources: SummarySource[] = overview
    ? [{ id: 'lista', text: documentListText(published, publishedTruncated) }]
    : [];
  const turnGraph = overview ? makeOverviewGraphProvider({ token: locals.token, organizationId }) : graphProvider;
  // Turn-conditional rules (`./prompt`, "Turn-conditional rules"): none on a
  // turn without their trigger, so that turn's prompt is unchanged.
  // The ecosistema's answer style (owner ruling 2026-10-28) is appended LAST;
  // `withTurnRules` (here and in `regroupTurn`) puts every rule before it.
  // No style: the same config as without one.
  const baseConfig = chatEngineConfigFor(kind, turnMode, (await settingsP).answerStyles);
  const turnRules = [
    ...(attachments.length > 0 ? [ATTACHMENT_RELEVANCE_RULE] : []),
    // A story turn already ends on a question (the interviewer prompt).
    ...(askBack && turnMode === 'answer' ? [FOLLOW_UP_RULE] : []),
  ];
  const turnConfig =
    turnRules.length > 0
      ? { ...baseConfig, systemPrompt: withTurnRules(baseConfig.systemPrompt, turnRules) }
      : baseConfig;
  // One `[N]` per document; the graph summary (and the overview list) as
  // numbered sources. Before generation, so no answer text is renumbered.
  // Each source opens with its card title; a testimonio's is its generated
  // title, read here once (one backend read, only when testimonios came back).
  // A testimonio with no generated title reads "Testimonio · <ecosistema> · <día>".
  const titleFetcher = backendTitleFetcher(locals.token);
  const regroup = async <P extends Parameters<typeof regroupTurn>[0]>(p: P): Promise<P> => {
    const ids = testimonioDocIds([p.provenance]);
    const anyTestimonio = (p.provenance?.chunks ?? []).some((c) => c.metadata?.kind === 'testimonio');
    const [testimonioTitles, ecoName] = await Promise.all([
      ids.length > 0 ? titleFetcher(ids) : new Map(),
      anyTestimonio ? ecosystemName(locals.token, organizationId) : null,
    ]);
    return regroupTurn(p, {
      config: turnConfig,
      extra: summarySources,
      passageCap: PASSAGE_TEXT_CAP,
      testimonioTitles,
      ecosystemName: ecoName,
    });
  };
  const answerAI = overview ? withoutRetrieval(engineAI) : turnAI;
  // An interviewer reply (either kind) with no `[N]` lists no sources: it is a
  // question back, not an answer, and the no-marker fallback would pin
  // documents to it. A cited `[N]` lists that source as usual.
  const turnSources = (provenance: Provenance | null, answer: string): Provenance | null =>
    (kind === 'resonancias' || turnMode === 'interview') && parseCitedOrdinals(answer).length === 0
      ? null
      : citedBrowserProvenance(provenance, answer, attachments);
  const engineTurnArgs = {
    config: turnConfig,
    // Condense is the only model call `prepareTurn` makes; it gets a deadline
    // (`./condenseDeadline`). The sync answer below calls `answerAI` itself.
    aiClient: withCondenseDeadline(answerAI),
    adapter,
    orgId: engineOrgId(),
    userId,
    scopeId: body.sessionId,
    threadId: body.sessionId,
    scope,
    history,
    userMessage,
    inlineRefs,
    // Omitted entirely when there is no ecosistema to scope a graph read to,
    // so the engine takes exactly the code path it took before GraphRAG.
    // Skipped on a title match: its retrieve and block span the ecosistema.
    ...(turnGraph && !titleMatch ? { graphProvider: turnGraph } : {}),
    // ai-service metadata filter, forwarded by the engine to every corpus leg.
    // Chunks embedded before `lengua` reached chunk metadata do not carry it
    // and are excluded until republished.
    ...(retrievalFilter ? { retrievalFilter } : {}),
    // Cross-encoder rerank on each corpus retrieve, `CHAT_RERANK` (default ON).
    // Off → no policy, the engine's pre-policy retrieval exactly. A failing
    // rerank falls back to the plain retrieve. See `$lib/server/engine/rerank`.
    // Under `hybrid` the policy is `mode: 'hybrid'` and rerank runs once,
    // after fusion.
    ...(retrievalPolicy ? { retrievalPolicy } : {}),
    // Persist each chunk's grounding passage so the canonical CitationCard can
    // quote it. Cap the stored text to keep the provenance JSON column lean.
    includePassageText: PASSAGE_TEXT_CAP,
  };

  // ── STREAMING ────────────────────────────────────────────────────────────
  // Assemble the turn with `prepareTurn` (+ `regroupTurn`), then drive the
  // existing SSE proxy.
  const readyAt = Date.now();
  if (stream) {
    let prepared;
    try {
      prepared = await regroup(await prepareTurn(engineTurnArgs));
    } catch (err) {
      // A failure assembling context must not 500 the turn: fall back to a
      // bare user turn (no summary/retrieval) and still stream an answer.
      console.warn('[generate] engine prepareTurn failed; bare turn:', safeErrMessage(err));
      prepared = {
        messages: [
          { role: 'system' as const, content: turnConfig.systemPrompt },
          ...history,
          { role: 'user' as const, content: userMessage },
        ],
        provenance: null,
        matches: [],
        retrievalQuery: userMessage,
        summaryText: '',
        graphContext: '',
      };
    }
    const upstream = buildChatUnitRequest({
      messages: prepared.messages,
      unitKey: body.sessionId,
      effortLevel: CHAT_ENGINE_CONFIG.chatEffort,
      // Stream and sync must migrate in lockstep — a flip that moved only one
      // transport onto the registry would give the two paths different specs.
      useRegistryPrompt: useRegistryPrompt(),
    });
    try {
      const preparedAt = Date.now();
      const upstreamRes = await chatClient.openGenerateStream(upstream, { signal: request.signal });
      // One line per turn: where the wait before the first words goes.
      console.info(
        `[generate] timing reads=${readyAt - startedAt}ms prepare=${preparedAt - readyAt}ms ` +
          `open=${Date.now() - preparedAt}ms`,
      );
      return streamGenerate(
        upstreamRes,
        locals.token,
        body.sessionId,
        // Mark chunks that came from THIS user's draft corpus before the turn
        // is persisted, so the citation stays labelled after a reload — the
        // corpus name is the exact signal, and it is only knowable here.
        // Then only the sources the finished answer cites (UX #35), through
        // the browser allowlist (Fable audit #8): what is saved is what every
        // member's browser later reads back. An attachment the answer uses
        // (title-named, @-mentioned, pinned) gets a card too (`citedBrowserProvenance`).
        (answer) =>
          turnSources(
            stampDraftProvenance(fenced.restorePassages(prepared.provenance, PASSAGE_TEXT_CAP), draftCorpus),
            answer,
          ),
        upstream.unit.systemPrompt,
        turnMeta(),
        turnId,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      // Reached only when the upstream fails BEFORE the SSE headers are out
      // (e.g. the enqueue 402). Once streaming has begun, budget failures come
      // back as an `error` frame instead — `sanitizeStreamErrorFrame`.
      const noAnswer = noAnswerCode(err);
      if (noAnswer) {
        logEmptyAnswer(body.sessionId, 'stream', noAnswer);
        throw error(502, noAnswerBody(noAnswer));
      }
      logBudgetFailure(err, 'generate:stream:open');
      const { status, message, code } = httpStatusFor(err, {
        requesterOrgKey: REQUESTER_ORG_KEY,
      });
      // A mapped `code` means the message is already the canonical, safe
      // wording — never prefix it. Unmapped errors keep their existing shape.
      throw error(status, code ? { code, message } : { message: `ai-service: ${message}` });
    }
  }

  // ── SYNC ─────────────────────────────────────────────────────────────────
  // The engine's `respond()`, unrolled so the prepared turn is regrouped
  // (`regroupTurn`) before it generates: `prepareTurn`, then the same
  // `generateSync` call `respond()` makes, on the same engine `AIClient` seam
  // (`generateSync` → `buildChatUnitRequest` → chat's BFF). The AbortSignal
  // rides through the `engineAI` closure (captured at construction above).
  try {
    const prepared = await regroup(await prepareTurn(engineTurnArgs));
    // The evals runner only (`$lib/server/evals`): the numbered sources the
    // model is about to see. No browser request sets `locals.evalTap`.
    locals.evalTap?.({ matches: prepared.matches, provenance: prepared.provenance });
    // An answer with no visible text throws `EmptyAnswerError` before
    // anything is saved (see `EMPTY_ANSWER_MESSAGE`).
    const generation = assertAnswer(
      await answerAI.generateSync({
        surface: turnConfig.surface,
        orgId: engineTurnArgs.orgId,
        scopeId: engineTurnArgs.scopeId,
        userId: engineTurnArgs.userId,
        messages: prepared.messages,
        effort: turnConfig.chatEffort,
        maxTokens: turnConfig.chatMaxTokens,
      }),
    );
    const rawProvenance = prepared.provenance;
    // See the streaming branch: stamp the caller's own drafts before
    // persisting, keep the cited sources only, then the browser allowlist.
    const provenance = turnSources(
      stampDraftProvenance(fenced.restorePassages(rawProvenance, PASSAGE_TEXT_CAP), draftCorpus),
      generation.text,
    );
    // Saved meanwhile by another request for this turn: return that one.
    const savedMeanwhile = await findSavedTurn(locals.token, body.sessionId, turnId);
    if (savedMeanwhile) return json(savedTurnResult(savedMeanwhile));
    const messageId = await persistAssistantMessage(
      locals.token,
      body.sessionId,
      generation.text,
      {
        traceId: generation.traceId,
        modelUsed: generation.modelUsed,
        provider: generation.provider,
        costUsd: generation.costUsd,
        ...turnMeta(),
      },
      provenance,
    );
    void bumpLastUsedAt(locals.token, body.sessionId);
    // `warnings` survives chat's zod schema and the engine adapter now; log it
    // once here and pass it to the browser on the result.
    const upstreamWarnings = (generation as { warnings?: AIWarning[] }).warnings;
    logAIWarnings(upstreamWarnings, 'generate:sync');
    const warnings = withSaveWarning(upstreamWarnings, messageId);
    return json({
      ...generation,
      messageId,
      // Titles on the browser copy only; the saved one never carries them.
      provenance: await withTestimonioTitles(provenance ?? null, backendTitleFetcher(locals.token)),
      ...(warnings ? { warnings } : {}),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const noAnswer = noAnswerCode(err);
    if (noAnswer) {
      logEmptyAnswer(body.sessionId, 'sync', noAnswer);
      throw error(502, noAnswerBody(noAnswer));
    }
    logBudgetFailure(err, 'generate:sync');
    const { status, message, code } = httpStatusFor(err, {
      requesterOrgKey: REQUESTER_ORG_KEY,
    });
    throw error(status, code ? { code, message } : { message: `ai-service: ${message}` });
  }
};
