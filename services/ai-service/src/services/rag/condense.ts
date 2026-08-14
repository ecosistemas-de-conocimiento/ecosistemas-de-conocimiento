// Query condensation MACHINERY — project-agnostic (ADR-0001).
//
// Rewrites an anaphoric follow-up ("and what about those?") into a standalone
// search query using the conversation history + the cheapest LLM tier, so the
// retriever embeds the real intent instead of a dangling pronoun. Extracted
// from a prototype's `services/chat/condense.ts` so every product gets it.
//
// CONTENT-AGNOSTIC SPLIT: this file ships ZERO natural-language wording. The
// consumer passes the entire rewrite instruction (its locale, its phrasing) as
// `directive.instruction`; all this module owns is the mechanism — pick the
// recent turns, call the model, sanitize the output, and FAIL SAFE to the raw
// question on the first turn (no history) or any error. A bad rewrite must
// never break a retrieval.

import { env } from '../../config/env.js';
import type { LLMRouter, RouteResult } from '../ai/router/types.js';
import { getTaskProfile } from '../ai/router/task-profiles.js';
import type { RetrieveRewrite } from './types.js';

/** Default rewrite output cap — a standalone query is short. */
const DEFAULT_MAX_TOKENS = 80;
/** How many trailing non-system turns to feed the rewrite. */
const HISTORY_TURNS = 6;
/** Hard cap on the returned query length. */
const OUTPUT_CHAR_CAP = 500;
/** Below this the rewrite is treated as junk and we fall back to the question. */
const MIN_OUTPUT_CHARS = 3;

export interface CondenseContext {
  org: string;
  project?: string;
}

/**
 * Rewrite `question` into a standalone search query, or return it unchanged.
 *
 * Fail-safe: returns `question` verbatim when there is no history to resolve
 * against (the first turn) or when anything throws — including a budget denial
 * on the cheap call, which surfaces as a thrown error and is swallowed here so
 * the retrieval still runs on the raw question.
 *
 * WALL-CLOCK BOUND: a rewrite that HANGS is not a thrown error, so the raw
 * `try/catch` above would let a stalled `router.route` block the whole retrieve
 * indefinitely. The rewrite call is therefore bounded by `CONDENSE_TIMEOUT_MS`
 * (mirrors the rerank rung's `RERANK_TIMEOUT_MS`, same `0 = disabled`
 * convention): on timeout we fall back to the raw question — the identical
 * fail-safe as the error path — while the passed `AbortSignal` lets a compliant
 * router cancel the in-flight upstream call rather than leak it.
 */
export async function condenseQuery(
  router: LLMRouter,
  args: {
    directive: RetrieveRewrite;
    question: string;
    ctx: CondenseContext;
  },
): Promise<string> {
  const { directive, question, ctx } = args;
  const recent = (directive.history ?? [])
    .filter((h) => h.role !== 'system')
    .slice(-HISTORY_TURNS);
  // No prior turns ⇒ nothing anaphoric to resolve ⇒ use the question as-is.
  if (recent.length === 0) return question;

  const timeoutMs = env.CONDENSE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Cheapest tier — this is a throwaway rewrite, not the answer.
    const profile = getTaskProfile('quick');
    // The built-in effort profiles always set a model; the type allows null, so
    // narrow via the fail-safe rather than pinning a model string in this file.
    const model = profile.model;
    if (!model) return question;
    const routePromise = router.route({
      label: 'retrieve:condense',
      org: ctx.org,
      ...(ctx.project ? { project: ctx.project } : {}),
      model,
      effortLevel: 'quick',
      effortProfile: profile,
      maxTokens: directive.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Hand the router an abort signal so a compliant implementation cancels
      // the upstream fetch when we hit `CONDENSE_TIMEOUT_MS` below.
      signal: controller.signal,
      // The consumer's instruction is the ONLY wording the service injects;
      // history + question ride as real chat turns so the model sees the
      // conversation faithfully rather than a flattened, locale-scaffolded blob.
      messages: [
        { role: 'system', content: directive.instruction },
        ...recent.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
      ],
    });

    // Race the rewrite against a wall-clock timer. `Promise.race` (not just the
    // abort signal) is what guarantees we return: a router that ignores `signal`
    // or hangs OUTSIDE the fetch would otherwise never settle. When the timer
    // wins, `routePromise` will typically reject later (abort) — attach a no-op
    // `catch` so that late rejection is never an unhandled rejection.
    let result: RouteResult;
    if (timeoutMs > 0) {
      void routePromise.catch(() => {});
      result = await Promise.race([
        routePromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`condense: rewrite timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } else {
      result = await routePromise;
    }
    // Sanitize: strip wrapping quotes/guillemets, collapse whitespace, cap
    // length. All punctuation-level, no language assumptions.
    const out = result.content
      .trim()
      .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OUTPUT_CHAR_CAP);
    return out.length >= MIN_OUTPUT_CHARS ? out : question;
  } catch {
    return question;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
