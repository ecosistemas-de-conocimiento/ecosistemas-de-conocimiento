/**
 * 🔴 `20261110_181621_consent_held_reviews_keep` AND THE CONSENT HOLD'S ONLY
 * WRITER — AGAINST A REAL POSTGRES.
 *
 *   · up/down/up: `documents.consent_held` (NOT NULL, default false) and the
 *     `anonymisation_reviews.document_id` FK `set null` + snapshot, and back;
 *   · `holdForConsent` (what `scripts/hold-for-consent.ts` runs): dry run
 *     writes nothing, `apply` holds exactly the selection, ids of another
 *     ecosistema are refused, a whole ecosistema is not a selection.
 *
 * Harness: `lib/testing/realPostgres` (migrations only, no Payload boot).
 */

import { sql } from '@payloadcms/db-postgres'
import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { migrations } from '../migrations'
import { holdForConsent, isConsentHeld } from './consentHold'
import { dockerOk, rowsOf, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
const run = (s: string) => pg.db.execute(sql.raw(s))
const NAME = '20261110_181621_consent_held_reviews_keep'
const migration = () => migrations.find((m) => m.name === NAME)!
const args = () => ({ db: pg.db, payload: {}, req: {} }) as unknown as MigrateUpArgs & MigrateDownArgs

const column = async () =>
  (
    await rowsOf(
      pg.db,
      sql`SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'documents' AND column_name = 'consent_held'`,
    )
  )[0]
const reviewFk = async () =>
  (
    await rowsOf(
      pg.db,
      sql`SELECT confdeltype FROM pg_constraint WHERE conname = 'anonymisation_reviews_document_id_documents_id_fk'`,
    )
  )[0]?.confdeltype

describe.skipIf(!dockerOk)('consent hold: migration and CLI', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-hold-${process.pid}`, 'consent_hold')
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  beforeEach(async () => {
    await run(`
      TRUNCATE anonymisation_reviews, documents, media, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'subio@example.invalid', false), (2, 'otra@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (8, 'Ocho', 'ocho'), (9, 'Nueve', 'nueve');
      INSERT INTO media (id, uploaded_by_id, filename) VALUES (70, 1, 'a.pdf'), (71, 1, 'b.pdf');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, publication_status, media_file_id) VALUES
        (11, 8, 1, 'taller-1.pdf', 'pdf', 'draft', 70),
        (12, 8, 1, 'taller-2.pdf', 'pdf', 'draft', 71),
        (13, 8, 2, 'nota.md', 'markdown', 'draft', NULL),
        (14, 8, 1, 'publicado.pdf', 'pdf', 'published', NULL),
        (21, 9, 1, 'otro-eco.pdf', 'pdf', 'draft', NULL);
    `)
  }, 60_000)

  it('up: consent_held is NOT NULL DEFAULT false, existing rows false; the review FK is SET NULL', async () => {
    expect(await column()).toMatchObject({ is_nullable: 'NO', column_default: 'false' })
    const held = await rowsOf(pg.db, sql`SELECT count(*)::int AS n FROM documents WHERE consent_held`)
    expect(held[0]?.n).toBe(0)
    expect(await reviewFk()).toBe('n')
  })

  it('a document delete keeps its review rows, with the snapshot (up/down/up round trip)', async () => {
    await run(`
      INSERT INTO anonymisation_reviews (id, document_id, organization_id, reviewer_id, decision)
        VALUES (90, 11, 8, 2, 'approved');
    `)
    // down: a review whose document is gone is deleted (it cannot be NOT NULL);
    // the FK is back to cascade.
    await run(`UPDATE anonymisation_reviews SET document_id_snapshot = NULL`)
    await migration().down(args())
    expect(await column()).toBeUndefined()
    expect(await reviewFk()).toBe('c')
    await migration().up(args())
    // up: the snapshot is backfilled from the FK.
    expect(await rowsOf(pg.db, sql`SELECT document_id_snapshot::int AS s FROM anonymisation_reviews WHERE id = 90`)).toEqual([
      { s: 11 },
    ])
    expect(await reviewFk()).toBe('n')

    await run(`DELETE FROM documents WHERE id = 11`)
    expect(
      await rowsOf(pg.db, sql`SELECT document_id, document_id_snapshot::int AS s FROM anonymisation_reviews WHERE id = 90`),
    ).toEqual([{ document_id: null, s: 11 }])

    // down with an orphaned review: it goes, and the round trip completes.
    await migration().down(args())
    expect(await rowsOf(pg.db, sql`SELECT id FROM anonymisation_reviews`)).toEqual([])
    await migration().up(args())
    expect(await column()).toMatchObject({ is_nullable: 'NO', column_default: 'false' })
  })

  it('dry run lists ids and writes nothing', async () => {
    const report = await holdForConsent(pg.db, { organizationId: 8, publicationStatus: 'draft', hasFile: true }, { apply: false })
    expect(report.rows.map((r) => r.id)).toEqual([11, 12])
    expect(report.held).toBe(0)
    expect(await rowsOf(pg.db, sql`SELECT id FROM documents WHERE consent_held`)).toEqual([])
  })

  it('apply holds exactly the filtered rows, once', async () => {
    const report = await holdForConsent(pg.db, { organizationId: 8, uploadedBy: 1, idFrom: 11, idTo: 14 }, { apply: true })
    expect(report.rows.map((r) => r.id)).toEqual([11, 12, 14])
    expect(report.held).toBe(3)
    expect(report.notDraft).toEqual([14])
    expect(await rowsOf(pg.db, sql`SELECT id FROM documents WHERE consent_held ORDER BY id`)).toEqual([
      { id: 11 },
      { id: 12 },
      { id: 14 },
    ])
    const again = await holdForConsent(pg.db, { organizationId: 8, uploadedBy: 1, idFrom: 11, idTo: 14 }, { apply: true })
    expect(again.held).toBe(0)
    expect(again.rows.every((r) => r.alreadyHeld)).toBe(true)
  })

  it('explicit ids: another ecosistema\'s or a missing id is refused, not held', async () => {
    const report = await holdForConsent(pg.db, { organizationId: 8, ids: [13, 21, 999] }, { apply: true })
    expect(report.rows.map((r) => r.id)).toEqual([13])
    expect(report.refused).toEqual(['21', '999'])
    expect(await rowsOf(pg.db, sql`SELECT id FROM documents WHERE consent_held`)).toEqual([{ id: 13 }])
  })

  it('a whole ecosistema with no filter is refused', async () => {
    await expect(holdForConsent(pg.db, { organizationId: 8 }, { apply: true })).rejects.toThrow(/not a selection/)
    expect(await rowsOf(pg.db, sql`SELECT id FROM documents WHERE consent_held`)).toEqual([])
  })
})

describe('isConsentHeld', () => {
  it('only true holds', () => {
    expect(isConsentHeld({ consentHeld: true })).toBe(true)
    for (const v of [false, null, undefined, 'true', 1]) expect(isConsentHeld({ consentHeld: v })).toBe(false)
    expect(isConsentHeld({})).toBe(false)
    expect(isConsentHeld(null)).toBe(false)
  })
})
