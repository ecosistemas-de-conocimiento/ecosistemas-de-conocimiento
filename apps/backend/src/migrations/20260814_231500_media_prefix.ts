import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `media.prefix` — the object-storage key prefix.
 *
 * WHY THIS IS A HAND-CUT MIGRATION AND NOT A PUSH. Schema push is off in every
 * environment (see `payload.config.ts`), so a new field needs a migration or the
 * column simply is not there and every `POST /api/media` fails on insert.
 *
 * ⚠ THE COLUMN EXISTS IN BOTH STORAGE MODES, and that is the point. The field is
 * declared on the `Media` collection itself rather than injected by
 * `@payloadcms/storage-s3`, which only adds it when the plugin is active. One
 * schema for local-disk and object-storage boots means the same migration
 * history applies to both, and switching a deployment between them is an env
 * change rather than a database change.
 *
 * NULLABLE, with no backfill: rows written before object storage have no key
 * prefix because their bytes are on local disk, where the prefix is meaningless.
 * `getFileKey` treats an empty prefix as "bucket root", which is exactly right
 * for anything that predates this change.
 *
 * The index is for operability queries ("everything belonging to eco_12"), the
 * same reason the prefix exists at all. It is NOT part of any access path — see
 * `mediaObjectPrefix` in `collections/Media.ts`.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "prefix" varchar;
  CREATE INDEX IF NOT EXISTS "media_prefix_idx" ON "media" USING btree ("prefix");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "media_prefix_idx";
  ALTER TABLE "media" DROP COLUMN IF EXISTS "prefix";`)
}
