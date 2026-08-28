import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Voces, the Investigador role, and the anonymisation gate.
 *
 * ✅ GENERATED, NOT HAND-WRITTEN, and that matters here: the last hand-written
 * migration (`20260814_231500_media_prefix`) shipped without a `.json` snapshot
 * and left the generator diffing against a stale baseline — the next
 * `migrate:create` re-emitted a column that already existed and would have taken
 * the boot down. See the header on `20260822_071001_rating_reason`. This one has
 * its snapshot alongside it.
 *
 * ── WHAT IT ADDS ─────────────────────────────────────────────────────────────
 *
 * `documents.content_kind` — what the material IS (`documento` / `testimonio` /
 * `conversacion`), as opposed to `documents.kind`, which is the FILE FORMAT.
 * `lib/contentKind.ts` explains why the two are separate columns.
 *
 * 🔴 THERE IS NO `subject` COLUMN AND NO `consent_level` COLUMN, AND THAT IS THE
 * DESIGN, NOT AN OMISSION. Every testimony is anonymous. We do not store who it
 * came from — not a name, not a code, not a hidden column — because a stored
 * subject IS a re-identification map, which is the exact thing the anonymisation
 * work refuses to keep. And there is no consent level because one rule means no
 * default a bulk upload can get wrong. If attribution is ever genuinely needed,
 * that is a deliberate future change with its own migration.
 *
 * `documents.redacted_text` / `messages.redacted_text` sit BESIDE the originals,
 * never over them. Only the redacted copy is ever embedded; the original stays
 * in Postgres, access-controlled, as the record of what was actually said.
 *
 * `*.anonymisation_report` is jsonb of COUNTS AND RULE NAMES ONLY. It must never
 * be allowed to carry the strings that were removed — that would recreate the
 * re-identification map under a friendlier name.
 *
 * ⚠ `ALTER TYPE … ADD VALUE 'investigador' BEFORE 'admin'` runs inside the
 * migration's transaction. PostgreSQL 12 and later allow that as long as the new
 * value is not USED in the same transaction, and nothing here inserts a row with
 * it. On PostgreSQL 11 or older this statement fails and the type has to be
 * swapped the way `down()` does it.
 *
 * ⚠ THE ORDER OF THE ENUM MATTERS AT THE APPLICATION LEVEL, not the database
 * one. `lib/permissions.ts` derives `ROLE_RANK` from `ORG_ROLES`, and
 * `investigador` must sit between `member` and `admin` — above a participant,
 * below anyone who manages people. `BEFORE 'admin'` keeps the column readable in
 * the same order.
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_documents_content_kind" AS ENUM('documento', 'testimonio', 'conversacion');
  CREATE TYPE "public"."enum_documents_anonymisation_status" AS ENUM('n/a', 'pending', 'held', 'ready');
  CREATE TYPE "public"."enum_messages_corpus_status" AS ENUM('pending', 'held-drafts', 'held-gate', 'embedding', 'ingested', 'failed', 'skipped');
  ALTER TYPE "public"."enum_memberships_role" ADD VALUE 'investigador' BEFORE 'admin';
  ALTER TABLE "documents" ADD COLUMN "content_kind" "enum_documents_content_kind" DEFAULT 'documento' NOT NULL;
  ALTER TABLE "documents" ADD COLUMN "redacted_text" varchar;
  ALTER TABLE "documents" ADD COLUMN "anonymisation_status" "enum_documents_anonymisation_status" DEFAULT 'n/a' NOT NULL;
  ALTER TABLE "documents" ADD COLUMN "anonymisation_error" varchar;
  ALTER TABLE "documents" ADD COLUMN "anonymisation_report" jsonb;
  ALTER TABLE "messages" ADD COLUMN "corpus_status" "enum_messages_corpus_status" DEFAULT 'pending' NOT NULL;
  ALTER TABLE "messages" ADD COLUMN "corpus_ingest_id" varchar;
  ALTER TABLE "messages" ADD COLUMN "corpus_error" varchar;
  ALTER TABLE "messages" ADD COLUMN "redacted_text" varchar;
  ALTER TABLE "messages" ADD COLUMN "anonymisation_report" jsonb;
  CREATE INDEX "documents_content_kind_idx" ON "documents" USING btree ("content_kind");
  CREATE INDEX "documents_anonymisation_status_idx" ON "documents" USING btree ("anonymisation_status");
  CREATE INDEX "messages_corpus_status_idx" ON "messages" USING btree ("corpus_status");
  CREATE INDEX "messages_corpus_ingest_id_idx" ON "messages" USING btree ("corpus_ingest_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "documents_content_kind_idx";
  DROP INDEX "documents_anonymisation_status_idx";
  DROP INDEX "messages_corpus_status_idx";
  DROP INDEX "messages_corpus_ingest_id_idx";
  ALTER TABLE "documents" DROP COLUMN "content_kind";
  ALTER TABLE "documents" DROP COLUMN "redacted_text";
  ALTER TABLE "documents" DROP COLUMN "anonymisation_status";
  ALTER TABLE "documents" DROP COLUMN "anonymisation_error";
  ALTER TABLE "documents" DROP COLUMN "anonymisation_report";
  ALTER TABLE "messages" DROP COLUMN "corpus_status";
  ALTER TABLE "messages" DROP COLUMN "corpus_ingest_id";
  ALTER TABLE "messages" DROP COLUMN "corpus_error";
  ALTER TABLE "messages" DROP COLUMN "redacted_text";
  ALTER TABLE "messages" DROP COLUMN "anonymisation_report";
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE text;
  DROP TYPE "public"."enum_memberships_role";
  CREATE TYPE "public"."enum_memberships_role" AS ENUM('member', 'admin', 'owner');
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE "public"."enum_memberships_role" USING "role"::"public"."enum_memberships_role";
  DROP TYPE "public"."enum_documents_content_kind";
  DROP TYPE "public"."enum_documents_anonymisation_status";
  DROP TYPE "public"."enum_messages_corpus_status";`)
}
