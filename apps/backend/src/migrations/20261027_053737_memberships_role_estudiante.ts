import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `estudiante` joins `enum_memberships_role` (owner ruling 2026-10-27; ladder
 * in `lib/permissions.ts`).
 *
 * 🔴 HAND-WRITTEN UP. `payload migrate:create` emitted a DROP/CREATE of the
 * whole enum (to match the new option order) AND a second copy of
 * `20261027_002257_sessions_kind` — the previous `.json` snapshot predates that
 * migration. Both were cut. `ADD VALUE` touches no row; the enum's value order
 * is irrelevant, because rank lives in code (`ROLE_RANK`). The `.json` beside
 * this file is the generated one and is the correct current snapshot.
 *
 * ⚠ The new value is not used in this transaction (Postgres refuses that).
 *
 * DOWN folds every `estudiante` back into `member`, then rebuilds the enum
 * without it — Postgres cannot drop a single enum value.
 */

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TYPE "public"."enum_memberships_role" ADD VALUE IF NOT EXISTS 'estudiante' BEFORE 'member';`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" DROP DEFAULT;
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE text;
  UPDATE "public"."memberships" SET "role" = 'member' WHERE "role" = 'estudiante';
  DROP TYPE "public"."enum_memberships_role";
  CREATE TYPE "public"."enum_memberships_role" AS ENUM('member', 'investigador', 'admin', 'owner');
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE "public"."enum_memberships_role" USING "role"::"public"."enum_memberships_role";
  ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DEFAULT 'member';`)
}
