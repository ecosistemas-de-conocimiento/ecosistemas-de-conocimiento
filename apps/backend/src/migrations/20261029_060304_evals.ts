import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `eval_items` and `eval_runs` — the evals dashboard (`/admin/evals`,
 * `collections/EvalItems.ts`, `collections/EvalRuns.ts`), platform admin only.
 *
 * 🔴 Hand-fixed SQL:
 *   · both `organization_id` FKs are `ON DELETE cascade` (generated `set null`
 *     on a NOT NULL column, which refuses an ecosistema delete — the 23502 of
 *     `20261027_061014`). The `.json` still says `set null`.
 *   · `down` drops the `payload_locked_documents_rels` constraints, indexes and
 *     columns BEFORE the tables: the generated order dropped the tables
 *     CASCADE first, which removes those constraints, and then failed on
 *     `DROP CONSTRAINT` of a constraint that no longer existed.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_eval_items_kind" AS ENUM('pregunta', 'privacidad');
  CREATE TYPE "public"."enum_eval_items_gate_kind" AS ENUM('documento', 'testimonio');
  CREATE TYPE "public"."enum_eval_runs_status" AS ENUM('queued', 'running', 'done', 'failed');
  CREATE TABLE "eval_items" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"kind" "enum_eval_items_kind" NOT NULL,
  	"question" varchar,
  	"expected_doc_ids" jsonb,
  	"should_refuse" boolean DEFAULT false,
  	"notes" varchar,
  	"text" varchar,
  	"private_names" jsonb,
  	"public_names" jsonb,
  	"gate_kind" "enum_eval_items_gate_kind" DEFAULT 'documento',
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "eval_runs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status" "enum_eval_runs_status" DEFAULT 'queued' NOT NULL,
  	"triggered_by_id" integer,
  	"started_at" timestamp(3) with time zone,
  	"finished_at" timestamp(3) with time zone,
  	"estimate_usd" numeric,
  	"cost_usd" numeric,
  	"progress" jsonb,
  	"models" jsonb,
  	"commit_sha" varchar,
  	"session_id" varchar,
  	"metrics" jsonb,
  	"results" jsonb,
  	"error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "eval_items_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "eval_runs_id" integer;
  ALTER TABLE "sessions" ADD COLUMN "eval_run" numeric;
  ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "eval_items_organization_idx" ON "eval_items" USING btree ("organization_id");
  CREATE INDEX "eval_items_updated_at_idx" ON "eval_items" USING btree ("updated_at");
  CREATE INDEX "eval_items_created_at_idx" ON "eval_items" USING btree ("created_at");
  CREATE INDEX "eval_runs_organization_idx" ON "eval_runs" USING btree ("organization_id");
  CREATE INDEX "eval_runs_status_idx" ON "eval_runs" USING btree ("status");
  CREATE INDEX "eval_runs_triggered_by_idx" ON "eval_runs" USING btree ("triggered_by_id");
  CREATE INDEX "eval_runs_updated_at_idx" ON "eval_runs" USING btree ("updated_at");
  CREATE INDEX "eval_runs_created_at_idx" ON "eval_runs" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_eval_items_fk" FOREIGN KEY ("eval_items_id") REFERENCES "public"."eval_items"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_eval_runs_fk" FOREIGN KEY ("eval_runs_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_eval_items_id_idx" ON "payload_locked_documents_rels" USING btree ("eval_items_id");
  CREATE INDEX "payload_locked_documents_rels_eval_runs_id_idx" ON "payload_locked_documents_rels" USING btree ("eval_runs_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_eval_items_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_eval_runs_fk";
  DROP INDEX "payload_locked_documents_rels_eval_items_id_idx";
  DROP INDEX "payload_locked_documents_rels_eval_runs_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "eval_items_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "eval_runs_id";
  ALTER TABLE "sessions" DROP COLUMN "eval_run";
  DROP TABLE "eval_items" CASCADE;
  DROP TABLE "eval_runs" CASCADE;
  DROP TYPE "public"."enum_eval_items_kind";
  DROP TYPE "public"."enum_eval_items_gate_kind";
  DROP TYPE "public"."enum_eval_runs_status";`)
}
