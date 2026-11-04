// The egress seam — the ONE place the PII minimiser is actually called.
//
// §9.4 of `plan/tecnología/ai-infra/inference-hosting-grill.md`
// (decisions 2 and 3) puts `minimise` at the EGRESS SEAMS, not at the routes: a
// route-level scrub is N copies that rot, and an absent rule is the widest rule.
// `src/services/ai/pii/` is the machinery; this file is the wiring. §9.4 named
// three call sites; there are now FIVE egress seams, because the fourth did not
// exist as a live egress path when that list was written and the fifth was
// missed until SECURITY_OPEN §15:
//
//   1. `src/services/ai/router/adapters/openrouter.ts` — `callOpenRouter`
//      (non-streaming chat completion body).
//   2. the same file — `callOpenRouterStream` (streaming chat completion body).
//   3. `src/services/ai/embeddings/openrouter.ts` — `callOpenRouterEmbedding`,
//      which is what ingest (`src/workers/ingest.worker.ts`), `/v1/embed` and
//      retrieve all embed through. §9.4 names "ingest embeddings"; placing the
//      call in the ADAPTER rather than in the ingest worker covers all three
//      callers and makes a future caller opt in by default.
//   4. `src/services/ai/rerank/rerank-client.ts` — `callRerank`. NOT in §9.4:
//      the rerank rung was dead when that section was written (the URL pointed
//      at a stopped container), so nothing crossed the perimeter there. The
//      DeepInfra cutover made it live, and it is the LARGEST seam of
//      the first four: a rerank ships the whole candidate pool, sized
//      `min(topK * 4, 50)` (`retrieve.ts:548`), so a default `topK` of 10 sends
//      40 passages. See that file's `callRerank` for the constants and for why
//      `model` is excluded from the scrub.
//   5. `src/services/ai/embeddings/sparse-embed.ts` — `callSparseEmbed`. Chunk
//      text (ingest) and query text (retrieve) go to `SPARSE_EMBED_URL`, which
//      is config-driven: pointing it at a managed host makes it a perimeter
//      crossing. Unscrubbed until SECURITY_OPEN §15 (option C);
//      `pii-egress-sparse.test.ts` checks it on the wire.
//
// One more importer, `src/services/ai/router/trace-writer.ts`, is not an
// egress site but §9.4's "option A" for the `traces` table — see
// `minimiseTracePayload` at the bottom of this file for why it has a DIFFERENT
// failure rule from the five above.
//
// ⚠ That said "a fourth importer … the three above" until the rerank seam landed,
// and the count was not updated with it. It then said "FOUR … the four above"
// while the sparse-embed seam sent raw text (§15). Corrected rather than quietly renumbered,
// because an off-by-one in a SEAM COUNT is precisely how a seam goes unnoticed —
// which is this file's own history: §9.4 named three, the fourth existed and was
// dead, and nobody counted it.
//
// 🔴 WHY THIS FILE EXISTS AT ALL rather than three direct `minimise` calls: the
// `piiMinimisation` capability has to name ONE function whose behaviour the
// probe asserts. Three inlined calls give the probe nothing to point at, and a
// capability that cannot be probed is exactly the `retrievalLegs` failure —
// advertising `true` while the wiring is inert. `capabilities.test.ts` probes
// `minimiseEgress`, and `pii-egress.test.ts` proves the three adapters call it;
// `pii-egress-rerank.test.ts` and `pii-egress-sparse.test.ts` check seams 4
// and 5 on the wire.
//
// 🔴 IT FAILS CLOSED. `minimise` rejects rather than returning a partially
// scrubbed payload (see `pii/types.ts` for the full list of what makes it
// refuse), and NOTHING here catches that. The refusal propagates out of the
// adapter and aborts the provider call. Do not wrap a call to this function in a
// try/catch that falls back to the raw payload — that is the silent no-op §9.1
// singles out as the one degradation this capability may not have.

import { minimise } from './pii/index.js';
import type { PiiKind } from './pii/index.js';

/**
 * Minimise a payload on its way out of the perimeter. Returns the same SHAPE
 * with every string scrubbed; throws `PiiMinimisationFailedError` if it could
 * not finish the job.
 *
 * The default policy (`RULE_DETECTORS`, checksum `'prefer'`) is deliberate and
 * is the whole policy: offline, deterministic, no network, no clock. The NER
 * model server is NOT installed here — `PII_NER_URL` exists but wiring
 * `nerDetector` into this policy is a later decision (`§5` open item 7 leaves
 * the model unchosen), and installing an unconfigured detector would make every
 * egress call refuse.
 *
 * ⚠ THE DOCUMENTED CEILING (§9.4): this is PRESENCE, not STRENGTH. The rules
 * layer has no `person` detector — a name written in running Spanish is not a
 * pattern — so names still leave. No recall number may be quoted for it; there
 * is no real Spanish golden set (`§5` open item 5).
 */
export async function minimiseEgress<T>(payload: T, signal?: AbortSignal): Promise<T> {
  return (await minimiseEgressReport(payload, signal)).payload;
}

/** What a seam scrubbed: the payload to send, plus how many redactions of which kind. */
export interface EgressReport<T> {
  payload: T;
  /** Total redactions across every string in the payload. 0 is a clean payload, not a skipped scrub. */
  redactions: number;
  /** Redactions by PII kind. Every kind is present; untouched kinds are 0. Counts only — never text. */
  counts: Readonly<Record<PiiKind, number>>;
}

/**
 * `minimiseEgress`, plus the counts `minimise` already computed and
 * `minimiseEgress` used to drop. Same policy, same fail-closed rule — it is the
 * same call. Exists so a seam can PROVE it scrubbed (a log line, a counter)
 * rather than only doing it: a working minimiser and a bypassed one otherwise
 * look identical from outside (aiinfra rerank-pii-egress handoff §5.1).
 */
export async function minimiseEgressReport<T>(payload: T, signal?: AbortSignal): Promise<EgressReport<T>> {
  const result = await minimise(payload, undefined, signal);
  return { payload: result.payload, redactions: result.redactions, counts: result.counts };
}

/**
 * §9.4 option A for the `traces` table: store the SCRUBBED payload only, with
 * placeholder tokens so the trace still reads as prose. No reversible map
 * anywhere — option B was rejected because it turns `traces` into a PII store
 * with a key, in deployments whose DB roles are already Postgres superusers.
 *
 * ⚠ THE ONE DELIBERATE DIFFERENCE FROM `minimiseEgress`, and it is not a
 * loosening. At an egress seam, "I could not minimise" must abort the call,
 * because the alternative is shipping raw PII to the provider. Here the
 * alternative is different: a trace row is observability, and a refusal must not
 * turn a successful generation into a failed request — `TraceWriter.writeTrace`
 * is awaited on the router's success path (`router.ts` `writeTraceSafe`, which
 * despite the name only skips when there is no writer).
 *
 * So a refusal here means STORE NOTHING, not store the raw text and not fail the
 * request. It returns a marker object instead of the payload, so the drop is
 * visible to whoever reads the trace rather than looking like a call that never
 * produced output. Fail-closed is preserved: the unscrubbed text does not reach
 * the column on any path.
 */
export async function minimiseTracePayload(payload: unknown): Promise<unknown> {
  if (payload === undefined || payload === null) return payload;
  try {
    return await minimiseEgress(payload);
  } catch {
    return { piiMinimisationFailed: true };
  }
}
