/**
 * Two owner decisions of 2026-11-10:
 *   · `documents.consent_held boolean DEFAULT false NOT NULL`: retenido por
 *     consentimiento (`lib/consentHold.ts`). Existing rows stay false; the
 *     workshop rows are held by `scripts/hold-for-consent.ts`, not here.
 *   · a document delete keeps another person's review rows:
 *     `anonymisation_reviews.document_id` nullable, its FK `ON DELETE set null`
 *     (was `cascade`, baseline), and `document_id_snapshot` keeps the id.
 * 🔴 Hand-written: the FK rewrite (the generated SQL only drops NOT NULL; the
 * `.json` says `set null` because that is Payload's default) and the snapshot
 * backfill. `down` first DELETES the review rows whose document is gone
 * (otherwise SET NOT NULL fails): audit rows lost, throwaway databases only.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "anonymisation_reviews" ALTER COLUMN "document_id" DROP NOT NULL;
  ALTER TABLE "documents" ADD COLUMN "consent_held" boolean DEFAULT false NOT NULL;
  ALTER TABLE "anonymisation_reviews" ADD COLUMN "document_id_snapshot" numeric;
  CREATE INDEX "anonymisation_reviews_document_id_snapshot_idx" ON "anonymisation_reviews" USING btree ("document_id_snapshot");`)

  // 🔴 Hand-written. See the header.
  await db.execute(sql`
  UPDATE "anonymisation_reviews" SET "document_id_snapshot" = "document_id" WHERE "document_id_snapshot" IS NULL;
  ALTER TABLE "anonymisation_reviews" DROP CONSTRAINT "anonymisation_reviews_document_id_documents_id_fk";
  ALTER TABLE "anonymisation_reviews" ADD CONSTRAINT "anonymisation_reviews_document_id_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DELETE FROM "anonymisation_reviews" WHERE "document_id" IS NULL;
  ALTER TABLE "anonymisation_reviews" DROP CONSTRAINT "anonymisation_reviews_document_id_documents_id_fk";
  ALTER TABLE "anonymisation_reviews" ADD CONSTRAINT "anonymisation_reviews_document_id_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;`)
  await db.execute(sql`
   DROP INDEX "anonymisation_reviews_document_id_snapshot_idx";
  ALTER TABLE "anonymisation_reviews" ALTER COLUMN "document_id" SET NOT NULL;
  ALTER TABLE "documents" DROP COLUMN "consent_held";
  ALTER TABLE "anonymisation_reviews" DROP COLUMN "document_id_snapshot";`)
}
