import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.held_text_hash` varchar (nullable) — SHA-256 of the text a gate
 * hold is about (`lib/gatedTextHash.ts`). `POST /api/documents/:id/retry`
 * refuses a held row while its text still matches (audit 2026-10-28 item 2).
 * No backfill, on purpose: a hold without a hash is refused (fail closed).
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "held_text_hash" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "held_text_hash";`)
}
