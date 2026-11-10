import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Owner ruling R60 (2026-10-28): a gated documento keeps its actual author
 * (the uploader) visible.
 *   · `documents.authors_kept` jsonb, nullable: the reviewers' log of the
 *     author as the gate left them in `redacted_text`, as
 *     `{ name, model, at }[]`; NULL on a hold or when none was kept.
 * Emitted by `payload migrate:create`; no backfill: rows gated before R60
 * have their authors redacted, and a re-run of the gate fills it.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "authors_kept" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "authors_kept";`)
}
