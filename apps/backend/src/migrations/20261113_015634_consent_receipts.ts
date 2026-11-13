/**
 * `consent_receipts` (+ its two enums): one row per upload consent
 * (`collections/ConsentReceipts.ts`, `lib/uploadConsent.ts`, Etapa 1
 * correction 2026-11-12). No backfill, on purpose: an older document has no
 * receipt and its constancia says so; a backfilled receipt would be a consent
 * nobody gave.
 * 🔴 Hand-written: the `organization_id` FK is `ON DELETE cascade` (generated
 * `set null` on NOT NULL, which refused every ecosistema delete; the `.json`
 * still says `set null`), and `down` drops the `payload_locked_documents_rels`
 * constraint before the table (reordered as in `20261108_001902`; the
 * generated order was not run). `document_id`
 * stays `set null`: a document delete keeps its receipt (`document_id_snapshot`).
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_consent_receipts_kind" AS ENUM('upload');
  CREATE TYPE "public"."enum_consent_receipts_content_kind" AS ENUM('documento', 'testimonio', 'conversacion');
  CREATE TABLE "consent_receipts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"document_id" integer,
  	"document_id_snapshot" numeric NOT NULL,
  	"organization_id" integer NOT NULL,
  	"actor_id" integer,
  	"kind" "enum_consent_receipts_kind" NOT NULL,
  	"consent_version" numeric NOT NULL,
  	"content_kind" "enum_consent_receipts_content_kind" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "consent_receipts_id" integer;
  ALTER TABLE "consent_receipts" ADD CONSTRAINT "consent_receipts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "consent_receipts" ADD CONSTRAINT "consent_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "consent_receipts" ADD CONSTRAINT "consent_receipts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "consent_receipts_document_idx" ON "consent_receipts" USING btree ("document_id");
  CREATE INDEX "consent_receipts_document_id_snapshot_idx" ON "consent_receipts" USING btree ("document_id_snapshot");
  CREATE INDEX "consent_receipts_organization_idx" ON "consent_receipts" USING btree ("organization_id");
  CREATE INDEX "consent_receipts_actor_idx" ON "consent_receipts" USING btree ("actor_id");
  CREATE INDEX "consent_receipts_updated_at_idx" ON "consent_receipts" USING btree ("updated_at");
  CREATE INDEX "consent_receipts_created_at_idx" ON "consent_receipts" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_consent_receipts_fk" FOREIGN KEY ("consent_receipts_id") REFERENCES "public"."consent_receipts"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_consent_receipts_id_idx" ON "payload_locked_documents_rels" USING btree ("consent_receipts_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_consent_receipts_fk";
  DROP INDEX "payload_locked_documents_rels_consent_receipts_id_idx";
  ALTER TABLE "consent_receipts" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "consent_receipts" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "consent_receipts_id";
  DROP TYPE "public"."enum_consent_receipts_kind";
  DROP TYPE "public"."enum_consent_receipts_content_kind";`)
}
