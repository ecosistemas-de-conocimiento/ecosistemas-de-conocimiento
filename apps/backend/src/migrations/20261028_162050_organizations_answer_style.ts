import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * The answer style per ecosistema (owner ruling 2026-10-28; `lib/answerStyle.ts`).
 *   · `organizations.answer_style_generales`, `answer_style_resonancias`,
 *     `answer_style_interviewer` varchar — nullable; NULL = no style, the
 *     chat prompt unchanged. Platform admin only (`refuseAnswerStyleChange`).
 * Emitted by `payload migrate:create`; nothing is backfilled. The Discapacidad
 * draft is seeded by `scripts/seed-answer-style.ts`, not here.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "organizations" ADD COLUMN "answer_style_generales" varchar;
  ALTER TABLE "organizations" ADD COLUMN "answer_style_resonancias" varchar;
  ALTER TABLE "organizations" ADD COLUMN "answer_style_interviewer" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "organizations" DROP COLUMN "answer_style_generales";
  ALTER TABLE "organizations" DROP COLUMN "answer_style_resonancias";
  ALTER TABLE "organizations" DROP COLUMN "answer_style_interviewer";`)
}
