// NER client — the THIRD model-server adapter (§9.1), and the detector that
// wraps it.
//
// WHY A MODEL AT ALL, when there are five rule detectors next door: a person's
// NAME is not a pattern. `Juan Pérez` and `Juan Rulfo` and `Juan de Dios` are
// the same shape as `Buenos Aires` and `Santa Marta` and `Juan es mi amigo`. No
// regex separates them; a sequence model does. Decision 2 is explicit — "A3 PII
// detection = rules AND a small NER model", not one or the other.
//
// 🔴 THE MODEL IS NOT CHOSEN. `§5` open item 7: size, language coverage and
// licence are all open, and the ~1.5 GB figure in `§2` is a GUESS that changes
// the inference box's slack arithmetic if it is wrong. So this adapter names no
// default model. `PII_NER_MODEL` has no fallback value: with it unset the
// adapter is NOT CONFIGURED and refuses, exactly as `RERANK_URL` unset makes
// `callRerank` refuse. Nothing here pretends a decision has been made.
//
// INVARIANT, the same one `rerank-client.ts` and `sparse-embed.ts` declare:
// this is the ONLY file in the tree that calls `fetch(PII_NER_URL)`.
//
// WIRE SHAPE (`pii-service/` `POST /ner`):
//   POST { model, input: string[] }
//   200  { model,
//          entities: [ [ { start, end, label, score, text } ] ]  // one array per input
//        }
// `start`/`end` are CHARACTER offsets into the corresponding input string, half
// open. They are character offsets and not token offsets on purpose: a token
// offset is meaningless on this side of the wire, and `minimise` verifies every
// span's `text` against the range it points at, so an offset convention
// mismatch surfaces as a REFUSAL rather than as a wrong redaction.

import { env } from '../../../config/env.js';
import { AiServiceError } from '../../../errors/base.js';
import type { ModelServerAdapter, ModelServerHealth } from './model-server.js';
import type { PiiDetector, PiiKind, PiiSpan } from './types.js';

/** One entity the model found in one input string. */
export interface NerEntity {
  /** Inclusive character offset into the input string. */
  start: number;
  /** Exclusive character offset into the input string. */
  end: number;
  /** The model's label, e.g. `PER`, `LOC`, `ORG`. Upstream vocabulary, not ours. */
  label: string;
  /** Model confidence, 0..1. */
  score: number;
  /** The substring the model believes it labelled. */
  text: string;
}

export interface NerArgs {
  /** The strings to tag, in order. At most `batchLimit` of them. */
  input: string[];
}

export interface NerResult {
  /** Echo of the model the server actually served. */
  model: string;
  /** One entity array per input, in submission order. */
  entities: NerEntity[][];
}

/** Typed error, matching `RerankHttpError` / `SparseEmbedHttpError`. */
export class NerHttpError extends Error {
  public readonly status: number;
  public readonly code: string | number | undefined;
  public readonly bodySnippet: string;
  /**
   * Present so the §9.1 resilience fix (an injectable `isTransient` predicate)
   * has something to read without another round of edits here. Nothing consumes
   * it yet.
   */
  public readonly retryAfterMs: number | undefined;
  constructor(opts: {
    status: number;
    code?: string | number;
    message: string;
    bodySnippet?: string;
    retryAfterMs?: number;
  }) {
    super(opts.message);
    this.name = 'NerHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Thrown when NER is requested but the deployment has not configured it.
 *
 * ⚠ THE DIFFERENCE FROM `RerankNotConfiguredError`, and it is the whole point:
 * an unconfigured reranker is caught one layer up and the request degrades to
 * the fused order. An unconfigured NER detector must NOT be caught — §9.1's
 * table makes PII the one capability that fails CLOSED. `minimise` converts
 * this into a `PiiMinimisationFailedError` and refuses the call, so a
 * deployment that installs the NER detector without a URL breaks LOUDLY at the
 * first request instead of quietly shipping every name to the provider.
 */
export class NerNotConfiguredError extends AiServiceError {
  readonly code = 'ERR_PII_NER_NOT_CONFIGURED';
  readonly status = 503;
  /** A deployment fault; the caller gets a generic 500, pino gets the detail. */
  override readonly expose = false;
  constructor(missing: string) {
    super(`PII NER requested but ${missing} is not configured.`);
    this.name = 'NerNotConfiguredError';
  }
}

export interface NerAdapterOptions {
  /** `POST /ner` endpoint. Defaults to `env.PII_NER_URL`. */
  url?: string;
  /** Model id. Defaults to `env.PII_NER_MODEL`. NO baked-in default. */
  model?: string;
  /** Max inputs per request. Defaults to `PII_NER_BATCH_LIMIT`, else 16. */
  batchLimit?: number;
  /** Per-request timeout. Defaults to `PII_NER_TIMEOUT_MS`, else 5000. `0` disables. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The five `PII_NER_*` knobs, read through the VALIDATED schema.
 *
 * ✅ THE LANE-BOUNDARY FOLLOW-UP IS DONE. This function used to read
 * `process.env` directly, because lane D owned only `src/services/ai/pii/` and
 * `pii-service/` and could not add to `src/config/env.ts`. The cost of that was
 * named at the time and was real: the five vars were absent from
 * `.env.example`, `PII_NER_URL=notaurl` was fetched rather than refused, and
 * `PII_NER_TIMEOUT_MS=abc` silently became the 5000 default. They are now
 * declared in the zod schema alongside `RERANK_URL` / `SPARSE_EMBED_URL`, so a
 * malformed value refuses the boot and a blank one warns once and falls back.
 *
 * The wrapper survives (rather than reading `env.PII_NER_*` at each use site)
 * because `createNerAdapter` and `nerDetector` both need the same five values
 * and the `options ?? env` precedence reads in one place.
 *
 *   PII_NER_URL          `POST /ner` endpoint of the sibling model server
 *   PII_NER_MODEL        model id — 🔴 UNCHOSEN, `§5` open item 7, no default
 *   PII_NER_BATCH_LIMIT  inputs per request (default 16)
 *   PII_NER_TIMEOUT_MS   per-request wall clock (default 5000; ⚠ never 0 in a
 *                        deployment — §10 item 8 records that `RERANK_TIMEOUT_MS=0`
 *                        installs no abort timer, so a hung server hangs the caller)
 *   PII_NER_MIN_SCORE    drop entities below this confidence (default 0.5)
 */
function readNerEnv(): {
  url?: string;
  model?: string;
  batchLimit?: number;
  timeoutMs?: number;
  minScore?: number;
} {
  return {
    // `|| undefined` on the two strings, not `??`: the schema leaves string vars
    // able to parse to `''` (see the empty-string note in `env.ts`), and an
    // empty URL must mean NOT CONFIGURED, not a fetch to the empty string.
    url: env.PII_NER_URL || undefined,
    model: env.PII_NER_MODEL || undefined,
    batchLimit: env.PII_NER_BATCH_LIMIT,
    timeoutMs: env.PII_NER_TIMEOUT_MS,
    minScore: env.PII_NER_MIN_SCORE,
  };
}

interface NerApiResponse {
  model?: string;
  entities?: Array<Array<{ start?: number; end?: number; label?: string; score?: number; text?: string }>>;
  error?: { message?: string; code?: string | number };
}

/**
 * Build the NER model-server adapter.
 *
 * Throws `NerNotConfiguredError` at CALL time, not at construction time, so a
 * process can build the adapter unconditionally and still boot when the model
 * server is not deployed. The refusal lands on the first request that actually
 * needs it, which is where an operator can see it.
 */
export function createNerAdapter(options: NerAdapterOptions = {}): ModelServerAdapter<NerArgs, NerResult> {
  const fromEnv = readNerEnv();
  const url = options.url ?? fromEnv.url;
  const model = options.model ?? fromEnv.model;
  const batchLimit = options.batchLimit ?? fromEnv.batchLimit ?? 16;
  const timeoutMs = options.timeoutMs ?? fromEnv.timeoutMs ?? 5000;
  // Bound to the global rather than passed by reference: an unbound `fetch`
  // throws `Illegal invocation` in some runtimes.
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));

  /**
   * Compose the caller's signal with this adapter's own timeout.
   * `AbortSignal.any` rather than a hand-rolled listener pair: whichever side
   * fires first aborts the request and the other is dropped with it.
   *
   * ⚠ `timeoutMs === 0` installs NO timer at all. That is deliberate (a caller
   * may own the whole budget) and it is the §10-item-8 footgun: the vault
   * records that `RERANK_TIMEOUT_MS=0` leaves a hung reranker hanging retrieve.
   * Never write 0 in a deployment.
   */
  const withTimeout = (signal: AbortSignal | undefined): AbortSignal | undefined => {
    if (timeoutMs <= 0) return signal;
    const timer = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timer]) : timer;
  };

  /** `PII_NER_URL` IS the `POST /ner` endpoint, exactly as `RERANK_URL` is the `POST /rerank` one. */
  const post = async (body: unknown, signal: AbortSignal | undefined): Promise<NerApiResponse> => {
    if (!url) throw new NerNotConfiguredError('PII_NER_URL');
    const composed = withTimeout(signal);
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(composed ? { signal: composed } : {}),
    });

    const text = await res.text();
    let parsed: NerApiResponse;
    try {
      parsed = text ? (JSON.parse(text) as NerApiResponse) : {};
    } catch {
      throw new NerHttpError({
        status: res.status,
        message: `NER returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
        bodySnippet: text.slice(0, 200),
      });
    }

    if (!res.ok || parsed.error) {
      const message = parsed.error?.message ?? `HTTP ${res.status}`;
      const code = parsed.error?.code;
      throw new NerHttpError({
        status: res.status,
        ...(code !== undefined ? { code } : {}),
        message: `NER error (${code ?? res.status}): ${message}`,
        bodySnippet: text.slice(0, 200),
      });
    }
    return parsed;
  };

  return {
    get modelName() {
      return model ?? '';
    },
    batchLimit,
    timeoutMs,

    async call(args: NerArgs, signal?: AbortSignal): Promise<NerResult> {
      if (!url) throw new NerNotConfiguredError('PII_NER_URL');
      // 🔴 No default model. `§5` item 7 is open; inventing one here would bake
      // an unmade decision into the code and into whatever image gets built.
      if (!model) throw new NerNotConfiguredError('PII_NER_MODEL');
      if (args.input.length === 0) return { model, entities: [] };
      if (args.input.length > batchLimit) {
        throw new NerHttpError({
          status: 400,
          code: 'too_many_inputs',
          message: `NER batch of ${args.input.length} exceeds batchLimit ${batchLimit}.`,
        });
      }

      const parsed = await post({ model, input: args.input }, signal);
      const rawBatches = parsed.entities ?? [];

      // 🔴 A short `entities` array means some inputs were NOT tagged. Padding
      // it with empty arrays would be the silent no-op §9.1 forbids: those
      // strings would sail through unminimised while `counts` reported zero.
      if (rawBatches.length !== args.input.length) {
        throw new NerHttpError({
          status: 502,
          code: 'entity_batch_mismatch',
          message: `NER returned ${rawBatches.length} entity lists for ${args.input.length} inputs.`,
        });
      }

      const entities = rawBatches.map((batch) =>
        (batch ?? []).flatMap((raw): NerEntity[] => {
          if (
            typeof raw.start !== 'number' ||
            typeof raw.end !== 'number' ||
            typeof raw.label !== 'string' ||
            typeof raw.text !== 'string'
          ) {
            // Same reasoning as the length check: a malformed entity is
            // dropped-and-loud, never dropped-and-quiet.
            throw new NerHttpError({
              status: 502,
              code: 'malformed_entity',
              message: 'NER returned an entity missing start/end/label/text.',
            });
          }
          return [
            {
              start: raw.start,
              end: raw.end,
              label: raw.label,
              score: typeof raw.score === 'number' ? raw.score : 1,
              text: raw.text,
            },
          ];
        }),
      );

      return { model: parsed.model ?? model, entities };
    },

    async health(signal?: AbortSignal): Promise<ModelServerHealth> {
      if (!url) return { ready: false };
      const composed = withTimeout(signal);
      try {
        // `PII_NER_URL` points at `POST /ner`; `/health` is its sibling on the
        // same server, so strip the endpoint segment rather than asking for a
        // second env var nobody would remember to set.
        const base = url.replace(/\/+$/, '').replace(/\/ner$/, '');
        const res = await doFetch(`${base}/health`, {
          method: 'GET',
          ...(composed ? { signal: composed } : {}),
        });
        if (!res.ok) return { ready: false };
        const body = (await res.json()) as { ready?: boolean; model?: string };
        // `/health` answering at all is not readiness; `pii-service` returns 503
        // until the model is in RAM and `ready: true` only after.
        return body.ready === true
          ? { ready: true, ...(body.model !== undefined ? { model: body.model } : {}) }
          : { ready: false };
      } catch {
        // A health PROBE reports unhealthy rather than throwing — it is the
        // question "is it up", and "no" is an answer. This is the ONE place in
        // this file that swallows an error, and it is safe because nothing
        // decides whether to minimise based on it.
        return { ready: false };
      }
    },
  };
}

/** Which model labels map to which `PiiKind`. Upstream vocabulary varies by model. */
export type NerLabelMap = Readonly<Record<string, PiiKind>>;

/**
 * The default label map.
 *
 * `PER` / `PERSON` / `B-PER` / `I-PER` → `person`, and nothing else. The rules
 * layer already covers addresses far more precisely than a `LOC` span would,
 * and mapping `LOC` → `address` would redact every city, river and country in
 * the text. `ORG` is deliberately unmapped: an organisation is not personal
 * data, and redacting the ministry a document is about destroys the document.
 *
 * ⚠ These labels are a GUESS about a model that has not been chosen (`§5` item
 * 7). Whichever model wins, check its `id2label` and pass a `labelMap` — do not
 * assume this one fits.
 */
export const DEFAULT_NER_LABELS: NerLabelMap = Object.freeze({
  PER: 'person',
  PERSON: 'person',
  'B-PER': 'person',
  'I-PER': 'person',
});

export interface NerDetectorOptions {
  /** Label → kind. Defaults to {@link DEFAULT_NER_LABELS}. */
  labelMap?: NerLabelMap;
  /** Drop entities scoring below this. Defaults to `PII_NER_MIN_SCORE`, else 0.5. */
  minScore?: number;
}

/**
 * Wrap a NER adapter as a {@link PiiDetector}, so the model is a THIRD DETECTOR
 * behind the same interface as the five rule detectors — not a second code path
 * through `minimise`.
 *
 * 🔴 IT PROPAGATES EVERY ERROR. No try/catch, no "degrade to zero spans". That
 * is the opposite of what `RetrieveService` does with a failed rerank, and the
 * difference is the whole of §9.1's fail-safe table: rerank degrades to the
 * fused order because a worse ORDER is still a correct answer, while a PII
 * minimiser that silently finds nothing ships raw names to the provider.
 * `minimise` turns whatever comes out of here into a refusal.
 */
export function nerDetector(
  adapter: ModelServerAdapter<NerArgs, NerResult>,
  options: NerDetectorOptions = {},
): PiiDetector {
  const labelMap = options.labelMap ?? DEFAULT_NER_LABELS;
  const minScore = options.minScore ?? readNerEnv().minScore ?? 0.5;
  const kinds = [...new Set(Object.values(labelMap))];

  return {
    name: 'ner',
    kinds,
    async find(text: string, signal?: AbortSignal): Promise<PiiSpan[]> {
      if (text.length === 0) return [];
      const result = await adapter.call({ input: [text] }, signal);
      const entities = result.entities[0] ?? [];
      const spans: PiiSpan[] = [];
      for (const entity of entities) {
        if (entity.score < minScore) continue;
        const kind = labelMap[entity.label];
        if (kind === undefined) continue;
        // Offsets are NOT trusted: `minimise.assertUsableSpan` re-derives
        // `text.slice(start, end)` and refuses if it disagrees with what the
        // model said it labelled. Passing the model's own `text` through rather
        // than re-slicing is what makes that check able to fire at all.
        spans.push({
          start: entity.start,
          end: entity.end,
          kind,
          detector: 'ner',
          text: entity.text,
        });
      }
      return spans;
    },
  };
}
