import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.kind` gains `xls` — legacy Excel 97–2003 workbooks, extracted to
 * the same text as an xlsx by `lib/extract/xls.ts`.
 *
 * `up` is generated and additive (`ADD VALUE`): existing rows are untouched.
 * 🔴 `down` is hand-fixed: the generated one dropped the type while the
 * column's `DEFAULT 'markdown'::enum_documents_kind` still depended on it, and
 * failed (measured on a throwaway postgres:16, 2026-10-28, cut after `20261028_231948`). It now moves the
 * default to text first and restores it after, as `20261026_200000` does.
 * `down` FAILS if any row still holds `xls` — delete those rows first.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_documents_kind" ADD VALUE 'xls' BEFORE 'csv';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "public"."documents" ALTER COLUMN "kind" SET DATA TYPE text;
   ALTER TABLE "public"."documents" ALTER COLUMN "kind" SET DEFAULT 'markdown'::text;
   DROP TYPE "public"."enum_documents_kind";
   CREATE TYPE "public"."enum_documents_kind" AS ENUM('markdown', 'pdf', 'docx', 'xlsx', 'csv', 'html', 'audio');
   ALTER TABLE "public"."documents" ALTER COLUMN "kind" SET DEFAULT 'markdown'::"public"."enum_documents_kind";
   ALTER TABLE "public"."documents" ALTER COLUMN "kind" SET DATA TYPE "public"."enum_documents_kind" USING "kind"::"public"."enum_documents_kind";`)
}
