import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Student view: its foreign keys stop blocking a user or ecosistema delete.
 * Audit 2026-10-27 item 5.
 *
 * WHY. `20261027_053800_student_view` (frozen, not edited) gave four NOT NULL
 * columns `ON DELETE set null` foreign keys. Postgres applies the action, then
 * refuses the NULL (23502) — the same class as `20261020_193707_ratings_fk_cascade`.
 * So a user with a consent row or a suggestion, and an ecosistema with either,
 * could not be deleted.
 *
 * WHAT EACH ONE DOES NOW:
 *   · `student_profiles.user_id` → cascade. A consent row is one person's
 *     choice; without the person it means nothing.
 *   · `student_profiles.organization_id` → cascade. Same.
 *   · `suggestions.organization_id` → cascade. A suggestion is about one
 *     ecosistema.
 *   · `suggestions.author_id` → stays `set null`, and the column becomes
 *     nullable. The suggestion survives its author's delete, anonymous; the
 *     endpoint already shows a missing author as "Estudiante".
 *
 * GENERATED vs HAND-WRITTEN. `migrate:create` (against a scratch postgres:16
 * at the full chain, 2026-10-27) emitted ONLY the `author_id DROP NOT NULL`
 * pair, from `collections/Suggestions.ts` dropping `required` on `author`.
 * 🔴 The three cascade rewrites are hand-written: Payload's field config cannot
 * say `cascade`, the `.json` still says `set null` for them, and a
 * `PAYLOAD_ALLOW_PUSH=1` boot can revert them (see `README.md`). The `.json`
 * `prevId` was hand-chained to `053800`.
 *
 * ⚠ A real student also has a `memberships` row, whose NOT NULL + set null FK
 * still refuses the user delete. Out of scope here, as it was for ratings.
 * `collections/StudentProfiles.deletePaths.pg.test.ts` pins this file.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "suggestions" ALTER COLUMN "author_id" DROP NOT NULL;
  ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_user_id_users_id_fk";
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_organization_id_organizations_id_fk";
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_organization_id_organizations_id_fk";
  ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // ⚠ SET NOT NULL fails if an author was already deleted (a NULL row exists).
  await db.execute(sql`
   ALTER TABLE "suggestions" ALTER COLUMN "author_id" SET NOT NULL;
  ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_user_id_users_id_fk";
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_organization_id_organizations_id_fk";
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_organization_id_organizations_id_fk";
  ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;`)
}
