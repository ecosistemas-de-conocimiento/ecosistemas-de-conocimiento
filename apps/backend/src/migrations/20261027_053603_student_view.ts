import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Student view (owner 2026-10-27; `studentView` switch): `student_profiles`
 * (a student's two consent flags per ecosistema, both default false) and
 * `suggestions` ("Sugerir"). Nothing is backfilled.
 *
 * ⚠ HAND-EDITED: `migrate:create` also emitted `sessions.kind` (type, column,
 * index), already created by `20261027_002257_sessions_kind` — the
 * `feature_switches` snapshot was cut from a branch without it. Those
 * statements were removed; this file's `.json` snapshot includes `kind`.
 * 🔴 Also hand-written: the UNIQUE index `student_profiles_user_organization_unq`.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_suggestions_kind" AS ENUM('contenido', 'arquitectura', 'interaccion');
  CREATE TABLE "student_profiles" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"share_with_peers" boolean DEFAULT false NOT NULL,
  	"share_activity" boolean DEFAULT false NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "suggestions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"author_id" integer NOT NULL,
  	"kind" "enum_suggestions_kind" NOT NULL,
  	"text" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "student_profiles_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "suggestions_id" integer;
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "student_profiles_user_idx" ON "student_profiles" USING btree ("user_id");
  CREATE INDEX "student_profiles_organization_idx" ON "student_profiles" USING btree ("organization_id");
  CREATE INDEX "student_profiles_updated_at_idx" ON "student_profiles" USING btree ("updated_at");
  CREATE INDEX "student_profiles_created_at_idx" ON "student_profiles" USING btree ("created_at");
  CREATE INDEX "suggestions_organization_idx" ON "suggestions" USING btree ("organization_id");
  CREATE INDEX "suggestions_author_idx" ON "suggestions" USING btree ("author_id");
  CREATE INDEX "suggestions_updated_at_idx" ON "suggestions" USING btree ("updated_at");
  CREATE INDEX "suggestions_created_at_idx" ON "suggestions" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_student_profiles_fk" FOREIGN KEY ("student_profiles_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_suggestions_fk" FOREIGN KEY ("suggestions_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_student_profiles_id_idx" ON "payload_locked_documents_rels" USING btree ("student_profiles_id");
  CREATE INDEX "payload_locked_documents_rels_suggestions_id_idx" ON "payload_locked_documents_rels" USING btree ("suggestions_id");

  -- HAND-WRITTEN: one consent row per (user, ecosistema); push does not know it.
  CREATE UNIQUE INDEX "student_profiles_user_organization_unq" ON "student_profiles" USING btree ("user_id", "organization_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "student_profiles" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "suggestions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_student_profiles_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_suggestions_fk";
  
  DROP INDEX "payload_locked_documents_rels_student_profiles_id_idx";
  DROP INDEX "payload_locked_documents_rels_suggestions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "student_profiles_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "suggestions_id";
  -- Moved below the constraint drops by hand: generated order failed on down.
  DROP TABLE "student_profiles" CASCADE;
  DROP TABLE "suggestions" CASCADE;
  DROP TYPE "public"."enum_suggestions_kind";`)
}
