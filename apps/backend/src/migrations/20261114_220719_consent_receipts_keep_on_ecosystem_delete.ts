/**
 * An ecosistema delete keeps its consent receipts (2026-11-14): a receipt is
 * the proof that consent was given (folio `EDC-YYYY-NNNNNN`), and deleting the
 * space it was given in does not undo it. `consent_receipts.organization_id`
 * nullable, its FK `ON DELETE set null` (was `cascade`, `20261113_015634`),
 * and `organization_id_snapshot` keeps which ecosistema it was (an id, never a
 * name: a receipt has no text column).
 * 🔴 Hand-written: the generated SQL added the snapshot `NOT NULL` with no
 * default (fails on any existing row) and did not touch the FK (the `.json`
 * of `20261113_015634` already said `set null`; here it agrees with the
 * database). The column is added nullable, backfilled from `organization_id`
 * (a fact the row already holds, not a new consent), then set NOT NULL.
 * `down` first DELETES the receipts whose ecosistema is gone (otherwise
 * SET NOT NULL fails): receipts lost, throwaway databases only.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "consent_receipts" ALTER COLUMN "organization_id" DROP NOT NULL;
  ALTER TABLE "consent_receipts" ADD COLUMN "organization_id_snapshot" numeric;
  CREATE INDEX "consent_receipts_organization_id_snapshot_idx" ON "consent_receipts" USING btree ("organization_id_snapshot");`)

  // 🔴 Hand-written. See the header.
  await db.execute(sql`
  UPDATE "consent_receipts" SET "organization_id_snapshot" = "organization_id" WHERE "organization_id_snapshot" IS NULL;
  ALTER TABLE "consent_receipts" ALTER COLUMN "organization_id_snapshot" SET NOT NULL;
  ALTER TABLE "consent_receipts" DROP CONSTRAINT "consent_receipts_organization_id_organizations_id_fk";
  ALTER TABLE "consent_receipts" ADD CONSTRAINT "consent_receipts_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DELETE FROM "consent_receipts" WHERE "organization_id" IS NULL;
  ALTER TABLE "consent_receipts" DROP CONSTRAINT "consent_receipts_organization_id_organizations_id_fk";
  ALTER TABLE "consent_receipts" ADD CONSTRAINT "consent_receipts_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;`)
  await db.execute(sql`
   DROP INDEX "consent_receipts_organization_id_snapshot_idx";
  ALTER TABLE "consent_receipts" ALTER COLUMN "organization_id" SET NOT NULL;
  ALTER TABLE "consent_receipts" DROP COLUMN "organization_id_snapshot";`)
}
