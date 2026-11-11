/**
 * THE EVALS RUNNER — one run of one ecosistema's set, in the background.
 *
 * 🔴 THE REAL PRODUCTION PATHS, NOT A COPY:
 *   · each question is one turn through `POST /api/generate` itself (the sync
 *     transport): the same corpora read, condense, expansion, retrieval,
 *     rerank, graph, regroup, prompt and `generateSync` as a person's turn,
 *     in a `generales` conversation the backend opens for the run
 *     (`/api/evals/session`, only while the run is `running`; R77). `locals.evalTap` is the one addition: it hands
 *     back the numbered sources the model saw, for hit@k and the judge;
 *   · each privacy item goes through the production gate in the backend
 *     (`/api/evals/gate`), which returns term verdicts, never the text;
 *   · the judge calls go through the ecosistema's own client (`./judge`).
 * Every call is booked to the ecosistema's ai-service org: its budget.
 *
 * ⚠ Runs one at a time per web process (a promise chain), and one start per
 * ecosistema at a time (`claimRun`). A restart loses a running run; the page
 * marks it failed and deletes its conversation (`reapLostRuns`, from the row's
 * `sessionId`). The conversation is deleted when the run ends, which retires
 * its turns from the corpus.
 *
 * ⚠ `costUsd` is NOT every cost the run causes. See `EvalRuns.costUsd` for
 * exactly what it counts.
 *
 * ⚠ ai-service caches identical prompts for a few minutes: a second run soon
 * after the first can return the same answers at no cost.
 */
import { env } from '$env/dynamic/private';
import { errSummary, isUnsafeText } from '$lib/errorSummary';
import type { BackendUser } from '$lib/server/auth';
import { judgeCitation, judgeStyle, makeJudge, type JudgeFn } from './judge';
import { aggregate, citedClaims, isRefusal, numberedSources, rankOf } from './score';
import type { EvalStore } from './store';
import type { ChatItemResult, EvalItem, EvalTurnTap, ItemResult, PrivacyItemResult } from './types';

export interface TurnOutcome {
  text: string;
  costUsd: number;
  model: string | null;
  messageId: string | null;
  tap: EvalTurnTap | null;
}

export type TurnFn = (args: { sessionId: string; question: string }) => Promise<TurnOutcome>;

export interface RunContext {
  runId: string;
  orgId: string;
  items: EvalItem[];
  /** The ecosistema's `generales` answer style; null = the style measure is skipped. */
  style: string | null;
  store: EvalStore;
  turn: TurnFn;
  judge: JudgeFn;
  commitSha?: string | null;
  now?: () => Date;
}

const errName = (err: unknown): string => {
  // Stored on the run and shown on the admin page: never a failed query's text.
  if (isUnsafeText(err)) return errSummary(err);
  const e = err as { status?: number; body?: { message?: string }; message?: string; name?: string };
  if (typeof e?.status === 'number') return `${e.status} ${e.body?.message ?? ''}`.trim().slice(0, 200);
  return (e?.message ?? e?.name ?? 'error').slice(0, 200);
};

async function runQuestion(ctx: RunContext, sessionId: string, item: EvalItem, models: Set<string>, judges: Set<string>): Promise<ChatItemResult> {
  const base: ChatItemResult = {
    itemId: item.id,
    kind: 'pregunta',
    question: item.question,
    shouldRefuse: item.shouldRefuse,
    expectedDocIds: item.expectedDocIds,
    answer: '',
    sources: [],
    rank: null,
    refused: false,
    refusalOk: false,
    claims: [],
    style: null,
    costUsd: 0,
    model: null,
  };
  let turn: TurnOutcome;
  try {
    turn = await ctx.turn({ sessionId, question: item.question });
  } catch (err) {
    return { ...base, error: errName(err) };
  }
  let cost = turn.costUsd;
  if (turn.messageId) cost += await ctx.store.expansionCost(turn.messageId).catch(() => 0);
  if (turn.model) models.add(turn.model);
  const { refs, passages } = numberedSources(turn.tap);
  const refused = isRefusal(turn.text);
  const result: ChatItemResult = {
    ...base,
    answer: turn.text.slice(0, 6000),
    sources: refs,
    rank: rankOf(refs, item.expectedDocIds),
    refused,
    refusalOk: item.shouldRefuse ? refused : !refused,
    model: turn.model,
  };
  try {
    if (!refused) {
      for (const { claim, n } of citedClaims(turn.text)) {
        const passage = passages[n - 1];
        if (passage === undefined) {
          result.claims.push({ n, claim, ok: false });
          continue;
        }
        const v = await judgeCitation(ctx.judge, claim, passage);
        cost += v.call.costUsd;
        if (v.call.model) judges.add(v.call.model);
        result.claims.push({ n, claim, ok: v.ok });
      }
      if (ctx.style && !item.shouldRefuse) {
        const s = await judgeStyle(ctx.judge, ctx.style, item.question, turn.text);
        cost += s.call.costUsd;
        if (s.call.model) judges.add(s.call.model);
        result.style = { ok: s.ok, reason: s.reason };
      }
    }
  } catch (err) {
    result.error = `juez: ${errName(err)}`;
  }
  result.costUsd = cost;
  return result;
}

async function runPrivacy(ctx: RunContext, item: EvalItem, gates: Set<string>): Promise<PrivacyItemResult> {
  try {
    const v = await ctx.store.gate(item.id);
    gates.add(v.model ? `${v.detector} (${v.model})` : v.detector);
    return { itemId: item.id, kind: 'privacidad', notes: item.notes, status: v.status, ...(v.stage ? { stage: v.stage } : {}), detector: v.detector, model: v.model, terms: v.terms };
  } catch (err) {
    return { itemId: item.id, kind: 'privacidad', notes: item.notes, status: 'error', detector: null, model: null, terms: [], error: errName(err) };
  }
}

/** Execute one run end to end. Never throws: a failure lands on the row. */
export async function executeRun(ctx: RunContext): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const questions = ctx.items.filter((i) => i.kind === 'pregunta');
  const privacy = ctx.items.filter((i) => i.kind === 'privacidad');
  const total = questions.length + privacy.length;
  const results: ItemResult[] = [];
  const models = new Set<string>();
  const judges = new Set<string>();
  const gates = new Set<string>();
  let sessionId: string | null = null;
  await ctx.store.updateRun(ctx.runId, { status: 'running', startedAt: now().toISOString(), progress: { done: 0, total } });
  try {
    // The backend binds the conversation to this (running) run and writes its
    // id on the row before the first turn, so a restart's reaper can delete it.
    if (questions.length) sessionId = await ctx.store.createSession(ctx.runId);
    for (const item of questions) {
      results.push(await runQuestion(ctx, sessionId!, item, models, judges));
      await ctx.store.updateRun(ctx.runId, { progress: { done: results.length, total } });
    }
    for (const item of privacy) {
      results.push(await runPrivacy(ctx, item, gates));
      await ctx.store.updateRun(ctx.runId, { progress: { done: results.length, total } });
    }
    // Answers + expansion + judge calls only (see `EvalRuns.costUsd`).
    const costUsd = results.reduce((s, r) => s + (r.kind === 'pregunta' ? r.costUsd : 0), 0);
    await ctx.store.updateRun(ctx.runId, {
      status: 'done',
      finishedAt: now().toISOString(),
      costUsd,
      metrics: aggregate(results),
      results,
      models: { chat: [...models], judge: [...judges], gate: [...gates] },
      commitSha: ctx.commitSha ?? null,
    });
  } catch (err) {
    await ctx.store.updateRun(ctx.runId, {
      status: 'failed',
      finishedAt: now().toISOString(),
      error: errName(err),
      results,
      metrics: aggregate(results),
    });
  } finally {
    if (sessionId) await ctx.store.deleteSession(sessionId);
  }
}

// ── production wiring ──────────────────────────────────────────────────────

/** One turn through the production `POST /api/generate`, as `user`. */
export function productionTurn(user: BackendUser, token: string | undefined): TurnFn {
  return async ({ sessionId, question }) => {
    const { POST } = await import('../../../routes/api/generate/+server');
    let tap: EvalTurnTap | null = null;
    const request = new Request('http://evals.internal/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: question }] }),
    });
    const event = {
      request,
      url: new URL(request.url),
      locals: { user, token, evalTap: (t: EvalTurnTap) => (tap = t) },
    };
    const res = await POST(event as never);
    if (!res.ok) throw new Error(`generate ${res.status}`);
    const body = (await res.json()) as { text?: string; costUsd?: number; modelUsed?: string; messageId?: string | null };
    return {
      text: body.text ?? '',
      costUsd: typeof body.costUsd === 'number' ? body.costUsd : 0,
      model: body.modelUsed ?? null,
      messageId: body.messageId ?? null,
      tap,
    };
  };
}

let chain: Promise<void> = Promise.resolve();
const active = new Set<string>();
/** Ecosistemas with a run being started, queued or running in THIS process. */
const busy = new Set<string>();

/**
 * 🔴 Check-and-set in ONE synchronous step: true reserves `orgId` for a new run,
 * false means one is already starting or running. Call it before any `await`
 * so two quick "Ejecutar" posts cannot both pass. `enqueueRun` takes the
 * reservation over; a start that fails before queueing calls `releaseRun`.
 */
export function claimRun(orgId: string): boolean {
  if (busy.has(orgId)) return false;
  busy.add(orgId);
  return true;
}

export function releaseRun(orgId: string): void {
  busy.delete(orgId);
}

/** Run ids queued or running in THIS process. */
export function activeRunIds(): ReadonlySet<string> {
  return active;
}

/** Queue a run behind any other in this process; returns at once. Frees the ecosistema's claim when it ends. */
export function enqueueRun(ctx: Omit<RunContext, 'judge' | 'commitSha'> & { judge?: JudgeFn }): void {
  active.add(ctx.runId);
  busy.add(ctx.orgId);
  const full: RunContext = {
    ...ctx,
    judge: ctx.judge ?? makeJudge(ctx.orgId, `eval-${ctx.runId}`),
    commitSha: env.SOURCE_COMMIT || null,
  };
  chain = chain
    .then(() => executeRun(full))
    .catch(() => undefined)
    .finally(() => {
      active.delete(ctx.runId);
      busy.delete(ctx.orgId);
    });
}
