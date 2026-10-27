import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.kind` gains `xlsx`, `csv` and `html` — spreadsheet and web-page
 * documentos, extracted to text by `lib/extract/*`.
 *
 * Hand-written: no chain-aware database was free to run `migrate:create`
 * against. `up` is additive (`ADD VALUE`), so existing rows are untouched.
 * `down` rebuilds the type the way Payload emits an enum change, and it FAILS
 * if any row still holds one of the new values — delete those rows first.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_documents_kind" ADD VALUE IF NOT EXISTS 'xlsx' BEFORE 'audio';
   ALTER TYPE "public"."enum_documents_kind" ADD VALUE IF NOT EXISTS 'csv' BEFORE 'audio';
   ALTER TYPE "public"."enum_documents_kind" ADD VALUE IF NOT EXISTS 'html' BEFORE 'audio';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ALTER COLUMN "kind" SET DATA TYPE text;
   ALTER TABLE "documents" ALTER COLUMN "kind" SET DEFAULT 'markdown'::text;
   DROP TYPE "public"."enum_documents_kind";
   CREATE TYPE "public"."enum_documents_kind" AS ENUM('markdown', 'pdf', 'docx', 'audio');
   ALTER TABLE "documents" ALTER COLUMN "kind" SET DEFAULT 'markdown'::"public"."enum_documents_kind";
   ALTER TABLE "documents" ALTER COLUMN "kind" SET DATA TYPE "public"."enum_documents_kind" USING "kind"::"public"."enum_documents_kind";`)
}
