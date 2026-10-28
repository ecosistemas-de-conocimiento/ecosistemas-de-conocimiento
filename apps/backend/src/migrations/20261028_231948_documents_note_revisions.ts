import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * "Publicar cambios" on a student's published note (owner ruling 2026-10-28,
 * `lib/studentNotes.ts`).
 *   · `documents.processed_body` varchar, nullable: a note's body as last sent
 *     through "Publicar"; the editor offers "Publicar cambios" when it differs.
 *   · `documents.revision_of_id` integer, nullable, UNIQUE: a hidden staging
 *     row for the new text of a published note. Unique = one per note, which
 *     is what makes a concurrent second click lose.
 *   · `documents.reindex_ingest_id` varchar, nullable: the shared-corpus
 *     re-index of a promoted revision; its callback re-checks the note is
 *     still published (`callback/route.ts` `dispatchNoteReindex`).
 * 🔴 Hand-written: the FK is `ON DELETE cascade` (generated: `set null`). The
 * note's delete removes its revision first (`deleteRevisionsHook`, which also
 * retires its draft copy); cascade is the backstop, so a revision can never
 * outlive its note as a stray, visible draft. The `.json` still says `set null`.
 * Backfill: {@link BACKFILL_PROCESSED_BODY}.
 */

/**
 * 🔴 BACKFILL: an in-app note already published (the Semiosis seed trabajos
 * among them) gets `processed_body = body_markdown`. Its body IS what was
 * published: an edit made after publishing was never processed before this
 * feature, so treating today's body as published is the only reading
 * available, and without a value the editor never offers "Publicar cambios"
 * (`apps/web/src/lib/publication.ts` `noteEdited` reads null as "not edited").
 * In-app note = `kind = 'markdown'` with no stored file.
 */
export const BACKFILL_PROCESSED_BODY = sql`
  UPDATE "documents" SET "processed_body" = "body_markdown"
   WHERE "kind" = 'markdown' AND "media_file_id" IS NULL
     AND "publication_status" = 'published'
     AND "processed_body" IS NULL AND "body_markdown" IS NOT NULL;`

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "processed_body" varchar;
  ALTER TABLE "documents" ADD COLUMN "revision_of_id" integer;
  ALTER TABLE "documents" ADD COLUMN "reindex_ingest_id" varchar;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_revision_of_id_documents_id_fk" FOREIGN KEY ("revision_of_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "documents_revision_of_idx" ON "documents" USING btree ("revision_of_id");`)
  await db.execute(BACKFILL_PROCESSED_BODY)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP CONSTRAINT "documents_revision_of_id_documents_id_fk";
  
  DROP INDEX "documents_revision_of_idx";
  ALTER TABLE "documents" DROP COLUMN "processed_body";
  ALTER TABLE "documents" DROP COLUMN "revision_of_id";
  ALTER TABLE "documents" DROP COLUMN "reindex_ingest_id";`)
}
