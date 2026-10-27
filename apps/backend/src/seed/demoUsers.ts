/**
 * DEV ACCOUNTS FOR THE TWO NEW PROFILES (owner ruling 2026-10-27).
 *
 *   estudiante1, estudiante2   estudiante of 8 ("Semiosis práctica"), each with
 *                              one private draft note of their own
 *   investigador-semiosis      investigador of 8
 *   investigador-dengue        investigador of 6 and 7
 *
 *     pnpm --filter @edc/backend seed:demo-users      # payload run src/seed/demoUsers.cli.ts
 *
 * ── 🔴 CREDENTIALS ───────────────────────────────────────────────────────────
 *
 * No password is in git. Each one is generated (18 random bytes, base64url),
 * set on the account, and written ONCE to a credentials file —
 * `~/chamba/cide/.env.demo-users` by default, outside every repo,
 * mode 0600. NEVER to stdout or a log: the run prints emails and statuses only.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * Re-running converges and changes nothing it does not have to:
 *  · an existing account keeps its password (the file keeps its line) unless
 *    `DEMO_USERS_RESET_PASSWORDS=1`, which issues and writes new ones;
 *  · a membership is created, re-activated, or re-roled to the role above;
 *  · a sample note is created once per student, keyed by (uploader, name).
 *
 * ── 🔴 REFUSES, BEFORE WRITING ANYTHING ──────────────────────────────────────
 *  · outside local/dev/demo-0 (`seed/env-gate.ts`, the manual tier);
 *  · when ecosistema 6, 7 or 8 does not exist;
 *  · when the credentials file's directory does not exist — a password that
 *    cannot be written down is a locked account;
 *  · when the credentials file cannot be written: it is written (temp +
 *    rename) after planning and BEFORE the first account write.
 *
 * Sample work is an in-app note (`kind: 'markdown'`, `ingestStatus: 'n/a'`):
 * no pipeline, no corpus, no AI call. It stays a private draft.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Payload } from 'payload'

import type { OrgRole } from '../lib/permissions'

import { manualSeedAllowed, manualSeedGateReason } from './env-gate'

export const DEFAULT_DEMO_USERS_FILE = '~/chamba/cide/.env.demo-users'

export interface DemoUser {
  /** The env-file key stem, e.g. `ESTUDIANTE1`. */
  key: string
  email: string
  displayName: string
  memberships: Array<{ organization: number; role: OrgRole }>
  /** One private draft note, for the students. */
  sampleWork?: { name: string; body: string }
}

export const DEMO_USERS: readonly DemoUser[] = [
  {
    key: 'ESTUDIANTE1',
    email: 'estudiante1@ecosistemas.test',
    displayName: 'Estudiante 1',
    memberships: [{ organization: 8, role: 'estudiante' }],
    sampleWork: {
      name: 'Ensayo — los signos del mercado',
      body:
        '# Los signos del mercado\n\nObservé cómo los puestos usan colores y pregones para ' +
        'anunciar frescura. El pregón funciona como índice: señala algo presente sin describirlo.\n',
    },
  },
  {
    key: 'ESTUDIANTE2',
    email: 'estudiante2@ecosistemas.test',
    displayName: 'Estudiante 2',
    memberships: [{ organization: 8, role: 'estudiante' }],
    sampleWork: {
      name: 'Bitácora — semiosis en el aula',
      body:
        '# Bitácora de clase\n\nSesión 3: el pizarrón como espacio de signos compartidos. ' +
        'Las flechas que dibuja la docente se leen como relaciones causales sin que nadie lo diga.\n',
    },
  },
  {
    key: 'INVESTIGADOR_SEMIOSIS',
    email: 'investigador-semiosis@ecosistemas.test',
    displayName: 'Investigador Semiosis',
    memberships: [{ organization: 8, role: 'investigador' }],
  },
  {
    key: 'INVESTIGADOR_DENGUE',
    email: 'investigador-dengue@ecosistemas.test',
    displayName: 'Investigador Dengue',
    memberships: [
      { organization: 6, role: 'investigador' },
      { organization: 7, role: 'investigador' },
    ],
  },
]

export type DemoUserStatus = 'created' | 'existing' | 'reset'

export interface DemoUserResult {
  key: string
  email: string
  status: DemoUserStatus
  /** Set only when this run issued one. Goes to the file, never to a log. */
  password?: string
}

export const generatePassword = (): string => randomBytes(18).toString('base64url')

type Id = number | string

async function findOne(payload: Payload, collection: 'users' | 'memberships' | 'documents', where: object) {
  const res = await payload.find({ collection, where: where as never, limit: 1, depth: 0, overrideAccess: true })
  return (res.docs[0] ?? null) as unknown as ({ id: Id } & Record<string, unknown>) | null
}

/** Every ecosistema the list names must exist, or nothing is written. */
export async function missingOrganizations(payload: Payload, users: readonly DemoUser[] = DEMO_USERS): Promise<number[]> {
  const ids = [...new Set(users.flatMap((u) => u.memberships.map((m) => m.organization)))].sort((a, b) => a - b)
  const found = await payload.find({
    collection: 'organizations',
    where: { id: { in: ids } },
    limit: ids.length,
    depth: 0,
    overrideAccess: true,
  })
  const have = new Set(found.docs.map((d) => String((d as { id: Id }).id)))
  return ids.filter((id) => !have.has(String(id)))
}

/**
 * Create or converge the accounts. Returns what happened; never logs a password.
 *
 * 🔴 TWO PHASES. Every account's fate and password is decided first, with no
 * write; then `beforeWrite` gets that plan (the CLI writes the credentials
 * file there); only then is anything written. A file that cannot be written
 * throws before any account exists, so no password is ever set that nobody
 * holds. A DB failure after the file is written leaves a password line the
 * DB does not hold yet (a new account, or a reset); re-running with the same
 * flags issues a new one over it and converges.
 */
export async function seedDemoUsers(
  payload: Payload,
  opts: {
    reset?: boolean
    password?: () => string
    users?: readonly DemoUser[]
    beforeWrite?: (planned: readonly DemoUserResult[]) => void | Promise<void>
  } = {},
): Promise<DemoUserResult[]> {
  const issue = opts.password ?? generatePassword
  const plan: Array<{ spec: DemoUser; found: ({ id: Id } & Record<string, unknown>) | null; result: DemoUserResult }> = []

  for (const spec of opts.users ?? DEMO_USERS) {
    const found = await findOne(payload, 'users', { email: { equals: spec.email } })
    const status: DemoUserStatus = !found ? 'created' : opts.reset ? 'reset' : 'existing'
    const result: DemoUserResult = { key: spec.key, email: spec.email, status }
    if (status !== 'existing') result.password = issue()
    plan.push({ spec, found, result })
  }
  const results = plan.map((p) => p.result)
  await opts.beforeWrite?.(results)

  for (const { spec, found, result } of plan) {
    let user = found
    if (!user) {
      user = (await payload.create({
        collection: 'users',
        data: { email: spec.email, password: result.password, displayName: spec.displayName, isActive: true } as never,
        overrideAccess: true,
      })) as unknown as { id: Id } & Record<string, unknown>
    } else if (result.status === 'reset') {
      await payload.update({
        collection: 'users',
        id: user.id,
        data: { password: result.password, isActive: true } as never,
        overrideAccess: true,
      })
    }

    for (const { organization, role } of spec.memberships) {
      const row = await findOne(payload, 'memberships', {
        and: [{ user: { equals: user.id } }, { organization: { equals: organization } }],
      })
      if (!row) {
        await payload.create({
          collection: 'memberships',
          data: { user: user.id, organization, role, isActive: true, personName: spec.displayName } as never,
          overrideAccess: true,
        })
      } else if (row.role !== role || row.isActive !== true) {
        await payload.update({
          collection: 'memberships',
          id: row.id,
          data: { role, isActive: true } as never,
          overrideAccess: true,
        })
      }
    }

    if (spec.sampleWork) {
      const organization = spec.memberships[0]!.organization
      const existing = await findOne(payload, 'documents', {
        and: [{ uploadedBy: { equals: user.id } }, { name: { equals: spec.sampleWork.name } }],
      })
      if (!existing) {
        await payload.create({
          collection: 'documents',
          data: {
            name: spec.sampleWork.name,
            organization,
            uploadedBy: user.id,
            kind: 'markdown',
            contentKind: 'documento',
            bodyMarkdown: spec.sampleWork.body,
            publicationStatus: 'draft',
            ingestStatus: 'n/a',
            anonymise: false,
          } as never,
          overrideAccess: true,
          context: { __skipDocsExtract: true },
        })
      }
    }
  }
  return results
}

/**
 * The credentials file after this run: existing lines kept, this run's
 * passwords written over their keys. Pure, so it is testable without a disk.
 */
export function renderCredentials(existing: string, results: readonly DemoUserResult[], now = new Date()): string {
  const lines = existing.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
  const values = new Map<string, string>()
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1))
  }
  for (const r of results) {
    values.set(`DEMO_${r.key}_EMAIL`, r.email)
    if (r.password) values.set(`DEMO_${r.key}_PASSWORD`, r.password)
  }
  const body = [...values.entries()].map(([k, v]) => `${k}=${v}`).join('\n')
  return `# EDC dev demo users — written by seed/demoUsers.ts, ${now.toISOString()}. Never commit.\n${body}\n`
}

/** Temp file (0600, created exclusively) + rename: the file is whole or untouched. */
export function writeCredentials(file: string, results: readonly DemoUserResult[]): void {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, renderCredentials(existing, results), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Why the CLI must not run, or null. Checked before anything is written. */
export async function demoUsersRefusal(
  payload: Payload,
  file: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!manualSeedAllowed(env)) return manualSeedGateReason(env)
  if (!existsSync(path.dirname(file))) return `the credentials directory ${path.dirname(file)} does not exist`
  const missing = await missingOrganizations(payload)
  if (missing.length > 0) return `ecosistema(s) ${missing.join(', ')} do not exist`
  return null
}

export async function runDemoUsersCli(): Promise<void> {
  const { getPayload } = await import('payload')
  const { default: config } = await import('@payload-config')
  const payload = await getPayload({ config })
  const file = process.env.DEMO_USERS_FILE?.trim() || DEFAULT_DEMO_USERS_FILE
  const refusal = await demoUsersRefusal(payload, file)
  if (refusal) {
    payload.logger.error(`[seed-demo-users] refusing: ${refusal}. Nothing was written.`)
    process.exit(1)
  }
  const reset = process.env.DEMO_USERS_RESET_PASSWORDS === '1'
  // 🔴 The file is written before the first account (see `seedDemoUsers`).
  const results = await seedDemoUsers(payload, { reset, beforeWrite: (planned) => writeCredentials(file, planned) })
  // 🔴 Emails and statuses only. The passwords are in `file`.
  for (const r of results) payload.logger.info(`[seed-demo-users] ${r.email}: ${r.status}`)
  payload.logger.info(`[seed-demo-users] credentials for new/reset accounts written to ${file} (0600).`)
}
