/**
 * SOMETHING TO REVIEW. An Investigador account, and two documents the
 * anonymisation gate refused.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `/revision` — the hold queue — could not be seen working. Reaching it needed
 * `holds:review` (Investigador and up, `lib/permissions.ts`) and at least one
 * row at `anonymisationStatus: 'held'`, and the seed produced neither. The only
 * way to look at the screen was to write the rows into the shared dev database
 * by hand, which somebody did, and which is exactly the state this file
 * replaces: a fixture that exists in one developer's database and nowhere in
 * the repo.
 *
 * ── 🔴 WHAT A HELD ROW IS, AS A SET OF COLUMNS ───────────────────────────────
 *
 * Copied from what `lib/anonymiseDocument.ts` actually writes on a hold, not
 * invented:
 *
 *   anonymisationStatus     'held'
 *   anonymisationError      '<stage>: <reason>'   ⚠ COUNTS ONLY, never the text
 *   heldText                the gate's output AT REFUSAL — what a reviewer reads
 *   anonymisationSurvivors  OFFSETS into `heldText`, never strings
 *   anonymisationReport     per-stage counts
 *   redactedText            🔴 NULL. `corpusTextFor` reads that column, so a
 *                           held row with one set is a row the next publish
 *                           would push into the shared corpus.
 *
 * ── 🔴 AND WHAT IS NOT IN THEM ───────────────────────────────────────────────
 *
 * No name, in any column, in either fixture. The `name` on the row is neutral;
 * the gate's own `neutralTitle` overrides it in the queue anyway, but the queue
 * is not the only reader of that column. Even the raw `extractedText` here —
 * which on a real row is the unredacted original — is written to contain no
 * full name and no address, only a first name and a phone number. It is enough
 * to make a hold look like a hold, and it identifies nobody, synthetic or
 * otherwise.
 *
 * ⚠ EXTENSIONLESS IMPORTS. Reached from `seed/demo.ts`, which
 * `payload.config.ts` imports for `onInit` — see the note in `seed/admin.ts`.
 */

import crypto from 'node:crypto'

import type { Payload } from 'payload'

/**
 * Used when `SEED_INVESTIGADOR_EMAIL` is unset. An address, never a credential.
 *
 * ⚠ NOT `investigador@localhost`, and the difference is not cosmetic. Payload's
 * `email` field validation REJECTS a bare hostname — `admin@localhost`, the
 * default in `seed/admin.ts`, fails with "Please enter a valid email address"
 * and the account is never created. `.test` is the RFC 2606 reserved TLD, so
 * this address is guaranteed never to resolve to a real mailbox and still
 * passes validation.
 */
export const DEFAULT_SEED_INVESTIGADOR_EMAIL = 'investigador@ecosistemas.test'

/**
 * The two holds, written out rather than derived from the corpus.
 *
 * ⚠ DELIBERATELY INDEPENDENT OF `../corpus-generativo`. The review screen must
 * be demonstrable on a checkout with no corpus next to it — that is the whole
 * degradation promise in `seed/corpus.ts`, and a review queue that is empty
 * without an optional sibling repo would quietly break it.
 *
 * ⚠ TWO SHAPES, NOT TWO COPIES. A `verify` hold has text and survivors and is
 * the interesting case; a `structural` hold has NEITHER, because that stage
 * refuses before producing any output. A reviewer's screen has to handle both,
 * and one fixture cannot show that.
 */
interface HeldFixture {
  /** Neutral. Never a person, and never a corpus id. */
  name: string
  stage: 'structural' | 'deterministic' | 'content' | 'verify'
  reason: string
  /** The unredacted original, as a real held row keeps it. */
  extractedText: string
  /** The gate's best-effort output at refusal. `null` for a structural hold. */
  heldText: string | null
  /**
   * Substrings of `heldText` that the verify stage found still standing.
   *
   * 🔴 STORED AS OFFSETS, and the offsets are COMPUTED from `heldText` at seed
   * time rather than typed in. A hand-counted index that drifts by one
   * character points a reviewer at the wrong word, and nothing in the system
   * would notice — the column is opaque JSON. `indexOf` cannot drift.
   */
  survivorTexts: Array<{ text: string; type: 'persona' | 'lugar' | 'contacto' }>
  report: Record<string, unknown>
}

const HELD_FIXTURES: readonly HeldFixture[] = [
  {
    name: 'Testimonio retenido por verificación',
    stage: 'verify',
    reason: 'La verificación encontró 2 datos que todavía identifican a una persona.',
    extractedText:
      'Cuando llegué a Jiutepec no conocía a nadie y no sabía a quién preguntarle. ' +
      'Mi hermana Lupita me ayudó con los trámites del hospital y me acompañó a cada cita, ' +
      'aunque ella tampoco entendía bien las palabras que usaban los doctores. ' +
      'Si alguien necesita ayuda con lo mismo, me pueden marcar al 55 4821 9930 y con gusto lo oriento.',
    heldText:
      'Cuando llegué a [Domicilio A] no conocía a nadie y no sabía a quién preguntarle. ' +
      'Mi hermana Lupita me ayudó con los trámites del hospital y me acompañó a cada cita, ' +
      'aunque ella tampoco entendía bien las palabras que usaban los doctores. ' +
      'Si alguien necesita ayuda con lo mismo, me pueden marcar al 55 4821 9930 y con gusto lo oriento.',
    survivorTexts: [
      { text: 'Lupita', type: 'persona' },
      { text: '55 4821 9930', type: 'contacto' },
    ],
    report: {
      model: 'seed',
      stages: [
        { stage: 'structural', removed: [] },
        { stage: 'deterministic', removed: [{ label: 'domicilio', count: 1 }] },
        { stage: 'content', removed: [{ label: 'persona', count: 1 }] },
        { stage: 'verify', removed: [] },
      ],
      pseudonyms: 1,
      addresses: 1,
    },
  },
  {
    name: 'Testimonio retenido antes de anonimizar',
    stage: 'structural',
    reason: 'El texto llegó vacío o ilegible, así que no se intentó anonimizar.',
    extractedText: '[transcripción ilegible]',
    // 🔴 NULL, and that is the point of this second fixture. The structural
    // stage refuses BEFORE anything is redacted, so there is no reviewable
    // output at all — and `lib/anonymiseDocument.ts` clears the column rather
    // than leaving a previous run's text behind.
    heldText: null,
    survivorTexts: [],
    report: {
      model: 'seed',
      stages: [{ stage: 'structural', removed: [], note: 'El documento no tenía texto utilizable.' }],
      pseudonyms: 0,
      addresses: 0,
    },
  },
]

/**
 * THE INVESTIGADOR. A real, loggable account with a membership in the demo
 * ecosistema, because `holds:review` is held on a MEMBERSHIP and nowhere else.
 *
 * ── 🔴 NO COMMITTED PASSWORD, AND NO SKIPPING EITHER ─────────────────────────
 *
 * `seed/admin.ts` refuses to invent a password, and it is right to: it seeds the
 * PLATFORM ADMIN of an identity provider, on every environment including prod.
 * This account is neither of those things — it is fiction, and
 * `seed/env-gate.ts` has already refused to run at all outside {local, dev,
 * demo-0} by the time we get here.
 *
 * So the rule is kept without the cost: `SEED_INVESTIGADOR_PASSWORD` if you set
 * one, otherwise a RANDOM password generated here and printed once to the boot
 * log. Nothing is committed, nothing is guessable, and the demo always has an
 * account somebody can actually sign in as — which "skip loudly" would not
 * deliver, and a review screen nobody can open is the bug this file exists to
 * fix.
 *
 * ⚠ IT LOGS A PASSWORD, ON PURPOSE. Read the paragraph above before removing
 * that line: it is a freshly generated credential for a fixture account, on an
 * environment the gate has already restricted to local/dev/demo. If this seed
 * ever becomes reachable anywhere else, the gate is the thing that broke.
 *
 * Idempotent by email: an existing account is reused, never re-passworded.
 */
export async function seedInvestigador(
  payload: Payload,
  organizationId: number,
): Promise<number | null> {
  const email = process.env.SEED_INVESTIGADOR_EMAIL?.trim() || DEFAULT_SEED_INVESTIGADOR_EMAIL

  const existing = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  let userId: number
  const found = existing.docs[0] as { id: number | string } | undefined
  if (found) {
    userId = Number(found.id)
  } else {
    const supplied = process.env.SEED_INVESTIGADOR_PASSWORD?.trim()
    const password = supplied || `demo-${crypto.randomBytes(9).toString('base64url')}`
    try {
      const created = (await payload.create({
        collection: 'users',
        data: {
          email,
          password,
          displayName: 'Investigadora del ecosistema',
          isPlatformAdmin: false,
          isActive: true,
        } as never,
        overrideAccess: true,
      })) as { id: number | string }
      userId = Number(created.id)
    } catch (err) {
      payload.logger.warn(
        `[seed-review] could not create the Investigador account (${email}): ` +
          `${err instanceof Error ? err.message : String(err)}. /revision will only be ` +
          'reachable by a platform admin.',
      )
      return null
    }
    payload.logger.info(
      supplied
        ? `[seed-review] Investigador ${email} created with SEED_INVESTIGADOR_PASSWORD.`
        : `[seed-review] Investigador ${email} created. Password (generated, shown once): ${password}`,
    )
  }

  // ⚠ The membership IS the permission. `holds:review` comes from
  // `role: 'investigador'` on a membership in THIS ecosistema and nowhere else
  // — being an investigador somewhere says nothing about here.
  const membership = await payload.find({
    collection: 'memberships',
    where: { and: [{ user: { equals: userId } }, { organization: { equals: organizationId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (membership.docs.length === 0) {
    await payload.create({
      collection: 'memberships',
      data: {
        user: userId,
        organization: organizationId,
        role: 'investigador',
        isActive: true,
        personName: 'Investigadora',
      } as never,
      overrideAccess: true,
    })
  }

  return userId
}

/**
 * The held documents.
 *
 * ⚠ `kind: 'markdown'` IS A SAFETY CHOICE, not a description. Markdown is not
 * in `INGESTABLE_KINDS` (`collections/Documents.ts`), so these rows cannot reach
 * a corpus even if some future code path re-saves them — on top of the two
 * guards that already stop a held row from being re-gated. A seeded document
 * carrying a deliberately un-anonymised text is the one row in this seed where
 * belt AND braces are worth the inconsistency with the rest of the library.
 *
 * Idempotent by `name` within the ecosistema.
 */
export async function seedHeldDocuments(
  payload: Payload,
  opts: { organizationId: number; uploadedById: number },
): Promise<number> {
  let created = 0

  for (const fixture of HELD_FIXTURES) {
    const existing = await payload.count({
      collection: 'documents',
      where: {
        and: [
          { organization: { equals: opts.organizationId } },
          { name: { equals: fixture.name } },
        ],
      },
    })
    if (existing.totalDocs > 0) continue

    // 🔴 COMPUTED, NEVER TYPED IN. See `HeldFixture.survivorTexts`.
    const survivors = fixture.heldText
      ? fixture.survivorTexts
          .map(({ text, type }) => {
            const start = fixture.heldText?.indexOf(text) ?? -1
            return start < 0 ? null : { start, end: start + text.length, type }
          })
          .filter((s): s is NonNullable<typeof s> => s !== null)
      : []

    await payload.create({
      collection: 'documents',
      data: {
        organization: opts.organizationId,
        uploadedBy: opts.uploadedById,
        name: fixture.name,
        kind: 'markdown',
        contentKind: 'testimonio',
        // A hold is never published — `corpusTextFor` refuses a gated row with
        // no `redactedText`, so `published` would be a state the publish path
        // could not have produced.
        publicationStatus: 'draft',
        extractedText: fixture.extractedText,
        // ⚠ The pipeline stopped at the gate, so `ingestStatus` never left
        // `pending`. `failed` would invite a retry button; a hold is not a
        // failure. See `collections/Documents.ts`.
        ingestStatus: 'pending',
        anonymisationStatus: 'held',
        // ⚠ `<stage>: <reason>`, the exact shape `lib/holdReview.ts` splits on.
        anonymisationError: `${fixture.stage}: ${fixture.reason}`,
        anonymisationReport: fixture.report,
        heldText: fixture.heldText,
        anonymisationSurvivors: survivors.length > 0 ? survivors : null,
        // 🔴 NULL. The one column that would let a publish push this into the
        // shared corpus.
        redactedText: null,
        mode: 'rag-retrieve',
        isPinned: false,
      } as never,
      overrideAccess: true,
      // Belt to the `kind: 'markdown'` braces: no ingest is even attempted.
      context: { __skipDocsExtract: true },
    })
    created += 1
  }

  if (created > 0) {
    payload.logger.info(
      `[seed-review] ${created} held documents for /revision (verify + structural).`,
    )
  }
  return created
}
