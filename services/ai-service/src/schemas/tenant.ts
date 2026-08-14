// Zod schemas for the tenant-provisioning surface:
//   PUT  /v1/budget/:org        (admin)
//   POST /v1/tenant/provision   (admin)
//   GET  /v1/tenant/readiness   (any authenticated role)
//
// NOTE THE ABSENCE of `org` / `project` in every body below. ai-service derives
// the tenant from the caller's API key (`req.auth`) and never from the request
// payload — that invariant is what keeps one consumer from writing into
// another's scope. `PUT /v1/budget/:org` carries an org in the PATH purely for
// symmetry with the existing GET; the handler rejects any value that isn't the
// caller's own.

import { z } from 'zod';

import { registryEntryCreateSchema } from './registry.js';

export const setBudgetRequestSchema = z
  .object({
    /** Hard monthly cap in USD. 0 is legal — it means "configured, but frozen". */
    limitUsd: z.number().finite().nonnegative(),
    /**
     * Top the live `remaining` counter back up to the new cap. Default false:
     * lowering a cap must not silently hand the org free spend, and raising one
     * shouldn't retroactively refund what was already used.
     */
    refill: z.boolean().default(false),
  })
  .strict();
export type SetBudgetRequestInput = z.infer<typeof setBudgetRequestSchema>;

/** One registry entry to register while provisioning. */
export const provisionUnitTypeSchema = registryEntryCreateSchema
  .extend({
    unitType: z.string().min(1),
    /** Provisioning activates by default — an inactive entry provisions nothing. */
    activate: z.boolean().default(true),
  })
  .strict();

export const provisionTenantRequestSchema = z
  .object({
    budget: setBudgetRequestSchema.optional(),
    unitTypes: z.array(provisionUnitTypeSchema).max(50).optional(),
  })
  .strict();
export type ProvisionTenantRequestInput = z.infer<typeof provisionTenantRequestSchema>;
