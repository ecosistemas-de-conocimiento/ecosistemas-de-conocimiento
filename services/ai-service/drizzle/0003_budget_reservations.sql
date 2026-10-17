CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text,
	"trace_id" text,
	"job_id" text,
	"amount_usd" numeric(20, 9) NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "budget_reservations_org_idx" ON "budget_reservations" USING btree ("org");--> statement-breakpoint
CREATE INDEX "budget_reservations_job_state_idx" ON "budget_reservations" USING btree ("job_id","state");--> statement-breakpoint
CREATE INDEX "budget_reservations_trace_idx" ON "budget_reservations" USING btree ("trace_id");