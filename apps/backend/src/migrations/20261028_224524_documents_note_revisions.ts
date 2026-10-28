import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * "Publicar cambios" on a student's published note (owner ruling 2026-10-28,
 * `lib/studentNotes.ts`).
 *   · `documents.processed_body` varchar, nullable: a note's body as last sent
 *     through "Publicar"; the editor offers "Publicar cambios" when it differs.
 *   · `documents.revision_of_id` integer, nullable, UNIQUE, FK `set null`: a
 *     hidden staging row for the new text of a published note. Unique = one
 *     per note, which is what makes a concurrent second click lose. The note's
 *     delete removes its revision first (`deleteRevisionsHook`), so `set null`
 *     is only the backstop.
 * Emitted by `payload migrate:create`; no backfill.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "processed_body" varchar;
  ALTER TABLE "documents" ADD COLUMN "revision_of_id" integer;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_revision_of_id_documents_id_fk" FOREIGN KEY ("revision_of_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "documents_revision_of_idx" ON "documents" USING btree ("revision_of_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP CONSTRAINT "documents_revision_of_id_documents_id_fk";
  
  DROP INDEX "documents_revision_of_idx";
  ALTER TABLE "documents" DROP COLUMN "processed_body";
  ALTER TABLE "documents" DROP COLUMN "revision_of_id";`)
}
