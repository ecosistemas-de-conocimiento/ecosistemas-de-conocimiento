import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Role } from '$lib/types';
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
  engineOrgId,
  makeChatDomainAdapter,
  makeEngineAIClient,
  useRegistryPrompt,
} from '$lib/server/engine';
import { fetchSessionCorpora } from '$lib/server/corpora';
import { stampDraftProvenance } from '$lib/publication';
import { prepareTurn, respond, type ContextRef, type ContextScope } from '@edc/chat-engine/core';

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
 *   1. Build the Domain Adapter (organization + session documents).
 *   2. `prepareTurn()` — condense → deterministic summary → scoped retrieve
 *      (per-session corpus + ai-service `filter`) → resolve `@`-refs → assemble
 *      the user turn.
 *   3. Generate: sync (`respond`-style) or stream (drive the existing SSE proxy
 *      with the engine-assembled messages).
 *   4. Persist the assistant turn (+ provenance) and round-trip the message id.
 *
 * Backward-compatible: a caller that omits `contextRefs`/`scope` still gets a
 * working turn (org-wide summary + per-session doc retrieval).
 */

interface IncomingBody {
  sessionId: string;
  messages: { role: Role; content: string }[];
  /** `@`-mention refs attached to the latest user turn. */
  contextRefs?: ContextRef[];
  /** Per-thread context scope. One tenancy level, so this is org-wide. */
  scope?: ContextScope;
  /** Deprecated: docs are resolved server-side now. Ignored. */
  docs?: unknown;
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
    if (!res.ok) return null;
    const body = (await res.json()) as { doc?: { id?: number | string } };
    return body.doc?.id != null ? String(body.doc.id) : null;
  } catch {
    return null;
  }
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
  provenance: unknown,
  sentSystemPrompt: string | undefined,
): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.body!.getReader();

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
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
              const messageId = await persistAssistantMessage(
                token,
                sessionId,
                evt.text ?? '',
                {
                  traceId: evt.traceId,
                  modelUsed: evt.modelUsed,
                  provider: evt.provider,
                  costUsd: evt.costUsd,
                },
                provenance,
              );
              void bumpLastUsedAt(token, sessionId);
              // `warnings` rides the terminal frame (e.g. BUDGET_SOFT_CAP).
              // Log it once here, then let it through to the browser via the
              // spread below — the client keeps it on the result.
              logAIWarnings(evt.warnings, 'generate:stream');
              emit({ ...evt, messageId, provenance: provenance ?? null });
            } else if (evt.type === 'error') {
              // Budget failures arrive HERE on the streaming transport, not as
              // an HTTP status — see `sanitizeStreamErrorFrame`.
              emit(sanitizeStreamErrorFrame(evt, { requesterOrgKey: REQUESTER_ORG_KEY }));
            } else {
              emit(evt);
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          emit({ type: 'error', code: 'STREAM_INTERRUPTED', message: (err as Error).message });
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

export const POST: RequestHandler = async ({ request, locals, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const stream = url.searchParams.get('stream') === '1';

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    throw error(400, 'Invalid JSON body.');
  }

  let chatClient;
  try {
    chatClient = getAIClient();
  } catch (err) {
    throw error(500, `Server misconfigured: ${(err as Error).message}`);
  }

  // Split the latest user turn off the history; the engine assembles the user
  // turn with injected context, so we pass `history` (everything before) + the
  // raw `userMessage` separately.
  const allMessages = body.messages ?? [];
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
  const { corpora, asOf, draftCorpus } = await fetchSessionCorpora(locals.token, body.sessionId);
  if (!asOf) {
    console.error(
      `[generate] no asOf for session ${body.sessionId}; answering WITHOUT retrieval ` +
        'rather than risking unpublished content in the answer.',
    );
  }

  // Build the Domain Adapter + the engine's AIClient over this app's BFF client.
  const adapter = makeChatDomainAdapter({
    token: locals.token,
    sessionId: body.sessionId,
    corpora,
  });
  const engineAI = makeEngineAIClient(chatClient, {
    sessionId: body.sessionId,
    signal: request.signal,
    asOf,
  });

  // The full engine turn spec (condense → summary → scoped retrieve → @-refs →
  // user-turn injection). Identical shape for both transports: the streaming
  // branch runs `prepareTurn` (context only) and drives the SSE proxy itself;
  // the sync branch hands the SAME args to `respond()`, which prepares AND
  // generates. Best-effort throughout — a failing context step degrades to
  // empty inside the engine and never breaks the turn.
  const engineTurnArgs = {
    config: CHAT_ENGINE_CONFIG,
    aiClient: engineAI,
    adapter,
    orgId: engineOrgId(),
    userId: String(locals.user.id ?? locals.user.email ?? 'user'),
    scopeId: body.sessionId,
    threadId: body.sessionId,
    scope,
    history,
    userMessage,
    inlineRefs: body.contextRefs ?? [],
    // Persist each chunk's grounding passage so the canonical CitationCard can
    // quote it. Cap the stored text to keep the provenance JSON column lean.
    includePassageText: 1200,
  };

  // ── STREAMING ────────────────────────────────────────────────────────────
  // `respond()` only generates synchronously, so streaming keeps its own path:
  // assemble the turn with `prepareTurn`, then drive the existing SSE proxy.
  if (stream) {
    let prepared;
    try {
      prepared = await prepareTurn(engineTurnArgs);
    } catch (err) {
      // A failure assembling context must not 500 the turn: fall back to a
      // bare user turn (no summary/retrieval) and still stream an answer.
      console.warn('[generate] engine prepareTurn failed; bare turn:', (err as Error).message);
      prepared = {
        messages: [
          { role: 'system' as const, content: CHAT_ENGINE_CONFIG.systemPrompt },
          ...history,
          { role: 'user' as const, content: userMessage },
        ],
        provenance: null,
        matches: [],
        retrievalQuery: userMessage,
        summaryText: '',
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
      const upstreamRes = await chatClient.openGenerateStream(upstream, { signal: request.signal });
      return streamGenerate(
        upstreamRes,
        locals.token,
        body.sessionId,
        // Mark chunks that came from THIS user's draft corpus before the turn
        // is persisted, so the citation stays labelled after a reload and in
        // sessions other than the one that uploaded the document.
        stampDraftProvenance(prepared.provenance, draftCorpus),
        upstream.unit.systemPrompt,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      // Reached only when the upstream fails BEFORE the SSE headers are out
      // (e.g. the enqueue 402). Once streaming has begun, budget failures come
      // back as an `error` frame instead — `sanitizeStreamErrorFrame`.
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
  // Collapse the whole prepare→generate→shape pipeline onto the engine's
  // `respond()` orchestrator. It runs `prepareTurn` internally, then generates
  // via the same engine `AIClient` seam (`engineAI.generateSync` →
  // `buildChatUnitRequest` → chat's BFF), so this branch no longer hand-rolls
  // the unit request or the generate call. The AbortSignal rides through the
  // `engineAI` closure (captured at construction above).
  try {
    const { generation, provenance: rawProvenance } = await respond(engineTurnArgs);
    // See the streaming branch: stamp the caller's own drafts before persisting.
    const provenance = stampDraftProvenance(rawProvenance, draftCorpus);
    const messageId = await persistAssistantMessage(
      locals.token,
      body.sessionId,
      generation.text,
      {
        traceId: generation.traceId,
        modelUsed: generation.modelUsed,
        provider: generation.provider,
        costUsd: generation.costUsd,
      },
      provenance,
    );
    void bumpLastUsedAt(locals.token, body.sessionId);
    // `warnings` survives chat's zod schema and the engine adapter now; log it
    // once here and pass it to the browser on the result.
    const warnings = (generation as { warnings?: AIWarning[] }).warnings;
    logAIWarnings(warnings, 'generate:sync');
    return json({ ...generation, messageId, provenance: provenance ?? null });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    logBudgetFailure(err, 'generate:sync');
    const { status, message, code } = httpStatusFor(err, {
      requesterOrgKey: REQUESTER_ORG_KEY,
    });
    throw error(status, code ? { code, message } : { message: `ai-service: ${message}` });
  }
};
