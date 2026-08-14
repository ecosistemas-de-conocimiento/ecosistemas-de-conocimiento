-- pgvector lives outside Drizzle's introspection; enable it before any table
-- declares a `vector(N)` column (chunks.embedding). Idempotent so it is safe on
-- a managed Postgres image that already ships the extension.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."budget_enforcement" AS ENUM('soft', 'hard');--> statement-breakpoint
CREATE TYPE "public"."callback_delivery_source" AS ENUM('generate', 'ingest');--> statement-breakpoint
CREATE TYPE "public"."callback_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'auth_failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."effort_level" AS ENUM('quick', 'standard', 'deep', 'maximum');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."generation_request_status" AS ENUM('queued', 'running', 'partial', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ingest_request_status" AS ENUM('queued', 'running', 'partial', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('openrouter', 'openai', 'anthropic', 'azure_openai', 'google', 'local');--> statement-breakpoint
CREATE TYPE "public"."trace_status" AS ENUM('queued', 'running', 'completed', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."usage_status" AS ENUM('completed', 'aborted', 'failed');--> statement-breakpoint
CREATE TABLE "budget_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"limit_usd" numeric(20, 9) DEFAULT '100' NOT NULL,
	"remaining_usd" numeric(20, 9) DEFAULT '100' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_cadence" text DEFAULT 'monthly_anniversary' NOT NULL,
	"reset_anchor_day" integer DEFAULT 1 NOT NULL,
	"reset_tz" text DEFAULT 'UTC' NOT NULL,
	"last_reset_at" timestamp with time zone,
	"next_reset_at" timestamp with time zone,
	"soft_cap_pct" numeric(5, 2) DEFAULT '90' NOT NULL,
	"soft_cap_warned_at" timestamp with time zone,
	CONSTRAINT "budget_state_org_unique" UNIQUE("org")
);
--> statement-breakpoint
CREATE TABLE "callback_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"source" "callback_delivery_source" NOT NULL,
	"source_id" text NOT NULL,
	"item_key" text,
	"event" text NOT NULL,
	"url" text NOT NULL,
	"api_key_id" text,
	"body" text NOT NULL,
	"signed_at_unix" integer NOT NULL,
	"signature" text NOT NULL,
	"status" "callback_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_body_excerpt" text,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"corpus_id" uuid NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"tokens" integer,
	"embedding" vector(1024),
	"text_search" "tsvector",
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpora" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"name" text NOT NULL,
	"embedding_model" text DEFAULT 'baai/bge-m3' NOT NULL,
	"embedding_dim" integer DEFAULT 1024 NOT NULL,
	"chunk_strategy" text DEFAULT 'recursive-char' NOT NULL,
	"chunk_size" integer DEFAULT 800 NOT NULL,
	"chunk_overlap" integer DEFAULT 100 NOT NULL,
	"chunk_config" jsonb,
	"text_search_config" text DEFAULT 'simple' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "corpus_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"name" text NOT NULL,
	"target_corpus_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"external_id" text,
	"text" text NOT NULL,
	"title" text,
	"source_url" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"language" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"ingest_id" uuid
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_request_id" uuid NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"unit_key" text NOT NULL,
	"unit_type" text,
	"depends_on" jsonb,
	"input" jsonb,
	"output" jsonb,
	"registry_entry_id" uuid,
	"spec_override" jsonb,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"effort" "effort_level" NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"trace_id" uuid,
	"queue_job_id" text,
	"estimated_cost_usd" numeric(12, 6),
	"actual_cost_usd" numeric(12, 6),
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"requested_by" text,
	"client_request_id" text,
	"status" "generation_request_status" DEFAULT 'queued' NOT NULL,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"failed_jobs" integer DEFAULT 0 NOT NULL,
	"effort" "effort_level" DEFAULT 'standard' NOT NULL,
	"effort_overrides" jsonb,
	"prompt_override" text,
	"meta_prompt_override" text,
	"model_override" text,
	"include_context" jsonb,
	"callback_url" text,
	"api_key_id" text,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"actual_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"api_key_id" text,
	"corpus" text NOT NULL,
	"corpus_id" uuid,
	"status" "ingest_request_status" DEFAULT 'queued' NOT NULL,
	"total_docs" integer DEFAULT 0 NOT NULL,
	"completed_docs" integer DEFAULT 0 NOT NULL,
	"failed_docs" integer DEFAULT 0 NOT NULL,
	"callback_url" text,
	"last_progress_emitted_at" timestamp with time zone,
	"last_progress_docs" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"base_url" text,
	"default_model" text,
	"max_tokens_per_request" integer DEFAULT 4096 NOT NULL,
	"requests_per_minute" integer DEFAULT 60 NOT NULL,
	"tokens_per_day" integer DEFAULT 1000000 NOT NULL,
	"monthly_budget_usd" numeric(20, 9) DEFAULT '100' NOT NULL,
	"budget_enforcement" "budget_enforcement" DEFAULT 'soft' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"default_model" text,
	"default_effort" "effort_level",
	"effort_profiles" jsonb,
	"context_rules" jsonb,
	"callback_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "registry_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"actor_key_id" text NOT NULL,
	"action" text NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"unit_type" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"prompt_template" text NOT NULL,
	"meta_prompt_template" text,
	"model" text,
	"default_effort" "effort_level",
	"effort_profiles" jsonb,
	"response_schema" jsonb,
	"validators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"renderer" text,
	"content_kind" text,
	"created_by" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"generation_request_id" uuid,
	"generation_job_id" uuid,
	"registry_entry_id" uuid,
	"parent_trace_id" uuid,
	"actor_user_id" text,
	"label" text,
	"status" "trace_status" DEFAULT 'queued' NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"input_payload" jsonb,
	"output_payload" jsonb,
	"token_usage" jsonb,
	"duration_ms" integer,
	"effort" "effort_level",
	"effort_profile_used" jsonb,
	"estimated_cost_usd" numeric(12, 6),
	"actual_cost_usd" numeric(12, 6),
	"cost_breakdown" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"user_id" text,
	"generation_request_id" uuid,
	"generation_job_id" uuid,
	"trace_id" uuid,
	"provider" text,
	"model" text,
	"endpoint" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6),
	"actual_cost_usd" numeric(12, 6),
	"status" "usage_status" DEFAULT 'completed' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_aliases" ADD CONSTRAINT "corpus_aliases_target_corpus_id_corpora_id_fk" FOREIGN KEY ("target_corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_generation_request_id_generation_requests_id_fk" FOREIGN KEY ("generation_request_id") REFERENCES "public"."generation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_state_org_idx" ON "budget_state" USING btree ("org");--> statement-breakpoint
CREATE INDEX "callback_deliveries_source_idx" ON "callback_deliveries" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "callback_deliveries_status_idx" ON "callback_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "callback_deliveries_next_attempt_idx" ON "callback_deliveries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "callback_deliveries_org_idx" ON "callback_deliveries" USING btree ("org");--> statement-breakpoint
CREATE INDEX "chunks_corpus_ordinal_idx" ON "chunks" USING btree ("corpus_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_text_search_gin_idx" ON "chunks" USING gin ("text_search");--> statement-breakpoint
CREATE INDEX "chunks_corpus_validity_idx" ON "chunks" USING btree ("corpus_id","valid_from","valid_to") WHERE "chunks"."valid_from" is not null or "chunks"."valid_to" is not null;--> statement-breakpoint
CREATE INDEX "chunks_metadata_gin_idx" ON "chunks" USING gin ("metadata" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "corpora_org_project_name_idx" ON "corpora" USING btree ("org","project","name");--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_aliases_org_project_name_idx" ON "corpus_aliases" USING btree ("org","project","name");--> statement-breakpoint
CREATE INDEX "corpus_aliases_target_idx" ON "corpus_aliases" USING btree ("target_corpus_id");--> statement-breakpoint
CREATE INDEX "documents_org_project_idx" ON "documents" USING btree ("org","project");--> statement-breakpoint
CREATE INDEX "documents_corpus_idx" ON "documents" USING btree ("corpus_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_corpus_external_id_idx" ON "documents" USING btree ("corpus_id","external_id") WHERE "documents"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "generation_jobs_request_idx" ON "generation_jobs" USING btree ("generation_request_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_org_idx" ON "generation_jobs" USING btree ("org");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_idx" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generation_jobs_queue_job_idx" ON "generation_jobs" USING btree ("queue_job_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_registry_entry_idx" ON "generation_jobs" USING btree ("registry_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_request_unit_idx" ON "generation_jobs" USING btree ("generation_request_id","unit_key");--> statement-breakpoint
CREATE INDEX "generation_requests_org_idx" ON "generation_requests" USING btree ("org");--> statement-breakpoint
CREATE INDEX "generation_requests_project_idx" ON "generation_requests" USING btree ("project");--> statement-breakpoint
CREATE INDEX "generation_requests_status_idx" ON "generation_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_requests_client_request_idx" ON "generation_requests" USING btree ("org","client_request_id") WHERE "generation_requests"."client_request_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_requests_org_idx" ON "ingest_requests" USING btree ("org");--> statement-breakpoint
CREATE INDEX "ingest_requests_project_idx" ON "ingest_requests" USING btree ("project");--> statement-breakpoint
CREATE INDEX "ingest_requests_status_idx" ON "ingest_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "llm_configs_org_provider_idx" ON "llm_configs" USING btree ("org","provider");--> statement-breakpoint
CREATE INDEX "llm_configs_active_idx" ON "llm_configs" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "project_configs_org_project_idx" ON "project_configs" USING btree ("org","project");--> statement-breakpoint
CREATE INDEX "registry_audit_org_project_created_idx" ON "registry_audit" USING btree ("org","project","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "registry_audit_actor_created_idx" ON "registry_audit" USING btree ("actor_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "registry_entries_org_project_idx" ON "registry_entries" USING btree ("org","project");--> statement-breakpoint
CREATE INDEX "registry_entries_unit_type_idx" ON "registry_entries" USING btree ("org","project","unit_type");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_entries_version_idx" ON "registry_entries" USING btree ("org","project","unit_type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_entries_active_idx" ON "registry_entries" USING btree ("org","project","unit_type") WHERE "registry_entries"."is_active";--> statement-breakpoint
CREATE INDEX "traces_org_idx" ON "traces" USING btree ("org");--> statement-breakpoint
CREATE INDEX "traces_project_idx" ON "traces" USING btree ("project");--> statement-breakpoint
CREATE INDEX "traces_label_idx" ON "traces" USING btree ("label");--> statement-breakpoint
CREATE INDEX "traces_parent_idx" ON "traces" USING btree ("parent_trace_id");--> statement-breakpoint
CREATE INDEX "traces_generation_request_idx" ON "traces" USING btree ("generation_request_id");--> statement-breakpoint
CREATE INDEX "traces_generation_job_idx" ON "traces" USING btree ("generation_job_id");--> statement-breakpoint
CREATE INDEX "traces_registry_entry_idx" ON "traces" USING btree ("registry_entry_id");--> statement-breakpoint
CREATE INDEX "usage_logs_org_idx" ON "usage_logs" USING btree ("org");--> statement-breakpoint
CREATE INDEX "usage_logs_project_idx" ON "usage_logs" USING btree ("project");--> statement-breakpoint
CREATE INDEX "usage_logs_created_at_idx" ON "usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_trace_idx" ON "usage_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "usage_logs_generation_request_idx" ON "usage_logs" USING btree ("generation_request_id");--> statement-breakpoint
-- Vector ANN index. Drizzle can't model `USING hnsw` cleanly, so it is added by
-- hand here, after the `chunks` table and its `embedding vector(1024)` column
-- exist. HNSW + cosine ops match how embeddings are compared at retrieve time
-- (the `<=>` operator under `vector_cosine_ops`). If a pgvector build lacks
-- HNSW (older 0.4.x), swap for:
--   CREATE INDEX "chunks_embedding_idx" ON "chunks"
--     USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);