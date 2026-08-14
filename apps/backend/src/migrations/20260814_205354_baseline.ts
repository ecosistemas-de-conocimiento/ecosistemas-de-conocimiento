import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_locale" AS ENUM('es', 'en');
  CREATE TYPE "public"."enum_memberships_role" AS ENUM('member', 'admin', 'owner');
  CREATE TYPE "public"."enum_projects_status" AS ENUM('planning', 'active', 'paused', 'done');
  CREATE TYPE "public"."enum_documents_publication_status" AS ENUM('draft', 'publishing', 'published', 'unpublishing');
  CREATE TYPE "public"."enum_documents_kind" AS ENUM('markdown', 'pdf', 'docx', 'audio');
  CREATE TYPE "public"."enum_documents_mode" AS ENUM('full-text', 'rag-retrieve');
  CREATE TYPE "public"."enum_documents_ingest_status" AS ENUM('n/a', 'pending', 'extracting', 'transcribing', 'transcribed', 'embedding', 'ready', 'failed');
  CREATE TYPE "public"."enum_messages_role" AS ENUM('user', 'assistant', 'system');
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"display_name" varchar,
  	"avatar_url" varchar,
  	"locale" "enum_users_locale" DEFAULT 'es',
  	"is_platform_admin" boolean DEFAULT false,
  	"is_active" boolean DEFAULT true,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "organizations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"description" varchar,
  	"is_active" boolean DEFAULT true,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "memberships" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"role" "enum_memberships_role" DEFAULT 'member' NOT NULL,
  	"is_active" boolean DEFAULT true,
  	"team_id" integer,
  	"person_name" varchar,
  	"title" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "teams" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"organization_id" integer NOT NULL,
  	"mission" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "projects" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"team_id" integer NOT NULL,
  	"status" "enum_projects_status" DEFAULT 'active',
  	"summary" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"uploaded_by_id" integer NOT NULL,
  	"publication_status" "enum_documents_publication_status" DEFAULT 'draft' NOT NULL,
  	"publication_error" varchar,
  	"publish_ingest_id" varchar,
  	"session_id" integer,
  	"kind" "enum_documents_kind" DEFAULT 'markdown' NOT NULL,
  	"mode" "enum_documents_mode" DEFAULT 'full-text' NOT NULL,
  	"name" varchar DEFAULT 'Untitled document' NOT NULL,
  	"body_markdown" varchar,
  	"media_file_id" integer,
  	"is_pinned" boolean DEFAULT true,
  	"ingest_status" "enum_documents_ingest_status" DEFAULT 'n/a' NOT NULL,
  	"ingest_error" varchar,
  	"ingest_id" varchar,
  	"transcribe_id" varchar,
  	"transcribe_attempt" numeric DEFAULT 0,
  	"audio_meta" jsonb,
  	"extracted_text" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"uploaded_by_id" integer,
  	"organization_id" integer,
  	"alt" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric
  );
  
  CREATE TABLE "sessions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"title" varchar DEFAULT 'New chat',
  	"last_used_at" timestamp(3) with time zone,
  	"panel_state" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sessions_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"organizations_id" integer,
  	"teams_id" integer,
  	"projects_id" integer,
  	"memberships_id" integer,
  	"documents_id" integer
  );
  
  CREATE TABLE "messages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"session_id" integer NOT NULL,
  	"role" "enum_messages_role" NOT NULL,
  	"content" varchar NOT NULL,
  	"generation_meta" jsonb,
  	"provenance" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "messages_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"organizations_id" integer,
  	"teams_id" integer,
  	"projects_id" integer,
  	"memberships_id" integer,
  	"documents_id" integer
  );
  
  CREATE TABLE "ratings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"message_id" integer NOT NULL,
  	"session_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"user_id" integer NOT NULL,
  	"stars" numeric NOT NULL,
  	"comment" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ai_service_callbacks" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"correlation_key" varchar NOT NULL,
  	"event_key" varchar DEFAULT '' NOT NULL,
  	"event" varchar NOT NULL,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"raw_body" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer,
  	"organizations_id" integer,
  	"memberships_id" integer,
  	"teams_id" integer,
  	"projects_id" integer,
  	"documents_id" integer,
  	"media_id" integer,
  	"sessions_id" integer,
  	"messages_id" integer,
  	"ratings_id" integer,
  	"ai_service_callbacks_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_media_file_id_media_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_teams_fk" FOREIGN KEY ("teams_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_projects_fk" FOREIGN KEY ("projects_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_memberships_fk" FOREIGN KEY ("memberships_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sessions_rels" ADD CONSTRAINT "sessions_rels_documents_fk" FOREIGN KEY ("documents_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_teams_fk" FOREIGN KEY ("teams_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_projects_fk" FOREIGN KEY ("projects_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_memberships_fk" FOREIGN KEY ("memberships_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "messages_rels" ADD CONSTRAINT "messages_rels_documents_fk" FOREIGN KEY ("documents_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_memberships_fk" FOREIGN KEY ("memberships_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_teams_fk" FOREIGN KEY ("teams_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_projects_fk" FOREIGN KEY ("projects_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_documents_fk" FOREIGN KEY ("documents_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sessions_fk" FOREIGN KEY ("sessions_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_messages_fk" FOREIGN KEY ("messages_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ratings_fk" FOREIGN KEY ("ratings_id") REFERENCES "public"."ratings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ai_service_callbacks_fk" FOREIGN KEY ("ai_service_callbacks_id") REFERENCES "public"."ai_service_callbacks"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_is_platform_admin_idx" ON "users" USING btree ("is_platform_admin");
  CREATE INDEX "users_is_active_idx" ON "users" USING btree ("is_active");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");
  CREATE INDEX "organizations_is_active_idx" ON "organizations" USING btree ("is_active");
  CREATE INDEX "organizations_updated_at_idx" ON "organizations" USING btree ("updated_at");
  CREATE INDEX "organizations_created_at_idx" ON "organizations" USING btree ("created_at");
  CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");
  CREATE INDEX "memberships_organization_idx" ON "memberships" USING btree ("organization_id");
  CREATE INDEX "memberships_role_idx" ON "memberships" USING btree ("role");
  CREATE INDEX "memberships_is_active_idx" ON "memberships" USING btree ("is_active");
  CREATE INDEX "memberships_team_idx" ON "memberships" USING btree ("team_id");
  CREATE INDEX "memberships_updated_at_idx" ON "memberships" USING btree ("updated_at");
  CREATE INDEX "memberships_created_at_idx" ON "memberships" USING btree ("created_at");
  CREATE INDEX "teams_slug_idx" ON "teams" USING btree ("slug");
  CREATE INDEX "teams_organization_idx" ON "teams" USING btree ("organization_id");
  CREATE INDEX "teams_updated_at_idx" ON "teams" USING btree ("updated_at");
  CREATE INDEX "teams_created_at_idx" ON "teams" USING btree ("created_at");
  CREATE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");
  CREATE INDEX "projects_team_idx" ON "projects" USING btree ("team_id");
  CREATE INDEX "projects_updated_at_idx" ON "projects" USING btree ("updated_at");
  CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");
  CREATE INDEX "documents_organization_idx" ON "documents" USING btree ("organization_id");
  CREATE INDEX "documents_uploaded_by_idx" ON "documents" USING btree ("uploaded_by_id");
  CREATE INDEX "documents_publication_status_idx" ON "documents" USING btree ("publication_status");
  CREATE INDEX "documents_publish_ingest_id_idx" ON "documents" USING btree ("publish_ingest_id");
  CREATE INDEX "documents_session_idx" ON "documents" USING btree ("session_id");
  CREATE INDEX "documents_media_file_idx" ON "documents" USING btree ("media_file_id");
  CREATE INDEX "documents_transcribe_id_idx" ON "documents" USING btree ("transcribe_id");
  CREATE INDEX "documents_updated_at_idx" ON "documents" USING btree ("updated_at");
  CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");
  CREATE INDEX "media_uploaded_by_idx" ON "media" USING btree ("uploaded_by_id");
  CREATE INDEX "media_organization_idx" ON "media" USING btree ("organization_id");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
  CREATE INDEX "sessions_organization_idx" ON "sessions" USING btree ("organization_id");
  CREATE INDEX "sessions_updated_at_idx" ON "sessions" USING btree ("updated_at");
  CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at");
  CREATE INDEX "sessions_rels_order_idx" ON "sessions_rels" USING btree ("order");
  CREATE INDEX "sessions_rels_parent_idx" ON "sessions_rels" USING btree ("parent_id");
  CREATE INDEX "sessions_rels_path_idx" ON "sessions_rels" USING btree ("path");
  CREATE INDEX "sessions_rels_organizations_id_idx" ON "sessions_rels" USING btree ("organizations_id");
  CREATE INDEX "sessions_rels_teams_id_idx" ON "sessions_rels" USING btree ("teams_id");
  CREATE INDEX "sessions_rels_projects_id_idx" ON "sessions_rels" USING btree ("projects_id");
  CREATE INDEX "sessions_rels_memberships_id_idx" ON "sessions_rels" USING btree ("memberships_id");
  CREATE INDEX "sessions_rels_documents_id_idx" ON "sessions_rels" USING btree ("documents_id");
  CREATE INDEX "messages_session_idx" ON "messages" USING btree ("session_id");
  CREATE INDEX "messages_updated_at_idx" ON "messages" USING btree ("updated_at");
  CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");
  CREATE INDEX "messages_rels_order_idx" ON "messages_rels" USING btree ("order");
  CREATE INDEX "messages_rels_parent_idx" ON "messages_rels" USING btree ("parent_id");
  CREATE INDEX "messages_rels_path_idx" ON "messages_rels" USING btree ("path");
  CREATE INDEX "messages_rels_organizations_id_idx" ON "messages_rels" USING btree ("organizations_id");
  CREATE INDEX "messages_rels_teams_id_idx" ON "messages_rels" USING btree ("teams_id");
  CREATE INDEX "messages_rels_projects_id_idx" ON "messages_rels" USING btree ("projects_id");
  CREATE INDEX "messages_rels_memberships_id_idx" ON "messages_rels" USING btree ("memberships_id");
  CREATE INDEX "messages_rels_documents_id_idx" ON "messages_rels" USING btree ("documents_id");
  CREATE INDEX "ratings_message_idx" ON "ratings" USING btree ("message_id");
  CREATE INDEX "ratings_session_idx" ON "ratings" USING btree ("session_id");
  CREATE INDEX "ratings_organization_idx" ON "ratings" USING btree ("organization_id");
  CREATE INDEX "ratings_user_idx" ON "ratings" USING btree ("user_id");
  CREATE INDEX "ratings_stars_idx" ON "ratings" USING btree ("stars");
  CREATE INDEX "ratings_updated_at_idx" ON "ratings" USING btree ("updated_at");
  CREATE INDEX "ratings_created_at_idx" ON "ratings" USING btree ("created_at");
  CREATE INDEX "ai_service_callbacks_correlation_key_idx" ON "ai_service_callbacks" USING btree ("correlation_key");
  CREATE INDEX "ai_service_callbacks_event_key_idx" ON "ai_service_callbacks" USING btree ("event_key");
  CREATE INDEX "ai_service_callbacks_event_idx" ON "ai_service_callbacks" USING btree ("event");
  CREATE INDEX "ai_service_callbacks_updated_at_idx" ON "ai_service_callbacks" USING btree ("updated_at");
  CREATE INDEX "ai_service_callbacks_created_at_idx" ON "ai_service_callbacks" USING btree ("created_at");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_organizations_id_idx" ON "payload_locked_documents_rels" USING btree ("organizations_id");
  CREATE INDEX "payload_locked_documents_rels_memberships_id_idx" ON "payload_locked_documents_rels" USING btree ("memberships_id");
  CREATE INDEX "payload_locked_documents_rels_teams_id_idx" ON "payload_locked_documents_rels" USING btree ("teams_id");
  CREATE INDEX "payload_locked_documents_rels_projects_id_idx" ON "payload_locked_documents_rels" USING btree ("projects_id");
  CREATE INDEX "payload_locked_documents_rels_documents_id_idx" ON "payload_locked_documents_rels" USING btree ("documents_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_locked_documents_rels_sessions_id_idx" ON "payload_locked_documents_rels" USING btree ("sessions_id");
  CREATE INDEX "payload_locked_documents_rels_messages_id_idx" ON "payload_locked_documents_rels" USING btree ("messages_id");
  CREATE INDEX "payload_locked_documents_rels_ratings_id_idx" ON "payload_locked_documents_rels" USING btree ("ratings_id");
  CREATE INDEX "payload_locked_documents_rels_ai_service_callbacks_id_idx" ON "payload_locked_documents_rels" USING btree ("ai_service_callbacks_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");`)

  /**
   * ─── HAND-WRITTEN. NOT GENERATED. DO NOT DELETE ON A REGENERATION. ────────
   *
   * Everything above this line came out of `payload migrate:create`. Everything
   * below it does NOT exist in the Payload collection config and therefore does
   * NOT exist in the drizzle schema Payload diffs against.
   *
   * 🔴 Two consequences, both load-bearing:
   *
   *   1. A future `migrate:create` will NOT re-emit these. If this baseline is
   *      ever regenerated, they must be copied forward by hand.
   *   2. Schema push does not know about them. `push: true` reconciles the
   *      database against the drizzle schema, and an index that is not in that
   *      schema is not something push will keep. It goes without an error, and
   *      the ratings table quietly starts accepting duplicates again. This is
   *      why the push gate in `payload.config.ts` is opt-IN
   *      (`PAYLOAD_ALLOW_PUSH === '1'`) rather than opt-out: forgetting a
   *      variable must not be able to remove these — see
   *      `src/migrations/README.md`.
   *
   * ── Why they are here and not in the collections ──────────────────────────
   * Payload has no compound-unique index in its field config. The three
   * constraints below are enforced in `beforeValidate` hooks today, and a hook
   * is a CHECK, not a LOCK: two concurrent inserts both read "no row exists",
   * both pass, both write. Only the database can close that race.
   *
   * The hooks stay exactly as they are — they produce the readable error in the
   * admin panel. These indexes close the gap underneath them.
   *
   * ⚠ Plain UNIQUE, not partial. The README calls these "partial unique
   * indexes"; a WHERE clause would buy nothing here because every column
   * involved is NOT NULL, so there are no NULLs for a partial index to exclude.
   */
  await db.execute(sql`
  -- ratings (message, user) — THE IMPORTANT ONE.
  -- Two fast clicks on the star widget race each other through
  -- collections/Ratings.ts's find-then-create. Without this index both rows
  -- land and every average computed over this table is quietly wrong. There is
  -- no error and no way to tell after the fact which row the user meant.
  CREATE UNIQUE INDEX "ratings_message_user_unq" ON "ratings" USING btree ("message_id","user_id");

  -- memberships (user, organization) — one membership per person per org.
  -- Duplicates make role resolution ambiguous: lib/permissions.ts reads "the"
  -- membership, and with two rows which one wins is insertion order.
  CREATE UNIQUE INDEX "memberships_user_organization_unq" ON "memberships" USING btree ("user_id","organization_id");

  -- ai_service_callbacks (correlation_key, event_key, event) — idempotency.
  -- app/api/ai-service/callback/route.ts dedupes by INSERTing and treating a
  -- unique violation as "already processed". With no unique index there is
  -- nothing for the insert to conflict WITH, so the dedupe is inert and an
  -- ai-service retry re-runs the entire dispatch.
  -- 🔴 The NAME is part of the contract: that route matches
  -- 'ai_service_callbacks_natural_key_unq' in the raw driver error text.
  -- Renaming this index silently narrows the dedupe to the other two error
  -- shapes it checks for.
  CREATE UNIQUE INDEX "ai_service_callbacks_natural_key_unq" ON "ai_service_callbacks" USING btree ("correlation_key","event_key","event");

  -- Hot path, not correctness. The document visibility constraint is
  --   OR(uploaded_by = me, AND(publication_status = 'published', organization IN …))
  -- and it runs on every document list. Payload already emitted single-column
  -- indexes on organization_id and publication_status; this composite serves
  -- the AND branch in one scan.
  CREATE INDEX "documents_organization_publication_status_idx" ON "documents" USING btree ("organization_id","publication_status");`)
}

/**
 * ⚠ No matching DROP INDEX for the hand-written indexes in `up`. Every one of
 * them lives on a table this function drops CASCADE, so Postgres removes them
 * with their table. Adding explicit drops would only create a second place to
 * forget to update.
 */
export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "organizations" CASCADE;
  DROP TABLE "memberships" CASCADE;
  DROP TABLE "teams" CASCADE;
  DROP TABLE "projects" CASCADE;
  DROP TABLE "documents" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "sessions" CASCADE;
  DROP TABLE "sessions_rels" CASCADE;
  DROP TABLE "messages" CASCADE;
  DROP TABLE "messages_rels" CASCADE;
  DROP TABLE "ratings" CASCADE;
  DROP TABLE "ai_service_callbacks" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TYPE "public"."enum_users_locale";
  DROP TYPE "public"."enum_memberships_role";
  DROP TYPE "public"."enum_projects_status";
  DROP TYPE "public"."enum_documents_publication_status";
  DROP TYPE "public"."enum_documents_kind";
  DROP TYPE "public"."enum_documents_mode";
  DROP TYPE "public"."enum_documents_ingest_status";
  DROP TYPE "public"."enum_messages_role";`)
}
