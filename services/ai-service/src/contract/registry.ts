// Zod schemas for the registry write path's request bodies and response
// shapes. The Zod definitions are the source of truth for what crosses /v1/
// — drizzle types are the source of truth for what hits the DB; the two are
// kept aligned by hand (the column set is small).

import { z } from './zod.js';

/** Mirrors the `effort_level` pgEnum so the API surface stays in lockstep. */
export const effortLevelSchema = z.enum(['quick', 'standard', 'deep', 'maximum']);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/**
 * A validator entry is either a builtin's name (string) or an inline rule the
 * service interprets generically (`{ type, ...params }`). `passthrough()`
 * keeps the extra fields — the service stores them verbatim and the runtime
 * validator interpreter reads them.
 */
export const validatorSchema = z.union([
  z.string().min(1),
  z.object({ type: z.string().min(1) }).passthrough(),
]);
export type Validator = z.infer<typeof validatorSchema>;

// ---------------------------------------------------------------------------
// PUT /v1/registry/config  — body
// ---------------------------------------------------------------------------
// Every field optional (it's a partial patch). The route hands this object
// straight to `upsertProjectConfig`; `undefined` keys are left untouched on
// update, `null` clears the column.

export const projectConfigPatchSchema = z
  .object({
    defaultModel: z.string().min(1).nullable().optional(),
    defaultEffort: effortLevelSchema.nullable().optional(),
    effortProfiles: z.record(z.string(), z.unknown()).nullable().optional(),
    contextRules: z.record(z.string(), z.unknown()).nullable().optional(),
    callbackUrl: z.string().url().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type ProjectConfigPatch = z.infer<typeof projectConfigPatchSchema>;

// ---------------------------------------------------------------------------
// POST /v1/registry/unit-types/:unitType/versions  — body
// ---------------------------------------------------------------------------

export const registryEntryCreateSchema = z
  .object({
    version: z.string().min(1),
    promptTemplate: z.string().min(1),
    metaPromptTemplate: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    defaultEffort: effortLevelSchema.nullable().optional(),
    effortProfiles: z.record(z.string(), z.unknown()).nullable().optional(),
    responseSchema: z.record(z.string(), z.unknown()).nullable().optional(),
    validators: z.array(validatorSchema).default([]),
    renderer: z.string().nullable().optional(),
    contentKind: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    activate: z.boolean().default(false),
  })
  .strict();
export type RegistryEntryCreate = z.infer<typeof registryEntryCreateSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
// These mirror the drizzle row types but are declared in Zod so the route
// handlers don't accidentally leak server-only columns. Not strictly enforced
// at runtime today — kept as a contract document.

export const projectConfigResponseSchema = z.object({
  id: z.string().uuid(),
  org: z.string(),
  project: z.string(),
  defaultModel: z.string().nullable(),
  defaultEffort: effortLevelSchema.nullable(),
  effortProfiles: z.unknown().nullable(),
  contextRules: z.unknown().nullable(),
  callbackUrl: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]).nullable(),
  updatedBy: z.string().nullable(),
});
export type ProjectConfigResponse = z.infer<typeof projectConfigResponseSchema>;

export const registryEntryResponseSchema = z.object({
  id: z.string().uuid(),
  org: z.string(),
  project: z.string(),
  unitType: z.string(),
  version: z.string(),
  isActive: z.boolean(),
  promptTemplate: z.string(),
  metaPromptTemplate: z.string().nullable(),
  model: z.string().nullable(),
  defaultEffort: effortLevelSchema.nullable(),
  effortProfiles: z.unknown().nullable(),
  responseSchema: z.unknown().nullable(),
  validators: z.unknown(),
  renderer: z.string().nullable(),
  contentKind: z.string().nullable(),
  createdBy: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.union([z.string(), z.date()]),
});
export type RegistryEntryResponse = z.infer<typeof registryEntryResponseSchema>;

export const unitTypeSummarySchema = z.object({
  unitType: z.string(),
  activeVersion: z.string().nullable(),
  versionCount: z.number().int().nonnegative(),
});
export type UnitTypeSummaryResponse = z.infer<typeof unitTypeSummarySchema>;
