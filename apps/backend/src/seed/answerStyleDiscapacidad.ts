/**
 * The first answer style (owner ruling 2026-10-28): ecosistema 7, Discapacidad,
 * gets this draft for Generales and Resonancias, as written by the owner. The
 * interviewer style stays empty. Run by `scripts/seed-answer-style.ts`.
 *
 * 🔴 Writes as a platform admin through the collection (`overrideAccess:
 * false`), so `refuseAnswerStyleChange` and `normalizeAnswerStyle` hold here
 * too. Refuses to write when the row's name is not the expected one: ids
 * differ between databases (local org 7 is an e2e fixture).
 */

import type { Payload } from 'payload'

import { normalizeAnswerStyle } from '../lib/answerStyle'

export const DISCAPACIDAD_ORG_ID = 7
export const DISCAPACIDAD_ORG_NAME = 'Discapacidad'

export const DISCAPACIDAD_ANSWER_STYLE =
  'Este ecosistema trata sobre discapacidad. Responde desde el modelo social y de derechos humanos: la discapacidad ' +
  'surge de la interacción entre las personas y las barreras del entorno (físicas, de comunicación, de información, ' +
  'actitudinales, institucionales y legales), no de un déficit individual. Cuando sea pertinente, señala qué barreras ' +
  'aparecen en lo que se pregunta o en los documentos, y qué ajustes, apoyos o cambios podrían eliminarlas. Nombra el ' +
  'capacitismo cuando lo haya, sin acusar a nadie. Usa lenguaje de derechos: "persona con discapacidad", "persona ' +
  'usuaria de silla de ruedas"; evita "padece", "sufre", "confinado", "especial", "normal" o "a pesar de su ' +
  'discapacidad", salvo al citar textualmente. No presentes a las personas con discapacidad como inspiración ni como ' +
  'objeto de lástima, y reconoce su autonomía y su experiencia. Tu tono es empático, cálido y respetuoso: valida lo ' +
  'que la persona cuenta antes de informar, y no minimices dificultades. Si la persona expresa malestar, acompáñala ' +
  'con calma y sin dar diagnósticos.'

export interface SeedAnswerStyleReport {
  mode: 'dry-run' | 'apply'
  organizationId: number
  name: string | null
  /** What the run did: wrote, would write, or nothing to do. */
  outcome: 'written' | 'would-write' | 'unchanged' | 'refused'
  reason?: string
}

export async function seedDiscapacidadAnswerStyle(
  payload: Payload,
  opts: { apply: boolean; adminEmail?: string; organizationId?: number; expectedName?: string },
): Promise<SeedAnswerStyleReport> {
  const organizationId = opts.organizationId ?? DISCAPACIDAD_ORG_ID
  const expectedName = opts.expectedName ?? DISCAPACIDAD_ORG_NAME
  const mode = opts.apply ? 'apply' : 'dry-run'
  const refuse = (name: string | null, reason: string): SeedAnswerStyleReport => ({
    mode,
    organizationId,
    name,
    outcome: 'refused',
    reason,
  })

  const style = normalizeAnswerStyle(DISCAPACIDAD_ANSWER_STYLE)
  if (!style.ok || style.value === null) return refuse(null, `draft refused: ${style.ok ? 'empty' : style.message}`)

  const org = (await payload
    .findByID({ collection: 'organizations', id: organizationId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Record<string, unknown> | null
  if (!org) return refuse(null, 'organization not found')
  const name = typeof org.name === 'string' ? org.name : null
  if (name !== expectedName) return refuse(name, `name is not "${expectedName}"`)

  if (org.answerStyleGenerales === style.value && org.answerStyleResonancias === style.value) {
    return { mode, organizationId, name, outcome: 'unchanged' }
  }
  if (!opts.apply) return { mode, organizationId, name, outcome: 'would-write' }

  const admins = await payload.find({
    collection: 'users',
    where: {
      and: [
        { isPlatformAdmin: { equals: true } },
        { isActive: { not_equals: false } },
        ...(opts.adminEmail ? [{ email: { equals: opts.adminEmail } }] : []),
      ],
    },
    sort: 'id',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const admin = admins.docs[0]
  if (!admin) return refuse(name, 'no active platform admin to write as')

  await payload.update({
    collection: 'organizations',
    id: organizationId,
    data: { answerStyleGenerales: style.value, answerStyleResonancias: style.value } as never,
    depth: 0,
    overrideAccess: false,
    user: { ...admin, collection: 'users' } as never,
  })
  return { mode, organizationId, name, outcome: 'written' }
}
