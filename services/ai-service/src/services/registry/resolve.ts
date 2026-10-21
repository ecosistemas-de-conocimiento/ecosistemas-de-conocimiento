// Registry resolution — pure function that produces a ResolvedSpec for one
// generation unit by walking the precedence chain (model C):
//
//   unit.specOverride
//     → request-level overrides (promptOverride / modelOverride / effortOverrides)
//       → active registry_entries row for (org, project, unitType)
//         → caller-supplied `specDefault` FLOOR
//           → project_configs defaults
//             → built-in EFFORT_PROFILES fallback
//               → typed error
//
// ── Why there is both an override slot and a floor slot ───────────────────
// `specOverride` is a CEILING: whatever it sets can never be reconfigured by a
// project. `specDefault` is a FLOOR: it makes an endpoint work with zero
// registry config, while still letting a project take ownership by registering
// the unit-type. An in-process endpoint that ships a built-in prompt (e.g.
// `/v1/route`'s `DEFAULT_ROUTER_PROMPT`) wants the floor, not the ceiling —
// otherwise its registry unit-type is resolved and then silently discarded,
// which is exactly the bug this slot exists to make unrepresentable.
//
// Reads the DB through whatever `Db`-shaped handle the caller passes in (the
// shared pool by default, or a test stub via `vi.mock`). Caches nothing — the
// registry table is small and reads are cheap; M3 plan §3 "New" defers any
// caching.

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { AiServiceError } from '../../errors/base.js';
import { projectConfigs, registryEntries } from '../../db/schema/index.js';
import type { EffortLevel, Validator } from '../../contract/registry.js';
import { clampCallerLimits } from './caller-limits.js';
import {
  STRICT_SCHEMA_MODELS,
  strictSchemaProblems,
  supportsStrictSchema,
} from '../ai/router/strict-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-effort-level knobs the router branches on. */
export interface EffortProfile {
  /** Optional — `ResolvedSpec.model` is the authoritative call-time model. */
  model?: string;
  maxOutputTokens: number;
  validationPasses: number;
  multiSample: number;
  temperature: number;
  estimatedCostUsdPerCall: number;
}

/** The single output object of `resolveSpec`. Immutable by convention. */
export interface ResolvedSpec {
  /** Raw template — orchestrator renders this against `input`. */
  promptTemplate: string;
  /**
   * Registry-level (or inline-spec-level) **system prompt template**. Rendered
   * with the same variables as `promptTemplate` and delivered to the model as a
   * `{ role: 'system' }` message — but only when the request itself carries no
   * system prompt. See `src/services/generation/system-prompt.ts`.
   */
  metaPromptTemplate?: string;
  /**
   * Where `metaPromptTemplate` came from. Load-bearing for precedence: an
   * inline `specOverride.metaPromptTemplate` is per-unit and therefore beats a
   * batch-level `systemPromptOverride`, whereas a `registry_entries` row is a
   * standing default and loses to it. `'default'` (a `specDefault` floor) is
   * lower still, and `resolveSystemPrompt` treats every non-`'inline'` source
   * identically — the lowest-privilege interpretation.
   */
  metaPromptSource?: 'inline' | 'registry' | 'default';
  model: string;
  effortLevel: EffortLevel;
  effortProfile: EffortProfile;
  responseSchema?: unknown;
  /**
   * `true` ⇒ the provider is asked for STRICT schema-constrained output
   * (`response_format: json_schema`, `strict: true`) instead of JSON mode.
   * Only ever `true` or absent: resolution has already checked the model and
   * the schema, see `checkStrictSchema`.
   */
  responseSchemaStrict?: true;
  validators: Validator[];
  renderer?: string;
  contentKind?: string;
  /** Null when the spec was resolved purely from an inline override. */
  registryEntryId?: string;
  /** Stamped onto `traces.prompt_version` for drift detection. */
  registryEntryVersion?: string;
}

/**
 * Built-in effort-profile defaults — the same shape as the per-model table in
 * `src/services/ai/router/task-profiles.ts`.
 * Used only when neither the registry entry nor `project_configs` supplies a
 * profile for the resolved effort level. The router can also override on a
 * per-call basis via `requestOverrides.effortOverrides`.
 *
 * `estimatedCostUsdPerCall` is a coarse capacity-planning number, not a
 * billing figure. It uses a fixed "average call" assumption of 500 input
 * tokens, taken against the upper-bound `maxOutputTokens` for the profile:
 *
 *   estimatedCostUsdPerCall =
 *     (500 / 1_000_000) * MODEL_PRICING[model].inputPerMillion +
 *     (maxOutputTokens / 1_000_000) * MODEL_PRICING[model].outputPerMillion
 *
 * Refresh these values whenever `MODEL_PRICING` is updated; the helper at
 * `scripts/refresh-model-pricing.ts` prints the upstream diff so the math
 * can be re-run by hand.
 */
export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  quick: {
    model: 'deepseek/deepseek-chat-v3.1',
    maxOutputTokens: 400,
    validationPasses: 1,
    multiSample: 1,
    temperature: 0.3,
    // (500/1M * 0.21) + (400/1M * 0.79) = 0.000421
    estimatedCostUsdPerCall: 0.000421,
  },
  standard: {
    model: 'deepseek/deepseek-chat-v3.1',
    maxOutputTokens: 800,
    validationPasses: 1,
    multiSample: 1,
    temperature: 0.4,
    // (500/1M * 0.21) + (800/1M * 0.79) = 0.000737
    estimatedCostUsdPerCall: 0.000737,
  },
  deep: {
    // Was `moonshotai/kimi-k2-0905`, which via this OpenRouter setup returned
    // degenerate output (` [1] `, ` [2024] `) — deterministically unusable for
    // structured generation. deepseek-chat-v3.1 is confirmed reliable for
    // structured JSON; deep keeps the multi-pass self-critique loop on top.
    model: 'deepseek/deepseek-chat-v3.1',
    // Raised from 1500 — rich structured output was truncating mid-JSON.
    maxOutputTokens: 3500,
    validationPasses: 2,
    multiSample: 1,
    temperature: 0.3,
    // (500/1M * 0.21) + (3500/1M * 0.79) = 0.002870
    estimatedCostUsdPerCall: 0.00287,
  },
  maximum: {
    // deepseek-r1 is a reasoning model; for reliable structured JSON we use the
    // confirmed-good chat-v3.1 and lean on the larger multi-sample budget +
    // self-critique loop for the extra capability at this tier.
    model: 'deepseek/deepseek-chat-v3.1',
    // Raised from 2500 — headroom for long structured documents.
    maxOutputTokens: 6000,
    validationPasses: 2,
    multiSample: 3,
    temperature: 0.3,
    // (500/1M * 0.21) + (6000/1M * 0.79) = 0.004845
    estimatedCostUsdPerCall: 0.004845,
  },
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type SpecResolutionCause =
  | 'no spec for unitType'
  | 'no defaults'
  | 'no model'
  /** `responseSchemaStrict` on a model not in `STRICT_SCHEMA_MODELS`. */
  | 'strict schema unsupported model'
  /** `responseSchemaStrict` with no schema, or one outside the strict subset. */
  | 'strict schema invalid'
  /**
   * An `includeContext` `{ name }` with no usable `project_configs.contextRules`
   * entry (`services/context/fetch.ts`). Was a silent empty context.
   */
  | 'unknown context recipe';

export class SpecResolutionError extends AiServiceError {
  readonly code = 'ERR_SPEC_RESOLUTION';
  readonly status = 400;
  /** Resolution happens before the SSE hijack; kept legible if it ever moves. */
  override readonly midStream = true;
  override readonly name = 'SpecResolutionError';
  override readonly cause: SpecResolutionCause;
  constructor(args: { cause: SpecResolutionCause; message?: string }) {
    super(args.message ?? args.cause);
    this.cause = args.cause;
  }
  protected override bodyFields() {
    return { cause: this.cause };
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Inline per-unit spec — `unit.specOverride`. Wins over everything else.
 * Same shape (subset) as `registry_entries` columns.
 */
export interface InlineSpecOverride {
  promptTemplate?: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  effortLevel?: EffortLevel;
  effortProfile?: Partial<EffortProfile>;
  responseSchema?: unknown;
  /** Strict schema-constrained output. See `ResolvedSpec.responseSchemaStrict`. */
  responseSchemaStrict?: boolean;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
}

/**
 * Caller-supplied FLOOR — `specDefault`. Structurally identical to
 * `InlineSpecOverride`, precedence-wise its mirror image: consulted only after
 * the active `registry_entries` row, so registering the unit-type WINS over it.
 * Sits above `project_configs` because a floor is authored for one specific
 * unit-type, while `project_configs` is a project-wide catch-all.
 *
 * Use this (never `specOverride`) for a built-in that an endpoint ships so it
 * works with no registry config — a prompt, a default effort tier, a fallback
 * response schema. Fields left unset fall through the rest of the chain exactly
 * as if the floor were absent.
 *
 * ⚠ A floor also keeps registry PROVENANCE intact: `specOverride` suppresses
 * `registryEntryId` / `registryEntryVersion` stamping (see below), a floor does
 * not, so traces still record which prompt version answered.
 */
export type SpecDefault = InlineSpecOverride;

/** Request-level knobs from the `POST /v1/generate` body. */
export interface RequestOverrides {
  promptOverride?: string;
  modelOverride?: string;
  effortLevel?: EffortLevel;
  /**
   * Per-unit partial effort-profile overlay keyed by `unitType` (preferred) or
   * `unitKey` (fallback). Looked up with `unitType ?? unitKey`.
   */
  effortOverrides?: Record<string, Partial<EffortProfile>>;
}

export interface ResolveSpecArgs {
  org: string;
  project: string;
  unitType?: string;
  unitKey?: string;
  specOverride?: InlineSpecOverride;
  /** Floor — beaten by a registered `registry_entries` row. See `SpecDefault`. */
  specDefault?: SpecDefault;
  requestOverrides?: RequestOverrides;
  /**
   * Caller-supplied fallback for the built-in `EFFORT_PROFILES` — the bottom
   * of the precedence chain. `/v1/route` uses it for the router's `quick`
   * model (see `ROUTER_DEFAULT_MODEL`); other wiring leaves it undefined.
   */
  defaultEffortProfiles?: Partial<Record<EffortLevel, Partial<EffortProfile>>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickProfileFromMap(
  map: unknown,
  level: EffortLevel,
): Partial<EffortProfile> | undefined {
  if (!isObject(map)) return undefined;
  const entry = map[level];
  return isObject(entry) ? (entry as Partial<EffortProfile>) : undefined;
}

function mergeProfile(
  base: EffortProfile,
  ...overlays: Array<Partial<EffortProfile> | undefined>
): EffortProfile {
  const out: Record<string, unknown> = { ...base };
  for (const overlay of overlays) {
    if (!overlay) continue;
    for (const [k, v] of Object.entries(overlay)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out as unknown as EffortProfile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function resolveSpec(db: Db, args: ResolveSpecArgs): Promise<ResolvedSpec> {
  const { org, project, unitType, unitKey, specOverride, specDefault, requestOverrides } = args;

  // 1. Registry entry (active row for unitType). Null when no unitType is
  //    provided or no active row exists.
  let registryRow:
    | (typeof registryEntries.$inferSelect)
    | null = null;
  if (unitType) {
    const rows = await db
      .select()
      .from(registryEntries)
      .where(
        and(
          eq(registryEntries.org, org),
          eq(registryEntries.project, project),
          eq(registryEntries.unitType, unitType),
          sql`${registryEntries.isActive}`,
        ),
      )
      .limit(1);
    registryRow = rows[0] ?? null;
  }

  // 2. Project defaults.
  const projectRows = await db
    .select()
    .from(projectConfigs)
    .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
    .limit(1);
  const projectRow = projectRows[0] ?? null;

  // 3. Hard precondition: we must have something to drive prompt+model from.
  //    If no inline override AND no floor AND no registry row AND no project
  //    defaults at all → there's literally nothing to resolve against.
  //    ⚠ `specDefault` counts here: `project_configs` is empty on every
  //    deployed environment, so an endpoint that ships a floor instead of an
  //    override would otherwise start throwing on its very first call.
  if (!specOverride && !specDefault && !registryRow && !projectRow) {
    throw new SpecResolutionError({
      cause: 'no spec for unitType',
      message: unitType
        ? `no active registry entry for unitType '${unitType}' and no project_configs row for (${org}, ${project})`
        : `no spec available for (${org}, ${project})`,
    });
  }

  // 4. Resolve prompt template. Precedence:
  //    inline override → request promptOverride → registry → specDefault floor
  //    → error. project_configs has no prompt — it only carries defaults.
  const promptTemplate =
    specOverride?.promptTemplate ??
    requestOverrides?.promptOverride ??
    registryRow?.promptTemplate ??
    specDefault?.promptTemplate ??
    undefined;
  if (!promptTemplate) {
    throw new SpecResolutionError({
      cause: 'no spec for unitType',
      message: unitType
        ? `no prompt template available for unitType '${unitType}'`
        : 'no prompt template available',
    });
  }

  // 4b. Resolve the meta (system) prompt template + its provenance.
  //     inline specOverride → registry row → none. Request-level system
  //     prompts deliberately do NOT flow through here: they are literal text
  //     supplied by the caller (never Handlebars-rendered) and are layered on
  //     top of this result by `resolveSystemPrompt`.
  const metaPromptTemplate =
    specOverride?.metaPromptTemplate ??
    registryRow?.metaPromptTemplate ??
    specDefault?.metaPromptTemplate ??
    undefined;
  const metaPromptSource: 'inline' | 'registry' | 'default' | undefined = specOverride?.metaPromptTemplate
    ? 'inline'
    : registryRow?.metaPromptTemplate
      ? 'registry'
      : specDefault?.metaPromptTemplate
        ? 'default'
        : undefined;

  // 5. Resolve effort level.
  //    Precedence: inline → request → registry default → specDefault floor →
  //    project default → 'standard'.
  const effortLevel: EffortLevel =
    specOverride?.effortLevel ??
    requestOverrides?.effortLevel ??
    registryRow?.defaultEffort ??
    specDefault?.effortLevel ??
    projectRow?.defaultEffort ??
    'standard';

  // 6. Resolve effort profile for that level.
  //    Base: built-in EFFORT_PROFILES[level], optionally swapped via
  //          args.defaultEffortProfiles[level].
  //    Then layer (lowest first — a later overlay wins):
  //                project_configs.effortProfiles[level],
  //                specDefault.effortProfile (the floor),
  //                registry_entries.effortProfiles[level],
  //                request-level effortOverrides[unitType ?? unitKey],
  //                inline specOverride.effortProfile.
  //    Note: the `model` field on the base built-in profile is the *last*
  //    resort — see model resolution below.
  // If the caller hands us a `defaultEffortProfiles[level]`, treat it as a
  // *replacement* for the built-in EFFORT_PROFILES[level] (not an overlay) —
  // so callers can deliberately scrub fields like `model` to exercise the
  // downstream resolution chain. Empty/undefined → use built-in.
  const baseDefault = EFFORT_PROFILES[effortLevel];
  const baseOverride = args.defaultEffortProfiles?.[effortLevel];
  const base: EffortProfile = baseOverride
    ? ({ ...baseDefault, ...baseOverride } as EffortProfile)
    : baseDefault;

  const fromProject = pickProfileFromMap(projectRow?.effortProfiles, effortLevel);
  const fromDefault = specDefault?.effortProfile;
  const fromRegistry = pickProfileFromMap(registryRow?.effortProfiles, effortLevel);
  const overrideKey = unitType ?? unitKey;
  const fromRequest =
    overrideKey && requestOverrides?.effortOverrides
      ? requestOverrides.effortOverrides[overrideKey]
      : undefined;
  const fromInline = specOverride?.effortProfile;

  // The admin-controlled layers ONLY: built-in defaults, `project_configs`,
  // and the active `registry_entries` row. `fromDefault` (`unit.specDefault`),
  // `fromRequest` (`requestOverrides.effortOverrides`) and `fromInline`
  // (`unit.specOverride`) all arrive over the wire, so they are excluded.
  // This is the floor `clampCallerLimits` holds `estimatedCostUsdPerCall` to,
  // and the fallback when a caller sends a non-numeric value.
  const adminBaseline = mergeProfile(base, fromProject, fromRegistry);

  // Security clamp — audit finding C4 (budget/cost caps bypassable
  // via a caller-supplied `effortProfile`). Applied AFTER the merge, so it
  // binds no matter which layer supplied the value, and so a caller keeps any
  // value that is already within the server's bounds.
  //
  // ⚠ CLAMP, NEVER DELETE. The audit's step 4 proposed dropping these fields
  // from the caller overlays; for `maxOutputTokens` that would silently break
  // the chat product's per-user credit cap. See
  // `plan/open-maxoutputtokens-clamp-not-delete.md` and the regression test
  // "a caller-supplied maxOutputTokens BELOW the ceiling survives untouched"
  // in `resolve.test.ts`, which exists to fail if anyone reverts to deletion.
  const effortProfile = clampCallerLimits(
    mergeProfile(base, fromProject, fromDefault, fromRegistry, fromRequest, fromInline),
    adminBaseline,
  );

  // 7. Resolve model.
  //    Precedence (highest first):
  //      a. inline specOverride.model
  //      b. requestOverrides.modelOverride
  //      c. inline specOverride.effortProfile.model  (per-call profile overlay)
  //      d. request-level effortOverrides[key].model (per-unit profile overlay)
  //      e. registry_entries.model                   (registered default for unitType)
  //      f. registry_entries.effortProfiles[level].model
  //      g. specDefault.model                        (caller-supplied floor)
  //      h. specDefault.effortProfile.model
  //      i. project_configs.defaultModel
  //      j. project_configs.effortProfiles[level].model
  //      k. baseDefault.model (built-in EFFORT_PROFILES[level] fallback)
  //
  //    The registry's `model` column intentionally beats the *profile-level*
  //    model field — the column is a unitType-wide default ("when generating
  //    units of this type, always use X"), whereas a profile's `model` field
  //    is the effort-level fallback for projects that haven't pinned one.
  const model =
    specOverride?.model ??
    requestOverrides?.modelOverride ??
    fromInline?.model ??
    fromRequest?.model ??
    registryRow?.model ??
    fromRegistry?.model ??
    specDefault?.model ??
    fromDefault?.model ??
    projectRow?.defaultModel ??
    fromProject?.model ??
    base.model ??
    undefined;
  if (!model) {
    throw new SpecResolutionError({
      cause: 'no model',
      message: `no model resolvable for effort '${effortLevel}'`,
    });
  }

  // 8. Validators / response schema / passthrough hints — inline beats
  //    registry, registry beats the specDefault floor.
  const validators: Validator[] =
    specOverride?.validators ??
    (registryRow?.validators as Validator[] | null | undefined) ??
    specDefault?.validators ??
    [];
  const responseSchema =
    specOverride?.responseSchema !== undefined
      ? specOverride.responseSchema
      : (registryRow?.responseSchema ?? specDefault?.responseSchema ?? undefined);
  // Strict mode: inline beats the floor. There is no registry column for it —
  // a caller turns it on per call, and it applies to whichever layer supplied
  // the schema (including a registered row's).
  const responseSchemaStrict =
    specOverride?.responseSchemaStrict ?? specDefault?.responseSchemaStrict ?? false;
  if (responseSchemaStrict) {
    checkStrictSchema(model, responseSchema ?? undefined);
  }
  const renderer =
    specOverride?.renderer ?? registryRow?.renderer ?? specDefault?.renderer ?? undefined;
  const contentKind =
    specOverride?.contentKind ?? registryRow?.contentKind ?? specDefault?.contentKind ?? undefined;

  const out: ResolvedSpec = {
    promptTemplate,
    model,
    effortLevel,
    effortProfile: { ...effortProfile, model },
    validators,
  };
  if (metaPromptTemplate) {
    out.metaPromptTemplate = metaPromptTemplate;
    if (metaPromptSource) out.metaPromptSource = metaPromptSource;
  }
  if (responseSchema !== undefined && responseSchema !== null)
    out.responseSchema = responseSchema;
  if (responseSchemaStrict) out.responseSchemaStrict = true;
  if (renderer) out.renderer = renderer;
  if (contentKind) out.contentKind = contentKind;
  // Provenance. Deliberately NOT gated on `specDefault`: a floor loses to the
  // registry row, so when a row exists it is the row that answered and the
  // trace must say so. (`specOverride` still suppresses stamping — there the
  // row genuinely did not supply the spec.)
  if (registryRow && !specOverride) {
    out.registryEntryId = registryRow.id;
    out.registryEntryVersion = registryRow.version;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strict schema-constrained output — the pre-flight check
// ---------------------------------------------------------------------------

/**
 * Throw `SpecResolutionError` (400) unless `model` can run strict mode and
 * `schema` is inside the strict subset. Never downgrades to JSON mode.
 *
 * Called by `resolveSpec` (so `/v1/generate` refuses at submit time, not in the
 * worker) AND by the router (the seam every provider call crosses), both
 * before any budget is reserved.
 */
export function checkStrictSchema(model: string, schema: unknown): void {
  if (!supportsStrictSchema(model)) {
    throw new SpecResolutionError({
      cause: 'strict schema unsupported model',
      message:
        `responseSchemaStrict: model '${model}' does not support strict schema-constrained ` +
        `output. Supported: ${STRICT_SCHEMA_MODELS.join(', ')} (also listed by ` +
        'GET /v1/capabilities as `strictStructuredOutputModels`). Pick one of those, or drop ' +
        'responseSchemaStrict to use JSON mode.',
    });
  }
  if (schema === undefined || schema === null) {
    throw new SpecResolutionError({
      cause: 'strict schema invalid',
      message: 'responseSchemaStrict: no responseSchema resolved for this unit, so there is nothing to enforce',
    });
  }
  const problems = strictSchemaProblems(schema);
  if (problems.length > 0) {
    throw new SpecResolutionError({
      cause: 'strict schema invalid',
      message:
        'responseSchemaStrict: the responseSchema is outside the strict subset; ai-service ' +
        `rejects it rather than rewrite it. ${problems.join('; ')}`,
    });
  }
}
