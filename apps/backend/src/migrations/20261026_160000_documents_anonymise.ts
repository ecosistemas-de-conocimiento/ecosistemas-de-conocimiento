import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.anonymise` — a `documento` that must pass the anonymisation gate
 * (owner rulings 2026-10-26): every participant PDF/DOCX, and staff uploads
 * ticked "Anonimizar". See the field in `collections/Documents.ts`.
 *
 * Same SQL `payload migrate:create` emits for a `checkbox` with
 * `defaultValue: false`. ⚠ The DEFAULT fills existing rows with `false`, which
 * `Media.ts` and the graph search read with `= false` (NULL fails closed).
 * Existing rows stay ungated; nothing is backfilled.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "anonymise" boolean DEFAULT false;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "anonymise";`)
}
