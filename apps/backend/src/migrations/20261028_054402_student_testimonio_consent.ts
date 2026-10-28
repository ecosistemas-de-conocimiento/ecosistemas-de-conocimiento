import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `student_profiles.share_testimonios_at` (timestamptz, nullable): when a
 * student accepted that the teacher report also shows their testimonios,
 * anonymised (owner ruling Q20). NULL = not given or withdrawn. Emitted by
 * `payload migrate:create`; no backfill, on purpose: an activity consent given
 * before this column existed does not cover testimonios.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "student_profiles" ADD COLUMN "share_testimonios_at" timestamp(3) with time zone;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "student_profiles" DROP COLUMN "share_testimonios_at";`)
}
