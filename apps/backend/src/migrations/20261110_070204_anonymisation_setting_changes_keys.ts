/**
 * The anonymisation audit log covers every switch (audit 2026-11-10, P-04/I-13):
 *   · `enum_anonymisation_setting_changes_key` gains `keepPublicFigures` (now in
 *     `ANONYMISE_SWITCHES`) and `detectorFallback` (`globals/PlatformSettings.ts`;
 *     before/after store `hosted` as true, `none` as false, the env as NULL);
 *   · `enum_anonymisation_setting_changes_scope` gains `plataforma`;
 *   · `organization_id` becomes nullable: a platform change has no ecosistema
 *     (the collection still requires it for every other scope).
 * 🔴 Hand-edited: `down` first DELETES the rows that only the new values can
 * hold (otherwise the NOT NULL and the enum casts fail). That loses audit rows,
 * so it is for a throwaway database only.
 * No backfill.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_anonymisation_setting_changes_scope" ADD VALUE 'plataforma';
  ALTER TYPE "public"."enum_anonymisation_setting_changes_key" ADD VALUE 'keepPublicFigures';
  ALTER TYPE "public"."enum_anonymisation_setting_changes_key" ADD VALUE 'detectorFallback';
  ALTER TABLE "anonymisation_setting_changes" ALTER COLUMN "organization_id" DROP NOT NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "anonymisation_setting_changes"
    WHERE "organization_id" IS NULL OR "scope"::text = 'plataforma' OR "key"::text IN ('keepPublicFigures', 'detectorFallback');
  ALTER TABLE "anonymisation_setting_changes" ALTER COLUMN "organization_id" SET NOT NULL;
  ALTER TABLE "public"."anonymisation_setting_changes" ALTER COLUMN "scope" SET DATA TYPE text;
  DROP TYPE "public"."enum_anonymisation_setting_changes_scope";
  CREATE TYPE "public"."enum_anonymisation_setting_changes_scope" AS ENUM('documento', 'ecosistema');
  ALTER TABLE "public"."anonymisation_setting_changes" ALTER COLUMN "scope" SET DATA TYPE "public"."enum_anonymisation_setting_changes_scope" USING "scope"::"public"."enum_anonymisation_setting_changes_scope";
  ALTER TABLE "public"."anonymisation_setting_changes" ALTER COLUMN "key" SET DATA TYPE text;
  DROP TYPE "public"."enum_anonymisation_setting_changes_key";
  CREATE TYPE "public"."enum_anonymisation_setting_changes_key" AS ENUM('keepDocumentAuthor', 'keepCitedAuthors');
  ALTER TABLE "public"."anonymisation_setting_changes" ALTER COLUMN "key" SET DATA TYPE "public"."enum_anonymisation_setting_changes_key" USING "key"::"public"."enum_anonymisation_setting_changes_key";`)
}
