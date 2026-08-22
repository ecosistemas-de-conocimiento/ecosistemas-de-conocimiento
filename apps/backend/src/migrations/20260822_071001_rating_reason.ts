import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `ratings.reason` — the preset "why" behind a score.
 *
 * ⚠ HAND-TRIMMED, and the reason matters for the next person who generates a
 * migration. `payload migrate:create` emitted the `media.prefix` column and its
 * index in here too, because the migration that added them
 * (`20260814_231500_media_prefix`) was written by hand with NO `.json`
 * snapshot. So the generator diffed against the BASELINE snapshot and re-emitted
 * a change that is already applied — `payload_migrations` records it as batch 2,
 * and `information_schema` confirms the column exists.
 *
 * Left in, this migration would fail on `ADD COLUMN "prefix"` and take the
 * boot with it, since the release entrypoint runs `payload migrate` before
 * `next start`.
 *
 * ✅ The snapshot generated alongside this file (`.json`) DOES describe the full
 * current schema, so the chain is repaired from here: the next
 * `migrate:create` will diff against reality rather than against the baseline.
 * A hand-written migration without a snapshot is what broke it — do not write
 * another one.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_ratings_reason" AS ENUM('not-grounded', 'invented', 'incomplete', 'unclear', 'wrong-language', 'accurate', 'well-sourced', 'clear', 'complete', 'other');
    ALTER TABLE "ratings" ADD COLUMN "reason" "enum_ratings_reason";`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "ratings" DROP COLUMN "reason";
    DROP TYPE "public"."enum_ratings_reason";`)
}
