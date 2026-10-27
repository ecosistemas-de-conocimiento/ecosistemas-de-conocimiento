import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Keep public figures (owner rulings 2026-10-27).
 *   · `documents.keep_public_figures` boolean, nullable: the per-document
 *     override of the ecosistema's `keepPublicFigures`; NULL = inherit.
 *   · `documents.public_figures_kept` jsonb: the reviewers' log of names the
 *     gate kept as public (name, motivo, model, at).
 * Emitted by `payload migrate:create`; no backfill: every existing row reads
 * NULL, which is today's behaviour (option off unless the ecosistema says so).
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "keep_public_figures" boolean;
  ALTER TABLE "documents" ADD COLUMN "public_figures_kept" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "keep_public_figures";
  ALTER TABLE "documents" DROP COLUMN "public_figures_kept";`)
}
