import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `student_profiles.share_testimonios_version` (numeric, nullable): the
 * version of the testimonio consent wording the student accepted
 * (`lib/student/testimonioConsent.ts`, owner ruling Q20: a consent covers only
 * the wording shown). Emitted by `payload migrate:create`; NO BACKFILL, on
 * purpose: consents given under the earlier, narrower wording stay NULL and no
 * longer count, so those students are asked again.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "student_profiles" ADD COLUMN "share_testimonios_version" numeric;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "student_profiles" DROP COLUMN "share_testimonios_version";`)
}
