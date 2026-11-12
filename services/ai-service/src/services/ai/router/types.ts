// Router-layer types. The router is the seam between orchestrator/worker and
// the actual LLM HTTP adapter — it owns budget reservation, cache, validator
// dispatch, and the self-critique pipeline.
//
// `label` is a free-form opaque string the consumer or orchestrator
// stamps onto `traces.label`. `effortProfile` is **passed in pre-resolved** by
// the orchestrator (`services/registry/resolve.ts`); the router does not
// re-resolve.

import type { Flag } from '../validators/types.js';
import type { EffortLevel, EffortProfile, Validator } from '../../../types/generation.js';
import type { FinishReason } from './finish-reason.js';

export type { FinishReason };

export type ProviderKey = 'openrouter' | 'openai' | 'anthropic' | 'local';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface RouteRequest {
  /** Opaque grouping tag stored on `traces.label`. Free-form. */
  label: string;
  /** Opaque consumer-supplied unit id (`generation_jobs.unit_key`). */
  unitKey?: string;
  /** Opaque consumer-supplied grouping tag (`generation_jobs.unit_type`). */
  unitType?: string;

  org: string;
  project?: string;

  messages: ChatMessage[];

  model: string;
  effortLevel: EffortLevel;
  effortProfile: EffortProfile;

  maxTokens?: number;
  temperature?: number;

  responseSchema?: unknown;
  /**
   * `true` ⇒ ask the provider for STRICT schema-constrained output
   * (`response_format: { type: 'json_schema', json_schema: { name, schema,
   * strict: true } }`) instead of JSON mode. Needs `responseSchema`, a model in
   * `STRICT_SCHEMA_MODELS`, and a schema inside the strict subset; otherwise the
   * router throws `SpecResolutionError` (400) before reserving budget. See
   * `strict-schema.ts`.
   */
  responseSchemaStrict?: boolean;
  validators?: Validator[];

  signal?: AbortSignal;

  /**
   * Optional per-token callback. When set, the router forwards it into the
   * adapter for the **primary** generation pass only (refine/sample passes
   * stay non-streaming), so a streaming HTTP route can relay tokens live.
   * The router's returned `RouteResult.content` remains authoritative — for
   * cache hits the callback never fires, and for multi-pass specs the streamed
   * pass may not be the winner.
   */
  onDelta?: (text: string) => void;

  /** Pre-existing trace ID — the worker stamps this so callers can correlate. */
  traceId?: string;
  /** Parent trace for self-critique chains. Cross-org rejected. */
  parentTraceId?: string;

  /** Soft links (no FK) — recorded on the trace row for joinability. */
  generationRequestId?: string;
  generationJobId?: string;
  registryEntryId?: string;
  /** Stamped onto `traces.prompt_version` (from `ResolvedSpec.registryEntryVersion`). */
  promptVersion?: string;

  /**
   * Fastify's per-HTTP-request id, recorded on `traces.metadata.httpRequestId`.
   *
   * 🔴 NOT `requestId`. In this codebase that name means
   * `generation_requests.id` — see `generationRequestId` above, the wire's
   * `LaunchGenerationResult.requestId`, and the `request:<uuid>:generations`
   * event channel. This one identifies ONE HTTP call: the synchronous routes
   * make exactly one router call per call, while a retry or a status poll is a
   * further HTTP request against the same generation request. Two ids, two
   * lifetimes, two names.
   */
  httpRequestId?: string;
}

export interface RouteResult {
  /** Raw model output as text. */
  content: string;
  /** Parsed structure if response schema validation extracted JSON. */
  parsed?: unknown;
  /** Validator output — `severity: 'blocker'` ⇒ retry-eligible. */
  flags: Flag[];
  usage: TokenUsage;
  /**
   * Why the model stopped, normalized off the provider's raw `finish_reason`
   * (see `finish-reason.ts`). **Optional and honestly absent**: omitted when
   * the provider reported nothing, and on cache hits — the cache entry does
   * not store it, and re-serving a cached body says nothing about how the
   * original call ended.
   *
   * `'length'` is the load-bearing value: it means the output was truncated at
   * `effortProfile.maxOutputTokens`, which consumers metering credits by
   * output tokens must settle differently from a clean `'stop'`.
   */
  finishReason?: FinishReason;
  model: string;
  provider: ProviderKey;
  /** Trace row id written by the router. */
  traceId: string;
  /** True when the response came from the in-process LRU cache. */
  cached: boolean;
  durationMs: number;
  effort: EffortLevel;
  effortProfileUsed: EffortProfile;
  /** Multi-pass breakdown (generate + critique + refine + samples). */
  breakdown?: Array<{
    traceId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    purpose: 'generate' | 'critique' | 'refine' | 'sample';
    /** An attempt the provider answered empty: billed by the provider, retried by us. */
    empty?: true;
  }>;
  /** Soft-cap signal from `BudgetEnforcer.reserve` (0007_budget_reset) — true
   *  when the org's remaining budget dipped below the configured threshold
   *  on the first reserve of this call. Routes turn this into a `warnings`
   *  entry on the HTTP response. */
  softCap?: boolean;
}

export interface LLMRouter {
  route(req: RouteRequest): Promise<RouteResult>;
}
