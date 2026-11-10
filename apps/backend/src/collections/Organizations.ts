import {
  APIError,
  ValidationError,
  type Access,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type FieldAccess,
  type PayloadRequest,
} from 'payload'

import {
  ANSWER_STYLE_FIELD_NAMES,
  ANSWER_STYLE_LOCKED_MESSAGE,
  ANSWER_STYLE_MAX_LENGTH,
  normalizeAnswerStyle,
} from '../lib/answerStyle'
import { invalidateFeatures, lockedFeatureChange, lockedFeatureMessage, parseFeaturesPatch, resolveFeatures } from '../lib/features'
import { organizationIdsForUserWithPermission, PERMISSIONS, roleInOrganization } from '../lib/permissions'

import { isActiveUser, isPlatformAdmin, isPlatformAdminUser, principalId, withinMyOrganizations } from '../access'

import { normalizedSlug } from './hooks/compoundUnique'

/**
 * 🔴 WHO UPDATES AN ECOSISTEMA (name, description, `features` and the
 * anonymisation switches in it — /ajustes): `organization:manage` there, i.e.
 * the responsable (`owner`), or a platform admin (owner decision 2026-11-10,
 * wave 4: the investigador no longer saves Ajustes). Asked by permission, the
 * same question `/api/funciones` and the ecosistema anonimización endpoints ask.
 * Fails closed: no user, an inactive one, or no such membership = nothing.
 */
export const manageableOrganizations: Access = async ({ req }) => {
  if (isPlatformAdminUser(req.user)) return true
  const id = principalId(req)
  if (id === null || !isActiveUser(req.user)) return false
  const ids = await organizationIdsForUserWithPermission(req.payload, id, PERMISSIONS.organizationManage)
  return ids.length === 0 ? false : { id: { in: ids } }
}

/**
 * 🔴 THE SLUG AND THE ON/OFF SWITCH ARE THE OWNER'S. A new slug breaks every
 * token in flight and switching the ecosistema off locks out everyone in it.
 * Owner or platform admin only (today the same people as
 * {@link manageableOrganizations}; kept by role so a future grant of
 * `organization:manage` does not hand them the slug). Payload strips a refused
 * field from the write, so an attempt is ignored rather than rejected — the
 * same contract as `platformAdminFieldAccess`.
 */
export const ownerOnlyField: FieldAccess = async ({ req, id }) => {
  if (isPlatformAdminUser(req.user)) return true
  const userId = (req.user as { id?: number | string } | null | undefined)?.id
  if (userId === undefined || userId === null || id === undefined || id === null) return false
  return (await roleInOrganization(req.payload, userId, id)) === 'owner'
}

/**
 * 🔴 THE ADMIN-ONLY SWITCHES ARE THE PLATFORM ADMIN'S (owner ruling Q16 A):
 * `keepPublicFigures`, `studentTestimonios` (`PLATFORM_ADMIN_ONLY_FEATURES`).
 * Every write to an organization — REST, the Payload panel, bulk updates,
 * `/api/funciones`, server code — passes through this hook, so this is the one
 * place the rule lives. Other switches in the same write stay the owner's.
 * (No GraphQL route is mounted: `app/(payload)/api` has only `[...slug]`.)
 *
 * ⚠ THE STATUS DEPENDS ON THE PATH. A single write (`PATCH /api/organizations/:id`,
 * the local API by id, `/api/funciones`) answers 403. A REST BULK update
 * (`PATCH /api/organizations?where=…`) answers 400: Payload's bulk handler
 * collects each row's error and replies 400 whatever that row's status was.
 * The row is refused either way, and the message names the switch
 * (pinned in `endpoints/funciones.pg.test.ts`).
 *
 * ⚠ NOT A FIELD-ACCESS RULE: `features` is a single json field, and field
 * access can only strip the whole field, which would block every other switch.
 * ⚠ REJECTED, NOT STRIPPED: a silently ignored change would read as "saved".
 * ⚠ FAILS CLOSED: no user (even with access overridden) = not an admin. A
 * server-side job that must flip it has to run as a platform admin.
 */
export const refuseLockedFeatureChange: CollectionBeforeChangeHook = ({ data, originalDoc, operation, req }) => {
  if (!data || data.features === undefined) return data
  const before = operation === 'update' ? (originalDoc as { features?: unknown } | undefined)?.features : undefined
  const locked = lockedFeatureChange(before, data.features)
  if (locked && !isPlatformAdminUser(req?.user)) {
    throw new APIError(lockedFeatureMessage(locked), 403, undefined, true)
  }
  return data
}

/**
 * 🔴 THE ANSWER STYLE IS THE PLATFORM ADMIN'S (owner ruling 2026-10-28):
 * `answerStyleGenerales`, `answerStyleResonancias`, `answerStyleInterviewer`.
 * The text lands in the chat's system prompt, so the responsable and the
 * investigador see it read-only. Same contract as `refuseLockedFeatureChange`:
 * every write path, a 403 on a single write (400 on a REST bulk update),
 * rejected rather than stripped, and FAILS CLOSED with no user. Sending the
 * stored value unchanged is not a change (`beforeValidate` has normalised it).
 */
export const refuseAnswerStyleChange: CollectionBeforeChangeHook = ({ data, originalDoc, operation, req }) => {
  if (!data || isPlatformAdminUser(req?.user)) return data
  const before = (operation === 'update' ? originalDoc : undefined) as Record<string, unknown> | undefined
  for (const field of ANSWER_STYLE_FIELD_NAMES) {
    if (data[field] === undefined) continue
    const next = normalizeAnswerStyle(data[field])
    const prev = normalizeAnswerStyle(before?.[field])
    const nextValue = next.ok ? next.value : data[field]
    const prevValue = prev.ok ? prev.value : before?.[field]
    if (nextValue !== prevValue) throw new APIError(ANSWER_STYLE_LOCKED_MESSAGE, 403, undefined, true)
  }
  return data
}

/**
 * 🔴 `studentTestimonios` GOING OFF WITHDRAWS EVERY TESTIMONIO CONSENT IN THAT
 * ECOSISTEMA (owner ruling Q20). A consent was given under the
 * wording shown while the switch was on; after an off→on cycle the student
 * must give it again. Runs on every write path (it is a collection hook) with
 * the request's `req`, so it shares the update's transaction: the switch and
 * the consents move together or not at all. `share_activity` is left alone.
 */
export const clearTestimonioConsentWhenOff: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update') return doc
  const was = resolveFeatures((previousDoc as { features?: unknown } | undefined)?.features).studentTestimonios
  const now = resolveFeatures((doc as { features?: unknown }).features).studentTestimonios
  const id = (doc as { id?: number | string }).id
  if (!was || now || id == null) return doc
  await req.payload.update({
    collection: 'studentProfiles' as never,
    where: { organization: { equals: id } },
    data: { shareTestimoniosAt: null, shareTestimoniosVersion: null } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return doc
}

/**
 * 🔴 AN ANONYMISATION SWITCH CHANGE IS AUDITED (audit 2026-11-07, item B):
 * one `anonymisation-setting-changes` row per changed key of
 * `ANONYMISE_SWITCHES` (`keepPublicFigures` included since 2026-11-10, audit
 * P-04/I-13), in the update's transaction (`req`), on every write path. Raw
 * stored values: `null` = never set (off by default). A failed audit write
 * fails the update.
 */
export const auditAnonymisationSwitches: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update') return doc
  const id = (doc as { id?: number | string }).id
  if (id == null) return doc
  const raw = (f: unknown, k: string): boolean | null => {
    const v = f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, unknown>)[k] : undefined
    return typeof v === 'boolean' ? v : null
  }
  const before = (previousDoc as { features?: unknown } | undefined)?.features
  const after = (doc as { features?: unknown }).features
  const { ANONYMISE_SWITCHES } = await import('@/lib/publicFigures')
  const changes = ANONYMISE_SWITCHES.filter((k) => raw(before, k) !== raw(after, k)).map((key) => ({
    organization: id,
    actor: (req.user as { id?: number | string } | null | undefined)?.id ?? null,
    scope: 'ecosistema' as const,
    key,
    before: raw(before, key),
    after: raw(after, key),
  }))
  if (changes.length === 0) return doc
  const { recordSettingChanges } = await import('./AnonymisationSettingChanges')
  await recordSettingChanges(req.payload as never, changes, req)
  // 🔴 ON→OFF re-gates what kept a name under the default (coordinator
  // decisions 2026-11-07 and 2026-11-10, `regateInheritors`); OFF→ON
  // reprocesses nothing. Detached, after commit.
  const resolvedBefore = resolveFeatures(before)
  const resolvedAfter = resolveFeatures(after)
  const turnedOff = ANONYMISE_SWITCHES.filter((k) => resolvedBefore[k] && !resolvedAfter[k])
  if (turnedOff.length > 0) {
    const { startEcosystemRegate } = await import('@/lib/anonymisationControls')
    startEcosystemRegate(req.payload, id, turnedOff)
  }
  return doc
}

/**
 * ⚠ THE TENANT. Everything in this product hangs off an organization: its
 * people (`memberships`), its structure (`teams` → `projects`), and — through
 * the session that produced them — its documents, messages and ratings.
 *
 * THE SLUG IS THE CONTRACT. It is what a client sends as the `audience` of a
 * token request, what keys the `projects` map in a resolved principal, and what
 * `aud` carries on every issued token. Renaming an organization is free;
 * changing its slug invalidates every token already in flight and every stored
 * reference to it. Treat it as permanent once anyone has logged in.
 *
 * ⚠ THE TOKEN AUDIENCE IS THE TENANT. There is one product and many tenants,
 * so the audience is the tenant, not a `project`. See the
 * header of `lib/permissions.ts` for the full reasoning.
 */
/**
 * `GET /api/organizations/:id/anonimizacion` and `POST …/anonimizacion/reintentar`
 * (`lib/anonymisationControls.ts`): what the ecosistema re-gate has left to do,
 * and a retry. Lazy, like the hooks above: that module loads the documents side.
 */
const anonimizacionEndpoints: NonNullable<CollectionConfig['endpoints']> = (['get', 'post'] as const).map((method) => ({
  path: method === 'get' ? '/:id/anonimizacion' : '/:id/anonimizacion/reintentar',
  method,
  handler: async (req: PayloadRequest) => {
    const { organizationAnonimizacionEndpoints } = await import('@/lib/anonymisationControls')
    const endpoint = organizationAnonimizacionEndpoints().find((e) => e.method === method)
    return endpoint!.handler(req)
  },
}))

export const Organizations: CollectionConfig = {
  slug: 'organizations',
  endpoints: anonimizacionEndpoints,
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'slug', 'isActive', 'updatedAt'],
    group: 'Tenancy',
  },
  access: {
    // You see the organizations you belong to, and no others. A boolean here
    // would make the whole customer list browsable by any account.
    read: withinMyOrganizations('id'),
    // Creating a tenant is an installation-level act, not a self-service one.
    create: isPlatformAdmin,
    // `organization:manage` (the responsable) or a platform admin
    // (`manageableOrganizations`). The slug and `isActive` stay the owner's
    // (`ownerOnlyField`).
    update: manageableOrganizations,
    // Deleting a tenant takes its people, documents and history with it.
    delete: isPlatformAdmin,
  },
  hooks: {
    beforeValidate: [
      ({ data }) => {
        const next = { ...(data ?? {}) } as Record<string, unknown>
        const slug = normalizedSlug(next.slug)
        if (slug) next.slug = slug
        // `features` holds known boolean keys only (`lib/features.ts`).
        if (next.features !== undefined && next.features !== null) {
          const parsed = parseFeaturesPatch(next.features)
          if (typeof parsed === 'string') {
            throw new ValidationError({ errors: [{ path: 'features', message: parsed }] })
          }
          next.features = parsed
        }
        // The answer style (`lib/answerStyle.ts`): cleaned, blank → null,
        // refused (400) when it would talk to the prompt's rules.
        for (const field of ANSWER_STYLE_FIELD_NAMES) {
          if (next[field] === undefined) continue
          const style = normalizeAnswerStyle(next[field])
          if (!style.ok) throw new ValidationError({ errors: [{ path: field, message: style.message }] })
          next[field] = style.value
        }
        return next
      },
    ],
    beforeChange: [refuseLockedFeatureChange, refuseAnswerStyleChange],
    afterChange: [
      ({ doc }) => {
        const id = (doc as { id?: number | string }).id
        if (id != null) invalidateFeatures(id)
        return doc
      },
      clearTestimonioConsentWhenOff,
      auditAnonymisationSwitches,
      // Each ecosistema is its own ai-service org; give it a budget on create
      // (`lib/provisionEcosystem.ts`). Not awaited: the create already
      // succeeded, and a slow ai-service must not hold the admin request.
      ({ doc, operation, req }) => {
        if (operation !== 'create') return doc
        const id = (doc as { id?: number | string }).id
        if (id == null) return doc
        void import('@/lib/provisionEcosystem').then(({ provisionEcosystemOrg }) =>
          provisionEcosystemOrg(id, { logger: req.payload.logger }),
        )
        return doc
      },
    ],
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: { update: ownerOnlyField },
      admin: {
        description:
          'Stable URL-safe key, lowercased. Used as the token audience — changing it breaks every issued token.',
      },
    },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Clean-text summary injected into the chat context.' },
    },
    {
      // An inactive organization grants nothing: the resolver skips it
      // entirely, so switching this off revokes access for every one of its
      // members at once without touching a single membership row.
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      access: { update: ownerOnlyField },
      label: 'Organization active',
      admin: { position: 'sidebar' },
    },
    {
      // Per-ecosistema switches (owner ruling 2026-10-27). NULL / missing key =
      // the default in `lib/features.ts`, which is today's behaviour. Written by
      // the responsable (owner) or a platform admin (2026-11-10), via
      // `/api/funciones`; `keepPublicFigures` and `studentTestimonios` by a
      // platform admin only (`refuseLockedFeatureChange`).
      name: 'features',
      type: 'json',
    },
    // The answer style, one text per prompt (owner ruling 2026-10-28;
    // `lib/answerStyle.ts`). NULL = no style: the prompt is unchanged.
    // Platform admin only (`refuseAnswerStyleChange`).
    ...ANSWER_STYLE_FIELD_NAMES.map((name) => ({
      name,
      type: 'textarea' as const,
      maxLength: ANSWER_STYLE_MAX_LENGTH,
    })),
  ],
}
