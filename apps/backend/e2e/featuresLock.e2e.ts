/**
 * 🔴 `keepPublicFigures` IS THE PLATFORM ADMIN'S (owner ruling Q16 A), over
 * HTTP on the live stack: the responsable of an ecosistema is refused on both
 * write paths (`PATCH /api/organizations/:id`, `PATCH /api/funciones`), still
 * flips every other switch, and the platform admin flips it.
 *
 * The same rule is pinned on a real Payload + Postgres, without the stack, in
 * `src/endpoints/funciones.pg.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, apiJson } from './support/api'
import { stackDown } from './support/stack'
import { provisionWorld, type World } from './support/world'

const LOCKED = 'Solo administración de la plataforma puede cambiar «Conservar nombres de figuras públicas».'

describe.skipIf(stackDown)('keepPublicFigures: platform admin only', () => {
  let world: World
  const stored = async () =>
    (await apiGet(world.admin, `/api/funciones?organization=${world.orgA.id}`)).body?.features as Record<string, boolean>

  beforeAll(async () => {
    world = await provisionWorld()
  })

  it('the responsable is refused on PATCH /api/organizations/:id, and the value stays', async () => {
    const res = await apiJson(world.alice.caller, 'PATCH', `/api/organizations/${world.orgA.id}`, {
      features: { keepPublicFigures: true },
    })
    expect(res.status).toBe(403)
    expect(res.body?.errors?.[0]?.message).toBe(LOCKED)
    expect((await stored()).keepPublicFigures).toBe(false)
  })

  it('the responsable is refused on PATCH /api/funciones, and the value stays', async () => {
    const res = await apiJson(world.alice.caller, 'PATCH', '/api/funciones', {
      organization: world.orgA.id,
      features: { keepPublicFigures: true },
    })
    expect(res.status).toBe(403)
    expect(res.body?.errors?.[0]?.message).toBe(LOCKED)
    expect((await stored()).keepPublicFigures).toBe(false)
  })

  it('the responsable still flips another switch', async () => {
    const res = await apiJson(world.alice.caller, 'PATCH', '/api/funciones', {
      organization: world.orgA.id,
      features: { graph: false },
    })
    expect(res.status).toBe(200)
    expect((await stored()).graph).toBe(false)
  })

  it('the platform admin flips it on both paths', async () => {
    const viaFunciones = await apiJson(world.admin, 'PATCH', '/api/funciones', {
      organization: world.orgA.id,
      features: { keepPublicFigures: true },
    })
    expect(viaFunciones.status).toBe(200)
    expect((await stored()).keepPublicFigures).toBe(true)
    const viaRest = await apiJson(world.admin, 'PATCH', `/api/organizations/${world.orgA.id}`, {
      features: { keepPublicFigures: false },
    })
    expect(viaRest.status).toBe(200)
    expect((await stored()).keepPublicFigures).toBe(false)
  })
})
