/**
 * THE TEST WORLD: two ecosistemas, three ordinary people, and the seeded admin.
 *
 * ⚠ EVERYTHING IS NAMESPACED. This suite runs against a SHARED live stack — the
 * frontend E2E suite is hitting the same containers, and the database already
 * holds real seed data. Every row created here carries an `e2e-be-` prefix plus
 * a per-run suffix, so two runs (or two suites) never collide and nothing this
 * file creates can be mistaken for seed data.
 *
 * ⚠ NOTHING IS EVER DELETED. Not the seeded admin's organization, not the demo
 * rows, not even our own — a suite that cleans up by deleting is one wrong
 * `where` clause away from wiping a colleague's stack. The rows are cheap and
 * their names say who made them.
 *
 * ── WHY THREE PEOPLE ────────────────────────────────────────────────────────
 *   · alice + bob share ONE ecosistema. They are the pair that proves
 *     same-ecosistema, cross-person draft privacy — the risk the ecosistema
 *     model introduces that a purely per-tenant scheme did not have.
 *   · carol is in the OTHER ecosistema. She is the cross-tenant probe.
 *
 * Each belongs to EXACTLY ONE organization on purpose: `Documents` and
 * `Sessions` both auto-derive the ecosistema when membership is unambiguous, so
 * a single membership keeps the fixtures honest about the common path.
 */

import { randomBytes } from 'node:crypto'

import { apiGet, apiJson, login, type Caller } from './api'
import { requireEnv } from './env'

export interface Person {
  id: number
  email: string
  password: string
  caller: Caller
}

export interface Org {
  id: number
  slug: string
  name: string
}

export interface World {
  ns: string
  admin: Caller
  adminId: number
  orgA: Org
  orgB: Org
  alice: Person
  bob: Person
  carol: Person
}

/** `e2e-be-` + time + randomness. Sortable, unique, and obviously ours. */
export function namespace(): string {
  return `e2e-be-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export async function loginAdmin(): Promise<Caller> {
  return login(requireEnv('SEED_ADMIN_EMAIL'), requireEnv('SEED_ADMIN_PASSWORD'), 'seed-admin')
}

async function createOrg(admin: Caller, ns: string, suffix: string): Promise<Org> {
  const slug = `${ns}-${suffix}`
  const res = await apiJson(admin, 'POST', '/api/organizations', {
    name: `E2E backend ${suffix.toUpperCase()} (${ns})`,
    slug,
  })
  if (res.status !== 201) {
    throw new Error(`[e2e] could not create organization ${slug}: ${res.status} ${res.text.slice(0, 400)}`)
  }
  return { id: res.body.doc.id, slug: res.body.doc.slug, name: res.body.doc.name }
}

/**
 * ⚠ Sign-up is CLOSED (`Users.access.create: isPlatformAdmin`, UX backlog #6),
 * so the platform admin creates every account — the same door a real admin
 * uses in the Payload panel.
 */
async function createPerson(admin: Caller, ns: string, handle: string): Promise<Person> {
  const email = `${ns}-${handle}@e2e.local`
  const password = `E2e-${randomBytes(12).toString('hex')}`
  const res = await apiJson(admin, 'POST', '/api/users', {
    email,
    password,
    displayName: `E2E ${handle} ${ns}`,
  })
  if (res.status !== 201) {
    throw new Error(`[e2e] could not create user ${email}: ${res.status} ${res.text.slice(0, 400)}`)
  }
  const caller = await login(email, password, handle)
  return { id: res.body.doc.id, email, password, caller }
}

async function addMembership(
  admin: Caller,
  person: Person,
  org: Org,
  role: 'member' | 'admin' | 'owner',
): Promise<void> {
  const res = await apiJson(admin, 'POST', '/api/memberships', {
    user: person.id,
    organization: org.id,
    role,
  })
  if (res.status !== 201) {
    throw new Error(
      `[e2e] could not add ${person.email} to ${org.slug}: ${res.status} ${res.text.slice(0, 400)}`,
    )
  }
}

/**
 * Build the world. Called from a `beforeAll` in each spec file, so every file is
 * self-contained and can be run alone (`vitest run e2e/audio.e2e.ts`).
 */
export async function provisionWorld(): Promise<World> {
  const ns = namespace()
  const admin = await loginAdmin()

  const me = await apiGet(admin, '/api/users/me')
  const adminId = Number(me.body?.user?.id ?? 1)

  const [orgA, orgB] = [await createOrg(admin, ns, 'a'), await createOrg(admin, ns, 'b')]

  const alice = await createPerson(admin, ns, 'alice')
  const bob = await createPerson(admin, ns, 'bob')
  const carol = await createPerson(admin, ns, 'carol')

  await addMembership(admin, alice, orgA, 'owner')
  await addMembership(admin, bob, orgA, 'member')
  await addMembership(admin, carol, orgB, 'owner')

  return { ns, admin, adminId, orgA, orgB, alice, bob, carol }
}

/**
 * A document row with `extractedText` already on it, created directly.
 *
 * ⚠ `kind: 'markdown'` is DELIBERATE. Markdown is not in `INGESTABLE_KINDS`, so
 * the extract → ingest hook never fires and the fixture is instant and
 * deterministic. Everything downstream of extraction — publish, unpublish,
 * visibility, corpora — reads `extractedText`, which is exactly what this
 * provides. The pipeline itself is exercised for real in `documents.e2e.ts` and
 * `audio.e2e.ts`; this is for the tests where the pipeline is not the subject.
 */
export async function createTextDocument(
  caller: Caller,
  name: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; publicationStatus: string; organization: unknown }> {
  const res = await apiJson(caller, 'POST', '/api/documents', {
    uploadConsentVersion: 1, // = UPLOAD_CONSENT_VERSION (src/lib/uploadConsent.ts)
    name,
    kind: 'markdown',
    mode: 'rag-retrieve',
    bodyMarkdown: text,
    extractedText: text,
    ...extra,
  })
  if (res.status !== 201) {
    throw new Error(`[e2e] could not create document "${name}": ${res.status} ${res.text.slice(0, 400)}`)
  }
  return res.body.doc
}
