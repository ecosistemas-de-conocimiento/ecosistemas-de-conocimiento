import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `sessions.kind` — `generales` (open chat) or `resonancias` (interview-style).
 * See the field in `collections/Sessions.ts`.
 *
 * SQL exactly as `payload migrate:create` emitted it. The DEFAULT fills
 * existing rows with `generales`; nothing is backfilled.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sessions_kind" AS ENUM('generales', 'resonancias');
  ALTER TABLE "sessions" ADD COLUMN "kind" "enum_sessions_kind" DEFAULT 'generales' NOT NULL;
  CREATE INDEX "sessions_kind_idx" ON "sessions" USING btree ("kind");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "sessions_kind_idx";
  ALTER TABLE "sessions" DROP COLUMN "kind";
  DROP TYPE "public"."enum_sessions_kind";`)
}
