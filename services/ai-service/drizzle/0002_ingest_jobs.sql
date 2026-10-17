CREATE TYPE "public"."ingest_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "ingest_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"ingest_id" uuid NOT NULL,
	"external_id" text,
	"status" "ingest_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ingest_jobs_ingest_id_idx" ON "ingest_jobs" USING btree ("ingest_id");--> statement-breakpoint
CREATE INDEX "ingest_jobs_status_idx" ON "ingest_jobs" USING btree ("status");