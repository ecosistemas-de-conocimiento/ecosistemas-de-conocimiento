import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `ratings`: all four foreign keys become `ON DELETE cascade`. Audit
 * 2026-10-17 §3 item 9, ruled by Rodrigo on 2026-10-20.
 *
 * 🔴 THE SQL IS HAND-WRITTEN. `payload migrate:create --force-accept-warning`
 * emitted an empty migration (the `.json` differs from the previous snapshot
 * in its `id` only), because Payload's field config cannot say `cascade`.
 * Same class as the baseline's rewritten foreign keys: the `.json` still says
 * `set null`, a regenerated baseline will not carry this, and a
 * `PAYLOAD_ALLOW_PUSH=1` boot can revert it. See `README.md`.
 *
 * WHY. Every `ratings` relationship is `required`, so Payload generated NOT
 * NULL columns with `ON DELETE set null` foreign keys. Postgres applies the
 * action first and then refuses the NULL (23502), so these deletes failed
 * (`plan/borradores-por-conversacion.md` §8):
 *
 *   · a rated MESSAGE;
 *   · an ECOSISTEMA that has ratings;
 *   · a USER who ever rated. 🔴 A data-protection issue: the account could
 *     not be deleted.
 *
 * WHAT EACH ONE DOES NOW:
 *
 *   · `message_id` → cascade. A rating judges one answer; without the answer
 *     it means nothing.
 *   · `session_id` → cascade. Same reason. `Sessions.beforeDelete` still
 *     deletes them first.
 *   · `organization_id` → cascade. Same as every graph and review FK to
 *     `organizations` in the baseline.
 *   · `user_id` → cascade: DELETED, not anonymised. A person may only rate a
 *     message in their OWN conversation (`collections/Ratings.ts` rule 3), and
 *     conversations are private to their owner, so a deleted person's ratings
 *     all sit on messages that go with them. Anonymising would mean a
 *     nullable `user_id`, which breaks one-rating-per-(message, user)
 *     (`ratings_message_user_unq` treats NULLs as distinct), for a row whose
 *     message goes anyway.
 *
 * ⚠ THIS ALONE DOES NOT MAKE A USER OR AN ECOSISTEMA DELETABLE. Other NOT
 * NULL + SET NULL foreign keys still refuse those deletes (`sessions`,
 * `memberships`, `documents`, `media`, `teams`; the README's 23502 query
 * lists them). Ratings were one blocker of several. The rest need a product
 * decision, because a database cascade from `sessions` would skip the corpus
 * erase in `Sessions.beforeDelete`. `collections/Ratings.deletePaths.pg.test.ts`
 * pins both halves.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_message_id_messages_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_session_id_sessions_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_organization_id_organizations_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_user_id_users_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_message_id_messages_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_session_id_sessions_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_organization_id_organizations_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" DROP CONSTRAINT "ratings_user_id_users_id_fk";
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;`)
}
