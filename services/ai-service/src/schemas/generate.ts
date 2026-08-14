// Zod schemas for POST /v1/generate + POST /v1/generate/sync request bodies.
//
// Source of truth for what crosses the wire on the generation surface. The
// internal `Unit` / `GenerateRequest` shapes in `src/types/generation.ts` are
// kept aligned with the `z.infer<>` outputs here — Zod is the runtime gate, the
// type aliases are the editor surface.

import { z } from 'zod';

import { effortLevelSchema, validatorSchema } from './registry.js';
import { includeContextItemSchema } from '../services/context/types.js';

// ---------------------------------------------------------------------------
// Inline per-unit spec override — matches `InlineSpecOverride` in
// `src/services/registry/resolve.ts`. Wins over registry / project defaults.
// `passthrough()` allowed on the validator object via `validatorSchema`'s union.
// ---------------------------------------------------------------------------

export const inlineSpecOverrideSchema = z
  .object({
    promptTemplate: z.string().min(1).optional(),
    metaPromptTemplate: z.string().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effortLevel: effortLevelSchema.optional(),
    effortProfile: z.record(z.unknown()).optional(),
    responseSchema: z.unknown().optional(),
    validators: z.array(validatorSchema).optional(),
    renderer: z.string().nullable().optional(),
    contentKind: z.string().nullable().optional(),
  })
  .strict();
export type InlineSpecOverrideInput = z.infer<typeof inlineSpecOverrideSchema>;

// ---------------------------------------------------------------------------
// Inline per-unit spec FLOOR — `specDefault`. Structurally identical to
// `specOverride`, precedence-wise its mirror image. See `SpecDefault` in
// `src/services/registry/resolve.ts`.
//
// ── Why this is on the wire at all ────────────────────────────────────────
// A consumer that ships a BUILT-IN prompt (the shared client's `text-to-sql`
// default, say) had exactly one slot to put it in: `specOverride`, a CEILING.
// That silently inverted the documented contract — the project registers a
// unit-type, the registry row resolves, and then the inline prompt discards it.
// The identical bug was found and fixed in-process on `/v1/route`; this field
// is the wire-level half, so consumers stop having to choose between "works
// with zero config" and "a project can take ownership".
//
// Same object shape as `specOverride` deliberately: one mental model, one
// validator, and moving a built-in from the ceiling to the floor is a key
// rename rather than a re-encode.
// ---------------------------------------------------------------------------

export const inlineSpecDefaultSchema = inlineSpecOverrideSchema;
export type InlineSpecDefaultInput = z.infer<typeof inlineSpecDefaultSchema>;

// ---------------------------------------------------------------------------
// One opaque generation unit.
// ---------------------------------------------------------------------------

export const unitSchema = z
  .object({
    unitKey: z.string().min(1),
    unitType: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    dependsOn: z.record(z.string()).optional(),
    specOverride: inlineSpecOverrideSchema.optional(),
    /**
     * Per-unit spec **FLOOR**. Consulted only AFTER the active
     * `registry_entries` row, so registering the unit-type WINS over it.
     *
     * This is where a caller's BUILT-IN belongs — a shipped default prompt,
     * effort tier or response schema that must work with zero registry config
     * while still letting a project take ownership by registering the
     * unit-type. Putting a built-in in `specOverride` instead makes the
     * registry row resolve and then be discarded, which is a bug that surfaces
     * far from its cause.
     *
     * Unlike `specOverride`, a floor does NOT suppress registry provenance:
     * `traces.prompt_version` still records which registered prompt answered.
     */
    specDefault: inlineSpecDefaultSchema
      .optional()
      .describe(
        'Per-unit spec FLOOR. Same shape as specOverride, opposite precedence: ' +
          'an active registry_entries row for this unitType BEATS it. Put a ' +
          'built-in default prompt/effort/schema here so the call works with no ' +
          'registry config while a project can still take ownership by ' +
          'registering the unit-type. Unlike specOverride, it does not suppress ' +
          'registry provenance on the trace.',
      ),
    /**
     * Per-unit **system prompt**, delivered to the model as a real
     * `{ role: 'system' }` message ahead of the rendered user prompt.
     *
     * Literal text — NOT a Handlebars template. It is passed through
     * byte-for-byte, so an embedded JSON schema / brace-heavy contract is safe.
     * (The registry-level `metaPromptTemplate` IS rendered; see
     * `src/services/generation/system-prompt.ts` for the precedence table.)
     *
     * Omit it and the request behaves exactly as it did before this field
     * existed: a single `user` message, no `system` role.
     */
    systemPrompt: z.string().min(1).optional(),
  })
  .strict();
export type UnitInput = z.infer<typeof unitSchema>;

// ---------------------------------------------------------------------------
// POST /v1/generate — body.
// ---------------------------------------------------------------------------

export const generateRequestSchema = z
  .object({
    units: z.array(unitSchema).min(1).max(100),
    effortLevel: effortLevelSchema.optional(),
    promptOverride: z.string().optional(),
    modelOverride: z.string().optional(),
    effortOverrides: z.record(z.record(z.unknown())).optional(),
    /**
     * Batch-wide system prompt. Applies to every unit that does not carry its
     * own `unit.systemPrompt`. Literal text, never rendered. Persisted on
     * `generation_requests.meta_prompt_override`.
     */
    systemPromptOverride: z.string().min(1).optional(),
    includeContext: z.array(includeContextItemSchema).optional(),
    clientRequestId: z.string().min(1).max(200).optional(),
    callbackUrl: z.string().url().optional(),
    requestedBy: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/generate/sync — body (single unit, no queue, no idempotency).
// ---------------------------------------------------------------------------

export const generateSyncRequestSchema = z
  .object({
    unit: unitSchema,
    effortLevel: effortLevelSchema.optional(),
    modelOverride: z.string().optional(),
    /** Same semantics as on `/v1/generate`; loses to `unit.systemPrompt`. */
    systemPromptOverride: z.string().min(1).optional(),
    includeContext: z.array(includeContextItemSchema).optional(),
    requestedBy: z.string().optional(),
  })
  .strict();
export type GenerateSyncRequestInput = z.infer<typeof generateSyncRequestSchema>;
