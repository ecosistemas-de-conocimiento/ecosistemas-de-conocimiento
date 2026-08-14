// Public/internal generation types.
//
// Pulled forward from a prototype's `types/generation.ts` but stripped of domain
// vocabulary (no `dimension`, no `scope`, no `surface`, no `storyId`). What
// remains is the contract-level shape consumers POST and the in-memory carrier
// the orchestrator passes around.
//
// Single sources of truth re-exported here so route handlers and tests can
// `import type { EffortProfile, ResolvedSpec } from '../../types/generation.js'`
// without reaching across module boundaries:
//   - `EffortProfile`, `ResolvedSpec`, `InlineSpecOverride`, `SpecDefault`
//     live on `src/services/registry/resolve.ts`.
//   - `IncludeContextItem` lives on `src/services/context/types.ts`.
//   - `EffortLevel`, `Validator` live on `src/schemas/registry.ts`.

import type { generationJobStatus, generationRequestStatus } from '../db/schema/index.js';
import type {
  EffortProfile,
  InlineSpecOverride,
  RequestOverrides,
  ResolvedSpec,
  SpecDefault,
} from '../services/registry/resolve.js';
import type { IncludeContextItem } from '../services/context/types.js';
import type { EffortLevel, Validator } from '../schemas/registry.js';

export type {
  EffortLevel,
  EffortProfile,
  InlineSpecOverride,
  RequestOverrides,
  ResolvedSpec,
  SpecDefault,
  Validator,
};
export type { IncludeContextItem } from '../services/context/types.js';

export type GenerationRequestStatus = (typeof generationRequestStatus.enumValues)[number];
export type GenerationJobStatus = (typeof generationJobStatus.enumValues)[number];

/**
 * One opaque generation unit on a `/v1/generate` request.
 *
 * The service doesn't interpret `input` / `dependsOn` / `specOverride` — it
 * only ferries them to the model. `unitKey` is the consumer's id; `unitType`
 * is an optional grouping tag used for registry lookup + cost rollup.
 *
 * `dependsOn` is a **named-slot** map: keys are arbitrary slot names the
 * prompt template references via `{{slotName}}`; values are predecessor
 * `unitKey`s in the same batch. The orchestrator topologically orders units
 * by these references and the worker merges predecessor `output`s under the
 * declared slot names before rendering.
 */
export interface Unit {
  unitKey: string;
  unitType?: string;
  input?: Record<string, unknown>;
  dependsOn?: Record<string, string>;
  specOverride?: InlineSpecOverride;
  /**
   * Per-unit spec FLOOR — beaten by an active `registry_entries` row. Where a
   * caller's BUILT-IN prompt/effort/schema belongs, so it works with zero
   * registry config without discarding a project's registered row. See
   * `SpecDefault` in `src/services/registry/resolve.ts`.
   */
  specDefault?: SpecDefault;
  /**
   * Per-unit system prompt, delivered as a real `{ role: 'system' }` message.
   * Literal text — never Handlebars-rendered. Highest-precedence level; see
   * `src/services/generation/system-prompt.ts`.
   */
  systemPrompt?: string;
}

/** Body of `POST /v1/generate` after Zod validation. */
export interface GenerateRequest {
  units: Unit[];
  effortLevel?: EffortLevel;
  promptOverride?: string;
  modelOverride?: string;
  /** Batch-wide system prompt; loses to a unit's own `systemPrompt`. */
  systemPromptOverride?: string;
  effortOverrides?: Record<string, Partial<EffortProfile>>;
  includeContext?: IncludeContextItem[];
  clientRequestId?: string;
  callbackUrl?: string;
  requestedBy?: string;
  metadata?: Record<string, unknown>;
}

/** Orchestrator-local carrier — unit + its resolved spec + per-unit estimate. */
export interface ResolvedUnit {
  unit: Unit;
  spec: ResolvedSpec;
  estimatedCostUsd: number;
  /**
   * For leaf units (no `dependsOn`): the fully rendered prompt string.
   * For dependent units: the raw template — the worker re-renders after
   * predecessor outputs are merged. See plan/m3-m4-decisions.md §16 amendment.
   */
  renderedPromptOrTemplate: string;
  /** True ⇒ orchestrator could render now; false ⇒ worker renders later. */
  rendered: boolean;
}

/** Top-level advisory flag returned alongside any budget-reserving response.
 *  Today only emits `BUDGET_SOFT_CAP`; consumers should treat unknown codes as
 *  informational. */
export interface ResponseWarning {
  code: string;
  message: string;
}

/** Return shape of `POST /v1/generate`. */
export interface LaunchGenerationResult {
  requestId: string;
  channel: string;
  totalJobs: number;
  estimatedCostUsd: number;
  /** Optional advisory flags (e.g. soft budget cap). Absent when none fired. */
  warnings?: ResponseWarning[];
}

/** Opaque-thin BullMQ payload. Everything else is on the DB row. */
export interface GenerationJobData {
  jobId: string;
  generationRequestId: string;
  org: string;
  project: string;
  unitKey: string;
}
