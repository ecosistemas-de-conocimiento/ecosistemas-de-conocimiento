import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.uploaded_in_session_id`: the conversation a document was uploaded
 * in. Ruled by Rodrigo on 2026-10-17. The field and its reasoning are in
 * `collections/Documents.ts` (`uploadedInSession`); the rule that reads it is
 * in `lib/conversationUploads.ts`.
 *
 * ✅ THE SQL IS FULLY GENERATED; ONLY THIS COMMENT IS HAND-WRITTEN.
 * `payload migrate:create`, diffed against the baseline snapshot; the only
 * change in the `.json` is this column, its foreign key and its index. No
 * hand-written SQL, so a regeneration has nothing to copy forward and
 * `PAYLOAD_ALLOW_PUSH=1` has nothing to drop.
 *
 * ✅ `ON DELETE set null` IS CORRECT HERE, unlike the generator's other
 * `set null`s in the README: this column is NULLABLE, so deleting a
 * conversation clears it instead of raising 23502. NULL is the value that
 * means "origin not recorded".
 *
 * 🔴 NO BACKFILL, ON PURPOSE. A row created before this column has no
 * recorded origin, and nothing on it says one for sure. "Attached to exactly
 * one conversation, created after it" is the guess the cascade already makes,
 * and it is wrong for a document uploaded into a later conversation, shared
 * into an older one, and left behind when the later one was deleted. Writing
 * that guess into this column would turn it into a fact the cascade then
 * trusts. Existing rows stay NULL, and the cascade keeps its old heuristic for
 * them.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "uploaded_in_session_id" integer;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_in_session_id_sessions_id_fk" FOREIGN KEY ("uploaded_in_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "documents_uploaded_in_session_idx" ON "documents" USING btree ("uploaded_in_session_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP CONSTRAINT "documents_uploaded_in_session_id_sessions_id_fk";
  
  DROP INDEX "documents_uploaded_in_session_idx";
  ALTER TABLE "documents" DROP COLUMN "uploaded_in_session_id";`)
}
