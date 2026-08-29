import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_documents_graph_status" AS ENUM('n/a', 'pending', 'extracting', 'ready', 'failed', 'skipped');
  CREATE TYPE "public"."enum_graph_entities_type" AS ENUM('tema', 'lugar', 'evento', 'organizacion', 'persona');
  CREATE TYPE "public"."enum_graph_relations_type" AS ENUM('ocurre_en', 'participa_en', 'ubicado_en', 'parte_de', 'afecta_a', 'relacionado_con');
  CREATE TABLE "graph_entities" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"type" "enum_graph_entities_type" NOT NULL,
  	"label" varchar NOT NULL,
  	"canonical_key" varchar NOT NULL,
  	"aliases" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "graph_mentions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"document_id" integer NOT NULL,
  	"entity_id" integer NOT NULL,
  	"occurrences" numeric DEFAULT 1 NOT NULL,
  	"snippet" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "graph_relations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"document_id" integer NOT NULL,
  	"from_entity_id" integer NOT NULL,
  	"to_entity_id" integer NOT NULL,
  	"type" "enum_graph_relations_type" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "documents" ADD COLUMN "graph_status" "enum_documents_graph_status" DEFAULT 'n/a' NOT NULL;
  ALTER TABLE "documents" ADD COLUMN "graph_error" varchar;
  ALTER TABLE "documents" ADD COLUMN "graph_prompt_version" varchar;
  ALTER TABLE "documents" ADD COLUMN "graph_extracted_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "graph_entities_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "graph_mentions_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "graph_relations_id" integer;
  ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_entity_id_graph_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_from_entity_id_graph_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_to_entity_id_graph_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "graph_entities_organization_idx" ON "graph_entities" USING btree ("organization_id");
  CREATE INDEX "graph_entities_type_idx" ON "graph_entities" USING btree ("type");
  CREATE INDEX "graph_entities_canonical_key_idx" ON "graph_entities" USING btree ("canonical_key");
  CREATE INDEX "graph_entities_updated_at_idx" ON "graph_entities" USING btree ("updated_at");
  CREATE INDEX "graph_entities_created_at_idx" ON "graph_entities" USING btree ("created_at");
  CREATE INDEX "graph_mentions_organization_idx" ON "graph_mentions" USING btree ("organization_id");
  CREATE INDEX "graph_mentions_document_idx" ON "graph_mentions" USING btree ("document_id");
  CREATE INDEX "graph_mentions_entity_idx" ON "graph_mentions" USING btree ("entity_id");
  CREATE INDEX "graph_mentions_updated_at_idx" ON "graph_mentions" USING btree ("updated_at");
  CREATE INDEX "graph_mentions_created_at_idx" ON "graph_mentions" USING btree ("created_at");
  CREATE INDEX "graph_relations_organization_idx" ON "graph_relations" USING btree ("organization_id");
  CREATE INDEX "graph_relations_document_idx" ON "graph_relations" USING btree ("document_id");
  CREATE INDEX "graph_relations_from_entity_idx" ON "graph_relations" USING btree ("from_entity_id");
  CREATE INDEX "graph_relations_to_entity_idx" ON "graph_relations" USING btree ("to_entity_id");
  CREATE INDEX "graph_relations_type_idx" ON "graph_relations" USING btree ("type");
  CREATE INDEX "graph_relations_updated_at_idx" ON "graph_relations" USING btree ("updated_at");
  CREATE INDEX "graph_relations_created_at_idx" ON "graph_relations" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_graph_entities_fk" FOREIGN KEY ("graph_entities_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_graph_mentions_fk" FOREIGN KEY ("graph_mentions_id") REFERENCES "public"."graph_mentions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_graph_relations_fk" FOREIGN KEY ("graph_relations_id") REFERENCES "public"."graph_relations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "documents_graph_status_idx" ON "documents" USING btree ("graph_status");
  CREATE INDEX "documents_graph_prompt_version_idx" ON "documents" USING btree ("graph_prompt_version");
  CREATE INDEX "payload_locked_documents_rels_graph_entities_id_idx" ON "payload_locked_documents_rels" USING btree ("graph_entities_id");
  CREATE INDEX "payload_locked_documents_rels_graph_mentions_id_idx" ON "payload_locked_documents_rels" USING btree ("graph_mentions_id");
  CREATE INDEX "payload_locked_documents_rels_graph_relations_id_idx" ON "payload_locked_documents_rels" USING btree ("graph_relations_id");`)

  /**
   * ─── HAND-WRITTEN. NOT GENERATED. DO NOT DELETE ON A REGENERATION. ────────
   *
   * Everything above this line came out of `payload migrate:create`. Everything
   * below it does NOT exist in the Payload collection config and therefore does
   * NOT exist in the drizzle schema Payload diffs against. Same block, same two
   * warnings, as `20260814_205354_baseline.ts`:
   *
   *   1. A future `migrate:create` will NOT re-emit these. If this migration is
   *      ever regenerated, copy them forward by hand.
   *   2. Schema push does not know about them. `PAYLOAD_ALLOW_PUSH=1`
   *      reconciles the database toward the drizzle schema, and an index that is
   *      not in that schema is not something push has any reason to keep. It
   *      goes without an error, and de-duplication silently becomes inert.
   *
   * ── Why they are CORRECTNESS, not tuning ─────────────────────────────────
   *
   * `plan/adr-corpus-graph.md` §4.2. De-duplication happens in APPLICATION CODE
   * — `lib/graph/writer.ts` does a find-then-create for entities and a
   * delete-then-insert for mentions and relations — and **a check is not a
   * lock**. Two concurrent extractions both read "no row exists", both pass,
   * both write. Only the database can close that, and the race is not
   * hypothetical here: re-extracting a document while the backfill sweeps the
   * same ecosistema is exactly the intended way to use both tools.
   *
   * ⚠ Plain UNIQUE, not partial. Every column involved is NOT NULL, so a WHERE
   * clause would have no NULLs to exclude and would buy nothing.
   */
  await db.execute(sql`
  -- graph_entities (organization, type, canonical_key) — NODE IDENTITY.
  -- ADR §4.1 D5: a node IS this triple. Without the index, two documents
  -- extracted at the same time that both name "consulta previa" create two
  -- nodes, and every support count computed over the graph is then split
  -- between them — which matters most for GRAPH_MIN_SUPPORT (§7.3.3), where a
  -- split count can drop a legitimate edge below the visibility threshold.
  -- The writer catches the losing INSERT and adopts the winner's row, so this
  -- index is what makes that recovery possible rather than a silent duplicate.
  CREATE UNIQUE INDEX "graph_entities_org_type_key_unq" ON "graph_entities" USING btree ("organization_id","type","canonical_key");

  -- graph_mentions (document, entity) — ONE ROW PER PAIR, NOT PER OCCURRENCE.
  -- How often the entity was named lives in 'occurrences'. Support is a count
  -- of DISTINCT DOCUMENTS, so a duplicated pair makes one document look like
  -- two independent sources — the precise failure the minimum-support rule
  -- exists to prevent.
  CREATE UNIQUE INDEX "graph_mentions_document_entity_unq" ON "graph_mentions" USING btree ("document_id","entity_id");

  -- graph_relations (document, from, to, type) — ONE EDGE PER DOCUMENT.
  -- Same reasoning: an edge's support is the number of distinct published
  -- documents that evidence it, and a duplicate row inflates that number.
  -- ⚠ This index does NOT collapse a symmetric A→B / B→A pair; those are
  -- genuinely different tuples. lib/graph/writer.ts orders the endpoints
  -- ascending for relacionado_con before insert, and that ordering is what
  -- makes this index cover the symmetric case too.
  CREATE UNIQUE INDEX "graph_relations_document_edge_unq" ON "graph_relations" USING btree ("document_id","from_entity_id","to_entity_id","type");`)

  /**
   * ─── ALSO HAND-WRITTEN. 🔴 THIS ONE FIXES A GENERATED DEFECT. ─────────────
   *
   * `migrate:create` emitted every foreign key above as `ON DELETE set null`,
   * against columns it declared `NOT NULL` in the same statement. Postgres
   * applies the referential action FIRST and only then checks the constraint,
   * so deleting a referenced row raises
   *
   *     23502 null value in column "document_id" violates not-null constraint
   *
   * and the DELETE fails. Concretely: **`DELETE /api/documents/:id` would 500
   * for any document extraction had touched**, and because it never completes,
   * `retireDeletedDocumentHook` never runs either — so the document's chunks
   * would stay retrievable in ai-service while the user believes the document
   * is gone. Documents are user-deletable (`collections/Documents.ts`,
   * `delete: uploaderOnly`), so this is an ordinary action, not an edge case.
   *
   * ⚠ It is also NOT the house pattern. Every pre-existing foreign key that
   * points at `documents` is `ON DELETE cascade`
   * (`20260814_205354_baseline.ts:269,276,287`).
   *
   * CASCADE is the correct semantic here in its own right: a mention or a
   * relation is a statement ABOUT a document, and it has no meaning once the
   * document is gone. Same for an entity's mentions and edges.
   *
   * ⚠ Deleting an ENTITY still leaves nothing dangling, but it can orphan the
   * remaining half of an edge — which is why entity deletion happens only in
   * the backfill's orphan sweep, over entities that already have no mentions.
   */
  await db.execute(sql`
  ALTER TABLE "graph_mentions" DROP CONSTRAINT "graph_mentions_document_id_documents_id_fk";
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_mentions" DROP CONSTRAINT "graph_mentions_entity_id_graph_entities_id_fk";
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_entity_id_graph_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_relations" DROP CONSTRAINT "graph_relations_document_id_documents_id_fk";
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_relations" DROP CONSTRAINT "graph_relations_from_entity_id_graph_entities_id_fk";
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_from_entity_id_graph_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_relations" DROP CONSTRAINT "graph_relations_to_entity_id_graph_entities_id_fk";
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_to_entity_id_graph_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_entities" DROP CONSTRAINT "graph_entities_organization_id_organizations_id_fk";
  ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_mentions" DROP CONSTRAINT "graph_mentions_organization_id_organizations_id_fk";
  ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "graph_relations" DROP CONSTRAINT "graph_relations_organization_id_organizations_id_fk";
  ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;`)
}

/**
 * ⚠ No matching DROP INDEX for the three hand-written indexes above. All three
 * live on tables this function drops CASCADE, so Postgres removes them with
 * their table. Explicit drops would only be a second place to forget.
 */

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "graph_entities" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "graph_mentions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "graph_relations" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "graph_entities" CASCADE;
  DROP TABLE "graph_mentions" CASCADE;
  DROP TABLE "graph_relations" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_graph_entities_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_graph_mentions_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_graph_relations_fk";
  
  DROP INDEX "documents_graph_status_idx";
  DROP INDEX "documents_graph_prompt_version_idx";
  DROP INDEX "payload_locked_documents_rels_graph_entities_id_idx";
  DROP INDEX "payload_locked_documents_rels_graph_mentions_id_idx";
  DROP INDEX "payload_locked_documents_rels_graph_relations_id_idx";
  ALTER TABLE "documents" DROP COLUMN "graph_status";
  ALTER TABLE "documents" DROP COLUMN "graph_error";
  ALTER TABLE "documents" DROP COLUMN "graph_prompt_version";
  ALTER TABLE "documents" DROP COLUMN "graph_extracted_at";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "graph_entities_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "graph_mentions_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "graph_relations_id";
  DROP TYPE "public"."enum_documents_graph_status";
  DROP TYPE "public"."enum_graph_entities_type";
  DROP TYPE "public"."enum_graph_relations_type";`)
}
