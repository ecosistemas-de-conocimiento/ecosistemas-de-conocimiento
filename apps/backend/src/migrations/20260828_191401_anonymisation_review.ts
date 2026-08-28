/**
 * THE REVIEW SCREEN FOR HELD DOCUMENTS, in three parts.
 *
 * 1. `anonymisation_reviews` — 🔴 the append-only audit trail. One row per human
 *    decision on a document the anonymisation gate refused: who, when, and a
 *    COPY of the gate report they were looking at. An unaudited override of a
 *    fail-closed gate is the same thing as no gate.
 *
 * 2. Two new `documents.anonymisation_status` values: `approved` (a human
 *    released a hold) and `rejected` (a human refused it, terminally).
 *
 * 3. `documents.held_text` + `documents.anonymisation_survivors`.
 *    🔴 `held_text` IS NOT `redacted_text` AND MUST NEVER BE MERGED INTO IT.
 *    `corpusTextFor` reads `redacted_text`; putting the gate's REFUSED output
 *    there would make the next publish push it into the shared corpus.
 *    `anonymisation_survivors` holds OFFSETS into `held_text`, never strings —
 *    see `lib/anonymise/types.ts`.
 *
 * ⚠ `ALTER TYPE … ADD VALUE` inside a transaction needs Postgres 12+. Applied
 * cleanly against the dev database on this branch.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_anonymisation_reviews_decision" AS ENUM('approved', 'rejected');
  ALTER TYPE "public"."enum_documents_anonymisation_status" ADD VALUE 'approved' BEFORE 'ready';
  ALTER TYPE "public"."enum_documents_anonymisation_status" ADD VALUE 'rejected' BEFORE 'ready';
  CREATE TABLE "anonymisation_reviews" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"document_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"reviewer_id" integer NOT NULL,
  	"decision" "enum_anonymisation_reviews_decision" NOT NULL,
  	"gate_stage" varchar,
  	"gate_reason" varchar,
  	"gate_report" jsonb,
  	"text_edited" boolean DEFAULT false,
  	"note" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "documents" ADD COLUMN "held_text" varchar;
  ALTER TABLE "documents" ADD COLUMN "anonymisation_survivors" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "anonymisation_reviews_id" integer;
  ALTER TABLE "anonymisation_reviews" ADD CONSTRAINT "anonymisation_reviews_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "anonymisation_reviews" ADD CONSTRAINT "anonymisation_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "anonymisation_reviews" ADD CONSTRAINT "anonymisation_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "anonymisation_reviews_document_idx" ON "anonymisation_reviews" USING btree ("document_id");
  CREATE INDEX "anonymisation_reviews_organization_idx" ON "anonymisation_reviews" USING btree ("organization_id");
  CREATE INDEX "anonymisation_reviews_reviewer_idx" ON "anonymisation_reviews" USING btree ("reviewer_id");
  CREATE INDEX "anonymisation_reviews_decision_idx" ON "anonymisation_reviews" USING btree ("decision");
  CREATE INDEX "anonymisation_reviews_updated_at_idx" ON "anonymisation_reviews" USING btree ("updated_at");
  CREATE INDEX "anonymisation_reviews_created_at_idx" ON "anonymisation_reviews" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_anonymisation_reviews_fk" FOREIGN KEY ("anonymisation_reviews_id") REFERENCES "public"."anonymisation_reviews"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_anonymisation_reviews_id_idx" ON "payload_locked_documents_rels" USING btree ("anonymisation_reviews_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "anonymisation_reviews" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "anonymisation_reviews" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_anonymisation_reviews_fk";
  
  DROP INDEX "payload_locked_documents_rels_anonymisation_reviews_id_idx";
  ALTER TABLE "documents" DROP COLUMN "held_text";
  ALTER TABLE "documents" DROP COLUMN "anonymisation_survivors";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "anonymisation_reviews_id";
  ALTER TABLE "public"."documents" ALTER COLUMN "anonymisation_status" SET DATA TYPE text;
  DROP TYPE "public"."enum_documents_anonymisation_status";
  CREATE TYPE "public"."enum_documents_anonymisation_status" AS ENUM('n/a', 'pending', 'held', 'ready');
  ALTER TABLE "public"."documents" ALTER COLUMN "anonymisation_status" SET DATA TYPE "public"."enum_documents_anonymisation_status" USING "anonymisation_status"::"public"."enum_documents_anonymisation_status";
  DROP TYPE "public"."enum_anonymisation_reviews_decision";`)
}
