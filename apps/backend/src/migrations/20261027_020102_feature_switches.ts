import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Feature switches (owner ruling 2026-10-27; backlog #39).
 *   · `organizations.features` jsonb — per-ecosistema; NULL = today's defaults
 *     (`lib/features.ts`).
 *   · `platform_settings` — the `platform-settings` global; NULL columns = the
 *     env value (`lib/platformSettings.ts`).
 * Emitted by `payload migrate:create`; nothing is backfilled, so nothing
 * changes until someone saves a switch.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_platform_settings_detector_fallback" AS ENUM('hosted', 'none');
  CREATE TABLE "platform_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"detector_fallback" "enum_platform_settings_detector_fallback",
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "organizations" ADD COLUMN "features" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "platform_settings" CASCADE;
  ALTER TABLE "organizations" DROP COLUMN "features";
  DROP TYPE "public"."enum_platform_settings_detector_fallback";`)
}
