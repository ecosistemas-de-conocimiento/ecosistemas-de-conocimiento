/**
 * Anonymisation switches per document and their audit trail (owner decision
 * and audit, 2026-11-07):
 *   · `documents.keep_document_author`, `documents.keep_cited_authors` boolean,
 *     nullable: per-document overrides of the ecosistema's features; NULL = inherit.
 *   · `documents.cited_authors_kept` jsonb: the cited names the gate left in
 *     `redacted_text`, as `{ name, model, at }[]`.
 *   · `anonymisation_setting_changes`: one append-only row per switch change
 *     (`collections/AnonymisationSettingChanges.ts`).
 * 🔴 Hand-edited: the `organization_id` FK is `ON DELETE cascade` (generated
 * `set null` on a NOT NULL column; the `.json` still says `set null`); `down`
 * drops the `payload_locked_documents_rels` constraint before the table.
 * No backfill: NULL is "the ecosistema's", and both features default to off.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_anonymisation_setting_changes_scope" AS ENUM('documento', 'ecosistema');
  CREATE TYPE "public"."enum_anonymisation_setting_changes_key" AS ENUM('keepDocumentAuthor', 'keepCitedAuthors');
  CREATE TABLE "anonymisation_setting_changes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"document_id" integer,
  	"actor_id" integer,
  	"scope" "enum_anonymisation_setting_changes_scope" NOT NULL,
  	"key" "enum_anonymisation_setting_changes_key" NOT NULL,
  	"before" boolean,
  	"after" boolean,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "documents" ADD COLUMN "keep_document_author" boolean;
  ALTER TABLE "documents" ADD COLUMN "keep_cited_authors" boolean;
  ALTER TABLE "documents" ADD COLUMN "cited_authors_kept" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "anonymisation_setting_changes_id" integer;
  ALTER TABLE "anonymisation_setting_changes" ADD CONSTRAINT "anonymisation_setting_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "anonymisation_setting_changes" ADD CONSTRAINT "anonymisation_setting_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "anonymisation_setting_changes" ADD CONSTRAINT "anonymisation_setting_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "anonymisation_setting_changes_organization_idx" ON "anonymisation_setting_changes" USING btree ("organization_id");
  CREATE INDEX "anonymisation_setting_changes_document_idx" ON "anonymisation_setting_changes" USING btree ("document_id");
  CREATE INDEX "anonymisation_setting_changes_actor_idx" ON "anonymisation_setting_changes" USING btree ("actor_id");
  CREATE INDEX "anonymisation_setting_changes_updated_at_idx" ON "anonymisation_setting_changes" USING btree ("updated_at");
  CREATE INDEX "anonymisation_setting_changes_created_at_idx" ON "anonymisation_setting_changes" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_anonymisation_setting_chang_fk" FOREIGN KEY ("anonymisation_setting_changes_id") REFERENCES "public"."anonymisation_setting_changes"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_anonymisation_setting_chan_idx" ON "payload_locked_documents_rels" USING btree ("anonymisation_setting_changes_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_anonymisation_setting_chang_fk";
  DROP INDEX "payload_locked_documents_rels_anonymisation_setting_chan_idx";
  ALTER TABLE "anonymisation_setting_changes" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "anonymisation_setting_changes" CASCADE;
  ALTER TABLE "documents" DROP COLUMN "keep_document_author";
  ALTER TABLE "documents" DROP COLUMN "keep_cited_authors";
  ALTER TABLE "documents" DROP COLUMN "cited_authors_kept";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "anonymisation_setting_changes_id";
  DROP TYPE "public"."enum_anonymisation_setting_changes_scope";
  DROP TYPE "public"."enum_anonymisation_setting_changes_key";`)
}
